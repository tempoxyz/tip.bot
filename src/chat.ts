import * as DB from '#db/client.ts'
import type { DB as DB_gen } from '#db/types.gen.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as AccessKey from '#/lib/accessKey.ts'
import { formatAmount, formatCurrencyAmount, formatTipAmount } from '#/lib/format.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Slack from '#/lib/slack.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Tip from '#/lib/tip.ts'
import { createCloudflareState } from '#/vendor/chatStateCloudflareDO.ts'
import { createSlackAdapter } from '@chat-adapter/slack'
import * as chat from 'chat'
import { env } from 'cloudflare:workers'
import { sql } from 'kysely'
import { z } from 'zod'

let bot: chat.Chat | null = null
export function getChat() {
  if (bot) return bot
  bot = new chat.Chat({
    adapters: { slack: getSlack() },
    state: createCloudflareState({
      name: 'tipbot',
      namespace: env.CHAT_STATE,
      shardKey(threadId) {
        return threadId.split(':', 1)[0] || 'default'
      },
    }),
    userName: 'tipbot',
  })
  bot.onAction(async (event) => {
    if (event.adapter !== getSlack()) throw new Error('Provider not implemented yet.')
    const action = z.safeParse(z.enum(actionNames), event.actionId)
    if (!action.success) return
    await actions[action.data](event)
  })
  bot.onModalSubmit(async (event) => {
    if (event.adapter !== getSlack()) throw new Error('Provider not implemented yet.')
    const modalSubmit = z.enum(modalSubmitNames).safeParse(event.callbackId)
    if (!modalSubmit.success) return
    return await modalSubmits[modalSubmit.data](event)
  })
  bot.onNewMention(async (thread, message) => {
    if (thread.adapter !== getSlack()) throw new Error('Provider not implemented yet.')

    const raw = z.parse(
      z.object({
        channel: z.string().min(1),
        subtype: z.string().min(1).optional(),
        team: z.string().min(1).optional(),
        team_id: z.string().min(1).optional(),
        text: z.string(),
        thread_ts: z.string().min(1).optional(),
        ts: z.string().min(1),
        type: z.literal('app_mention'),
        user: z.string().min(1),
      }),
      message.raw,
    )
    if (raw.subtype) return

    const providerId = raw.team_id ?? raw.team
    if (!providerId) throw new Error('Slack app mention missing team id.')

    const installation = await getSlack().getInstallation(providerId)
    if (!installation?.botUserId) throw new Error('Slack app installation missing bot user id.')

    const threadTs = raw.thread_ts ?? raw.ts
    const event = { channel: thread.channel, user: message.author } satisfies TipEvent
    const context = {
      db: DB.create(env.DB),
      provider: { id: providerId, type: 'slack' },
      text: parseSlackMentionTipText(raw.text, installation.botUserId) ?? '',
    } satisfies HandlerContext

    if (isSlackIntroduceYourselfText(raw.text, installation.botUserId)) {
      await postSlackIntroduction(event, context, threadTs)
      return
    }

    if (!context.text) {
      await postInvalidUsage(event, context, { mention: true, threadTs })
      return
    }

    await handleTipText(event, context, {
      idempotencyKey: `mention:${providerId}:${raw.channel}:${raw.ts}`,
      insufficientFundsThreadTs: raw.thread_ts,
      mention: true,
      thread,
      threadTs,
    })
  })
  bot.onReaction(async (event) => {
    if (event.adapter !== getSlack()) throw new Error('Provider not implemented yet.')

    const reaction = z.parse(slackReactionEventSchema, event.raw)
    if (reaction.type !== 'reaction_added') return
    if (reaction.item.type !== 'message') return
    if (reaction.item.channel.startsWith('D')) return

    const context = await (async () => {
      const db = DB.create(env.DB)
      const workspace = await db
        .selectFrom('workspace')
        .selectAll()
        .where('provider', '=', 'slack')
        .where('provider_id', '=', reaction.team_id)
        .executeTakeFirst()
      if (!workspace) return
      if (reaction.reaction !== workspace.reaction_tip_emoji) return
      return {
        db,
        provider: { id: reaction.team_id, type: 'slack' },
        workspace,
      } satisfies ReactionHandlerContext
    })()
    if (!context) return
    await handleSlackReactionTip(reaction, context)
  })
  bot.onSlashCommand('/tip', async (event) => {
    if (event.adapter !== getSlack()) throw new Error('Provider not implemented yet.')

    const context = {
      db: DB.create(env.DB),
      provider: getProvider(event),
      text: event.text.trim(),
      threadTs: z
        .object({ thread_ts: z.string().min(1).optional() })
        .passthrough()
        .parse(event.raw).thread_ts,
    } satisfies HandlerContext

    const match = context.text.match(commandPattern)
    if (match) {
      const name = z.parse(z.enum(commandNames), match[1])
      await handlers[name](event, { ...context, text: match[2]?.trim() ?? '' })
      return
    }
    await handlers.default(event, context)
  })
  return bot
}

let slack: ReturnType<typeof createSlackAdapter> | null = null
export function getSlack() {
  if (slack) return slack
  slack = createSlackAdapter({
    apiUrl: `${env.SLACK_API_URL}/`,
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    encryptionKey: env.SECRET_KEY,
    signingSecret: env.SLACK_SIGNING_SECRET,
  })
  return slack
}

const actions = {
  async config_edit(event) {
    const raw = z.parse(
      z.object({
        channel: z.object({ id: z.string().min(1) }).optional(),
        container: z.object({ channel_id: z.string().min(1).optional() }).optional(),
        team: z.object({ id: z.string().min(1) }),
      }),
      event.raw,
    )
    const workspace = await DB.create(env.DB)
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', 'slack')
      .where('provider_id', '=', raw.team.id)
      .executeTakeFirst()
    if (!workspace) return

    if (!(await canManageSlackWorkspaceSettings(raw.team.id, event.user.userId))) {
      const channelId = raw.channel?.id ?? raw.container?.channel_id
      if (channelId)
        await getChat()
          .channel(`slack:${channelId}`)
          .postEphemeral(
            event.user,
            {
              card: chat.Card({
                children: [chat.CardText('Only Slack admins can change Tipbot settings.')],
                title: 'Admin permission required',
              }),
              fallbackText:
                'Admin permission required\nOnly Slack admins can change Tipbot settings.',
            },
            { fallbackToDM: false },
          )
      else if (event.thread)
        await event.thread.postEphemeral(
          event.user,
          {
            card: chat.Card({
              children: [chat.CardText('Only Slack admins can change Tipbot settings.')],
              title: 'Admin permission required',
            }),
            fallbackText:
              'Admin permission required\nOnly Slack admins can change Tipbot settings.',
          },
          { fallbackToDM: false },
        )
      return
    }

    const tokenAddress = workspace.default_token_address ?? Tempo.addressLookup.pathUsd
    const tokenOptions = workspaceTokenOptions(workspace.chain_id)
    const tokenValue =
      tokenOptions.find((option) => option.address.toLowerCase() === tokenAddress.toLowerCase())
        ?.value ?? 'pathUSD'
    await event.openModal(
      chat.Modal({
        callbackId: 'config_edit',
        children: [
          chat.Select({
            id: 'network',
            initialOption: workspace.chain_id === Tempo.chainLookup.mainnet ? 'mainnet' : 'testnet',
            label: 'Network',
            options: [
              chat.SelectOption({ label: 'Mainnet', value: 'mainnet' }),
              chat.SelectOption({ label: 'Testnet', value: 'testnet' }),
            ],
          }),
          chat.Select({
            id: 'default_token',
            initialOption: tokenValue,
            label: 'Default token',
            options: tokenOptions.map((option) =>
              chat.SelectOption({ label: option.label, value: option.value }),
            ),
          }),
          chat.TextInput({
            id: 'default_amount',
            initialValue: formatAmount(workspace.default_amount),
            label: 'Default amount',
          }),
          chat.TextInput({
            id: 'reaction_tip_emoji',
            initialValue: workspace.reaction_tip_emoji,
            label: 'Tip reaction emoji',
          }),
        ],
        privateMetadata: JSON.stringify({ providerId: raw.team.id }),
        submitLabel: 'Save',
        title: 'Edit workspace settings',
      }),
    )
  },
  async connect_cancel(event) {
    await event.adapter.deleteMessage(event.threadId, event.messageId)
  },
  async confirm_cancel(event) {
    await event.adapter.deleteMessage(event.threadId, event.messageId)
  },
} as const satisfies Record<
  (typeof actionNames)[number],
  (event: chat.ActionEvent) => Promise<void>
