import { sql } from 'kysely'
import { Address, Hex } from 'ox'
import { createClient, http } from 'viem'
import { multicall } from 'viem/actions'
import { Actions } from 'viem/tempo'
import { formatAmount, formatCurrencyAmount } from '#/lib/format.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as DB from '#db/client.ts'

export type SlackErrorClass =
  | 'duplicate_or_conflict'
  | 'invalid_destination'
  | 'invalid_payload'
  | 'rate_limited'
  | 'restricted_destination'
  | 'transient_slack_error'
  | 'unknown_slack_error'

export type SlackErrorInfo = {
  code?: string
  errorClass: SlackErrorClass
  message: string
  retryable: boolean
  status?: number
}

export function classifySlackError(error: unknown): SlackErrorInfo {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const response =
    record.response && typeof record.response === 'object'
      ? (record.response as Record<string, unknown>)
      : {}
  const data =
    response.data && typeof response.data === 'object'
      ? (response.data as Record<string, unknown>)
      : {}
  const status = typeof response.status === 'number' ? response.status : undefined
  const code = stringValue(
    record.code ?? record.error ?? data.code ?? data.error ?? data.error_code,
  )
    .trim()
    .toLowerCase()
  const message = (() => {
    if (error instanceof Error) return error.message
    if (typeof record.message === 'string') return record.message
    if (typeof record.error === 'string') return record.error
    if (typeof data.error === 'string') return data.error
    return stringValue(error) || 'Slack API error'
  })()
  const lowerMessage = message.toLowerCase()
  const matches = (values: string[]) =>
    Boolean(code && values.includes(code)) || values.some((value) => lowerMessage.includes(value))

  if (status === 409)
    return {
      code: code || undefined,
      errorClass: 'duplicate_or_conflict',
      message,
      retryable: false,
      status,
    }
  if (matches(['channel_not_found', 'not_in_channel', 'user_not_found']))
    return {
      code: code || undefined,
      errorClass: 'invalid_destination',
      message,
      retryable: false,
      status,
    }
  if (matches(['restricted_action', 'restricted_action_thread_locked']))
    return {
      code: code || undefined,
      errorClass: 'restricted_destination',
      message,
      retryable: false,
      status,
    }
  if (matches(['invalid_blocks', 'invalid_payload', 'msg_too_long', 'msg_blocks_too_long']))
    return {
      code: code || undefined,
      errorClass: 'invalid_payload',
      message,
      retryable: false,
      status,
    }
  if (status === 429 || matches(['rate_limited', 'ratelimited']))
    return { code: code || undefined, errorClass: 'rate_limited', message, retryable: true, status }
  if (status && status >= 500)
    return {
      code: code || undefined,
      errorClass: 'transient_slack_error',
      message,
      retryable: true,
      status,
    }
  if (matches(['internal_error', 'timeout', 'timed out', 'network']))
    return {
      code: code || undefined,
      errorClass: 'transient_slack_error',
      message,
      retryable: true,
      status,
    }
  return {
    code: code || undefined,
    errorClass: 'unknown_slack_error',
    message,
    retryable: false,
    status,
  }
}

export function slackApiError(method: string, error: string | undefined) {
  const value = new Error(error ?? `Slack API ${method} failed.`)
  Object.assign(value, { code: error, error })
  return value
}

export function getChannelId(channelId: string) {
  return channelId.replace(/^slack:/, '').split(':')[0] ?? ''
}

export function isDMChannelId(channelId: string) {
  return getChannelId(channelId).startsWith('D')
}

function stringValue(value: unknown) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export async function createSlackHeaders(body: string, signingSecret: string) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  )
  return {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${Hex.fromBytes(new Uint8Array(digest)).slice(2)}`,
  }
}

export async function verifySlackSignature(input: {
  body: string
  signature: string | null
  signingSecret: string
  timestamp: string | null
}) {
  if (!input.timestamp || !input.signature) return false
  const timestamp = Number.parseInt(input.timestamp, 10)
  if (!Number.isFinite(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300)
    return false

  const signature = input.signature.match(/^v0=([0-9a-f]{64})$/i)?.[1]?.toLowerCase()
  if (!signature) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.signingSecret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${input.timestamp}:${input.body}`),
  )
  const expected = Hex.fromBytes(new Uint8Array(digest)).slice(2)
  let result = 0
  for (let i = 0; i < expected.length; i++)
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return result === 0
}

