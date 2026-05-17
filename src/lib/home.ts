import * as DB from '#db/client.ts'
import type { DB as DB_gen } from '#db/types.gen.ts'
import { getSlackCommand } from '#/lib/app.ts'
import { formatAmount, formatCurrencyAmount } from '#/lib/format.ts'
import { getChat, getSlack } from '#/chat.ts'
import * as Tempo from '#/lib/tempo.ts'
import { sql } from 'kysely'
import { Address } from 'ox'
import { createClient, http } from 'viem'
import { Actions } from 'viem/tempo'

const balanceLookupTimeoutMs = 1_500 // 1.5 seconds
const recentTipLimit = 10
const tokenLookup = [
  { address: Tempo.addressLookup.pathUsd, label: 'PathUSD' },
  { address: Tempo.addressLookup.usdcE, label: 'USDC.e' },
  { address: Tempo.addressLookup.usdt0, label: 'USDT0' },
  { address: Tempo.addressLookup.alphaUsd, label: 'AlphaUSD' },
  { address: Tempo.addressLookup.betaUsd, label: 'BetaUSD' },
  { address: Tempo.addressLookup.thetaUsd, label: 'ThetaUSD' },
] as const

export async function publishHome(input: { env: Env; slackUserId: string; teamId: string }) {
  await getChat().initialize()
  const installation = await getSlack().getInstallation(input.teamId)
  if (!installation) {
    console.warn('publishHome: no installation', { teamId: input.teamId })
    return
  }

  const view = await buildHomeView({
    env: input.env,
    slackUserId: input.slackUserId,
    teamId: input.teamId,
  })
  await getSlack().withBotToken(installation.botToken, () =>
    getSlack().publishHomeView(input.slackUserId, view),
  )
  console.log('publishHome: published', {
    slackUserId: input.slackUserId,
    teamId: input.teamId,
  })
}