>

const modalSubmits = {
  async config_edit(event) {
    const metadata = z.parse(
      z.object({
        providerId: z.string().min(1),
      }),
      JSON.parse(event.privateMetadata ?? '{}'),
    )
    if (!(await canManageSlackWorkspaceSettings(metadata.providerId, event.user.userId))) return

    const chainId = (() => {
      if (event.values.network === 'mainnet') return Tempo.chainLookup.mainnet
      if (event.values.network === 'testnet') return Tempo.chainLookup.testnet
      return null
    })()
    const tokenAddress =
      workspaceTokenOptions().find((option) => option.value === event.values.default_token)
        ?.address ?? null
    const amount = Tip.parseAmount(event.values.default_amount ?? '')
    const reactionTipEmoji = (() => {
      // Store Slack emoji names without surrounding colons for reaction event matching.
      const normalized = (event.values.reaction_tip_emoji ?? '')
        .trim()
        .replace(/^:+|:+$/g, '')
        .toLowerCase()
      if (!/^[a-z0-9_+-]+$/.test(normalized)) return null
      return normalized
    })()
    const errors: Record<string, string> = {}
    if (chainId === null) errors.network = 'Choose Mainnet or Testnet.'
    if (tokenAddress === null) errors.default_token = 'Choose a default token.'
    if (amount === null)
      errors.default_amount = 'Enter a positive amount with up to 6 decimal places. Example: 0.005'
    if (!reactionTipEmoji)
      errors.reaction_tip_emoji = 'Enter a Slack emoji name. Example: money_with_wings'
    if (chainId !== null && tokenAddress !== null && !Tempo.isAllowedToken(chainId, tokenAddress))
      errors.default_token = 'This token isn’t available on the selected network.'
    if (Object.keys(errors).length > 0) return { action: 'errors' as const, errors }
    if (amount === null || chainId === null || tokenAddress === null || !reactionTipEmoji) return

    const now = new Date().toISOString()
    await DB.create(env.DB)
      .updateTable('workspace')
      .set({
        chain_id: chainId,
        default_amount: amount,
        default_token_address: tokenAddress,
        reaction_tip_emoji: reactionTipEmoji,
        updated_at: now,
      })
      .where('provider', '=', 'slack')
      .where('provider_id', '=', metadata.providerId)
      .execute()

    const workspace = await DB.create(env.DB)
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', 'slack')
      .where('provider_id', '=', metadata.providerId)
      .executeTakeFirstOrThrow()
    if (event.relatedMessage)
      await event.relatedMessage.edit(configCard(workspace, { canEdit: true, updated: true }))
  },
} as const satisfies Record<
  (typeof modalSubmitNames)[number],
  (event: chat.ModalSubmitEvent) => Promise<chat.ModalResponse | void | undefined>
>

