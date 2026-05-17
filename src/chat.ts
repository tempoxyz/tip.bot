import * as DB from '#db/client.ts'
import type { DB as DB_gen } from '#db/types.gen.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as AccessKey from '#/lib/accessKey.ts'
import { getSlackBotDisplayName, getSlackCommand } from '#/lib/app.ts'
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
import { Address } from 'ox'
import { createClient, http } from 'viem'
import { Actions } from 'viem/tempo'
import { z } from 'zod'

const creaturePattern =
  /\b(creature|creatures|dragon|dragons|elf|elves|fae|fairy|goblin|goblins|gnome|gnomes|gremlin|gremlins|kobold|kobolds|monster|monsters|orc|orcs|troll|trolls)\b/i

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
    const mentionText = normalizeSlackMentionText(raw.text, installation.botUserId)
    const context = {
      db: DB.create(env.DB),
      provider: { id: providerId, type: 'slack' },
      text: parseSlackMentionTipText(mentionText) ?? '',
    } satisfies HandlerContext

    if (isSlackIntroduceYourselfText(mentionText)) {
      await postSlackIntroduction(event, context, threadTs)
      return
    }

    if (!context.text) {
      if (isSlackSelfMentionChatter(raw.text, installation.botUserId, mentionText)) return
      await postInvalidMentionReply(event, context, mentionText, threadTs)
      return
    }

    await handleTipText(event, context, {
      idempotencyKey: `mention:${providerId}:${raw.channel}:${raw.ts}`,
      insufficientFundsThreadTs: raw.thread_ts,
      mention: true,
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
  bot.onSlashCommand(getSlackCommand(env.HOST), async (event) => {
    if (event.adapter !== getSlack()) throw new Error('Provider not implemented yet.')

    const context = {
      db: DB.create(env.DB),
      provider: getProvider(event),
      text: event.text.trim(),
      threadTs: z.looseObject({ thread_ts: z.string().min(1).optional() }).parse(event.raw)
        .thread_ts,
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
  async balance(event, ctx) {
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
      await postPrivateReply(
        event,
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
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
      await postPrivateReply(event, event.user, 'No account connected. Run `/tip connect` first.')
      return
    }

    const client = createClient({
      chain: Tempo.getChain(workspace.chain_id),
      transport: http(Tempo.getRpcUrl(env, workspace.chain_id)),
    })
    const tokens = workspaceTokenOptions(workspace.chain_id)
    const balances = await Promise.all(
      tokens.map(async (token) => {
        try {
          const balance = await Actions.token.getBalance(client, {
            account: member.account_address as Address.Address,
            token: token.address as Address.Address,
          })
          return { balance, label: token.label }
        } catch {
          return { balance: 0n, label: token.label }
        }
      }),
    )

    const lines = balances
      .filter((b) => b.balance > 0n)
      .map((b) => `${b.label} ${formatCurrencyAmount(formatAmount(Number(b.balance)), 'USD')}`)
    const truncatedAddress = `${member.account_address.slice(0, 6)}…${member.account_address.slice(-4)}`
    const explorerUrl = Tempo.explorerLink(workspace.chain_id, member.account_address)
    if (lines.length === 0) {
      await postPrivateReply(
        event,
        event.user,
        `Wallet ${truncatedAddress} has no balances.\nView on explorer: ${explorerUrl}`,
      )
      return
    }

    await postPrivateReply(
      event,
      event.user,
      [`Wallet ${truncatedAddress}`, ...lines, `View on explorer: ${explorerUrl}`].join('\n'),
    )
  },
  async config(event, ctx) {
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()
    if (!workspace) {
      await postPrivateReply(
        event,
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
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
      await postPrivateReply(
        event,
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
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
      await postPrivateReply(event, event.user, 'No account connected.')
      return
    }

    await ctx.db.deleteFrom('access_key').where('account_id', '=', member.account_id).execute()
    await ctx.db
      .updateTable('member')
      .set({ account_id: null, updated_at: new Date().toISOString() })
      .where('id', '=', member.id)
      .execute()
    await postPrivateReply(event, event.user, 'Disconnected')
  },
  async help(event, ctx) {
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()

    const commandRows = [
      [`${getSlackCommand(env.HOST)} @account [amount] [token] [for memo]`, 'Send payment'],
      [`${getSlackCommand(env.HOST)} balance`, 'Show wallet balance'],
      [`${getSlackCommand(env.HOST)} config`, 'Manage workspace configuration'],
      [`${getSlackCommand(env.HOST)} connect`, 'Connect to Tipbot'],
      [`${getSlackCommand(env.HOST)} disconnect`, 'Disconnect from Tipbot'],
      [`${getSlackCommand(env.HOST)} help`, 'Show help message'],
      [`${getSlackCommand(env.HOST)} leaderboard`, 'Show top tippers and recipients'],
      [`${getSlackCommand(env.HOST)} stats`, 'Show your tip stats'],
      [`${getSlackCommand(env.HOST)} status`, 'Check connection status'],
    ]
    const paymentExampleRows = [
      [`${getSlackCommand(env.HOST)} @account`, 'Send default amount'],
      [`${getSlackCommand(env.HOST)} @account for coffee`, 'Send default amount with memo'],
      [`${getSlackCommand(env.HOST)} @account 0.005`, 'Send custom amount'],
      [`${getSlackCommand(env.HOST)} @account 0.005 for coffee`, 'Send custom amount with memo'],
      [`${getSlackCommand(env.HOST)} @account 0.005 USDC`, 'Send custom token'],
      [
        `${getSlackCommand(env.HOST)} @account 0.005 USDC for coffee`,
        'Send custom token with memo',
      ],
    ]
    const mentionExampleRows = [
      [`@${getSlackBotDisplayName(env.HOST)} @account`, 'Send default amount'],
      [`@${getSlackBotDisplayName(env.HOST)} @account for coffee`, 'Send default amount with memo'],
      [
        `@${getSlackBotDisplayName(env.HOST)} @account 0.005 for coffee`,
        'Send custom amount with memo',
      ],
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
    await postSlackPrivateReply(
      ctx.provider.id,
      event.channel.id.replace(/^slack:/, ''),
      event.user.userId,
      body,
    )
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
      await postPrivateReply(
        event,
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
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
      await postPrivateReply(
        event,
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
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
      await postPrivateReply(event, event.user, 'No account connected.')
      return
    }

    await postPrivateReply(event, event.user, `Connected as \`${member.account_address}\``)
  },
  async stats(event, ctx) {
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
      await postPrivateReply(
        event,
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
      )
      return
    }

    const member = await ctx.db
      .selectFrom('member')
      .selectAll()
      .where('workspace_id', '=', workspace.id)
      .where('provider_user_id', '=', event.user.userId)
      .executeTakeFirst()

    if (!member) {
      await postPrivateReply(
        event,
        event.user,
        'Your tip stats\nReceived $0.00 (0 tips)\nTipped $0.00 (0 tips)\nMost tipped None\nMost tipped by None',
      )
      return
    }

    const received = await ctx.db
      .selectFrom('tip')
      .select([
        sql<number>`coalesce(sum("tip"."amount"), 0)`.as('amount'),
        sql<number>`count("tip"."id")`.as('tip_count'),
      ])
      .where('tip.workspace_id', '=', workspace.id)
      .where('tip.recipient_member_id', '=', member.id)
      .where('tip.confirmed_at', 'is not', null)
      .executeTakeFirstOrThrow()
    const sent = await ctx.db
      .selectFrom('tip')
      .select([
        sql<number>`coalesce(sum("tip"."amount"), 0)`.as('amount'),
        sql<number>`count("tip"."id")`.as('tip_count'),
      ])
      .where('tip.workspace_id', '=', workspace.id)
      .where('tip.sender_member_id', '=', member.id)
      .where('tip.confirmed_at', 'is not', null)
      .executeTakeFirstOrThrow()
    const mostTipped = await ctx.db
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
      .executeTakeFirst()
    const mostTippedBy = await ctx.db
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
      .executeTakeFirst()

    await postPrivateReply(
      event,
      event.user,
      [
        'Your tip stats',
        `Received ${formatCurrencyAmount(formatAmount(Number(received.amount)), 'USD')} (${Number(received.tip_count)} ${Number(received.tip_count) === 1 ? 'tip' : 'tips'})`,
        `Tipped ${formatCurrencyAmount(formatAmount(Number(sent.amount)), 'USD')} (${Number(sent.tip_count)} ${Number(sent.tip_count) === 1 ? 'tip' : 'tips'})`,
        `Most tipped ${
          mostTipped
            ? `<@${mostTipped.provider_user_id}> ${formatCurrencyAmount(formatAmount(Number(mostTipped.amount)), 'USD')} (${Number(mostTipped.tip_count)} ${Number(mostTipped.tip_count) === 1 ? 'tip' : 'tips'})`
            : 'None'
        }`,
        `Most tipped by ${
          mostTippedBy
            ? `<@${mostTippedBy.provider_user_id}> ${formatCurrencyAmount(formatAmount(Number(mostTippedBy.amount)), 'USD')} (${Number(mostTippedBy.tip_count)} ${Number(mostTippedBy.tip_count) === 1 ? 'tip' : 'tips'})`
            : 'None'
        }`,
      ].join('\n'),
    )
  },
  async default(event, ctx) {
    if (!event.triggerId) {
      await postPrivateReply(event, event.user, 'Payment not sent. Try again.')
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

const commandNames = [
  'balance',
  'config',
  'connect',
  'disconnect',
  'help',
  'leaderboard',
  'stats',
  'status',
] as const
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
    threadTs?: string
  },
) {
  const workspace = await ctx.db
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', ctx.provider.type)
    .where('provider_id', '=', ctx.provider.id)
    .executeTakeFirst()
  const parsed = Tip.parseTipBatchText(ctx.text, {
    chainId: workspace?.chain_id ?? Tempo.chainLookup.mainnet,
  })
  if (!parsed) {
    if (options.mention && options.threadTs) {
      await postInvalidMentionReply(event, ctx, ctx.text, options.threadTs)
      return
    }
    await postInvalidUsage(event, ctx, { mention: options.mention, threadTs: options.threadTs })
    return
  }

  const tokenAddress = parsed.token
    ? Tempo.getTokenAddress(workspace?.chain_id ?? Tempo.chainLookup.mainnet, parsed.token)
    : null
  if (parsed.token && !tokenAddress) {
    await postPrivateReply(
      event,
      event.user,
      'Payment not sent. This token is not supported on this network.',
    )
    return
  }

  if (options.threadTs)
    void setSlackAssistantThreadStatus(event, ctx, options.threadTs, 'is sending a tip', {
      loadingMessages: ['Sending tip'],
    }).catch(() => {
      // Best effort only. Payment flow must not depend on Slack assistant UI.
    })
  try {
    const result = await (
      parsed.recipients.length === 1
        ? Tip.handleTipRequest(env, {
            amount: parsed.amount,
            idempotencyKey: options.idempotencyKey,
            memo: parsed.memo,
            provider: ctx.provider.type,
            providerChannelId: event.channel.id,
            providerId: ctx.provider.id,
            providerThreadId: options.threadTs,
            recipientProviderLabel: parsed.recipients[0]?.recipientProviderLabel,
            recipientProviderUserId: parsed.recipients[0]!.recipientProviderUserId,
            senderProviderUserId: event.user.userId,
            tokenAddress: tokenAddress ?? undefined,
          })
        : Tip.handleTipBatchRequest(env, {
            amount: parsed.amount,
            idempotencyKey: options.idempotencyKey,
            memo: parsed.memo,
            provider: ctx.provider.type,
            providerChannelId: event.channel.id,
            providerId: ctx.provider.id,
            providerThreadId: options.threadTs,
            recipients: parsed.recipients,
            senderProviderUserId: event.user.userId,
            source: options.mention ? 'mention' : 'command',
            tokenAddress: tokenAddress ?? undefined,
          })
    ).catch(
      (error) =>
        ({
          code: 'failed',
          message: error instanceof Error ? error.message : 'Command failed.',
          ok: false,
        }) satisfies Tip.TipResult,
    )

    if (result.ok && result.status === 'sent' && 'recipients' in result) {
      const amount = result.isDefaultToken
        ? formatCurrencyAmount(result.amount, result.tokenCurrency)
        : formatTipAmount(result.amount, result.tokenCurrency, result.tokenSymbol)
      await postSlackReceiptMessage(
        event,
        ctx,
        `${event.channel.mentionUser(result.senderProviderUserId)} ${result.memo ? 'sent' : 'tipped'} ${result.recipients.length} accounts ${amount} each${result.memo ? ` for ${result.memo}` : ''}.\n${result.recipients.map((recipient) => `• ${event.channel.mentionUser(recipient.recipientProviderUserId)}`).join('\n')}`,
        result.chainId,
        result.transactionHash,
        undefined,
        result.feePayer === 'sender'
          ? 'Fee sponsor unavailable; fee paid from your balance.'
          : undefined,
        options.threadTs,
      )
      if (result.memo && options.threadTs)
        await postSlackMemoReply(event, ctx, result.memo, options.threadTs)
    } else if (result.ok && result.status === 'sent' && !('recipients' in result)) {
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
      if (result.memo && options.threadTs)
        await postSlackMemoReply(event, ctx, result.memo, options.threadTs)
    } else if (result.ok)
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
        await postPrivateReply(event, event.user, {
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
        })
        return
      }
      if (result.code === 'sender_unconnected' || result.code === 'missing_sender_access_key') {
        await postConnectLink(event, ctx)
        return
      }
      const message = await (async () => {
        if (result.code === 'self_tip')
          return 'Payment not sent. Cannot send a payment to yourself.'
        if (result.code === 'recipient_unconnected')
          return `Payment not sent. ${event.channel.mentionUser(result.recipientProviderUserId ?? parsed.recipients[0]!.recipientProviderUserId)} needs to connect Tipbot before receiving payments.`
        if (result.code === 'pending') return 'Payment still sending.'
        if (result.code === 'insufficient_funds')
          return 'Payment not sent. Your wallet has insufficient funds.'
        if (result.code === 'failed' && result.message === 'Memo must be at most 32 bytes.') {
          const suggestion = await (async () => {
            if (!parsed.memo) return null
            try {
              const value = z
                .parse(
                  z.object({ response: z.string().default('') }),
                  await env.AI.run('@cf/meta/llama-3.2-1b-instruct', {
                    max_tokens: 24,
                    messages: [
                      {
                        content:
                          'Shorten this payment memo to at most 32 UTF-8 bytes. Preserve the meaning. Return only the shortened memo text, no quotes, no explanation, no punctuation unless needed.',
                        role: 'system',
                      },
                      { content: parsed.memo, role: 'user' },
                    ],
                  }),
                )
                .response.replace(/[\r\n]+/g, ' ')
                .trim()
                .replace(/^['"]|['"]$/g, '')
              if (!value || new TextEncoder().encode(value).length > 32) return null
              if (/[`\r\n]|<@[A-Z0-9_]+/i.test(value)) return null
              const memoWords = new Set(parsed.memo.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
              const suggestionWords = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
              if (!suggestionWords.length) return null
              if (suggestionWords.some((word) => !memoWords.has(word))) return null
              return value
            } catch (error) {
              console.error('Failed to generate short memo suggestion:', error)
            }
            return null
          })()
          return `Payment not sent. Memo must be at most 32 bytes; shorten the text after \`for\`.${suggestion ? ` Try: \`${suggestion}\`.` : ''}`
        }
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
      else await postPrivateReply(event, event.user, message)
    }
  } finally {
    // Clear Slack's assistant thread status after this request finishes or hands off to
    // confirmation.
    if (options.threadTs)
      await setSlackAssistantThreadStatus(event, ctx, options.threadTs, '').catch(() => {
        // Best effort only. Payment/error flow must not depend on Slack assistant UI cleanup.
      })
  }
}

async function setSlackAssistantThreadStatus(
  event: TipEvent,
  ctx: HandlerContext,
  threadTs: string,
  status: string,
  options?: { loadingMessages?: readonly string[] },
) {
  const installation = await getSlack().getInstallation(ctx.provider.id)
  if (!installation) return

  const body = new URLSearchParams()
  body.set('channel_id', event.channel.id.replace(/^slack:/, ''))
  if (options?.loadingMessages)
    body.set('loading_messages', JSON.stringify(options.loadingMessages))
  body.set('status', status)
  body.set('thread_ts', threadTs)
  await fetch(`${env.SLACK_API_URL}/assistant.threads.setStatus`, {
    body,
    headers: { authorization: `Bearer ${installation.botToken}` },
    method: 'POST',
  })
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
    const historyBody = new URLSearchParams()
    historyBody.set('channel', event.item.channel)
    historyBody.set('limit', '20')
    const historyResponse = await getSlack().withBotToken(installation.botToken, () =>
      fetch(`${env.SLACK_API_URL}/conversations.history`, {
        body: historyBody,
        headers: { authorization: `Bearer ${installation.botToken}` },
        method: 'POST',
      }),
    )
    const historyJson = z.parse(
      z.object({
        messages: z
          .array(
            z.object({
              reply_count: z.number().optional(),
              ts: z.string().optional(),
            }),
          )
          .optional(),
        ok: z.boolean().optional(),
      }),
      await historyResponse.json(),
    )
    if (historyJson.ok) {
      for (const parentMessage of historyJson.messages ?? []) {
        if (!parentMessage.ts || !parentMessage.reply_count) continue
        const repliesBody = new URLSearchParams()
        repliesBody.set('channel', event.item.channel)
        repliesBody.set('limit', '100')
        repliesBody.set('ts', parentMessage.ts)
        const repliesResponse = await getSlack().withBotToken(installation.botToken, () =>
          fetch(`${env.SLACK_API_URL}/conversations.replies`, {
            body: repliesBody,
            headers: { authorization: `Bearer ${installation.botToken}` },
            method: 'POST',
          }),
        )
        const repliesJson = z.parse(
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
          await repliesResponse.json(),
        )
        if (!repliesJson.ok) continue
        const message = repliesJson.messages?.find((message) => message.ts === event.item.ts)
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
  if (
    message.bot_id ||
    (message.subtype && !['reply_broadcast', 'thread_broadcast'].includes(message.subtype))
  ) {
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
      `Payment not sent. Connect to Tipbot with \`${getSlackCommand(env.HOST)} connect\` and try again.`,
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

  const result = await Tip.handleTipBatchRequest(env, {
    idempotencyKey,
    memo: null,
    provider: provider.type,
    providerChannelId: event.item.channel,
    providerId: provider.id,
    recipients: [{ recipientProviderUserId: recipient.providerUserId }],
    senderProviderUserId: sender.providerUserId,
    source: 'reaction',
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
      reaction: event.reaction,
      threadTs: message.thread_ts ?? event.item.ts,
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

async function postSlackPrivateReply(
  providerId: string,
  channelId: string,
  userId: string,
  body: URLSearchParams,
) {
  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return

  const method = isSlackDMChannelId(channelId) ? 'chat.postMessage' : 'chat.postEphemeral'
  if (method === 'chat.postEphemeral') body.set('user', userId)
  const response = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/${method}`, {
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
  if (!json.ok) throw Slack.slackApiError(method, json.error)
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
  options: {
    channelId: string
    reaction: string
    threadTs: string
    workspaceId: string
  },
) {
  const db = DB.create(env.DB)
  const rows = await db
    .selectFrom('reaction_tip')
    .innerJoin('tip', 'tip.id', 'reaction_tip.tip_id')
    .innerJoin('tip_batch', 'tip_batch.id', 'tip.batch_id')
    .innerJoin('member as sender', 'sender.id', 'reaction_tip.sender_member_id')
    .innerJoin('member as recipient', 'recipient.id', 'reaction_tip.recipient_member_id')
    .innerJoin('workspace', 'workspace.id', 'reaction_tip.workspace_id')
    .select([
      'reaction_tip.message_ts',
      'recipient.provider_user_id as recipient_provider_user_id',
      'sender.provider_user_id as sender_provider_user_id',
      'tip.amount',
      'tip.chain_id',
      'tip.token_address',
      'tip_batch.transaction_hash',
      'workspace.default_token_address',
      'workspace.reaction_tip_emoji',
    ])
    .where('reaction_tip.workspace_id', '=', options.workspaceId)
    .where('reaction_tip.channel_id', '=', options.channelId)
    .where('reaction_tip.thread_ts', '=', options.threadTs)
    .where('reaction_tip.reaction', '=', options.reaction)
    .where('tip.confirmed_at', 'is not', null)
    .where('tip_batch.transaction_hash', 'is not', null)
    .orderBy('reaction_tip.created_at', 'asc')
    .execute()
  if (rows.length === 0) return

  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return

  const rowTexts = await Promise.all(
    rows.map(async (row) => {
      const token = await Tempo.getTokenMetadata(env, row.chain_id, row.token_address)
      const amount = formatAmount(row.amount)
      const displayAmount = Address.isEqual(
        Address.checksum(row.token_address),
        Address.checksum(row.default_token_address ?? Tempo.addressLookup.pathUsd),
      )
        ? formatCurrencyAmount(amount, token.currency)
        : formatTipAmount(amount, token.currency, token.symbol)
      return {
        messageTs: row.message_ts,
        recipientProviderUserId: row.recipient_provider_user_id,
        text: `• <@${row.sender_provider_user_id}> tipped ${displayAmount} · <${Tempo.formatTxLink(row.chain_id, row.transaction_hash!)}|Receipt>`,
      }
    }),
  )
  const messageGroups = rowTexts.reduce(
    (groups, row) => {
      const group = groups.find((group) => group.messageTs === row.messageTs)
      if (group) {
        group.lines.push(row.text)
        return groups
      }
      groups.push({
        lines: [row.text],
        messageTs: row.messageTs,
        recipientProviderUserId: row.recipientProviderUserId,
      })
      return groups
    },
    [] as Array<{ lines: string[]; messageTs: string; recipientProviderUserId: string }>,
  )
  const text = (() => {
    const title = `:${rows[0]!.reaction_tip_emoji}: Reaction tips received`
    if (messageGroups.length === 1) {
      const reactedMessageUrl = new URL('slack://channel')
      reactedMessageUrl.searchParams.set('team', providerId)
      reactedMessageUrl.searchParams.set('id', options.channelId)
      reactedMessageUrl.searchParams.set('message', messageGroups[0]!.messageTs)
      return `${title} on this message:\n\n<@${messageGroups[0]!.recipientProviderUserId}> received ${rowTexts.length === 1 ? 'a tip' : 'tips'} on <${reactedMessageUrl}|this> message:\n${messageGroups[0]!.lines.join('\n')}`
    }
    return `${title} in this thread:\n\n${messageGroups
      .map((group) => {
        const reactedMessageUrl = new URL('slack://channel')
        reactedMessageUrl.searchParams.set('team', providerId)
        reactedMessageUrl.searchParams.set('id', options.channelId)
        reactedMessageUrl.searchParams.set('message', group.messageTs)
        return `<@${group.recipientProviderUserId}> received ${group.lines.length === 1 ? 'a tip' : 'tips'} on <${reactedMessageUrl}|this> message:\n${group.lines.join('\n')}`
      })
      .join('\n\n')}`
  })()
  const existing = await db
    .selectFrom('reaction_tip_thread')
    .selectAll()
    .where('workspace_id', '=', options.workspaceId)
    .where('channel_id', '=', options.channelId)
    .where('message_ts', '=', options.threadTs)
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
    await db
      .updateTable('reaction_tip_thread')
      .set({ updated_at: new Date().toISOString() })
      .where('id', '=', existing.id)
      .execute()
    return
  }

  const body = new URLSearchParams()
  body.set('channel', options.channelId)
  body.set('text', text)
  body.set('thread_ts', options.threadTs)
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
        message_ts: options.threadTs,
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

function normalizeSlackMentionText(value: string, botUserId: string) {
  const botMentionPattern = new RegExp(`<@${escapeRegex(botUserId)}(?:\\|[^>]+)?>`, 'g')
  return value.replace(botMentionPattern, ' ').replace(/\s+/g, ' ').trim()
}

function parseSlackMentionTipText(text: string) {
  const mentions = [...text.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]+)?>/g)]
  if (mentions.length < 1) return null
  const prefix = text.slice(0, mentions[0]!.index).trim().toLowerCase()
  if (prefix && !['pay', 'send', 'tip'].includes(prefix)) return null
  return text.slice(mentions[0]!.index).trim()
}

function isSlackIntroduceYourselfText(text: string) {
  return text.toLowerCase() === 'introduce yourself'
}

function isSlackSelfMentionChatter(rawText: string, botUserId: string, mentionText: string) {
  const mentions = [...rawText.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]+)?>/g)].map((match) => match[1])
  if (mentions.filter((mention) => mention === botUserId).length < 2) return false
  if (mentions.some((mention) => mention !== botUserId)) return false
  return !hasInvalidMentionIntent(mentionText)
}

function hasInvalidMentionIntent(text: string) {
  return /\b(connect|configure|get started|install|link|mine|set ?up|start|tip|send|pay|sent|paid|for|thank you|thanks|ty|thx|thank u|creature|creatures|dragon|dragons|elf|elves|fae|fairy|goblin|goblins|gnome|gnomes|gremlin|gremlins|kobold|kobolds|monster|monsters|orc|orcs|troll|trolls)\b/i.test(
    text,
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
  const body = new URLSearchParams()
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set(
    'text',
    options.mention
      ? `Invalid \`@${getSlackBotDisplayName(env.HOST)}\` usage. Try \`@${getSlackBotDisplayName(env.HOST)} @account for coffee\` or \`@${getSlackBotDisplayName(env.HOST)} @account 0.005 for coffee\`.`
      : `Invalid \`${getSlackCommand(env.HOST)}\` usage. Try \`${getSlackCommand(env.HOST)} @account\` or \`${getSlackCommand(env.HOST)} help\` for more info.`,
  )
  if (options.threadTs) body.set('thread_ts', options.threadTs)
  await postSlackPrivateReply(
    ctx.provider.id,
    event.channel.id.replace(/^slack:/, ''),
    event.user.userId,
    body,
  )
}

async function postInvalidMentionReply(
  event: TipEvent,
  ctx: HandlerContext,
  mentionText: string,
  threadTs: string,
) {
  const installation = await getSlack().getInstallation(ctx.provider.id)
  if (!installation) throw new Error('Tibot app not installed for this workspace.')

  const body = new URLSearchParams()
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set('text', await generateInvalidMentionReply(mentionText))
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

async function generateInvalidMentionReply(mentionText: string) {
  const text = mentionText.trim()
  const creatureMatch = text.match(creaturePattern)
  const isTipText = /<@[A-Z0-9_]+|\b(tip|send|pay|sent|paid)\b/i.test(text)
  const isSetupText = /\b(connect|configure|get started|install|link|mine|set ?up|start)\b/i.test(
    text,
  )
  const isThanksText = /^(thank you|thanks|ty|thx|thank u)\b/i.test(text)
  const fallback = (() => {
    if (creatureMatch && isTipText)
      return `${creatureMatch[0].toUpperCase()}? Excellent. For tips: \`@${getSlackBotDisplayName(env.HOST)} @account for coffee\`.`
    if (creatureMatch) return `${creatureMatch[0].toUpperCase()}? Now we are talking.`
    if (isThanksText) return 'Anytime.'
    if (isSetupText)
      return `Run \`${getSlackCommand(env.HOST)} connect\`, then try \`@${getSlackBotDisplayName(env.HOST)} tip @account\`.`
    if (isTipText)
      return `Almost. Try \`@${getSlackBotDisplayName(env.HOST)} @account for coffee\`.`
    return 'Anytime.'
  })()
  try {
    const result = z
      .parse(
        z.object({ response: z.string().default('') }),
        await env.AI.run('@cf/meta/llama-3.2-1b-instruct', {
          max_tokens: 48,
          messages: [
            {
              content: `You are ${getSlackBotDisplayName(env.HOST)} in Slack. Reply to an invalid @${getSlackBotDisplayName(env.HOST)} mention. Keep it under 140 chars. Be short and pithy. Do not mention users. If the user mentions goblins or other creatures, get REALLY EXCITED. If the user seems to be trying to send a tip/payment, include this exact syntax: \`@${getSlackBotDisplayName(env.HOST)} @account for coffee\`. Otherwise just acknowledge or deflect lightly.`,
              role: 'system',
            },
            { content: text || '(empty mention)', role: 'user' },
          ],
        }),
      )
      .response.replace(/[\r\n]+/g, ' ')
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (isValidInvalidMentionAiReply(result)) return result
  } catch (error) {
    console.error('Failed to generate invalid mention reply:', error)
  }
  return fallback
}

function isValidInvalidMentionAiReply(value: string) {
  if (!value || value.length > 200) return false
  if (/^@?tipbot[.!?]?$/i.test(value)) return false
  if (value.includes(`@${getSlackBotDisplayName(env.HOST)}`) || /@Tipbot|<@[A-Z0-9_]+/i.test(value))
    return false
  return true
}

async function postSlackIntroduction(event: TipEvent, ctx: HandlerContext, threadTs: string) {
  const installation = await getSlack().getInstallation(ctx.provider.id)
  if (!installation) throw new Error('Tibot app not installed for this workspace.')

  const text =
    `I’m ${getSlackBotDisplayName(env.HOST)}: sometime tipper, sometime messenger, always bot.\n` +
    `Connect with \`${getSlackCommand(env.HOST)} connect\`, then send stablecoins with \`@${getSlackBotDisplayName(env.HOST)} @account for coffee\`, \`@${getSlackBotDisplayName(env.HOST)} @account 0.005 for coffee\`, \`${getSlackCommand(env.HOST)} @account for coffee\`, or a 💸 reaction.`
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
  await postSlackPrivateReply(
    ctx.provider.id,
    event.channel.id.replace(/^slack:/, ''),
    event.user.userId,
    body,
  )
}

async function postConnectLink(event: TipEvent, ctx: HandlerContext) {
  const workspace = await ctx.db
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', ctx.provider.type)
    .where('provider_id', '=', ctx.provider.id)
    .executeTakeFirst()
  if (!workspace) {
    await postPrivateReply(
      event,
      event.user,
      'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
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
      await postPrivateReply(event, event.user, 'Already connected')
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

  await postPrivateReply(event, event.user, {
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
  })
}

async function postPrivateReply(
  event: TipEvent,
  user: chat.Author,
  message: Parameters<TipEvent['channel']['postEphemeral']>[1],
) {
  if (isSlackDMChannelId(event.channel.id)) {
    await event.channel.post(message)
    return
  }

  await event.channel.postEphemeral(user, message, { fallbackToDM: false })
}

function isSlackDMChannelId(channelId: string) {
  return channelId.replace(/^slack:/, '').startsWith('D')
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
  body.set('text', formatReceiptText(`${receiptText}${context ? ` ${context}` : ''}`, 'Receipt'))
  if (threadTs) body.set('thread_ts', threadTs)
  if (user && !isSlackDMChannelId(event.channel.id)) body.set('user', user.userId)
  else {
    body.set('unfurl_links', 'false')
    body.set('unfurl_media', 'false')
  }
  const method =
    user && !isSlackDMChannelId(event.channel.id) ? 'chat.postEphemeral' : 'chat.postMessage'
  const response = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/${method}`, {
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
  if (!json.ok) throw Slack.slackApiError(method, json.error)
}

async function postSlackMemoReply(
  event: TipEvent,
  ctx: HandlerContext,
  memo: string,
  threadTs: string,
) {
  const creatureMatch = memo.match(creaturePattern)
  if (!creatureMatch) return

  const installation = await getSlack().getInstallation(ctx.provider.id)
  if (!installation) return

  const fallback = `${creatureMatch[0].toUpperCase()}? Now we are talking.`
  let reply = fallback
  try {
    const result = z
      .parse(
        z.object({ response: z.string().default('') }),
        await env.AI.run('@cf/meta/llama-3.2-1b-instruct', {
          max_tokens: 48,
          messages: [
            {
              content:
                'You are Tipbot in Slack. Someone just sent a tip with a memo. React to the memo in character. Keep it under 140 chars. Be short and pithy. Do not mention users. If the memo mentions goblins or other creatures, get REALLY EXCITED.',
              role: 'system',
            },
            { content: memo, role: 'user' },
          ],
        }),
      )
      .response.replace(/[\r\n]+/g, ' ')
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (isValidInvalidMentionAiReply(result)) reply = result
  } catch (error) {
    console.error('Failed to generate memo reply:', error)
  }

  const body = new URLSearchParams()
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set('text', reply)
  body.set('thread_ts', threadTs)
  body.set('unfurl_links', 'false')
  body.set('unfurl_media', 'false')
  await getSlack()
    .withBotToken(installation.botToken, async () => {
      const response = await fetch(`${env.SLACK_API_URL}/chat.postMessage`, {
        body,
        headers: { authorization: `Bearer ${installation.botToken}` },
        method: 'POST',
      })
      const json = z.parse(
        z.object({
          error: z.string().optional(),
          ok: z.boolean().optional(),
        }),
        await response.json(),
      )
      if (!json.ok) throw Slack.slackApiError('chat.postMessage', json.error)
    })
    .catch((error: unknown) => {
      console.error('Failed to post memo reply:', error)
    })
}

function createReceiptBlocks(
  text: string,
  chainId: number,
  transactionHash: string,
  context?: string,
) {
  const receiptLink = `<${Tempo.formatTxLink(chainId, transactionHash)}|Receipt>`
  return [
    {
      text: {
        text: formatReceiptText(text, receiptLink),
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

function formatReceiptText(text: string, receipt: string) {
  const lineBreakIndex = text.indexOf('\n')
  if (lineBreakIndex === -1) return `${text} · ${receipt}`
  return `${text.slice(0, lineBreakIndex).replace(/\.$/, '')} · ${receipt}${text.slice(lineBreakIndex)}`
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
  await postSlackPrivateReply(
    ctx.provider.id,
    event.channel.id.replace(/^slack:/, ''),
    event.user.userId,
    body,
  )
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