export async function publishHome(input: {
  env: Env
  getInstallation: (teamId: string) => Promise<{ botToken: string } | null | undefined>
  initializeChat: () => Promise<unknown>
  publishHomeView: (slackUserId: string, view: Record<string, unknown>) => Promise<unknown>
  slackUserId: string
  teamId: string
  withBotToken: <value>(
    botToken: string,
    fn: () => value | Promise<value>,
  ) => value | Promise<value>
}) {
  await input.initializeChat()
  const installation = await input.getInstallation(input.teamId)
  if (!installation) return

  const view = await buildHomeView({
    env: input.env,
    slackUserId: input.slackUserId,
    teamId: input.teamId,
  })
  await input.withBotToken(installation.botToken, () =>
    input.publishHomeView(input.slackUserId, view),
  )
}

async function buildHomeView(input: {
  env: Env
  slackUserId: string
  teamId: string
}): Promise<Record<string, unknown>> {
  const db = DB.create(input.env.DB)
  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', 'slack')
    .where('provider_id', '=', input.teamId)
    .executeTakeFirst()
  if (!workspace)
    return (() => {
      // Build the Home tab for Slack teams that do not have a workspace row yet.
      return {
        blocks: [
          {
            text: { emoji: true, text: 'Tipbot', type: 'plain_text' },
            type: 'header',
          },
          {
            text: {
              text: `Hi <@${input.slackUserId}>! Tipbot isn't installed in this workspace yet. Ask an admin to install it.`,
              type: 'mrkdwn',
            },
            type: 'section',
          },
        ],
        type: 'home',
      }
    })()
  const reactionTipConfigs = await db
    .selectFrom('reaction_tip_config')
    .select(['amount', 'emoji'])
    .where('workspace_id', '=', workspace.id)
    .orderBy('amount', 'asc')
    .orderBy('emoji', 'asc')
    .execute()
  const reactionTipText = (
    reactionTipConfigs.length
      ? reactionTipConfigs
      : [
          { amount: 1000, emoji: 'money_with_wings' }, // $0.001
          { amount: 10_000, emoji: 'dollar' }, // $0.01
          { amount: 100_000, emoji: 'moneybag' }, // $0.10
        ]
  )
    .map((config) => `:${config.emoji}: (${formatAmount(config.amount)})`)
    .join(', ')

  const member = await db
    .selectFrom('member')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .leftJoin('account', 'account.id', 'provider_identity.account_id')
    .select(['member.id as id', 'account.address as account_address'])
    .where('member.workspace_id', '=', workspace.id)
    .where('member.provider_user_id', '=', input.slackUserId)
    .executeTakeFirst()
  if (!member?.account_address)
    return (() => {
      // Build the Home tab for workspace members who have not connected a wallet.
      const networkLabel = workspace.chain_id === Tempo.chainLookup.mainnet ? 'Mainnet' : 'Testnet'
      const slashCommand = getSlackCommand(input.env.HOST)
      return {
        blocks: [
          {
            text: { emoji: true, text: 'Tipbot', type: 'plain_text' },
            type: 'header',
          },
          {
            text: {
              text: `Hi <@${input.slackUserId}>! You haven't connected an account yet.`,
              type: 'mrkdwn',
            },
            type: 'section',
          },
          {
            text: {
              text: `Run \`${slashCommand} connect\` in any channel to link a wallet. Then come back here to see balances, stats, and recent tips.`,
              type: 'mrkdwn',
            },
            type: 'section',
          },
          { type: 'divider' },
          {
            text: { emoji: true, text: 'Workspace', type: 'plain_text' },
            type: 'header',
          },
          {
            text: {
              text: `*Network* ${networkLabel}\n*Default amount* ${formatAmount(workspace.default_amount)}\n*Tip reactions* ${reactionTipText}`,
              type: 'mrkdwn',
            },
            type: 'section',
          },
        ],
        type: 'home',
      }
    })()

  const [balances, received, sent, mostTipped, mostTippedBy, recent] = await Promise.all([
    (async () => {
      // Fetch balances for every token allowed in this workspace, falling back to zero on RPC failures.
      const tokens = [
        { address: Tempo.addressLookup.pathUsd, label: 'PathUSD' },
        { address: Tempo.addressLookup.usdcE, label: 'USDC.e' },
        { address: Tempo.addressLookup.usdt0, label: 'USDT0' },
        { address: Tempo.addressLookup.alphaUsd, label: 'AlphaUSD' },
        { address: Tempo.addressLookup.betaUsd, label: 'BetaUSD' },
        { address: Tempo.addressLookup.thetaUsd, label: 'ThetaUSD' },
      ].filter((token) => Tempo.isAllowedToken(workspace.chain_id, token.address))
      const client = createClient({
        chain: Tempo.getChain(workspace.chain_id),
        transport: http(Tempo.getRpcUrl(input.env, workspace.chain_id), {
          retryCount: 0,
          timeout: 1_500, // 1.5 seconds
        }),
      })
      try {
        const results = await multicall(client, {
          allowFailure: true,
          contracts: tokens.map((token) =>
            Actions.token.getBalance.call({
              account: member.account_address as Address.Address,
              token: token.address as Address.Address,
            }),
          ),
          deployless: true,
        })
        return tokens.map((token, index) => {
          const result = results[index]
          return {
            address: token.address,
            balance: result?.status === 'success' ? result.result : 0n,
            label: token.label,
          }
        })
      } catch {
        return tokens.map((token) => ({ address: token.address, balance: 0n, label: token.label }))
      }
    })(),
    db
      .selectFrom('tip')
      .select([
        sql<number>`coalesce(sum("tip"."amount"), 0)`.as('amount'),
        sql<number>`count("tip"."id")`.as('tip_count'),
      ])
      .where('tip.workspace_id', '=', workspace.id)
      .where('tip.recipient_member_id', '=', member.id)
      .where('tip.confirmed_at', 'is not', null)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('tip')
      .select([
        sql<number>`coalesce(sum("tip"."amount"), 0)`.as('amount'),
        sql<number>`count("tip"."id")`.as('tip_count'),
      ])
      .where('tip.workspace_id', '=', workspace.id)
      .where('tip.sender_member_id', '=', member.id)
      .where('tip.confirmed_at', 'is not', null)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('tip')
      .innerJoin('member', 'member.id', 'tip.recipient_member_id')
      .select([
        'member.provider_user_id',
        sql<number>`coalesce(sum("tip"."amount"), 0)`.as('amount'),
        sql<number>`count("tip"."id")`.as('tip_count'),
      ])
      .where('tip.workspace_id', '=', workspace.id)
      .where('tip.sender_member_id', '=', member.id)
      .where('tip.confirmed_at', 'is not', null)
      .groupBy(['member.id', 'member.provider_user_id'])
      .orderBy('amount', 'desc')
      .orderBy('tip_count', 'desc')
      .orderBy('member.provider_user_id', 'asc')
      .executeTakeFirst(),
    db
      .selectFrom('tip')
      .innerJoin('member', 'member.id', 'tip.sender_member_id')
      .select([
        'member.provider_user_id',
        sql<number>`coalesce(sum("tip"."amount"), 0)`.as('amount'),
        sql<number>`count("tip"."id")`.as('tip_count'),
      ])
      .where('tip.workspace_id', '=', workspace.id)
      .where('tip.recipient_member_id', '=', member.id)
      .where('tip.confirmed_at', 'is not', null)
      .groupBy(['member.id', 'member.provider_user_id'])
      .orderBy('amount', 'desc')
      .orderBy('tip_count', 'desc')
      .orderBy('member.provider_user_id', 'asc')
      .executeTakeFirst(),
    db
      .selectFrom('tip')
      .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
      .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
      .leftJoin('tip_batch', 'tip_batch.id', 'tip.batch_id')
      .select([
        'tip.amount',
        'tip.chain_id',
        'tip.confirmed_at',
        'tip.created_at',
        'tip.failed_at',
        'tip.memo',
        'tip.token_address',
        'tip_batch.transaction_hash as transaction_hash',
        'recipient.provider_user_id as recipient_provider_user_id',
        'sender.provider_user_id as sender_provider_user_id',
      ])
      .where('tip.workspace_id', '=', workspace.id)
      .where((eb) =>
        eb.or([
          eb('tip.sender_member_id', '=', member.id),
          eb('tip.recipient_member_id', '=', member.id),
        ]),
      )
      .orderBy('tip.created_at', 'desc')
      .limit(10)
      .execute(),
  ])

  return (() => {
    // Build the Home tab for connected members with wallet, balance, stats, and recent tip sections.
    const explorerUrl = Tempo.explorerLink(workspace.chain_id, member.account_address)

    const balanceFields = [...balances]
      .sort((a, b) => {
        if (a.balance === b.balance) return a.label.localeCompare(b.label)
        return a.balance > b.balance ? -1 : 1
      })
      .map((b) => ({
        text: `*${b.label}*\n${formatCurrencyAmount(formatAmount(Number(b.balance)), 'USD')}`,
        type: 'mrkdwn',
      }))

    const statsFields = [
      {
        text: `*Received*\n${formatCurrencyAmount(formatAmount(Number(received.amount)), 'USD')} · ${Number(received.tip_count)} ${Number(received.tip_count) === 1 ? 'tip' : 'tips'}`,
        type: 'mrkdwn',
      },
      {
        text: `*Most tipped by*\n${
          mostTippedBy
            ? `<@${mostTippedBy.provider_user_id}> · ${formatCurrencyAmount(formatAmount(Number(mostTippedBy.amount)), 'USD')}`
            : 'None yet'
        }`,
        type: 'mrkdwn',
      },
      {
        text: `*Tipped*\n${formatCurrencyAmount(formatAmount(Number(sent.amount)), 'USD')} · ${Number(sent.tip_count)} ${Number(sent.tip_count) === 1 ? 'tip' : 'tips'}`,
        type: 'mrkdwn',
      },
      {
        text: `*Most tipped*\n${
          mostTipped
            ? `<@${mostTipped.provider_user_id}> · ${formatCurrencyAmount(formatAmount(Number(mostTipped.amount)), 'USD')}`
            : 'None yet'
        }`,
        type: 'mrkdwn',
      },
    ]

    const recentLines = recent.map((row) => {
      const token = Tempo.getTokenMetadataFallback(row.token_address)
      const amount = formatCurrencyAmount(formatAmount(Number(row.amount)), token.currency)
      const direction = row.sender_provider_user_id === input.slackUserId ? '→' : '←'
      const counterparty =
        row.sender_provider_user_id === input.slackUserId
          ? `<@${row.recipient_provider_user_id}>`
          : `<@${row.sender_provider_user_id}>`
      const memo = row.memo
        ? ` _${(() => {
            // Escape Slack mrkdwn control characters and cap memo length for section limits.
            const escaped = row.memo.replace(/[<>&]/g, (char) =>
              char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&amp;',
            )
            if (escaped.length <= 120) return escaped
            return `${escaped.slice(0, 119)}…`
          })()}_`
        : ''
      const status = row.failed_at ? ' · failed' : row.confirmed_at ? '' : ' · pending'
      const receipt = row.transaction_hash
        ? ` · <${Tempo.formatTxLink(row.chain_id, row.transaction_hash)}|receipt>`
        : ''
      const timestamp = (() => {
        // Render compact relative timestamps for the activity list.
        const diffMs = Date.now() - new Date(row.created_at).getTime()
        const minuteMs = 60 * 1000 // 1 minute
        const hourMs = 60 * 60 * 1000 // 1 hour
        const dayMs = 24 * 60 * 60 * 1000 // 1 day
        if (diffMs < minuteMs) return 'just now'
        if (diffMs < hourMs) return `${Math.floor(diffMs / minuteMs)}m ago`
        if (diffMs < dayMs) return `${Math.floor(diffMs / hourMs)}h ago`
        return `${Math.floor(diffMs / dayMs)}d ago`
      })()
      return `${direction} ${counterparty} ${amount} ${token.symbol}${memo} · ${timestamp}${status}${receipt}`
    })
    const recentText =
      recentLines.length > 0
        ? (() => {
            // Keep the recent activity section safely under Slack text limits.
            const text = recentLines.join('\n')
            if (text.length <= 2_500) return text
            return `${text.slice(0, 2_499)}…`
          })()
        : 'No tips yet.'

    const slashCommand = getSlackCommand(input.env.HOST)
    const quickReferenceFields = [
      {
        text: `*Send a tip*\n\`${slashCommand} @account [amount] [token] [for memo]\``,
        type: 'mrkdwn',
      },
      {
        text: `*Workspace leaderboard*\n\`${slashCommand} leaderboard\``,
        type: 'mrkdwn',
      },
      {
        text: `*Your stats*\n\`${slashCommand} stats\``,
        type: 'mrkdwn',
      },
      {
        text: `*Help*\n\`${slashCommand} help\``,
        type: 'mrkdwn',
      },
      {
        text: `*Tip a message*\nReact with ${reactionTipText}`,
        type: 'mrkdwn',
      },
    ]

    return {
      blocks: [
        {
          text: {
            text: `Hi <@${input.slackUserId}>!\n\n*Connected wallet:* <${explorerUrl}|${member.account_address}>`,
            type: 'mrkdwn',
          },
          type: 'section',
        },
        {
          elements: [
            {
              style: 'primary',
              text: { emoji: true, text: 'Open wallet', type: 'plain_text' },
              type: 'button',
              url: 'https://wallet.tempo.xyz/',
            },
          ],
          type: 'actions',
        },
        { type: 'divider' },
        {
          text: { emoji: true, text: 'Balances', type: 'plain_text' },
          type: 'header',
        },
        ...(balanceFields.length > 0
          ? (() => {
              // Split balance fields into Slack's two-column field sections.
              return Array.from({ length: Math.ceil(balanceFields.length / 2) }, (_, index) => ({
                fields: balanceFields.slice(index * 2, index * 2 + 2),
                type: 'section',
              }))
            })()
          : [
              {
                text: {
                  text: `No balances yet. Run \`${slashCommand} connect\` to add funds.`,
                  type: 'mrkdwn',
                },
                type: 'section',
              },
            ]),
        { type: 'divider' },
        {
          text: { emoji: true, text: 'Stats', type: 'plain_text' },
          type: 'header',
        },
        ...(() => {
          // Split stat fields into Slack's two-column field sections.
          return Array.from({ length: Math.ceil(statsFields.length / 2) }, (_, index) => ({
            fields: statsFields.slice(index * 2, index * 2 + 2),
            type: 'section',
          }))
        })(),
        { type: 'divider' },
        {
          text: { emoji: true, text: 'Recent activity', type: 'plain_text' },
          type: 'header',
        },
        { text: { text: recentText, type: 'mrkdwn' }, type: 'section' },
        { type: 'divider' },
        {
          text: { emoji: true, text: 'Quick reference', type: 'plain_text' },
          type: 'header',
        },
        {
          text: {
            text: 'Common commands and shortcuts.',
            type: 'mrkdwn',
          },
          type: 'section',
        },
        { fields: quickReferenceFields.slice(0, 2), type: 'section' },
        { fields: quickReferenceFields.slice(2, 4), type: 'section' },
        { fields: quickReferenceFields.slice(4), type: 'section' },
        {
          elements: [
            {
              text: `Updated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
              type: 'mrkdwn',
            },
          ],
          type: 'context',
        },
      ],
      type: 'home',
    }
  })()
}

function getSlackCommand(host: string) {
  const previewPrNumber = host.match(/^pr(\d+)\.tip\.bot$/)?.[1]
  return previewPrNumber ? `/tippr${previewPrNumber}` : '/tip'
}