const handlers = {
  async config(event, ctx) {
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()
    if (!workspace) {
      await event.channel.postEphemeral(
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
        { fallbackToDM: false },
      )
      return
    }

    await postConfigEphemeral(event, ctx, workspace, {
      canEdit: await canManageSlackWorkspaceSettings(ctx.provider.id, event.user.userId),
    })
  },
  async connect(event, ctx) {
    await postConnectLink(event, ctx)
  },
  async disconnect(event, ctx) {
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()
    if (!workspace) {
      await event.channel.postEphemeral(
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
        { fallbackToDM: false },
      )
      return
    }

    const member = await ctx.db
      .selectFrom('member')
      .selectAll()
      .where('workspace_id', '=', workspace.id)
      .where('provider_user_id', '=', event.user.userId)
      .executeTakeFirst()
    if (!member?.account_id) {
      await event.channel.postEphemeral(event.user, 'No account connected.', {
        fallbackToDM: false,
      })
      return
    }

    await ctx.db.deleteFrom('access_key').where('account_id', '=', member.account_id).execute()
    await ctx.db
      .updateTable('member')
      .set({ account_id: null, updated_at: new Date().toISOString() })
      .where('id', '=', member.id)
      .execute()
    await event.channel.postEphemeral(event.user, 'Disconnected', {
      fallbackToDM: false,
    })
  },
  async help(event, ctx) {
    const installation = await getSlack().getInstallation(ctx.provider.id)
    if (!installation) return

    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()

    const commandRows = [
      ['/tip @account [amount] [token] [for memo]', 'Send payment'],
      ['/tip config', 'Manage workspace configuration'],
      ['/tip connect', 'Connect to Tipbot'],
      ['/tip disconnect', 'Disconnect from Tipbot'],
      ['/tip help', 'Show help message'],
      ['/tip leaderboard', 'Show top tippers and recipients'],
      ['/tip status', 'Check connection status'],
    ]
    const paymentExampleRows = [
      ['/tip @account', 'Send default amount'],
      ['/tip @account for coffee', 'Send default amount with memo'],
      ['/tip @account 0.005', 'Send custom amount'],
      ['/tip @account 0.005 for coffee', 'Send custom amount with memo'],
      ['/tip @account 0.005 USDC', 'Send custom token'],
      ['/tip @account 0.005 USDC for coffee', 'Send custom token with memo'],
    ]
    const mentionExampleRows = [
      ['@Tipbot @account [amount] [token] [for memo]', 'Send payment by mentioning Tipbot'],
      [
        `[emoji] :${workspace?.reaction_tip_emoji ?? 'money_with_wings'}:`,
        'Send default amount by reacting to a message',
      ],
    ]
    const body = new URLSearchParams()
    body.set('channel', event.channel.id.replace(/^slack:/, ''))
    body.set(
      'text',
      [
        commandRows.map((row) => `${row[0]} ${row[1]}`).join('\n'),
        '',
        paymentExampleRows.map((row) => `${row[0]} ${row[1]}`).join('\n'),
        '',
        mentionExampleRows.map((row) => `${row[0]} ${row[1]}`).join('\n'),
      ].join('\n'),
    )
    body.set(
      'blocks',
      JSON.stringify([
        {
          rows: [
            [slackTableCell('Command'), slackTableCell('Description')],
            ...commandRows.map((row) => [
              slackTableCell(row[0], { code: true }),
              slackTableCell(row[1]),
            ]),
          ],
          type: 'table',
        },
        {
          rows: [
            [slackTableCell(' '), slackTableCell('Description')],
            ...paymentExampleRows.map((row) => [
              slackTableCell(row[0], { code: true }),
              slackTableCell(row[1]),
            ]),
          ],
          type: 'table',
        },
        {
          rows: [
            [slackTableCell('Interaction'), slackTableCell('Description')],
            ...mentionExampleRows.map((row) => [
              slackTableCell(row[0], { code: true }),
              slackTableCell(row[1]),
            ]),
          ],
          type: 'table',
        },
      ]),
    )
    body.set('user', event.user.userId)
    const response = await getSlack().withBotToken(installation.botToken, () =>
      fetch(`${env.SLACK_API_URL}/chat.postEphemeral`, {
        body,
        headers: { authorization: `Bearer ${installation.botToken}` },
        method: 'POST',
      }),
    )
    const json = z.parse(
      z.object({
        error: z.string().optional(),
        ok: z.boolean().optional(),
      }),
      await response.json(),
    )
    if (!json.ok) throw Slack.slackApiError('chat.postEphemeral', json.error)
  },
  async leaderboard(event, ctx) {
    if (ctx.text) {
      await postInvalidUsage(event, ctx)
      return
    }
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()
    if (!workspace) {
      await event.channel.postEphemeral(
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
        { fallbackToDM: false },
      )
      return
    }

    const received = await getLeaderboardRows(ctx, {
      memberIdColumn: 'tip.recipient_member_id',
      workspaceId: workspace.id,
    })
    const sent = await getLeaderboardRows(ctx, {
      memberIdColumn: 'tip.sender_member_id',
      workspaceId: workspace.id,
    })
    if (received.length === 0 && sent.length === 0) {
      await event.channel.post('No confirmed tips yet.')
      return
    }

    const installation = await getSlack().getInstallation(ctx.provider.id)
    if (!installation) return

    const body = new URLSearchParams()
    body.set('channel', event.channel.id.replace(/^slack:/, ''))
    body.set(
      'text',
      [
        'Tips received',
        [
          'Rank Account Tips',
          ...received.map((row, index) =>
            [String(index + 1), `<@${row.providerUserId}>`, String(row.tipCount)].join(' '),
          ),
        ].join('\n'),
        '',
        'Tips sent',
        [
          'Rank Account Tips',
          ...sent.map((row, index) =>
            [String(index + 1), `<@${row.providerUserId}>`, String(row.tipCount)].join(' '),
          ),
        ].join('\n'),
      ].join('\n'),
    )
    body.set(
      'blocks',
      JSON.stringify([
        {
          text: { text: 'Tips received', type: 'mrkdwn' },
          type: 'section',
        },
        {
          rows: [
            [slackTableCell('Rank'), slackTableCell('Account'), slackTableCell('Tips')],
            ...received.map((row, index) => [
              slackTableCell(String(index + 1)),
              slackTableUserCell(row.providerUserId),
              slackTableCell(String(row.tipCount)),
            ]),
          ],
          type: 'table',
        },
        {
          text: { text: 'Tips sent', type: 'mrkdwn' },
          type: 'section',
        },
        {
          rows: [
            [slackTableCell('Rank'), slackTableCell('Account'), slackTableCell('Tips')],
            ...sent.map((row, index) => [
              slackTableCell(String(index + 1)),
              slackTableUserCell(row.providerUserId),
              slackTableCell(String(row.tipCount)),
            ]),
          ],
          type: 'table',
        },
      ]),
    )
    body.set('unfurl_links', 'false')
    body.set('unfurl_media', 'false')
    const response = await getSlack().withBotToken(installation.botToken, () =>
      fetch(`${env.SLACK_API_URL}/chat.postMessage`, {
        body,
        headers: { authorization: `Bearer ${installation.botToken}` },
        method: 'POST',
      }),
    )
    const json = z.parse(
      z.object({
        error: z.string().optional(),
        ok: z.boolean().optional(),
      }),
      await response.json(),
    )
    if (!json.ok) throw Slack.slackApiError('chat.postMessage', json.error)
  },
  async status(event, ctx) {
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()
    if (!workspace) {
      await event.channel.postEphemeral(
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
        { fallbackToDM: false },
      )
      return
    }

    const member = await ctx.db
      .selectFrom('member')
      .innerJoin('account', 'account.id', 'member.account_id')
      .select('account.address as account_address')
      .where('member.workspace_id', '=', workspace.id)
      .where('member.provider_user_id', '=', event.user.userId)
      .executeTakeFirst()
    if (!member) {
      await event.channel.postEphemeral(event.user, 'No account connected.', {
        fallbackToDM: false,
      })
      return
    }

    await event.channel.postEphemeral(event.user, `Connected as \`${member.account_address}\``, {
      fallbackToDM: false,
    })
  },
  async default(event, ctx) {
    if (!event.triggerId) {
      await event.channel.postEphemeral(event.user, 'Payment not sent. Try again.', {
        fallbackToDM: false,
      })
      return
    }
    await handleTipText(event, ctx, {
      idempotencyKey: `command:${ctx.provider.id}:${event.triggerId}`,
      insufficientFundsThreadTs: ctx.threadTs,
      threadTs: ctx.threadTs,
    })
  },
} as const satisfies Record<
  (typeof commandNames)[number] | 'default',
  (event: chat.SlashCommandEvent, ctx: HandlerContext) => Promise<void>
>

const commandNames = ['config', 'connect', 'disconnect', 'help', 'leaderboard', 'status'] as const
const commandPattern = new RegExp(`^(${commandNames.join('|')})(?:\\s+([\\s\\S]*))?$`)
const actionNames = ['config_edit', 'connect_cancel', 'confirm_cancel'] as const
const modalSubmitNames = ['config_edit'] as const
const tokenOptions = [
  { address: Tempo.addressLookup.pathUsd, label: 'PathUSD', value: 'pathUSD' },
  { address: Tempo.addressLookup.usdcE, label: 'USDC.e', value: 'USDC.e' },
  { address: Tempo.addressLookup.usdt0, label: 'USDT0', value: 'USDT0' },
  { address: Tempo.addressLookup.alphaUsd, label: 'AlphaUSD', value: 'AlphaUSD' },
  { address: Tempo.addressLookup.betaUsd, label: 'BetaUSD', value: 'BetaUSD' },
  { address: Tempo.addressLookup.thetaUsd, label: 'ThetaUSD', value: 'ThetaUSD' },
] as const
const workspaceSettingsAccountAddressAllowlist = [
  '0x00ec0495bb6d03a32d75c460ca2f2a9e53654348',
] as const

type HandlerContext = {
  db: DB.Type
  provider: ProviderContext
  text: string
  threadTs?: string
}

type ProviderContext = { id: string; type: 'slack' }

type TipEvent = {
  channel: chat.Channel
  user: chat.Author
}

type ReactionHandlerContext = {
  db: DB.Type
  provider: ProviderContext
  workspace: DB_gen.Selectable.workspace
}

type LeaderboardRow = {
  providerUserId: string
  tipCount: number
}

export const reactionTipIdempotencyPrefix = 'reaction:'