export async function buildHomeView(input: {
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
  if (!workspace) return workspaceMissingView(input.slackUserId)

  const member = await db
    .selectFrom('member')
    .leftJoin('account', 'account.id', 'member.account_id')
    .select(['member.id as id', 'account.address as account_address'])
    .where('member.workspace_id', '=', workspace.id)
    .where('member.provider_user_id', '=', input.slackUserId)
    .executeTakeFirst()
  if (!member?.account_address) return notConnectedView(workspace, input.slackUserId)

  const [balances, received, sent, mostTipped, mostTippedBy, recent] = await Promise.all([
    fetchBalances({ accountAddress: member.account_address, env: input.env, workspace }),
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
      .limit(recentTipLimit)
      .execute(),
  ])

  return connectedView({
    accountAddress: member.account_address,
    balances,
    env: input.env,
    mostTipped,
    mostTippedBy,
    received,
    recent,
    sent,
    slackUserId: input.slackUserId,
    workspace,
  })
}

function connectedView(input: {
  accountAddress: string
  balances: Array<{ address: string; balance: bigint; label: string }>
  env: Env
  mostTipped: { amount: number; provider_user_id: string; tip_count: number } | undefined
  mostTippedBy: { amount: number; provider_user_id: string; tip_count: number } | undefined
  received: { amount: number; tip_count: number }
  recent: Array<{
    amount: number
    chain_id: number
    confirmed_at: string | null
    created_at: string
    failed_at: string | null
    memo: string | null
    recipient_provider_user_id: string
    sender_provider_user_id: string
    token_address: string
    transaction_hash: string | null
  }>
  sent: { amount: number; tip_count: number }
  slackUserId: string
  workspace: DB_gen.workspace
}) {
  const explorerUrl = Tempo.explorerLink(input.workspace.chain_id, input.accountAddress)
  const truncatedAddress = `${input.accountAddress.slice(0, 6)}…${input.accountAddress.slice(-4)}`
  const networkLabel =
    input.workspace.chain_id === Tempo.chainLookup.mainnet ? 'Mainnet' : 'Testnet'

  const balanceLines = input.balances.map((b) => {
    const formatted = formatCurrencyAmount(formatAmount(Number(b.balance)), 'USD')
    return `*${b.label}* ${formatted}`
  })
  const balancesText =
    balanceLines.length > 0
      ? balanceLines.join('  ·  ')
      : 'No balances yet. Run `/tip connect` to add funds.'

  const statsText = [
    `*Received* ${formatCurrencyAmount(formatAmount(Number(input.received.amount)), 'USD')} (${pluralizeTips(Number(input.received.tip_count))})`,
    `*Tipped* ${formatCurrencyAmount(formatAmount(Number(input.sent.amount)), 'USD')} (${pluralizeTips(Number(input.sent.tip_count))})`,
    `*Most tipped* ${
      input.mostTipped
        ? `<@${input.mostTipped.provider_user_id}> ${formatCurrencyAmount(formatAmount(Number(input.mostTipped.amount)), 'USD')} (${pluralizeTips(Number(input.mostTipped.tip_count))})`
        : 'None'
    }`,
    `*Most tipped by* ${
      input.mostTippedBy
        ? `<@${input.mostTippedBy.provider_user_id}> ${formatCurrencyAmount(formatAmount(Number(input.mostTippedBy.amount)), 'USD')} (${pluralizeTips(Number(input.mostTippedBy.tip_count))})`
        : 'None'
    }`,
  ].join('\n')

  const recentLines = input.recent.map((row) => {
    const token = Tempo.getTokenMetadataFallback(row.token_address)
    const amount = formatCurrencyAmount(formatAmount(Number(row.amount)), token.currency)
    const direction = row.sender_provider_user_id === input.slackUserId ? '→' : '←'
    const counterparty =
      row.sender_provider_user_id === input.slackUserId
        ? `<@${row.recipient_provider_user_id}>`
        : `<@${row.sender_provider_user_id}>`
    const memo = row.memo ? ` _${escapeMrkdwn(row.memo)}_` : ''
    const status = row.failed_at ? ' · failed' : row.confirmed_at ? '' : ' · pending'
    const receipt = row.transaction_hash
      ? ` · <${Tempo.formatTxLink(row.chain_id, row.transaction_hash)}|receipt>`
      : ''
    return `${direction} ${counterparty} ${amount} ${token.symbol}${memo} · ${relativeTime(row.created_at)}${status}${receipt}`
  })
  const recentText = recentLines.length > 0 ? recentLines.join('\n') : 'No tips yet.'

  const slashCommand = getSlackCommand(input.env.HOST)
  const helpLines = [
    `\`${slashCommand} @account [amount] [token] [for memo]\` send a tip`,
    `\`${slashCommand} leaderboard\` workspace leaderboard`,
    `\`${slashCommand} stats\` your tip stats`,
    `React with :${input.workspace.reaction_tip_emoji}: to tip a message`,
  ]

  return {
    blocks: [
      {
        text: { emoji: true, text: 'Tipbot', type: 'plain_text' },
        type: 'header',
      },
      {
        text: {
          text: `Hi <@${input.slackUserId}> · *${networkLabel}* · <${explorerUrl}|${truncatedAddress}>`,
          type: 'mrkdwn',
        },
        type: 'section',
      },
      { type: 'divider' },
      {
        text: { emoji: true, text: 'Balances', type: 'plain_text' },
        type: 'header',
      },
      { text: { text: balancesText, type: 'mrkdwn' }, type: 'section' },
      { type: 'divider' },
      {
        text: { emoji: true, text: 'Your stats', type: 'plain_text' },
        type: 'header',
      },
      { text: { text: statsText, type: 'mrkdwn' }, type: 'section' },
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
      { text: { text: helpLines.join('\n'), type: 'mrkdwn' }, type: 'section' },
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
}

function notConnectedView(workspace: DB_gen.workspace, slackUserId: string) {
  const networkLabel = workspace.chain_id === Tempo.chainLookup.mainnet ? 'Mainnet' : 'Testnet'
  return {
    blocks: [
      {
        text: { emoji: true, text: 'Tipbot', type: 'plain_text' },
        type: 'header',
      },
      {
        text: {
          text: `Hi <@${slackUserId}>! You haven't connected an account yet.`,
          type: 'mrkdwn',
        },
        type: 'section',
      },
      {
        text: {
          text: 'Run `/tip connect` in any channel to link a wallet. Then come back here to see balances, stats, and recent tips.',
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
          text: `*Network* ${networkLabel}\n*Default amount* ${formatAmount(workspace.default_amount)}\n*Tip reaction* :${workspace.reaction_tip_emoji}:`,
          type: 'mrkdwn',
        },
        type: 'section',
      },
    ],
    type: 'home',
  }
}

function workspaceMissingView(slackUserId: string) {
  return {
    blocks: [
      {
        text: { emoji: true, text: 'Tipbot', type: 'plain_text' },
        type: 'header',
      },
      {
        text: {
          text: `Hi <@${slackUserId}>! Tipbot isn't installed in this workspace yet. Ask an admin to install it.`,
          type: 'mrkdwn',
        },
        type: 'section',
      },
    ],
    type: 'home',
  }
}

async function fetchBalances(input: {
  accountAddress: string
  env: Env
  workspace: DB_gen.workspace
}) {
  const tokens = tokenLookup.filter((token) =>
    Tempo.isAllowedToken(input.workspace.chain_id, token.address),
  )
  const client = createClient({
    chain: Tempo.getChain(input.workspace.chain_id),
    transport: http(Tempo.getRpcUrl(input.env, input.workspace.chain_id), {
      retryCount: 0,
      timeout: balanceLookupTimeoutMs,
    }),
  })
  return await Promise.all(
    tokens.map(async (token) => {
      try {
        const balance = await Actions.token.getBalance(client, {
          account: input.accountAddress as Address.Address,
          token: token.address as Address.Address,
        })
        return { address: token.address, balance, label: token.label }
      } catch {
        return { address: token.address, balance: 0n, label: token.label }
      }
    }),
  )
}

function pluralizeTips(count: number) {
  return `${count} ${count === 1 ? 'tip' : 'tips'}`
}

function escapeMrkdwn(value: string) {
  return value.replace(/[<>&]/g, (char) =>
    char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&amp;',
  )
}

function relativeTime(isoString: string) {
  const diffMs = Date.now() - new Date(isoString).getTime()
  const minuteMs = 60 * 1000 // 1 minute
  const hourMs = 60 * 60 * 1000 // 1 hour
  const dayMs = 24 * 60 * 60 * 1000 // 1 day
  if (diffMs < minuteMs) return 'just now'
  if (diffMs < hourMs) return `${Math.floor(diffMs / minuteMs)}m ago`
  if (diffMs < dayMs) return `${Math.floor(diffMs / hourMs)}h ago`
  return `${Math.floor(diffMs / dayMs)}d ago`
}