export function isReactionTipIdempotencyKey(value: string) {
  return value.startsWith(reactionTipIdempotencyPrefix)
}

const slackReactionEventSchema = z.object({
  event_id: z.string().min(1).optional(),
  event_ts: z.string().min(1),
  item: z.object({
    channel: z.string().min(1),
    ts: z.string().min(1),
    type: z.string().min(1),
  }),
  item_user: z.string().min(1).optional(),
  reaction: z.string().min(1),
  team_id: z.string().min(1),
  type: z.enum(['reaction_added', 'reaction_removed']),
  user: z.string().min(1),
})

type SlackReactionEvent = z.infer<typeof slackReactionEventSchema>

async function handleTipText(
  event: TipEvent,
  ctx: HandlerContext,
  options: {
    idempotencyKey: string
    insufficientFundsThreadTs?: string
    mention?: boolean
    thread?: chat.Thread
    threadTs?: string
  },
) {
  const parsed = Tip.parseTipText(ctx.text)
  if (!parsed) {
    await postInvalidUsage(event, ctx, { mention: options.mention, threadTs: options.threadTs })
    return
  }

  const workspace = await ctx.db
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', ctx.provider.type)
    .where('provider_id', '=', ctx.provider.id)
    .executeTakeFirst()
  const tokenAddress = parsed.token
    ? Tempo.getTokenAddress(workspace?.chain_id ?? Tempo.chainLookup.mainnet, parsed.token)
    : null
  if (parsed.token && !tokenAddress) {
    await event.channel.postEphemeral(
      event.user,
      'Payment not sent. This token is not supported on this network.',
      { fallbackToDM: false },
    )
    return
  }

  void options.thread?.startTyping('Sending payment')
  try {
    const result = await Tip.handleTipRequest(env, {
      amount: parsed.amount,
      idempotencyKey: options.idempotencyKey,
      memo: parsed.memo,
      provider: ctx.provider.type,
      providerChannelId: event.channel.id,
      providerId: ctx.provider.id,
      providerThreadId: options.threadTs,
      recipientProviderLabel: parsed.recipientProviderLabel,
      recipientProviderUserId: parsed.recipientProviderUserId,
      senderProviderUserId: event.user.userId,
      tokenAddress: tokenAddress ?? undefined,
    }).catch(
      (error) =>
        ({
          code: 'failed',
          message: error instanceof Error ? error.message : 'Command failed.',
          ok: false,
        }) satisfies Tip.TipResult,
    )

    if (result.ok && result.status === 'sent')
      await postSlackReceiptMessage(
        event,
        ctx,
        `${event.channel.mentionUser(result.senderProviderUserId)} ${result.memo ? 'sent' : 'tipped'} ${event.channel.mentionUser(result.recipientProviderUserId)} ${result.isDefaultToken ? formatCurrencyAmount(result.amount, result.tokenCurrency) : formatTipAmount(result.amount, result.tokenCurrency, result.tokenSymbol)}${result.memo ? ` for ${result.memo}` : ''}.`,
        result.chainId,
        result.transactionHash,
        undefined,
        result.feePayer === 'sender'
          ? 'Fee sponsor unavailable; fee paid from your balance.'
          : undefined,
        options.threadTs,
      )
    else if (result.ok)
      await postSlackReceiptMessage(
        event,
        ctx,
        'Payment sent.',
        result.chainId,
        result.transactionHash,
        event.user,
        result.feePayer === 'sender'
          ? 'Fee sponsor unavailable; fee paid from your balance.'
          : undefined,
        options.threadTs,
      )
    else {
      if (result.code === 'confirmation_required' && result.confirmUrl) {
        const confirmUrlLabel = result.confirmUrl.replace(/(\/confirm\/.{8}).+$/, '$1...')
        await event.channel.postEphemeral(
          event.user,
          {
            card: chat.Card({
              children: [
                chat.CardText('Tipbot needs your approval to send this payment.'),
                chat.Actions([
                  chat.LinkButton({
                    label: 'Confirm payment',
                    style: 'primary',
                    url: result.confirmUrl,
                  }),
                  chat.Button({ id: 'confirm_cancel', label: 'Cancel' }),
                ]),
                chat.CardText(
                  `Link expires in 10 minutes. <${result.confirmUrl}|${confirmUrlLabel}>`,
                  {
                    style: 'muted',
                  },
                ),
              ],
            }),
            fallbackText: `Tipbot needs your approval to send this payment.\nConfirm payment: ${result.confirmUrl}\nLink expires in 10 minutes.`,
          },
          { fallbackToDM: false },
        )
        return
      }
      if (result.code === 'sender_unconnected' || result.code === 'missing_sender_access_key') {
        await postConnectLink(event, ctx)
        return
      }
      const message = (() => {
        if (result.code === 'self_tip')
          return 'Payment not sent. Cannot send a payment to yourself.'
        if (result.code === 'recipient_unconnected')
          return `Payment not sent. ${event.channel.mentionUser(result.recipientProviderUserId ?? parsed.recipientProviderUserId)} needs to connect Tipbot before receiving payments.`
        if (result.code === 'pending') return 'Payment still sending.'
        if (result.code === 'insufficient_funds')
          return 'Payment not sent. Your wallet has insufficient funds.'
        return 'Payment failed.'
      })()
      if (result.code === 'insufficient_funds') {
        await postSlackInsufficientFunds(
          event,
          ctx,
          options.mention ? options.insufficientFundsThreadTs : options.threadTs,
        )
        return
      }
      if (
        'chainId' in result &&
        result.chainId &&
        'transactionHash' in result &&
        result.transactionHash
      )
        await postSlackReceiptMessage(
          event,
          ctx,
          message,
          result.chainId,
          result.transactionHash,
          event.user,
          undefined,
          options.threadTs,
        )
      else await event.channel.postEphemeral(event.user, message, { fallbackToDM: false })
    }
  } finally {
    // Clear Slack's assistant thread status ("Sending payment") after this request
    // finishes or hands off to confirmation.
    if (options.threadTs)
      try {
        const installation = await getSlack().getInstallation(ctx.provider.id)
        if (installation) {
          const body = new URLSearchParams()
          body.set('channel_id', event.channel.id.replace(/^slack:/, ''))
          body.set('thread_ts', options.threadTs)
          body.set('status', '')
          await fetch(`${env.SLACK_API_URL}/assistant.threads.setStatus`, {
            body,
            headers: { authorization: `Bearer ${installation.botToken}` },
            method: 'POST',
          })
        }
      } catch {
        // Best effort only. Payment/error flow must not depend on Slack assistant UI cleanup.
      }
  }
}

async function handleSlackReactionTip(event: SlackReactionEvent, context: ReactionHandlerContext) {
  const { db, provider, workspace } = context

  const installation = await getSlack().getInstallation(provider.id)
  if (!installation) return

  const conversation = await (async () => {
    const body = new URLSearchParams()
    body.set('channel', event.item.channel)
    const response = await getSlack().withBotToken(installation.botToken, () =>
      fetch(`${env.SLACK_API_URL}/conversations.info`, {
        body,
        headers: { authorization: `Bearer ${installation.botToken}` },
        method: 'POST',
      }),
    )
    const json = z.parse(
      z.object({
        channel: z
          .object({
            is_im: z.boolean().optional(),
            is_mpim: z.boolean().optional(),
          })
          .optional(),
        ok: z.boolean().optional(),
      }),
      await response.json(),
    )
    if (!json.ok) return null
    return json.channel ?? null
  })()
  if (conversation?.is_im || conversation?.is_mpim) return

  const message = await (async () => {
    const methods = ['conversations.replies', 'conversations.history'] as const
    for (const method of methods) {
      const body = new URLSearchParams()
      body.set('channel', event.item.channel)
      if (method === 'conversations.history') {
        body.set('inclusive', 'true')
        body.set('latest', event.item.ts)
      }
      body.set('limit', '1')
      if (method === 'conversations.replies') body.set('ts', event.item.ts)
      const response = await getSlack().withBotToken(installation.botToken, () =>
        fetch(`${env.SLACK_API_URL}/${method}`, {
          body,
          headers: { authorization: `Bearer ${installation.botToken}` },
          method: 'POST',
        }),
      )
      const json = z.parse(
        z.object({
          messages: z
            .array(
              z.object({
                bot_id: z.string().optional(),
                subtype: z.string().optional(),
                thread_ts: z.string().optional(),
                ts: z.string().optional(),
                user: z.string().optional(),
              }),
            )
            .optional(),
          ok: z.boolean().optional(),
        }),
        await response.json(),
      )
      if (json.ok) {
        const message = json.messages?.find((message) => message.ts === event.item.ts)
        if (message) return message
      }
    }
    return { thread_ts: event.item.ts, user: event.item_user }
  })()
  if (!message?.user) {
    await postSlackEphemeral(
      provider.id,
      event.item.channel,
      event.user,
      'Payment not sent. I could not find the message author.',
    )
    return
  }
  if (message.bot_id || message.subtype) {
    await postSlackEphemeral(
      provider.id,
      event.item.channel,
      event.user,
      'Payment not sent. Reaction tips only work on regular account messages.',
    )
    return
  }
  const recipientProviderUserId = event.item_user ?? message.user
  if (recipientProviderUserId === event.user) {
    await postSlackEphemeral(
      provider.id,
      event.item.channel,
      event.user,
      'Payment not sent. Cannot send a payment to yourself.',
    )
    return
  }

  const sender = await getConnectedSlackMember(db, workspace.id, event.user)
  if (!sender) {
    await postSlackEphemeral(
      provider.id,
      event.item.channel,
      event.user,
      'Payment not sent. Connect to Tipbot with `/tip connect` and try again.',
    )
    return
  }
  const recipient = await getConnectedSlackMember(db, workspace.id, recipientProviderUserId)
  if (!recipient) {
    await postSlackEphemeral(
      provider.id,
      event.item.channel,
      event.user,
      `Payment not sent. <@${recipientProviderUserId}> needs to connect Tipbot before receiving payments.`,
    )
    return
  }

  const existing = await db
    .selectFrom('reaction_tip')
    .select('id')
    .where('workspace_id', '=', workspace.id)
    .where('channel_id', '=', event.item.channel)
    .where('message_ts', '=', event.item.ts)
    .where('reaction', '=', event.reaction)
    .where('sender_member_id', '=', sender.memberId)
    .executeTakeFirst()
  if (existing) return

  const idempotencyKey = [
    reactionTipIdempotencyPrefix,
    workspace.id,
    event.item.channel,
    event.item.ts,
    event.reaction,
    sender.memberId,
    event.event_ts,
  ].join(':')
  const inserted = await (async () => {
    const now = new Date().toISOString()
    try {
      await db
        .insertInto('reaction_tip')
        .values({
          channel_id: event.item.channel,
          created_at: now,
          id: Nanoid.generate(),
          idempotency_key: idempotencyKey,
          message_ts: event.item.ts,
          reaction: event.reaction,
          recipient_member_id: recipient.memberId,
          sender_member_id: sender.memberId,
          thread_ts: message.thread_ts ?? event.item.ts,
          tip_id: null,
          updated_at: now,
          workspace_id: workspace.id,
        })
        .execute()
      return true
    } catch (error) {
      if (isUniqueConstraintError(error)) return false
      throw error
    }
  })()
  if (!inserted) return

  const result = await Tip.handleTipRequest(env, {
    idempotencyKey,
    memo: null,
    provider: provider.type,
    providerChannelId: event.item.channel,
    providerId: provider.id,
    recipientProviderUserId: recipient.providerUserId,
    senderProviderUserId: sender.providerUserId,
  }).catch(
    (error) =>
      ({
        code: 'failed',
        message: error instanceof Error ? error.message : 'Reaction tip failed.',
        ok: false,
      }) satisfies Tip.TipResult,
  )

  if (result.ok) {
    const tip = await db
      .selectFrom('tip')
      .select('id')
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst()
    if (!tip) return

    await db
      .updateTable('reaction_tip')
      .set({ tip_id: tip.id, updated_at: new Date().toISOString() })
      .where('idempotency_key', '=', idempotencyKey)
      .execute()
    await updateReactionTipAggregate(provider.id, {
      channelId: event.item.channel,
      messageTs: event.item.ts,
      reaction: event.reaction,
      workspaceId: workspace.id,
    }).catch((error) => {
      console.error('Failed to update Slack reaction tip aggregate:', error)
    })
    return
  }

  if (result.code === 'confirmation_required' && result.confirmUrl) {
    await postSlackEphemeral(
      provider.id,
      event.item.channel,
      event.user,
      `Tipbot needs your approval to send this payment. Confirm payment: ${result.confirmUrl}`,
      {
        blocks: [
          {
            text: { text: 'Tipbot needs your approval to send this payment.', type: 'mrkdwn' },
            type: 'section',
          },
          {
            elements: [
              {
                action_id: 'confirm_payment',
                style: 'primary',
                text: { text: 'Confirm payment', type: 'plain_text' },
                type: 'button',
                url: result.confirmUrl,
              },
              {
                action_id: 'confirm_cancel',
                text: { text: 'Cancel', type: 'plain_text' },
                type: 'button',
              },
            ],
            type: 'actions',
          },
        ],
      },
    )
    return
  }

  await db.deleteFrom('reaction_tip').where('idempotency_key', '=', idempotencyKey).execute()
  await postSlackEphemeral(
    provider.id,
    event.item.channel,
    event.user,
    (() => {
      if (result.code === 'insufficient_funds')
        return 'Payment not sent. Your wallet has insufficient funds. Add funds and try again.'
      if (result.code === 'pending') return 'Payment still sending.'
      return 'Payment failed.'
    })(),
  )
}

async function postSlackEphemeral(
  providerId: string,
  channelId: string,
  userId: string,
  text: string,
  options?: { blocks?: unknown[] },
) {
  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return

  const body = new URLSearchParams()
  if (options?.blocks) body.set('blocks', JSON.stringify(options.blocks))
  body.set('channel', channelId)
  body.set('text', text)
  body.set('user', userId)
  const response = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/chat.postEphemeral`, {
      body,
      headers: {
        authorization: `Bearer ${installation.botToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    }),
  )
  const json = z.parse(
    z.object({
      error: z.string().optional(),
      ok: z.boolean().optional(),
    }),
    await response.json(),
  )
  if (!json.ok) throw Slack.slackApiError('chat.postEphemeral', json.error)
}

function getProvider(event: chat.SlashCommandEvent): ProviderContext {
  const slackSlashCommandRaw = z.object({
    team_id: z.string().min(1),
  })
  const raw = z.parse(slackSlashCommandRaw, event.raw)
  return {
    id: raw.team_id,
    type: 'slack',
  }
}

//////////////////////////////////////////////////////////////////////////////////////

async function getConnectedSlackMember(db: DB.Type, workspaceId: string, providerUserId: string) {
  const member = await db
    .selectFrom('member')
    .select(['id', 'provider_user_id'])
    .where('workspace_id', '=', workspaceId)
    .where('provider_user_id', '=', providerUserId)
    .where('account_id', 'is not', null)
    .executeTakeFirst()
  if (!member) return null
  return { memberId: member.id, providerUserId: member.provider_user_id }
}

export async function updateReactionTipAggregate(
  providerId: string,
  options: { channelId: string; messageTs: string; reaction: string; workspaceId: string },
) {
  const db = DB.create(env.DB)
  const rows = await db
    .selectFrom('reaction_tip')
    .innerJoin('tip', 'tip.id', 'reaction_tip.tip_id')
    .innerJoin('member as sender', 'sender.id', 'reaction_tip.sender_member_id')
    .innerJoin('member as recipient', 'recipient.id', 'reaction_tip.recipient_member_id')
    .select([
      'reaction_tip.thread_ts',
      'recipient.provider_user_id as recipient_provider_user_id',
      'sender.provider_user_id as sender_provider_user_id',
    ])
    .where('reaction_tip.workspace_id', '=', options.workspaceId)
    .where('reaction_tip.channel_id', '=', options.channelId)
    .where('reaction_tip.message_ts', '=', options.messageTs)
    .where('reaction_tip.reaction', '=', options.reaction)
    .where('tip.confirmed_at', 'is not', null)
    .orderBy('reaction_tip.created_at', 'asc')
    .execute()
  if (rows.length === 0) return

  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return

  const text = `${(() => {
    // Keep aggregate replies short when many people tip the same message.
    const mentions = rows.map((row) => `<@${row.sender_provider_user_id}>`)
    if (mentions.length === 1) return mentions[0]
    if (mentions.length === 2) return `${mentions[0]} and ${mentions[1]}`
    if (mentions.length === 3) return `${mentions[0]}, ${mentions[1]}, and ${mentions[2]}`
    return `${mentions[0]}, ${mentions[1]}, and ${mentions.length - 2} others`
  })()} tipped <@${rows[0]!.recipient_provider_user_id}>`
  const existing = await db
    .selectFrom('reaction_tip_thread')
    .selectAll()
    .where('workspace_id', '=', options.workspaceId)
    .where('channel_id', '=', options.channelId)
    .where('message_ts', '=', options.messageTs)
    .where('reaction', '=', options.reaction)
    .executeTakeFirst()

  if (existing) {
    const body = new URLSearchParams()
    body.set('channel', options.channelId)
    body.set('text', text)
    body.set('ts', existing.reply_ts)
    const response = await getSlack().withBotToken(installation.botToken, () =>
      fetch(`${env.SLACK_API_URL}/chat.update`, {
        body,
        headers: { authorization: `Bearer ${installation.botToken}` },
        method: 'POST',
      }),
    )
    const json = z.parse(
      z.object({
        error: z.string().optional(),
        ok: z.boolean().optional(),
      }),
      await response.json(),
    )
    if (!json.ok) throw Slack.slackApiError('chat.update', json.error)
    return
  }

  const body = new URLSearchParams()
  body.set('channel', options.channelId)
  body.set('text', text)
  body.set('thread_ts', rows[0]!.thread_ts)
  body.set('unfurl_links', 'false')
  body.set('unfurl_media', 'false')
  const response = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/chat.postMessage`, {
      body,
      headers: { authorization: `Bearer ${installation.botToken}` },
      method: 'POST',
    }),
  )
  const json = z.parse(
    z.object({
      error: z.string().optional(),
      ok: z.boolean().optional(),
      ts: z.string().optional(),
    }),
    await response.json(),
  )
  if (!json.ok || !json.ts) throw Slack.slackApiError('chat.postMessage', json.error)

  const now = new Date().toISOString()
  try {
    await db
      .insertInto('reaction_tip_thread')
      .values({
        channel_id: options.channelId,
        created_at: now,
        id: Nanoid.generate(),
        message_ts: options.messageTs,
        reaction: options.reaction,
        reply_ts: json.ts,
        updated_at: now,
        workspace_id: options.workspaceId,
      })
      .execute()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /unique constraint|constraint failed/i.test(error.message)
}

function parseSlackMentionTipText(value: string, botUserId: string) {
  const botMentionPattern = new RegExp(`<@${escapeRegex(botUserId)}(?:\\|[^>]+)?>`, 'g')
  const text = value.replace(botMentionPattern, ' ').replace(/\s+/g, ' ').trim()
  const mentions = [...text.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]+)?>/g)]
  if (mentions.length !== 1) return null
  if (!text.startsWith(mentions[0]![0])) return null
  return text
}

function isSlackIntroduceYourselfText(value: string, botUserId: string) {
  const botMentionPattern = new RegExp(`<@${escapeRegex(botUserId)}(?:\\|[^>]+)?>`, 'g')
  return (
    value.replace(botMentionPattern, ' ').replace(/\s+/g, ' ').trim().toLowerCase() ===
    'introduce yourself'
  )
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function getLeaderboardRows(
  ctx: HandlerContext,
  options: {
    memberIdColumn: 'tip.recipient_member_id' | 'tip.sender_member_id'
    workspaceId: string
  },
) {
  const rows = await ctx.db
    .selectFrom('tip')
    .innerJoin('member', 'member.id', options.memberIdColumn)
    .select(['member.provider_user_id', sql<number>`count("tip"."id")`.as('tip_count')])
    .where('tip.workspace_id', '=', options.workspaceId)
    .where('tip.confirmed_at', 'is not', null)
    .groupBy(['member.id', 'member.provider_user_id'])
    .orderBy('tip_count', 'desc')
    .orderBy('member.provider_user_id', 'asc')
    .limit(10)
    .execute()

  return rows.map(
    (row) =>
      ({
        providerUserId: row.provider_user_id,
        tipCount: Number(row.tip_count),
      }) satisfies LeaderboardRow,
  )
}

async function postInvalidUsage(
  event: TipEvent,
  ctx: HandlerContext,
  options: { mention?: boolean; threadTs?: string } = {},
) {
  const installation = await getSlack().getInstallation(ctx.provider.id)
  if (!installation) throw new Error('Tibot app not installed for this workspace.')

  const body = new URLSearchParams()
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set(
    'text',
    options.mention
      ? 'Invalid `@Tipbot` usage. Try `@Tipbot @account [amount] [token] [for memo]`.'
      : 'Invalid `/tip` usage. Try `/tip @account` or `/tip help` for more info.',
  )
  if (options.threadTs) body.set('thread_ts', options.threadTs)
  body.set('user', event.user.userId)
  const response = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/chat.postEphemeral`, {
      body,
      headers: { authorization: `Bearer ${installation.botToken}` },
      method: 'POST',
    }),
  )
  const json = z.parse(
    z.object({
      error: z.string().optional(),
      ok: z.boolean().optional(),
    }),
    await response.json(),
  )
  if (!json.ok) throw Slack.slackApiError('chat.postEphemeral', json.error)
}

async function postSlackIntroduction(event: TipEvent, ctx: HandlerContext, threadTs: string) {
  const installation = await getSlack().getInstallation(ctx.provider.id)
  if (!installation) throw new Error('Tibot app not installed for this workspace.')

  const text =
    'I’m Tipbot: sometime tipper, sometime messenger, always bot.\n' +
    'Connect with `/tip connect`, then send stablecoins with `@Tipbot @account for coffee`, `/tip @account for coffee`, or a 💸 reaction.'
  const body = new URLSearchParams()
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set('text', text)
  body.set('thread_ts', threadTs)
  body.set('unfurl_links', 'false')
  body.set('unfurl_media', 'false')
  const response = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/chat.postMessage`, {
      body,
      headers: { authorization: `Bearer ${installation.botToken}` },
      method: 'POST',
    }),
  )
  const json = z.parse(
    z.object({
      error: z.string().optional(),
      ok: z.boolean().optional(),
    }),
    await response.json(),
  )
  if (!json.ok) throw Slack.slackApiError('chat.postMessage', json.error)
}

async function postSlackInsufficientFunds(event: TipEvent, ctx: HandlerContext, threadTs?: string) {
  const installation = await getSlack().getInstallation(ctx.provider.id)
  if (!installation) throw new Error('Tibot app not installed for this workspace.')

  const message = 'Payment not sent. Your wallet has insufficient funds.'
  const body = new URLSearchParams()
  body.set(
    'blocks',
    JSON.stringify([
      {
        text: { text: message, type: 'mrkdwn' },
        type: 'section',
      },
      {
        elements: [
          {
            action_id: 'add_funds',
            style: 'primary',
            text: { text: 'Add funds', type: 'plain_text' },
            type: 'button',
            url: 'https://wallet.tempo.xyz',
          },
          {
            action_id: 'connect_cancel',
            text: { text: 'Cancel', type: 'plain_text' },
            type: 'button',
          },
        ],
        type: 'actions',
      },
      {
        elements: [{ text: 'Add funds on https://wallet.tempo.xyz', type: 'mrkdwn' }],
        type: 'context',
      },
    ]),
  )
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set('text', message)
  if (threadTs) body.set('thread_ts', threadTs)
  body.set('user', event.user.userId)
  const response = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/chat.postEphemeral`, {
      body,
      headers: { authorization: `Bearer ${installation.botToken}` },
      method: 'POST',
    }),
  )
  const json = z.parse(
    z.object({
      error: z.string().optional(),
      ok: z.boolean().optional(),
    }),
    await response.json(),
  )
  if (!json.ok) throw Slack.slackApiError('chat.postEphemeral', json.error)
}

async function postConnectLink(event: TipEvent, ctx: HandlerContext) {
  const workspace = await ctx.db
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', ctx.provider.type)
    .where('provider_id', '=', ctx.provider.id)
    .executeTakeFirst()
  if (!workspace) {
    await event.channel.postEphemeral(
      event.user,
      'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
      { fallbackToDM: false },
    )
    return
  }

  let member = await ctx.db
    .selectFrom('member')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .where('provider_user_id', '=', event.user.userId)
    .executeTakeFirst()
  if (!member) {
    const id = Nanoid.generate()
    const createdAt = new Date().toISOString()
    await ctx.db
      .insertInto('member')
      .values({
        account_id: null,
        created_at: createdAt,
        id,
        login: null,
        name: null,
        provider_user_id: event.user.userId,
        updated_at: createdAt,
        workspace_id: workspace.id,
      })
      .execute()
    member = await ctx.db
      .selectFrom('member')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  if (member.account_id) {
    const accessKeys = await ctx.db
      .selectFrom('access_key')
      .select(['id', 'token_address'])
      .where('account_id', '=', member.account_id)
      .where('chain_id', '=', workspace.chain_id)
      .where('expires_at', '>', new Date().toISOString())
      .where('revoked_at', 'is', null)
      .execute()
    const accessKey = accessKeys.find(
      (row) =>
        !row.token_address ||
        row.token_address.toLowerCase() ===
          (workspace.default_token_address ?? Tempo.addressLookup.pathUsd).toLowerCase(),
    )
    if (accessKey) {
      await event.channel.postEphemeral(event.user, 'Already connected', { fallbackToDM: false })
      return
    }
  }

  const now = new Date()
  const token = Nanoid.generate()
  const accessKey = AccessKey.generate()
  const linkButtonLabel = member.account_id ? 'Refresh connection' : 'Connect to Tipbot'
  const linkDescription = 'Link expires in 10 minutes.'
  const linkUrl = `https://${env.HOST}/connect/${token}`
  const linkText = `${member.account_id ? 'Refresh Tipbot connection' : 'Connect to Tipbot'}: ${linkUrl}\n${linkDescription}`
  const linkExpiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString() // 10 minutes
  const accessKeyExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
  await ctx.db
    .deleteFrom('account_link_token')
    .where('member_id', '=', member.id)
    .where('used_at', 'is', null)
    .execute()
  await ctx.db
    .insertInto('account_link_token')
    .values({
      access_key_address: accessKey.address,
      access_key_authorization: null,
      access_key_ciphertext: await AccessKey.encrypt(env, accessKey.privateKey),
      access_key_expires_at: accessKeyExpiresAt,
      access_key_public_key: accessKey.publicKey,
      account_id: null,
      created_at: now.toISOString(),
      expires_at: linkExpiresAt,
      id: Nanoid.generate(),
      member_id: member.id,
      provider_channel_id: event.channel.id,
      token_hash: await AccountLink.hashToken(env, token),
      used_at: null,
    })
    .execute()

  await event.channel.postEphemeral(
    event.user,
    {
      card: chat.Card({
        children: [
          chat.Actions([
            chat.LinkButton({ label: linkButtonLabel, style: 'primary', url: linkUrl }),
            chat.Button({ id: 'connect_cancel', label: 'Cancel' }),
          ]),
          chat.CardText(`${linkDescription} ${linkUrl}`, { style: 'muted' }),
        ],
      }),
      fallbackText: linkText,
    },
    { fallbackToDM: false },
  )
}

async function postSlackReceiptMessage(
  event: TipEvent,
  ctx: HandlerContext,
  text: string,
  chainId: number,
  transactionHash: string,
  user?: chat.Author,
  context?: string,
  threadTs?: string,
) {
  const installation = await getSlack().getInstallation(ctx.provider.id)
  if (!installation) throw new Error('Tibot app not installed for this workspace.')

  const receiptText = text.replace(/\.$/, '')
  const body = new URLSearchParams()
  body.set(
    'blocks',
    JSON.stringify(createReceiptBlocks(receiptText, chainId, transactionHash, context)),
  )
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set('text', `${receiptText}${context ? ` ${context}` : ''} Receipt`)
  if (threadTs) body.set('thread_ts', threadTs)
  if (user) body.set('user', user.userId)
  else {
    body.set('unfurl_links', 'false')
    body.set('unfurl_media', 'false')
  }
  const response = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/${user ? 'chat.postEphemeral' : 'chat.postMessage'}`, {
      body,
      headers: { authorization: `Bearer ${installation.botToken}` },
      method: 'POST',
    }),
  )
  const json = z.parse(
    z.object({
      error: z.string().optional(),
      ok: z.boolean().optional(),
    }),
    await response.json(),
  )
  if (!json.ok) throw Slack.slackApiError('chat.postMessage', json.error)
}

function createReceiptBlocks(
  text: string,
  chainId: number,
  transactionHash: string,
  context?: string,
) {
  return [
    {
      text: {
        text: `${text} <${Tempo.formatTxLink(chainId, transactionHash)}|Receipt>`,
        type: 'mrkdwn',
      },
      type: 'section',
    },
    ...(context
      ? [
          {
            elements: [{ text: context, type: 'mrkdwn' }],
            type: 'context',
          },
        ]
      : []),
  ]
}

async function isSlackAdmin(providerId: string, providerUserId: string) {
  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return false

  const body = new URLSearchParams()
  body.set('user', providerUserId)
  const response = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/users.info`, {
      body,
      headers: { authorization: `Bearer ${installation.botToken}` },
      method: 'POST',
    }),
  )
  const info = z.parse(
    z.object({
      ok: z.boolean().optional(),
      user: z
        .object({
          is_admin: z.boolean().optional(),
          is_owner: z.boolean().optional(),
        })
        .optional(),
    }),
    await response.json(),
  )
  return Boolean(info.ok && (info.user?.is_admin || info.user?.is_owner))
}

async function canManageSlackWorkspaceSettings(providerId: string, providerUserId: string) {
  if (await isSlackAdmin(providerId, providerUserId)) return true

  const member = await DB.create(env.DB)
    .selectFrom('workspace')
    .innerJoin('member', 'member.workspace_id', 'workspace.id')
    .innerJoin('account', 'account.id', 'member.account_id')
    .select('member.id')
    .where('workspace.provider', '=', 'slack')
    .where('workspace.provider_id', '=', providerId)
    .where('member.provider_user_id', '=', providerUserId)
    .where(sql<string>`lower("account"."address")`, 'in', workspaceSettingsAccountAddressAllowlist)
    .executeTakeFirst()
  return Boolean(member)
}

function configCard(
  workspace: DB_gen.Selectable.workspace,
  options?: { canEdit?: boolean; updated?: boolean },
) {
  const tokenAddress = workspace.default_token_address ?? Tempo.addressLookup.pathUsd
  const token = Tempo.getTokenMetadataFallback(tokenAddress)
  const networkLabel = workspace.chain_id === Tempo.chainLookup.mainnet ? 'Mainnet' : 'Testnet'
  return {
    card: chat.Card({
      children: [
        chat.Table({
          headers: ['Setting', 'Value'],
          rows: [
            ['Network', networkLabel],
            ['Default token', token.symbol],
            ['Default amount', formatAmount(workspace.default_amount)],
            ['Reaction', `💸 \`:${workspace.reaction_tip_emoji}:\``],
          ],
        }),
        ...(options?.canEdit
          ? [
              chat.Actions([
                chat.Button({
                  actionType: 'modal',
                  id: 'config_edit',
                  label: 'Edit settings',
                  style: 'primary',
                }),
              ]),
            ]
          : []),
        ...(options?.updated ? [chat.CardText('Workspace settings updated')] : []),
      ],
    }),
    fallbackText: `Network ${networkLabel}\nDefault token ${token.symbol} ${Tempo.explorerLink(workspace.chain_id, tokenAddress)}\nDefault amount ${formatAmount(workspace.default_amount)}\nReaction 💸 \`:${workspace.reaction_tip_emoji}:\`${options?.updated ? '\nWorkspace settings updated' : ''}`,
  }
}

async function postConfigEphemeral(
  event: chat.SlashCommandEvent,
  ctx: HandlerContext,
  workspace: DB_gen.Selectable.workspace,
  options?: { canEdit?: boolean },
) {
  const installation = await getSlack().getInstallation(ctx.provider.id)
  if (!installation) return

  const body = new URLSearchParams()
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set('text', configFallbackText(workspace))
  body.set(
    'blocks',
    JSON.stringify([
      {
        rows: [
          [slackTableCell('Setting'), slackTableCell('Value')],
          [slackTableCell('Network'), slackTableCell(configNetworkLabel(workspace))],
          [slackTableCell('Default token'), slackTableCell(configToken(workspace).symbol)],
          [
            slackTableCell('Default amount'),
            slackTableCell(formatAmount(workspace.default_amount)),
          ],
          [slackTableCell('Reaction'), slackTableReactionCell(workspace.reaction_tip_emoji)],
        ],
        type: 'table',
      },
      ...(options?.canEdit
        ? [
            {
              elements: [
                {
                  action_id: 'config_edit',
                  text: { text: 'Edit settings', type: 'plain_text' },
                  type: 'button',
                },
              ],
              type: 'actions',
            },
          ]
        : []),
    ]),
  )
  body.set('user', event.user.userId)
  const response = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/chat.postEphemeral`, {
      body,
      headers: { authorization: `Bearer ${installation.botToken}` },
      method: 'POST',
    }),
  )
  const json = z.parse(
    z.object({
      error: z.string().optional(),
      ok: z.boolean().optional(),
    }),
    await response.json(),
  )
  if (!json.ok) throw Slack.slackApiError('chat.postEphemeral', json.error)
}

function configFallbackText(
  workspace: DB_gen.Selectable.workspace,
  options?: { updated?: boolean },
) {
  const tokenAddress = workspace.default_token_address ?? Tempo.addressLookup.pathUsd
  return `Setting Value\nNetwork ${configNetworkLabel(workspace)}\nDefault token ${configToken(workspace).symbol} ${Tempo.explorerLink(workspace.chain_id, tokenAddress)}\nDefault amount ${formatAmount(workspace.default_amount)}\nReaction 💸 \`:${workspace.reaction_tip_emoji}:\`${options?.updated ? '\nWorkspace settings updated' : ''}`
}

function configNetworkLabel(workspace: DB_gen.Selectable.workspace) {
  return workspace.chain_id === Tempo.chainLookup.mainnet ? 'Mainnet' : 'Testnet'
}

function configToken(workspace: DB_gen.Selectable.workspace) {
  return Tempo.getTokenMetadataFallback(
    workspace.default_token_address ?? Tempo.addressLookup.pathUsd,
  )
}

function workspaceTokenOptions(chainId?: number) {
  if (chainId === undefined) return tokenOptions
  return tokenOptions.filter((option) => Tempo.isAllowedToken(chainId, option.address))
}

function slackTableCell(text: string, style?: { code?: boolean }) {
  return {
    elements: [
      {
        elements: [style ? { style, text, type: 'text' } : { text, type: 'text' }],
        type: 'rich_text_section',
      },
    ],
    type: 'rich_text',
  }
}

function slackTableReactionCell(emojiName: string) {
  return slackTableRichCell([
    { name: emojiName, type: 'emoji' },
    { text: ' ', type: 'text' },
    { style: { code: true }, text: `:${emojiName}:`, type: 'text' },
  ])
}

function slackTableRichCell(elements: unknown[]) {
  return {
    elements: [
      {
        elements,
        type: 'rich_text_section',
      },
    ],
    type: 'rich_text',
  }
}

function slackTableUserCell(providerUserId: string) {
  return {
    elements: [
      {
        elements: [{ type: 'user', user_id: providerUserId }],
        type: 'rich_text_section',
      },
    ],
    type: 'rich_text',
  }
}
