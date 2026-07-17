import * as DB from '#db/client.ts'
import type { DB as DB_gen } from '#db/types.gen.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as AccessKey from '#/lib/accessKey.ts'
import { getReceiptBoostReaction, getSlackBotDisplayName, getSlackCommand } from '#/lib/app.ts'
import * as Emoji from '#/lib/emoji.ts'
import { formatAmount, formatCurrencyAmount, formatTipAmount } from '#/lib/format.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Slack from '#/lib/slack.ts'
import * as Tapimo from '#/lib/tapimo.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Tip from '#/lib/tip.ts'
import { createCloudflareState } from '#/vendor/chatStateCloudflareDO.ts'
import { createSlackAdapter } from '@chat-adapter/slack'
import * as chat from 'chat'
import { env } from 'cloudflare:workers'
import { sql } from 'kysely'
import { Address, Hash, Hex } from 'ox'
import { createClient, http } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { privateKeyToAccount } from 'viem/accounts'
import { Actions } from 'viem/tempo'
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
        authorizations: z
          .array(
            z.object({
              is_bot: z.boolean().optional(),
              team_id: z.string().min(1).nullable().optional(),
              user_id: z.string().min(1).nullable().optional(),
            }),
          )
          .optional(),
        channel: z.string().min(1),
        context_team_id: z.string().min(1).nullable().optional(),
        files: z
          .array(
            z.object({
              filetype: z.string().optional(),
              id: z.string().min(1).optional(),
              mimetype: z.string().optional(),
              name: z.string().optional(),
              title: z.string().optional(),
            }),
          )
          .optional(),
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
    if (raw.subtype && !['file_share', 'reply_broadcast', 'thread_broadcast'].includes(raw.subtype))
      return

    const providerId = (() => {
      const mentioned = new Set(
        [...raw.text.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]+)?>/g)].map((match) => match[1]),
      )
      return (
        raw.authorizations?.find(
          (authorization) =>
            authorization.user_id && mentioned.has(authorization.user_id) && authorization.team_id,
        )?.team_id ??
        raw.context_team_id ??
        raw.team_id ??
        raw.team
      )
    })()
    if (!providerId) throw new Error('Slack app mention missing team id.')

    const installation = await getSlack().getInstallation(providerId)
    if (!installation?.botUserId) throw new Error('Slack app installation missing bot user id.')

    const publicThreadTs = raw.thread_ts ?? raw.ts
    const privateThreadTs = raw.thread_ts
    const event = {
      channel: thread.channel,
      threadTs: privateThreadTs,
      user: message.author,
    } satisfies TipEvent
    const mentionText = Slack.normalizeMentionText(raw.text, installation.botUserId)
    const match = mentionText.match(commandPattern)
    const slackConnectActor = await Slack.resolveConnectActor({
      apiUrl: env.SLACK_API_URL,
      channelId: raw.channel,
      getInstallation: (providerId) => getSlack().getInstallation(providerId),
      providerId,
      providerUserId: raw.user,
      withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
    })
    if (slackConnectActor.blocked || slackConnectActor.external) {
      if (slackConnectActor.external && match && Slack.isConnectExternalCommand(match[1])) {
        const name = match[1]
        await handlers[name](event, {
          allowUninstalledWorkspaceCreate: name === 'connect',
          channelProviderId: providerId,
          db: DB.create(env.DB),
          externalSlackConnect: true,
          provider: { id: slackConnectActor.providerId, type: 'slack' },
          settingsProviderId: providerId,
          text: match[2]?.trim() ?? '',
          threadTs: privateThreadTs,
        })
        return
      }
      if (slackConnectActor.external && !match) {
        const db = DB.create(env.DB)
        const workspace = await db
          .selectFrom('workspace')
          .select(['id', 'installed_at'])
          .where('provider', '=', 'slack')
          .where('provider_id', '=', slackConnectActor.providerId)
          .executeTakeFirst()
        if (!workspace) {
          await postPrivateReply(
            event,
            event.user,
            `Payment not sent. Connect with \`@${getSlackBotDisplayName(env.HOST)} connect\` first.`,
          )
          return
        }
        if (workspace.installed_at) {
          await postPrivateReply(
            event,
            event.user,
            'Payment not sent. Use your workspace’s Tipbot app to send payments here.',
          )
          return
        }
        const member = await db
          .selectFrom('member')
          .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
          .select('member.id')
          .where('member.workspace_id', '=', workspace.id)
          .where('member.provider_user_id', '=', raw.user)
          .where('provider_identity.account_id', 'is not', null)
          .executeTakeFirst()
        if (!member) {
          await postPrivateReply(
            event,
            event.user,
            `Payment not sent. Connect with \`@${getSlackBotDisplayName(env.HOST)} connect\` first.`,
          )
          return
        }
        await handlers.default(event, {
          channelProviderId: providerId,
          db,
          externalSlackConnect: true,
          provider: { id: slackConnectActor.providerId, type: 'slack' },
          settingsProviderId: providerId,
          text: Slack.parseMentionTipText(mentionText) ?? '',
          threadTs: privateThreadTs,
          defaultTip: {
            idempotencyKey: `mention:${providerId}:${raw.channel}:${raw.ts}`,
            insufficientFundsThreadTs: raw.thread_ts,
            mention: true,
            threadTs: publicThreadTs,
          },
        })
        return
      }
      await postPrivateReply(
        event,
        event.user,
        match
          ? `Tipbot is not installed in your Slack workspace yet. You can use \`@${getSlackBotDisplayName(env.HOST)} connect\`, \`@${getSlackBotDisplayName(env.HOST)} disconnect\`, or \`@${getSlackBotDisplayName(env.HOST)} status\` here, or ask an admin to install Tipbot for full support.`
          : 'Payment not sent. Use your workspace’s Tipbot app to send payments here.',
      )
      return
    }

    const context = {
      db: DB.create(env.DB),
      provider: { id: providerId, type: 'slack' },
      text: Slack.parseMentionTipText(mentionText) ?? '',
      threadTs: privateThreadTs,
      tipAskImageFiles: slackTipAskImageFiles(raw.files),
    } satisfies HandlerContext

    if (mentionText.toLowerCase() === 'introduce yourself') {
      // Keep the one-off introduction response local to mention handling.
      const installation = await getSlack().getInstallation(context.provider.id)
      if (!installation) throw new Error('Tibot app not installed for this workspace.')

      const text =
        `I’m ${getSlackBotDisplayName(env.HOST)}: sometime tipper, sometime messenger, always bot.\n` +
        `Connect with \`@${getSlackBotDisplayName(env.HOST)} connect\` or \`${getSlackCommand(env.HOST)} connect\`, then send stablecoins with \`@${getSlackBotDisplayName(env.HOST)} @account for coffee\`, \`@${getSlackBotDisplayName(env.HOST)} @account 0.005 for coffee\`, \`${getSlackCommand(env.HOST)} @account for coffee\`, or a 💸 reaction.`
      const body = new URLSearchParams()
      body.set('channel', event.channel.id.replace(/^slack:/, ''))
      body.set('text', text)
      body.set('thread_ts', publicThreadTs)
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
      return
    }

    if (match) {
      const name = z.parse(z.enum(commandNames), match[1])
      await handlers[name](event, { ...context, text: match[2]?.trim() ?? '' })
      return
    }

    if (!context.text) {
      // Ignore messages that only repeat Tipbot mentions without a command or tip intent.
      const isSelfMentionChatter = (() => {
        const mentions = [...raw.text.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]+)?>/g)].map(
          (match) => match[1],
        )
        if (mentions.filter((mention) => mention === installation.botUserId).length < 2)
          return false
        if (mentions.some((mention) => mention !== installation.botUserId)) return false
        return !hasInvalidMentionIntent(mentionText)
      })()
      if (isSelfMentionChatter) return
      await postInvalidMentionReply(event, context, mentionText, publicThreadTs)
      return
    }

    await handlers.default(event, {
      ...context,
      defaultTip: {
        idempotencyKey: `mention:${providerId}:${raw.channel}:${raw.ts}`,
        insufficientFundsThreadTs: raw.thread_ts,
        mention: true,
        threadTs: publicThreadTs,
      },
    })
  })
  bot.onReaction(async (event) => {
    if (event.adapter !== getSlack()) throw new Error('Provider not implemented yet.')

    const reaction = z.parse(Slack.reactionEventSchema, event.raw)
    if (reaction.type !== 'reaction_added') return
    if (reaction.item.type !== 'message') return
    if (reaction.item.channel.startsWith('D')) return

    const context = await (async () => {
      const db = DB.create(env.DB)
      const existingReceiptWorkspace = isReceiptBoostReaction(reaction.reaction)
        ? await db
            .selectFrom('tip_receipt_message')
            .innerJoin('workspace', 'workspace.id', 'tip_receipt_message.workspace_id')
            .select([
              'workspace.chain_id',
              'workspace.created_at',
              'workspace.default_amount',
              'workspace.default_token_address',
              'workspace.id',
              'workspace.installed_at',
              'workspace.name',
              'workspace.provider',
              'workspace.provider_id',
              'workspace.uninstalled_at',
              'workspace.updated_at',
            ])
            .where('tip_receipt_message.channel_id', '=', reaction.item.channel)
            .where('tip_receipt_message.message_ts', '=', reaction.item.ts)
            .executeTakeFirst()
        : null
      const providerId =
        existingReceiptWorkspace?.provider_id ??
        reaction.authorizations?.find((authorization) => authorization.team_id)?.team_id ??
        reaction.team_id
      const workspace = await db
        .selectFrom('workspace')
        .select([
          'workspace.chain_id',
          'workspace.created_at',
          'workspace.default_amount',
          'workspace.default_token_address',
          'workspace.id',
          'workspace.installed_at',
          'workspace.name',
          'workspace.provider',
          'workspace.provider_id',
          'workspace.uninstalled_at',
          'workspace.updated_at',
        ])
        .where('workspace.provider', '=', 'slack')
        .where('workspace.provider_id', '=', providerId)
        .executeTakeFirst()
      if (!workspace) return
      const reactionTipConfigs = await db
        .selectFrom('reaction_tip_config')
        .select(['amount', 'emoji'])
        .where('workspace_id', '=', workspace.id)
        .execute()
      const reactionTipConfig = (
        reactionTipConfigs.length ? reactionTipConfigs : Tip.defaultReactionTipConfigs
      ).find((config) => config.emoji === reaction.reaction)
      if (!reactionTipConfig && !isReceiptBoostReaction(reaction.reaction)) return
      return {
        db,
        provider: { id: providerId, type: 'slack' },
        ...(reactionTipConfig
          ? {
              reactionTipConfig: {
                amount: reactionTipConfig.amount,
                emoji: reactionTipConfig.emoji,
              },
            }
          : {}),
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
  async airdrop_claim(event) {
    const raw = z.parse(
      z.object({
        channel: z.object({ id: z.string().min(1) }).optional(),
        container: z.object({ channel_id: z.string().min(1).optional() }).optional(),
        message: z
          .object({
            blocks: z.array(z.unknown()).optional(),
            text: z.string().optional(),
            thread_ts: z.string().min(1).optional(),
            ts: z.string().min(1).optional(),
          })
          .optional(),
        team: z.object({ id: z.string().min(1) }),
      }),
      event.raw,
    )
    const channelId = raw.channel?.id ?? raw.container?.channel_id
    if (!channelId) return
    const payload = z.object({ tipAirdropId: z.string().min(1) }).safeParse(
      (() => {
        try {
          return JSON.parse(event.value ?? 'null')
        } catch {
          return null
        }
      })(),
    )
    if (!payload.success) return
    const tipEvent = {
      channel: getChat().channel(`slack:${channelId}`),
      threadTs: raw.message?.thread_ts,
      user: event.user,
    } satisfies TipEvent
    const ctx = {
      db: DB.create(env.DB),
      provider: { id: raw.team.id, type: 'slack' },
      text: '',
      threadTs: raw.message?.thread_ts,
    } satisfies HandlerContext
    const tipAirdrop = await ctx.db
      .selectFrom('tip_airdrop')
      .innerJoin('workspace', 'workspace.id', 'tip_airdrop.workspace_id')
      .innerJoin('member as creator', 'creator.id', 'tip_airdrop.creator_member_id')
      .select([
        'creator.provider_user_id as creator_provider_user_id',
        'tip_airdrop.chain_id',
        'tip_airdrop.claim_amount',
        'tip_airdrop.claimed_amount',
        'tip_airdrop.ended_at',
        'tip_airdrop.ends_at',
        'tip_airdrop.id',
        'tip_airdrop.name',
        'tip_airdrop.provider_channel_id',
        'tip_airdrop.provider_id',
        'tip_airdrop.provider_message_ts',
        'tip_airdrop.status',
        'tip_airdrop.token_address',
        'tip_airdrop.total_amount',
        'tip_airdrop.workspace_id',
        'workspace.default_token_address as workspace_default_token_address',
      ])
      .where('tip_airdrop.id', '=', payload.data.tipAirdropId)
      .where('tip_airdrop.provider_id', '=', raw.team.id)
      .executeTakeFirst()
    if (!tipAirdrop) return

    const closeAirdrop = async () => {
      const now = new Date().toISOString()
      await ctx.db
        .updateTable('tip_airdrop')
        .set({ ended_at: now, status: 'ended', updated_at: now })
        .where('id', '=', tipAirdrop.id)
        .where('status', '=', 'open')
        .execute()
      if (raw.message?.ts)
        await updateAirdropMessage(raw.team.id, channelId, raw.message.ts, tipAirdrop.id).catch(
          (error) => {
            console.error('Failed to update Slack airdrop message:', error)
          },
        )
    }

    const remainingAmount = tipAirdrop.total_amount - tipAirdrop.claimed_amount
    if (
      tipAirdrop.status !== 'open' ||
      Date.parse(tipAirdrop.ends_at) <= Date.now() ||
      remainingAmount <= 0
    ) {
      await closeAirdrop()
      return
    }

    const recipient = await getConnectedSlackMember(
      ctx.db,
      tipAirdrop.workspace_id,
      event.user.userId,
    )
    if (!recipient) {
      await postConnectLink(tipEvent, ctx)
      return
    }
    const amount = Math.min(tipAirdrop.claim_amount, remainingAmount)
    const idempotencyKey = `tip_airdrop:${tipAirdrop.id}:claim:${event.user.userId}:${slackActionInteractionId(event) ?? Nanoid.generate()}`
    const result = await Tip.handleTipRequest(env, {
      amount,
      idempotencyKey,
      memo: tipAirdrop.name,
      provider: 'slack',
      providerChannelId: channelId,
      providerId: raw.team.id,
      providerThreadId: ctx.threadTs,
      recipientProviderUserId: event.user.userId,
      senderProviderUserId: tipAirdrop.creator_provider_user_id,
      source: 'command',
      tokenAddress: tipAirdrop.token_address,
      workspaceProviderId: raw.team.id,
    })
    if (result.ok && result.status === 'duplicate') return
    if (!result.ok) {
      await closeAirdrop()
      return
    }

    const now = new Date().toISOString()
    await ctx.db
      .insertInto('tip_airdrop_claim')
      .values({
        airdrop_id: tipAirdrop.id,
        amount,
        created_at: now,
        id: Nanoid.generate(),
        idempotency_key: idempotencyKey,
        recipient_member_id: recipient.memberId,
        updated_at: now,
      })
      .execute()
      .catch((error) => {
        if (!isUniqueConstraintError(error)) throw error
      })
    await ctx.db
      .updateTable('tip_airdrop')
      .set({
        claimed_amount: sql<number>`min("total_amount", "claimed_amount" + ${amount})`,
        ended_at: sql<
          string | null
        >`case when "claimed_amount" + ${amount} >= "total_amount" then ${now} else null end`,
        status: sql<
          DB_gen.Selectable.tip_airdrop['status']
        >`case when "claimed_amount" + ${amount} >= "total_amount" then 'ended' else 'open' end`,
        updated_at: now,
      })
      .where('id', '=', tipAirdrop.id)
      .execute()

    if (raw.message?.ts)
      await updateAirdropMessage(raw.team.id, channelId, raw.message.ts, tipAirdrop.id).catch(
        (error) => {
          console.error('Failed to update Slack airdrop message:', error)
        },
      )
  },
  async tip_ask_option(event) {
    const payload = z
      .object({
        nonce: z.string().min(1).optional(),
        reaction: z.enum(tipAskReactionNames),
        tipAskId: z.string().min(1),
      })
      .safeParse(
        (() => {
          try {
            return JSON.parse(event.value ?? 'null')
          } catch {
            return null
          }
        })(),
      )
    if (!payload.success) return

    const raw = z.parse(
      z.object({
        channel: z.object({ id: z.string().min(1) }),
        team: z.object({ id: z.string().min(1) }),
      }),
      event.raw,
    )
    const db = DB.create(env.DB)
    const tipAsk = await db
      .selectFrom('tip_ask')
      .innerJoin('workspace', 'workspace.id', 'tip_ask.workspace_id')
      .innerJoin('member as requester', 'requester.id', 'tip_ask.requester_member_id')
      .select([
        'requester.provider_user_id as requester_provider_user_id',
        'tip_ask.beneficiary_provider_user_id',
        'tip_ask.chain_id',
        'tip_ask.closed_at',
        'tip_ask.creator_fee_basis_points',
        'tip_ask.dollar_amount',
        'tip_ask.id',
        'tip_ask.memo',
        'tip_ask.money_with_wings_amount',
        'tip_ask.moneybag_amount',
        'tip_ask.provider_channel_id',
        'tip_ask.provider_id',
        'tip_ask.provider_message_ts',
        'tip_ask.token_address',
        'workspace.default_token_address',
        'workspace.id as workspace_id',
        'workspace.provider_id as workspace_provider_id',
      ])
      .where('tip_ask.id', '=', payload.data.tipAskId)
      .where('tip_ask.provider_id', '=', raw.team.id)
      .executeTakeFirst()
    if (!tipAsk) return
    if (tipAsk.closed_at) {
      await postSlackEphemeral(
        tipAsk.provider_id,
        raw.channel.id,
        event.user.userId,
        'Tip jar is closed.',
      )
      return
    }

    const tipEvent = {
      channel: getChat().channel(`slack:${tipAsk.provider_channel_id}`),
      user: event.user,
    } satisfies TipEvent
    const ctx = {
      db,
      provider: { id: tipAsk.provider_id, type: 'slack' },
      text: '',
    } satisfies HandlerContext
    const idempotencyKey = tipAskIdempotencyKey({
      interactionId: slackActionInteractionId(event),
      nonce: payload.data.nonce,
      providerUserId: event.user.userId,
      reaction: payload.data.reaction,
      tipAskId: tipAsk.id,
    })
    const beneficiaryIdempotencyKey = tipAsk.beneficiary_provider_user_id
      ? `${idempotencyKey}:beneficiary`
      : idempotencyKey
    const result = await Tip.handleTipRequest(env, {
      amount: tipAskAmount(tipAsk, payload.data.reaction),
      idempotencyKey: beneficiaryIdempotencyKey,
      memo: tipAsk.memo,
      provider: 'slack',
      providerChannelId: tipAsk.provider_channel_id,
      providerId: tipAsk.provider_id,
      recipientProviderUserId:
        tipAsk.beneficiary_provider_user_id ?? tipAsk.requester_provider_user_id,
      senderProviderUserId: event.user.userId,
      source: 'command',
      tokenAddress: tipAsk.token_address,
      workspaceProviderId: tipAsk.workspace_provider_id,
    }).catch(
      (error) =>
        ({
          code: 'failed',
          message: error instanceof Error ? error.message : 'Tip jar payment failed.',
          ok: false,
        }) satisfies Tip.TipResult,
    )

    if (result.ok) {
      const feeAmount = Math.floor(
        (tipAskAmount(tipAsk, payload.data.reaction) * tipAsk.creator_fee_basis_points) / 10_000,
      )
      if (feeAmount > 0 && event.user.userId !== tipAsk.requester_provider_user_id)
        await Tip.handleTipRequest(env, {
          amount: feeAmount,
          idempotencyKey: `${idempotencyKey}:creator_fee`,
          memo: tipAsk.memo,
          provider: 'slack',
          providerChannelId: tipAsk.provider_channel_id,
          providerId: tipAsk.provider_id,
          recipientProviderUserId: tipAsk.requester_provider_user_id,
          senderProviderUserId: event.user.userId,
          source: 'command',
          tokenAddress: tipAsk.token_address,
          workspaceProviderId: tipAsk.workspace_provider_id,
        }).catch((error) => {
          console.error('Failed to send tip jar creator fee:', error)
        })
      await updateTipAskMessage(tipAsk.provider_id, { tipAskId: tipAsk.id }).catch((error) => {
        console.error('Failed to update Slack tip jar:', error)
      })
      return
    }

    if (result.code === 'confirmation_required' && result.confirmUrl) {
      await postSlackPaymentConfirmation(tipEvent, ctx, result.confirmUrl, {
        label: 'Confirm payment',
        message: 'Tipbot needs your approval to send this payment.',
      })
      return
    }
    if (result.code === 'sender_unconnected' || result.code === 'missing_sender_access_key') {
      await postConnectLink(tipEvent, ctx)
      return
    }
    await postSlackEphemeral(
      tipAsk.provider_id,
      raw.channel.id,
      event.user.userId,
      (() => {
        if (result.code === 'self_tip')
          return 'Payment not sent. Cannot send a payment to yourself.'
        if (result.code === 'insufficient_funds')
          return 'Payment not sent. Your wallet has insufficient funds.'
        if (result.code === 'pending') return 'Payment still sending.'
        return result.message ?? 'Payment failed.'
      })(),
    )
  },
  async tip_ask_close(event) {
    const payload = z.object({ tipAskId: z.string().min(1) }).safeParse(
      (() => {
        try {
          return JSON.parse(event.value ?? 'null')
        } catch {
          return null
        }
      })(),
    )
    if (!payload.success) return

    const raw = z.parse(
      z.object({
        channel: z.object({ id: z.string().min(1) }),
        team: z.object({ id: z.string().min(1) }),
      }),
      event.raw,
    )
    const db = DB.create(env.DB)
    const tipAsk = await db
      .selectFrom('tip_ask')
      .innerJoin('member as requester', 'requester.id', 'tip_ask.requester_member_id')
      .select([
        'requester.provider_user_id as requester_provider_user_id',
        'tip_ask.closed_at',
        'tip_ask.id',
        'tip_ask.provider_channel_id',
        'tip_ask.provider_id',
      ])
      .where('tip_ask.id', '=', payload.data.tipAskId)
      .where('tip_ask.provider_id', '=', raw.team.id)
      .executeTakeFirst()
    if (!tipAsk) return
    if (tipAsk.requester_provider_user_id !== event.user.userId) {
      await postSlackEphemeral(
        tipAsk.provider_id,
        raw.channel.id,
        event.user.userId,
        'Only the creator can close this tip jar.',
      )
      return
    }
    if (!tipAsk.closed_at) {
      const now = new Date().toISOString()
      await db
        .updateTable('tip_ask')
        .set({ closed_at: now, updated_at: now })
        .where('id', '=', tipAsk.id)
        .where('closed_at', 'is', null)
        .execute()
      await updateTipAskMessage(tipAsk.provider_id, { tipAskId: tipAsk.id })
    }
  },
  async tip_ask_option_dollar(event) {
    await actions.tip_ask_option(event)
  },
  async tip_ask_option_money_with_wings(event) {
    await actions.tip_ask_option(event)
  },
  async tip_ask_option_moneybag(event) {
    await actions.tip_ask_option(event)
  },
  async tip_raffle_buy_1(event) {
    await handleTipRaffleBuy(event, { ticketCount: 1 })
  },
  async tip_raffle_buy_5(event) {
    await handleTipRaffleBuy(event, { ticketCount: 5 })
  },
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

    const reactionTipConfigs = await getReactionTipConfigs(DB.create(env.DB), workspace.id)
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
            id: 'reaction_tip_configs',
            initialValue: reactionTipConfigs
              .map((config) => `:${config.emoji}: ${formatAmount(config.amount)}`)
              .join(', '),
            label: 'Reaction tips',
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
  async confirm_tip(event) {
    const token = z.safeParse(z.string().min(1), event.value)
    if (!token.success) return

    const pending = await (async () => {
      // Load the pending preview created by the Slack confirmation prompt.
      const state = createCloudflareState({
        name: 'tipbot',
        namespace: env.CHAT_STATE,
        shardKey(threadId) {
          return threadId.split(':', 1)[0] || 'default'
        },
      })
      await state.connect()
      const value = await state.get<PendingSlackTip>(`pending_tip:${token.data}`)
      await state.disconnect()
      return value
    })()
    if (!pending) {
      await event.adapter.deleteMessage(event.threadId, event.messageId)
      return
    }
    if (pending.senderProviderUserId !== event.user.userId) return

    await event.adapter.deleteMessage(event.threadId, event.messageId)
    const tipEvent = {
      channel: getChat().channel(pending.providerChannelId),
      threadTs: pending.providerThreadId,
      user: event.user,
    } satisfies TipEvent
    const ctx = {
      db: DB.create(env.DB),
      provider: { id: pending.providerId, type: 'slack' },
      text: '',
      threadTs: pending.providerThreadId,
    } satisfies HandlerContext
    const result = await Tip.handleTipBatchRequest(env, {
      amount: pending.amount,
      idempotencyKey: pending.idempotencyKey,
      memo: pending.memo,
      provider: 'slack',
      providerChannelId: pending.providerChannelId,
      providerId: pending.providerId,
      providerThreadId: pending.providerThreadId,
      recipients: pending.recipients,
      senderProviderUserId: pending.senderProviderUserId,
      settingsProviderId: pending.settingsProviderId,
      skippedRecipients: pending.skippedRecipients,
      source: pending.source,
      tokenAddress: pending.tokenAddress,
      usergroupId: pending.usergroupId,
      usergroupLabel: pending.usergroupLabel,
      workspaceProviderId: pending.workspaceProviderId,
    }).catch(
      (error) =>
        ({
          code: 'failed',
          message: error instanceof Error ? error.message : 'Command failed.',
          ok: false,
        }) satisfies Tip.TipBatchResult,
    )
    await (async () => {
      // Delete the pending preview after one confirmation attempt so stale Slack buttons cannot
      // be retried.
      const state = createCloudflareState({
        name: 'tipbot',
        namespace: env.CHAT_STATE,
        shardKey(threadId) {
          return threadId.split(':', 1)[0] || 'default'
        },
      })
      await state.connect()
      await state.delete(`pending_tip:${token.data}`)
      await state.disconnect()
    })()
    await postTipResult(tipEvent, ctx, result, { ...pending, threadTs: pending.providerThreadId })
  },
} as const satisfies Record<
  (typeof actionNames)[number],
  (event: chat.ActionEvent) => Promise<void>
>

const modalSubmits = {
  async tip_airdrop_create(event) {
    const metadata = z.parse(
      z.object({
        channelId: z.string().min(1),
        providerId: z.string().min(1),
        threadTs: z.string().min(1).optional(),
      }),
      JSON.parse(event.privateMetadata ?? '{}'),
    )
    const name = (() => {
      // Empty name preserves the default Tipbot airdrop; long names are likely mistakes.
      const value = (event.values.name ?? '').trim().replace(/\s+/g, ' ')
      if (value.length > 80) return null
      return value || 'Tipbot'
    })()
    const amount = Tip.parseAmount(event.values.amount ?? '')
    const duration = tipRaffleDurationOptions.find(
      (option) => option.value === event.values.duration,
    )
    const errors: Record<string, string> = {}
    if (!name) errors.name = 'Name must be at most 80 characters.'
    if (amount === null)
      errors.amount = 'Enter a positive amount with up to 6 decimal places. Example: 0.10'
    if (!duration) errors.duration = 'Choose a duration.'
    if (Object.keys(errors).length > 0) return { action: 'errors' as const, errors }
    if (amount === null || !duration || !name) return

    const db = DB.create(env.DB)
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', 'slack')
      .where('provider_id', '=', metadata.providerId)
      .executeTakeFirst()
    if (!workspace) return

    const creator = await db
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .innerJoin('account', 'account.id', 'provider_identity.account_id')
      .select(['account.address', 'member.id'])
      .where('member.workspace_id', '=', workspace.id)
      .where('member.provider_user_id', '=', event.user.userId)
      .where('provider_identity.account_id', 'is not', null)
      .executeTakeFirst()
    if (!creator) return

    const tokenAddress = Address.checksum(
      workspace.default_token_address ?? Tempo.addressLookup.pathUsd,
    )
    const balance = await Actions.token.getBalance(
      createClient({
        chain: Tempo.getChain(workspace.chain_id),
        transport: http(Tempo.getRpcUrl(env, workspace.chain_id)),
      }),
      { account: creator.address as Address.Address, token: tokenAddress as Address.Address },
    )
    if (BigInt(amount) > balance) {
      await postConnectLink(
        {
          channel: getChat().channel(`slack:${metadata.channelId}`),
          threadTs: metadata.threadTs,
          user: event.user,
        },
        {
          db,
          forceConnectRefresh: true,
          provider: { id: metadata.providerId, type: 'slack' },
          text: '',
          threadTs: metadata.threadTs,
        },
      )
      return
    }
    const accessKey = await Tip.checkReusableTipAccessKey(env, {
      amount,
      chainId: workspace.chain_id,
      memo: name,
      providerUserId: event.user.userId,
      tokenAddress,
      workspaceId: workspace.id,
    })
    if (!accessKey.ok) {
      if (
        accessKey.code === 'sender_unconnected' ||
        accessKey.code === 'missing_sender_access_key'
      ) {
        await postConnectLink(
          {
            channel: getChat().channel(`slack:${metadata.channelId}`),
            threadTs: metadata.threadTs,
            user: event.user,
          },
          {
            db,
            forceConnectRefresh: accessKey.code === 'missing_sender_access_key',
            provider: { id: metadata.providerId, type: 'slack' },
            text: '',
            threadTs: metadata.threadTs,
          },
        )
        return
      }
      return { action: 'errors' as const, errors: { amount: 'Amount exceeds your balance.' } }
    }

    const installation = await getSlack().getInstallation(metadata.providerId)
    if (!installation) return

    const now = new Date()
    const tipAirdrop = {
      chain_id: workspace.chain_id,
      claim_amount: airdropClaimAmount,
      claimed_amount: 0,
      created_at: now.toISOString(),
      creator_member_id: creator.id,
      ended_at: null,
      ends_at: new Date(now.getTime() + duration.ms).toISOString(),
      id: Nanoid.generate(),
      name,
      provider_channel_id: metadata.channelId,
      provider_id: metadata.providerId,
      provider_message_ts: 'pending',
      status: 'open',
      token_address: tokenAddress,
      total_amount: amount,
      updated_at: now.toISOString(),
      workspace_id: workspace.id,
    } satisfies DB_gen.Insertable.tip_airdrop
    const message = await tipAirdropMessage(db, {
      ...tipAirdrop,
      claimed_provider_user_ids: [],
      workspace_default_token_address: workspace.default_token_address,
    })
    const body = new URLSearchParams()
    body.set('blocks', JSON.stringify(message.blocks))
    body.set('channel', metadata.channelId)
    body.set('text', message.text)
    if (metadata.threadTs) body.set('thread_ts', metadata.threadTs)
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
    await db
      .insertInto('tip_airdrop')
      .values({ ...tipAirdrop, provider_message_ts: json.ts })
      .execute()
  },
  async tip_raffle_create(event) {
    const metadata = z.parse(
      z.object({
        channelId: z.string().min(1),
        providerId: z.string().min(1),
        threadTs: z.string().min(1).optional(),
      }),
      JSON.parse(event.privateMetadata ?? '{}'),
    )
    const memo = (event.values.memo ?? '').trim()
    const ticketAmount = Tip.parseAmount(event.values.ticket_amount ?? '')
    const duration = tipRaffleDurationOptions.find(
      (option) => option.value === event.values.duration,
    )
    const errors: Record<string, string> = {}
    if (!memo) errors.memo = 'Enter a raffle title.'
    else if (Tip.isTransferMemoTooLong(memo)) errors.memo = 'Title must be at most 32 bytes.'
    if (ticketAmount === null)
      errors.ticket_amount = 'Enter a positive amount with up to 6 decimal places. Example: 0.10'
    if (!duration) errors.duration = 'Choose a duration.'
    if (Object.keys(errors).length > 0) return { action: 'errors' as const, errors }
    if (ticketAmount === null || !duration) return

    const db = DB.create(env.DB)
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', 'slack')
      .where('provider_id', '=', metadata.providerId)
      .executeTakeFirst()
    if (!workspace) return

    const creator = await getConnectedSlackMember(db, workspace.id, event.user.userId)
    if (!creator) return

    const installation = await getSlack().getInstallation(metadata.providerId)
    if (!installation) return

    const now = new Date()
    const tokenAddress = workspace.default_token_address ?? Tempo.addressLookup.pathUsd
    const tipRaffle = {
      chain_id: workspace.chain_id,
      created_at: now.toISOString(),
      creator_member_id: creator.memberId,
      ended_at: null,
      ends_at: new Date(now.getTime() + duration.ms).toISOString(),
      failed_ticket_count: 0,
      id: Nanoid.generate(),
      memo,
      provider_channel_id: metadata.channelId,
      provider_id: metadata.providerId,
      provider_message_ts: 'pending',
      settled_amount: 0,
      status: 'open',
      ticket_amount: ticketAmount,
      token_address: tokenAddress,
      updated_at: now.toISOString(),
      winner_member_id: null,
      winning_ticket_number: null,
      workspace_id: workspace.id,
    } satisfies DB_gen.Insertable.tip_raffle
    const message = await tipRaffleMessage(db, {
      ...tipRaffle,
      creator_provider_user_id: event.user.userId,
      winner_provider_user_id: null,
      workspace_default_token_address: workspace.default_token_address,
    })
    const body = new URLSearchParams()
    body.set('blocks', JSON.stringify(message.blocks))
    body.set('channel', metadata.channelId)
    body.set('text', message.text)
    if (metadata.threadTs) body.set('thread_ts', metadata.threadTs)
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
    await db
      .insertInto('tip_raffle')
      .values({ ...tipRaffle, provider_message_ts: json.ts })
      .execute()
  },
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
    const reactionTipConfigs = (() => {
      const configs: ReactionTipConfig[] = []
      for (const rawPart of (event.values.reaction_tip_configs ?? '').split(/[\n,]+/)) {
        const part = rawPart.trim()
        if (!part) continue
        const match = part.match(
          /^:?([a-z0-9_+-]+):?\s*(?:(?:->|=|→)\s*)?(\$?(?:0|[1-9]\d*)(?:\.\d+)?)$/i,
        )
        if (!match) return null
        const amount = Tip.parseAmount(match[2]!)
        const emoji = match[1]!.toLowerCase()
        if (amount === null || configs.some((config) => config.emoji === emoji)) return null
        configs.push({ amount, emoji })
      }
      if (configs.length === 0) return null
      return configs
    })()
    const errors: Record<string, string> = {}
    if (chainId === null) errors.network = 'Choose Mainnet or Testnet.'
    if (tokenAddress === null) errors.default_token = 'Choose a default token.'
    if (amount === null)
      errors.default_amount = 'Enter a positive amount with up to 6 decimal places. Example: 0.005'
    if (!reactionTipConfigs)
      errors.reaction_tip_configs =
        'Enter emoji and positive amount pairs. Example: :money_with_wings: 0.001, :dollar: 0.01, :moneybag: 0.10'
    else if (reactionTipConfigs.some((config) => isReceiptBoostReaction(config.emoji)))
      errors.reaction_tip_configs = `:${receiptBoostReaction}: is reserved for boosting receipts.`
    else if (
      !(await (async () => {
        const customEmojiNames = reactionTipConfigs.filter(
          (config) => Emoji.replaceEmojiShortcodes(`:${config.emoji}:`) === `:${config.emoji}:`,
        )
        if (customEmojiNames.length === 0) return true

        const installation = await getSlack().getInstallation(metadata.providerId)
        if (!installation) return false
        const response = await getSlack().withBotToken(installation.botToken, () =>
          fetch(`${env.SLACK_API_URL}/emoji.list`, {
            headers: { authorization: `Bearer ${installation.botToken}` },
            method: 'GET',
          }),
        )
        const json = z.parse(
          z.object({
            emoji: z.record(z.string(), z.string()).optional(),
            ok: z.boolean().optional(),
          }),
          await response.json(),
        )
        return Boolean(json.ok && customEmojiNames.every((config) => json.emoji?.[config.emoji]))
      })())
    )
      errors.reaction_tip_configs = 'Choose emojis that exist in this Slack workspace.'
    if (chainId !== null && tokenAddress !== null && !Tempo.isAllowedToken(chainId, tokenAddress))
      errors.default_token = 'This token isn’t available on the selected network.'
    if (Object.keys(errors).length > 0) return { action: 'errors' as const, errors }
    if (amount === null || chainId === null || tokenAddress === null || !reactionTipConfigs) return

    const now = new Date().toISOString()
    const db = DB.create(env.DB)
    await db
      .updateTable('workspace')
      .set({
        chain_id: chainId,
        default_amount: amount,
        default_token_address: tokenAddress,
        updated_at: now,
      })
      .where('provider', '=', 'slack')
      .where('provider_id', '=', metadata.providerId)
      .execute()

    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', 'slack')
      .where('provider_id', '=', metadata.providerId)
      .executeTakeFirstOrThrow()
    await db.deleteFrom('reaction_tip_config').where('workspace_id', '=', workspace.id).execute()
    await db
      .insertInto('reaction_tip_config')
      .values(
        reactionTipConfigs.map((config) => ({
          amount: config.amount,
          created_at: now,
          emoji: config.emoji,
          id: Nanoid.generate(),
          updated_at: now,
          workspace_id: workspace.id,
        })),
      )
      .execute()
    if (event.relatedMessage)
      await event.relatedMessage.edit(
        await configCard(db, workspace, { canEdit: true, updated: true }),
      )
  },
} as const satisfies Record<
  (typeof modalSubmitNames)[number],
  (event: chat.ModalSubmitEvent) => Promise<chat.ModalResponse | void | undefined>
>

const handlers = {
  async airdrop(event, ctx) {
    if (Slack.isDMChannelId(event.channel.id)) {
      await postPrivateReply(event, event.user, 'Airdrops can only be opened in channels.')
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

    const creator = await getConnectedSlackMember(ctx.db, workspace.id, event.user.userId)
    if (!creator) {
      await postPrivateReply(
        event,
        event.user,
        `Connect to Tipbot before opening an airdrop. Run \`${getSlackCommand(env.HOST)} connect\` first.`,
      )
      return
    }

    const tokenAddress = workspace.default_token_address ?? Tempo.addressLookup.pathUsd
    const token = await Tapimo.getTokenMetadata(workspace.chain_id, tokenAddress)
    if (!('openModal' in event)) {
      await postPrivateReply(
        event,
        event.user,
        `Use \`${getSlackCommand(env.HOST)} airdrop\` to open the airdrop form.`,
      )
      return
    }
    await event.openModal(
      chat.Modal({
        callbackId: 'tip_airdrop_create',
        children: [
          chat.TextInput({
            id: 'name',
            initialValue: ctx.text.trim().replace(/\s+/g, ' ') || 'Tipbot',
            label: 'Airdrop name',
            placeholder: 'Tipbot',
          }),
          chat.TextInput({
            id: 'amount',
            initialValue: '0.10',
            label: `Pot amount (${token.symbol})`,
            placeholder: '0.10',
          }),
          chat.Select({
            id: 'duration',
            initialOption: '5m',
            label: 'Duration',
            options: tipRaffleDurationOptions.map((option) =>
              chat.SelectOption({ label: option.label, value: option.value }),
            ),
          }),
        ],
        privateMetadata: JSON.stringify({
          channelId: Slack.getChannelId(event.channel.id),
          providerId: ctx.provider.id,
          threadTs: ctx.threadTs,
        }),
        submitLabel: 'Start airdrop',
        title: 'Start airdrop',
      }),
    )
  },
  async raffle(event, ctx) {
    if (Slack.isDMChannelId(event.channel.id)) {
      await postPrivateReply(event, event.user, 'Raffles can only be opened in channels.')
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

    const creator = await getConnectedSlackMember(ctx.db, workspace.id, event.user.userId)
    if (!creator) {
      await postPrivateReply(
        event,
        event.user,
        `Connect to Tipbot before opening a raffle. Run \`${getSlackCommand(env.HOST)} connect\` first.`,
      )
      return
    }

    const tokenAddress = workspace.default_token_address ?? Tempo.addressLookup.pathUsd
    const token = await Tapimo.getTokenMetadata(workspace.chain_id, tokenAddress)
    if (!('openModal' in event)) return
    await event.openModal(
      chat.Modal({
        callbackId: 'tip_raffle_create',
        children: [
          chat.TextInput({
            id: 'memo',
            label: 'Raffle title',
            placeholder: 'team lunch',
          }),
          chat.TextInput({
            id: 'ticket_amount',
            initialValue: '0.01',
            label: `Ticket price (${token.symbol})`,
            placeholder: '0.01',
          }),
          chat.Select({
            id: 'duration',
            initialOption: '5m',
            label: 'Duration',
            options: tipRaffleDurationOptions.map((option) =>
              chat.SelectOption({ label: option.label, value: option.value }),
            ),
          }),
        ],
        privateMetadata: JSON.stringify({
          channelId: Slack.getChannelId(event.channel.id),
          providerId: ctx.provider.id,
          threadTs: ctx.threadTs,
        }),
        submitLabel: 'Start raffle',
        title: 'Start raffle',
      }),
    )
  },
  async jar(event, ctx) {
    const parsed = (() => {
      const beneficiary = ctx.text.match(/^<@([A-Z0-9_]+)(?:\|[^>]+)?>\s*(?:for\s+([\s\S]*))?$/i)
      if (beneficiary)
        return {
          beneficiaryProviderUserId: beneficiary[1]!,
          memo: beneficiary[2]?.trim() || null,
        }
      const value = ctx.text
        .replace(/^for\s+/i, '')
        .trim()
        .replace(/\.+$/, '')
        .trim()
      return { beneficiaryProviderUserId: event.user.userId, memo: value || null }
    })()
    if (Slack.isDMChannelId(event.channel.id)) {
      await postPrivateReply(event, event.user, 'Tip jars can only be opened in channels.')
      return
    }
    if (parsed.memo && Tip.isTransferMemoTooLong(parsed.memo)) {
      await postPrivateReply(
        event,
        event.user,
        'Tip jar not opened. Memo must be at most 32 bytes; shorten the text after `jar`.',
      )
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

    const requester = await getConnectedSlackMember(ctx.db, workspace.id, event.user.userId)
    if (!requester) {
      await postPrivateReply(
        event,
        event.user,
        `Connect to Tipbot before opening a tip jar. Run \`${getSlackCommand(env.HOST)} connect\` first.`,
      )
      return
    }

    const configs = await getReactionTipConfigs(ctx.db, workspace.id)
    const configByReaction = new Map(configs.map((config) => [config.emoji, config.amount]))
    const amounts = {
      dollar: configByReaction.get('dollar'),
      money_with_wings: configByReaction.get('money_with_wings'),
      moneybag: configByReaction.get('moneybag'),
    }
    if (!amounts.dollar || !amounts.money_with_wings || !amounts.moneybag) {
      await postPrivateReply(
        event,
        event.user,
        'Tip jar not opened. Configure money_with_wings, dollar, and moneybag reaction tip amounts first.',
      )
      return
    }

    const installation = await getSlack().getInstallation(ctx.provider.id)
    if (!installation) return
    const now = new Date().toISOString()
    const tipAskId = Nanoid.generate()
    const tipAsk = {
      beneficiary_provider_user_id:
        parsed.beneficiaryProviderUserId === event.user.userId
          ? null
          : parsed.beneficiaryProviderUserId,
      chain_id: workspace.chain_id,
      closed_at: null,
      created_at: now,
      creator_fee_basis_points: parsed.beneficiaryProviderUserId === event.user.userId ? 0 : 100,
      dollar_amount: amounts.dollar,
      id: tipAskId,
      memo: parsed.memo,
      money_with_wings_amount: amounts.money_with_wings,
      moneybag_amount: amounts.moneybag,
      provider_channel_id: Slack.getChannelId(event.channel.id),
      provider_id: ctx.provider.id,
      provider_message_ts: 'pending',
      requester_member_id: requester.memberId,
      token_address: workspace.default_token_address ?? Tempo.addressLookup.pathUsd,
      updated_at: now,
      workspace_id: workspace.id,
    } satisfies DB_gen.Insertable.tip_ask
    const message = await tipAskMessage(ctx.db, {
      ...tipAsk,
      image_files: ctx.tipAskImageFiles ?? [],
      requester_provider_user_id: event.user.userId,
      workspace_default_token_address: workspace.default_token_address,
    })
    const body = new URLSearchParams()
    body.set('blocks', JSON.stringify(message.blocks))
    body.set('channel', Slack.getChannelId(event.channel.id))
    body.set('text', message.text)
    if (ctx.threadTs) body.set('thread_ts', ctx.threadTs)
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
    await ctx.db
      .insertInto('tip_ask')
      .values({ ...tipAsk, provider_message_ts: json.ts })
      .execute()
    if (ctx.tipAskImageFiles?.length)
      await ctx.db
        .insertInto('tip_ask_image_file')
        .values(
          ctx.tipAskImageFiles.map((imageFile, position) => ({
            alt_text: imageFile.alt_text,
            id: Nanoid.generate(),
            position,
            provider_file_id: imageFile.provider_file_id,
            tip_ask_id: tipAskId,
          })),
        )
        .execute()
    await postSlackEphemeral(
      ctx.provider.id,
      Slack.getChannelId(event.channel.id),
      event.user.userId,
      'Manage your tip jar.',
      {
        blocks: [
          {
            text: { text: 'Manage your tip jar.', type: 'mrkdwn' },
            type: 'section',
          },
          {
            elements: [
              {
                action_id: 'tip_ask_close',
                style: 'danger',
                text: { emoji: true, text: 'Close tip jar', type: 'plain_text' },
                type: 'button',
                value: JSON.stringify({ tipAskId }),
              },
            ],
            type: 'actions',
          },
        ],
        threadTs: ctx.threadTs,
      },
    ).catch((error) => {
      console.error('Failed to post Slack tip jar controls:', error)
    })
  },
  async balance(event, ctx) {
    if (ctx.text) {
      await postInvalidUsage(event, ctx)
      return
    }
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.settingsProviderId ?? ctx.provider.id)
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
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .innerJoin('account', 'account.id', 'provider_identity.account_id')
      .select('account.address as account_address')
      .where('member.workspace_id', '=', workspace.id)
      .where('member.provider_user_id', '=', event.user.userId)
      .executeTakeFirst()
    if (!member) {
      await postPrivateReply(
        event,
        event.user,
        `No account connected. Run \`@${getSlackBotDisplayName(env.HOST)} connect\` or \`${getSlackCommand(env.HOST)} connect\` first.`,
      )
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
      .where('provider_id', '=', ctx.settingsProviderId ?? ctx.provider.id)
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
        ctx.externalSlackConnect
          ? 'No account connected.'
          : 'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
      )
      return
    }

    const member = await ctx.db
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .select(['member.id', 'member.provider_identity_id', 'provider_identity.account_id'])
      .where('member.workspace_id', '=', workspace.id)
      .where('member.provider_user_id', '=', event.user.userId)
      .executeTakeFirst()
    if (!member) {
      await postPrivateReply(event, event.user, 'No account connected.')
      return
    }
    if (!member.account_id) {
      await postPrivateReply(event, event.user, 'No account connected.')
      return
    }

    await ctx.db.deleteFrom('access_key').where('account_id', '=', member.account_id).execute()
    await ctx.db
      .updateTable('provider_identity')
      .set({ account_id: null, updated_at: new Date().toISOString() })
      .where('id', '=', member.provider_identity_id)
      .execute()
    await postPrivateReply(event, event.user, 'Disconnected')
  },
  async help(event, ctx) {
    if (ctx.externalSlackConnect) {
      const body = new URLSearchParams()
      body.set('channel', event.channel.id.replace(/^slack:/, ''))
      body.set(
        'text',
        [
          `Tipbot commands available here:`,
          `\`@${getSlackBotDisplayName(env.HOST)} connect\` Connect to Tipbot`,
          `\`@${getSlackBotDisplayName(env.HOST)} disconnect\` Disconnect from Tipbot`,
          `\`@${getSlackBotDisplayName(env.HOST)} help\` Show help message`,
          `\`@${getSlackBotDisplayName(env.HOST)} status\` Check connection status`,
          '',
          `Payments in Slack Connect channels aren’t supported yet unless you install the Tipbot app to your workspace.`,
        ].join('\n'),
      )
      await postSlackPrivateReply(
        ctx.channelProviderId ?? ctx.provider.id,
        event.channel.id.replace(/^slack:/, ''),
        event.user.userId,
        body,
        { threadTs: ctx.threadTs },
      )
      return
    }

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
      [`${getSlackCommand(env.HOST)} jar [memo]`, 'Open a tip jar'],
      [`${getSlackCommand(env.HOST)} jar @account for [memo]`, 'Open a tip jar for someone'],
      [`${getSlackCommand(env.HOST)} leaderboard`, 'Show top tippers and recipients'],
      [`${getSlackCommand(env.HOST)} raffle`, 'Start a raffle'],
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
    const reactionTipConfigs = await getReactionTipConfigs(ctx.db, workspace?.id)
    const mentionExampleRows = [
      [`@${getSlackBotDisplayName(env.HOST)} @account`, 'Send default amount'],
      [`@${getSlackBotDisplayName(env.HOST)} balance`, 'Show wallet balance'],
      [`@${getSlackBotDisplayName(env.HOST)} connect`, 'Connect to Tipbot'],
      [`@${getSlackBotDisplayName(env.HOST)} disconnect`, 'Disconnect from Tipbot'],
      [`@${getSlackBotDisplayName(env.HOST)} help`, 'Show help message'],
      [`@${getSlackBotDisplayName(env.HOST)} jar [memo]`, 'Open a tip jar'],
      [
        `@${getSlackBotDisplayName(env.HOST)} jar @account for [memo]`,
        'Open a tip jar for someone',
      ],
      [`@${getSlackBotDisplayName(env.HOST)} leaderboard`, 'Show top tippers and recipients'],
      [`@${getSlackBotDisplayName(env.HOST)} stats`, 'Show your tip stats'],
      [`@${getSlackBotDisplayName(env.HOST)} status`, 'Check connection status'],
      [`@${getSlackBotDisplayName(env.HOST)} @account for coffee`, 'Send default amount with memo'],
      [
        `@${getSlackBotDisplayName(env.HOST)} @account 0.005 for coffee`,
        'Send custom amount with memo',
      ],
      [
        reactionTipConfigs.map((config) => `:${config.emoji}:`).join(' / '),
        'Send by reacting to a message',
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
            [Slack.tableCell('Command'), Slack.tableCell('Description')],
            ...commandRows.map((row) => [
              Slack.tableCell(row[0], { code: true }),
              Slack.tableCell(row[1]),
            ]),
          ],
          type: 'table',
        },
        {
          rows: [
            [Slack.tableCell(' '), Slack.tableCell('Description')],
            ...paymentExampleRows.map((row) => [
              Slack.tableCell(row[0], { code: true }),
              Slack.tableCell(row[1]),
            ]),
          ],
          type: 'table',
        },
        {
          rows: [
            [Slack.tableCell('Interaction'), Slack.tableCell('Description')],
            ...mentionExampleRows.map((row) => [
              Slack.tableCell(row[0], { code: true }),
              Slack.tableCell(row[1]),
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
      { threadTs: ctx.threadTs },
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
        ctx.externalSlackConnect
          ? 'No account connected.'
          : 'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
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
      const channel = ctx.threadTs
        ? getChat().channel(`slack:${Slack.getChannelId(event.channel.id)}:${ctx.threadTs}`)
        : event.channel
      await channel.post('No confirmed tips yet.')
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
            [Slack.tableCell('Rank'), Slack.tableCell('Account'), Slack.tableCell('Tips')],
            ...received.map((row, index) => [
              Slack.tableCell(String(index + 1)),
              Slack.tableUserCell(row.providerUserId),
              Slack.tableCell(String(row.tipCount)),
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
            [Slack.tableCell('Rank'), Slack.tableCell('Account'), Slack.tableCell('Tips')],
            ...sent.map((row, index) => [
              Slack.tableCell(String(index + 1)),
              Slack.tableUserCell(row.providerUserId),
              Slack.tableCell(String(row.tipCount)),
            ]),
          ],
          type: 'table',
        },
      ]),
    )
    body.set('unfurl_links', 'false')
    body.set('unfurl_media', 'false')
    if (ctx.threadTs) body.set('thread_ts', ctx.threadTs)
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
        ctx.externalSlackConnect
          ? 'No account connected.'
          : 'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
      )
      return
    }

    const member = await ctx.db
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .innerJoin('account', 'account.id', 'provider_identity.account_id')
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
      .where('tip.recipient_member_id', '=', member.id)
      .where('tip.confirmed_at', 'is not', null)
      .executeTakeFirstOrThrow()
    const sent = await ctx.db
      .selectFrom('tip')
      .select([
        sql<number>`coalesce(sum("tip"."amount"), 0)`.as('amount'),
        sql<number>`count("tip"."id")`.as('tip_count'),
      ])
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
    const defaultTip = (() => {
      if (ctx.defaultTip) return ctx.defaultTip
      if (!('triggerId' in event) || !event.triggerId) return null
      return {
        idempotencyKey: `command:${ctx.provider.id}:${event.triggerId}`,
        insufficientFundsThreadTs: ctx.threadTs,
        threadTs: ctx.threadTs,
      }
    })()
    if (!defaultTip) {
      await postPrivateReply(event, event.user, 'Payment not sent. Try again.')
      return
    }

    const options = { ...defaultTip, threadTs: defaultTip.threadTs ?? ctx.threadTs }
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.settingsProviderId ?? ctx.provider.id)
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
    if (Tip.isTransferMemoTooLong(parsed.memo)) {
      const suggestion = await (async () => {
        // Best-effort UX sugar: the hard requirement is returning the length error.
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
          if (!value || Tip.isTransferMemoTooLong(value)) return null
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
      await postPrivateReply(
        event,
        event.user,
        `Payment not sent. Memo must be at most 32 bytes; shorten the text after \`for\`.${suggestion ? ` Try: \`${suggestion}\`.` : ''}`,
      )
      if (options.threadTs)
        await Slack.setAssistantThreadStatus({
          apiUrl: env.SLACK_API_URL,
          channelId: event.channel.id,
          getInstallation: (providerId) => getSlack().getInstallation(providerId),
          providerId: ctx.channelProviderId ?? ctx.provider.id,
          status: '',
          threadTs: options.threadTs,
        }).catch(() => {
          // Best effort only. Payment/error flow must not depend on Slack assistant UI cleanup.
        })
      return
    }
    const shouldResolvePlan =
      parsed.recipients.length !== 1 ||
      Boolean(parsed.usergroups?.length) ||
      (await (async () => {
        // Single-recipient Slack Connect tips still need workspace-safe recipient resolution.
        const installation = await getSlack().getInstallation(
          ctx.channelProviderId ?? ctx.provider.id,
        )
        if (!installation) return false
        return (
          await Slack.getConversationInfo({
            apiUrl: env.SLACK_API_URL,
            botToken: installation.botToken,
            channelId: event.channel.id,
            withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
          })
        ).isShared
      })().catch(() => false))
    const plan = !shouldResolvePlan
      ? {
          ok: true as const,
          previewRequired: false,
          recipients: parsed.recipients,
          skippedRecipients: [],
        }
      : await resolveSlackTipPlan(event, ctx, parsed, {
          amountEach: parsed.amount ?? workspace?.default_amount,
        })
    if (!plan.ok) {
      await postPrivateReply(event, event.user, plan.message, {
        providerId: ctx.channelProviderId ?? ctx.provider.id,
      })
      return
    }
    if (plan.previewRequired) {
      await postSlackTipPreview(event, {
        amount: parsed.amount,
        amountText: parsed.amount
          ? formatCurrencyAmount(formatAmount(parsed.amount), 'USD')
          : workspace?.default_amount
            ? formatCurrencyAmount(formatAmount(workspace.default_amount), 'USD')
            : 'the default amount',
        idempotencyKey: options.idempotencyKey,
        memo: parsed.memo,
        providerChannelId: event.channel.id,
        providerId: ctx.channelProviderId ?? ctx.provider.id,
        providerThreadId: options.threadTs,
        recipients: plan.recipients,
        senderProviderUserId: event.user.userId,
        settingsProviderId: ctx.settingsProviderId,
        skippedRecipients: plan.skippedRecipients,
        source: options.mention ? 'mention' : 'command',
        tokenAddress: tokenAddress ?? undefined,
        usergroupId: plan.usergroupId,
        usergroupLabel: plan.usergroupLabel,
        workspaceProviderId: ctx.provider.id,
      })
      return
    }

    if (options.threadTs)
      void Slack.setAssistantThreadStatus({
        apiUrl: env.SLACK_API_URL,
        channelId: event.channel.id,
        getInstallation: (providerId) => getSlack().getInstallation(providerId),
        loadingMessages: ['Sending tip'],
        providerId: ctx.channelProviderId ?? ctx.provider.id,
        status: 'is sending a tip',
        threadTs: options.threadTs,
      }).catch(() => {
        // Best effort only. Payment flow must not depend on Slack assistant UI.
      })
    try {
      const result = await (
        plan.recipients.length === 1 && !plan.usergroupId
          ? Tip.handleTipRequest(env, {
              amount: parsed.amount,
              idempotencyKey: options.idempotencyKey,
              memo: parsed.memo,
              provider: ctx.provider.type,
              providerChannelId: event.channel.id,
              providerId: ctx.channelProviderId ?? ctx.provider.id,
              providerThreadId: options.threadTs,
              recipientProviderLabel: plan.recipients[0]?.recipientProviderLabel,
              recipientProviderUserId: plan.recipients[0]!.recipientProviderUserId,
              recipientProviderWorkspaceId: plan.recipients[0]?.recipientProviderWorkspaceId,
              senderProviderUserId: event.user.userId,
              settingsProviderId: ctx.settingsProviderId,
              source: options.mention ? 'mention' : 'command',
              tokenAddress: tokenAddress ?? undefined,
              workspaceProviderId: ctx.provider.id,
            })
          : Tip.handleTipBatchRequest(env, {
              amount: parsed.amount,
              idempotencyKey: options.idempotencyKey,
              memo: parsed.memo,
              provider: ctx.provider.type,
              providerChannelId: event.channel.id,
              providerId: ctx.channelProviderId ?? ctx.provider.id,
              providerThreadId: options.threadTs,
              recipients: plan.recipients,
              senderProviderUserId: event.user.userId,
              settingsProviderId: ctx.settingsProviderId,
              skippedRecipients: plan.skippedRecipients,
              source: options.mention ? 'mention' : 'command',
              tokenAddress: tokenAddress ?? undefined,
              usergroupId: plan.usergroupId,
              usergroupLabel: plan.usergroupLabel,
              workspaceProviderId: ctx.provider.id,
            })
      ).catch(
        (error) =>
          ({
            code: 'failed',
            message: error instanceof Error ? error.message : 'Command failed.',
            ok: false,
          }) satisfies Tip.TipResult,
      )

      if (result.ok && 'recipients' in result) {
        await postTipResult(event, ctx, result, {
          skippedRecipients: plan.skippedRecipients,
          threadTs: options.threadTs,
          usergroupId: plan.usergroupId,
          usergroupLabel: plan.usergroupLabel,
        })
      } else if (result.ok && result.status === 'queued') {
        const messageTs = await postSlackQueuedTipMessage(ctx, result, {
          channelId: event.channel.id,
          mentionUser: (providerUserId) => event.channel.mentionUser(providerUserId),
          recipientProviderWorkspaceId: plan.recipients[0]?.recipientProviderWorkspaceId,
          threadTs: options.threadTs,
        })
        await Tip.recordPendingTipMessage(env, {
          pendingTipId: result.pendingTipId,
          providerMessageTs: messageTs,
        })
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
          await postSlackPaymentConfirmation(event, ctx, result.confirmUrl, {
            label: 'Confirm payment',
            message: 'Tipbot needs your approval to send this payment.',
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
            return `Payment not sent. ${event.channel.mentionUser(result.recipientProviderUserId ?? plan.recipients[0]!.recipientProviderUserId)} needs to connect Tipbot before receiving payments.`
          if (result.code === 'pending') return 'Payment still sending.'
          if (result.code === 'insufficient_funds')
            return 'Payment not sent. Your wallet has insufficient funds.'
          return result.message ?? 'Payment failed.'
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
        await Slack.setAssistantThreadStatus({
          apiUrl: env.SLACK_API_URL,
          channelId: event.channel.id,
          getInstallation: (providerId) => getSlack().getInstallation(providerId),
          providerId: ctx.channelProviderId ?? ctx.provider.id,
          status: '',
          threadTs: options.threadTs,
        }).catch(() => {
          // Best effort only. Payment/error flow must not depend on Slack assistant UI cleanup.
        })
    }
  },
} as const satisfies Record<
  (typeof commandNames)[number] | 'default',
  (event: chat.SlashCommandEvent | TipEvent, ctx: HandlerContext) => Promise<void>
>

const commandNames = [
  'airdrop',
  'balance',
  'config',
  'connect',
  'disconnect',
  'help',
  'jar',
  'leaderboard',
  'raffle',
  'stats',
  'status',
] as const
const commandPattern = new RegExp(`^(${commandNames.join('|')})(?:\\s+([\\s\\S]*))?$`)
const actionNames = [
  'airdrop_claim',
  'config_edit',
  'connect_cancel',
  'confirm_cancel',
  'confirm_tip',
  'tip_ask_close',
  'tip_ask_option',
  'tip_ask_option_dollar',
  'tip_ask_option_money_with_wings',
  'tip_ask_option_moneybag',
  'tip_raffle_buy_1',
  'tip_raffle_buy_5',
] as const
const modalSubmitNames = ['config_edit', 'tip_airdrop_create', 'tip_raffle_create'] as const
const tipAskIdempotencyPrefix = 'tip_ask:'
const tipRaffleIdempotencyPrefix = 'tip_raffle:'
const tipAskReactionNames = ['money_with_wings', 'dollar', 'moneybag'] as const
const tipAskImageFileLimit = 5
const tipAskReactions = [
  { emoji: '💸', name: 'money_with_wings' },
  { emoji: '💵', name: 'dollar' },
  { emoji: '💰', name: 'moneybag' },
] as const satisfies Array<{ emoji: string; name: TipAskReaction }>
const tipRaffleDurationOptions = [
  { label: '90 seconds', ms: 90 * 1000, value: '90s' }, // 90 seconds
  { label: '5 minutes', ms: 5 * 60 * 1000, value: '5m' }, // 5 minutes
  { label: '10 minutes', ms: 10 * 60 * 1000, value: '10m' }, // 10 minutes
  { label: '15 minutes', ms: 15 * 60 * 1000, value: '15m' }, // 15 minutes
  { label: '1 hour', ms: 60 * 60 * 1000, value: '1h' }, // 1 hour
  { label: '4 hours', ms: 4 * 60 * 60 * 1000, value: '4h' }, // 4 hours
  { label: '24 hours', ms: 24 * 60 * 60 * 1000, value: '24h' }, // 24 hours
  { label: '3 days', ms: 3 * 24 * 60 * 60 * 1000, value: '3d' }, // 3 days
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000, value: '7d' }, // 7 days
] as const
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
  allowUninstalledWorkspaceCreate?: boolean
  channelProviderId?: string
  defaultTip?: {
    idempotencyKey: string
    insufficientFundsThreadTs?: string
    mention?: boolean
    threadTs?: string
  }
  db: DB.Type
  externalSlackConnect?: boolean
  forceConnectRefresh?: boolean
  provider: ProviderContext
  settingsProviderId?: string
  text: string
  threadTs?: string
  tipAskImageFiles?: TipAskImageFile[]
}

type ProviderContext = { id: string; type: 'slack' }

type TipEvent = {
  channel: chat.Channel
  threadTs?: string
  user: chat.Author
}

type ReactionHandlerContext = {
  db: DB.Type
  provider: ProviderContext
  reactionTipConfig?: ReactionTipConfig
  workspace: DB_gen.Selectable.workspace
}

type ReactionTipConfig = Pick<DB_gen.Selectable.reaction_tip_config, 'amount' | 'emoji'>

type TipAskReaction = (typeof tipAskReactionNames)[number]

type TipAskMessageInput = Pick<
  DB_gen.Selectable.tip_ask,
  | 'beneficiary_provider_user_id'
  | 'closed_at'
  | 'creator_fee_basis_points'
  | 'dollar_amount'
  | 'id'
  | 'memo'
  | 'money_with_wings_amount'
  | 'moneybag_amount'
  | 'token_address'
  | 'chain_id'
> & {
  image_files: TipAskImageFile[]
  requester_provider_user_id: string
  workspace_default_token_address: string | null
}

type TipAskImageFile = Pick<DB_gen.Selectable.tip_ask_image_file, 'alt_text' | 'provider_file_id'>

type TipAirdropMessageInput = Pick<
  DB_gen.Selectable.tip_airdrop,
  | 'chain_id'
  | 'claim_amount'
  | 'claimed_amount'
  | 'ended_at'
  | 'ends_at'
  | 'id'
  | 'name'
  | 'status'
  | 'token_address'
  | 'total_amount'
> & {
  claimed_provider_user_ids: string[]
  workspace_default_token_address: string | null
}

type TipRaffleMessageInput = Pick<
  DB_gen.Selectable.tip_raffle,
  | 'chain_id'
  | 'ended_at'
  | 'ends_at'
  | 'failed_ticket_count'
  | 'id'
  | 'memo'
  | 'provider_channel_id'
  | 'provider_message_ts'
  | 'settled_amount'
  | 'status'
  | 'ticket_amount'
  | 'token_address'
  | 'winning_ticket_number'
> & {
  creator_provider_user_id: string
  winner_provider_user_id: string | null
  workspace_default_token_address: string | null
}

type LeaderboardRow = {
  providerUserId: string
  tipCount: number
}

type PendingSlackTip = {
  amount?: number
  idempotencyKey: string
  memo: string | null
  providerChannelId: string
  providerId: string
  providerThreadId?: string
  recipients: Tip.TipRecipientInput[]
  senderProviderUserId: string
  settingsProviderId?: string
  skippedRecipients?: Tip.TipSkippedRecipient[]
  source: 'command' | 'mention' | 'reaction'
  tokenAddress?: string
  usergroupId?: string
  usergroupLabel?: string
  workspaceProviderId?: string
}

type ParsedTipBatch = NonNullable<ReturnType<typeof Tip.parseTipBatchText>>

export const reactionTipIdempotencyPrefix = 'reaction:'
export const receiptBoostIdempotencyPrefix = 'boost:'
const receiptBoostReaction = getReceiptBoostReaction(env.HOST)

export function isTipAskIdempotencyKey(value: string) {
  return value.startsWith(tipAskIdempotencyPrefix)
}

export function isReactionTipIdempotencyKey(value: string) {
  return value.startsWith(reactionTipIdempotencyPrefix)
}

export function isReceiptBoostIdempotencyKey(value: string) {
  return value.startsWith(receiptBoostIdempotencyPrefix)
}

async function resolveSlackTipPlan(
  event: TipEvent,
  ctx: HandlerContext,
  parsed: ParsedTipBatch,
  options: { amountEach?: number } = {},
): Promise<
  | {
      ok: true
      previewRequired: boolean
      recipients: Tip.TipRecipientInput[]
      skippedRecipients: Tip.TipSkippedRecipient[]
      usergroupId?: string
      usergroupLabel?: string
    }
  | { message: string; ok: false }
> {
  if (ctx.provider.type !== 'slack')
    return {
      ok: true,
      previewRequired: false,
      recipients: parsed.recipients,
      skippedRecipients: [],
    }
  if (
    parsed.recipients.some((recipient) => recipient.recipientProviderUserId === event.user.userId)
  )
    return { message: 'Payment not sent. Cannot send a payment to yourself.', ok: false }

  const installation = await getSlack().getInstallation(ctx.channelProviderId ?? ctx.provider.id)
  if (!installation)
    return {
      ok: true,
      previewRequired: false,
      recipients: parsed.recipients,
      skippedRecipients: [],
    }

  const conversation = await Slack.getConversationInfo({
    apiUrl: env.SLACK_API_URL,
    botToken: installation.botToken,
    channelId: event.channel.id,
    withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
  })
  if (
    parsed.usergroups?.some((usergroup) => {
      // Slack special mentions resolve from channel state, so they can work in Slack Connect;
      // custom Slack usergroups still cannot be resolved safely there.
      return !['channel', 'here'].includes(usergroup.providerUsergroupId)
    }) &&
    conversation.isShared
  ) {
    return {
      message:
        'Group tips are not supported in Slack Connect channels yet; mention individual recipients instead.',
      ok: false,
    }
  }

  const targets: Array<{ recipient: Tip.TipRecipientInput; source: 'explicit' | 'usergroup' }> =
    parsed.recipients.map((recipient) => ({
      recipient,
      source: 'explicit' as const,
    }))
  for (const usergroup of parsed.usergroups ?? []) {
    const users = await (async () => {
      if (usergroup.providerUsergroupId !== 'channel' && usergroup.providerUsergroupId !== 'here')
        return await Slack.getUsergroupMembers({
          apiUrl: env.SLACK_API_URL,
          botToken: installation.botToken,
          usergroup,
          withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
        })

      // Slack special mentions are represented in the parsed usergroup list but resolve via
      // conversation APIs instead of usergroups.users.list.
      const providerUserIds: string[] = []
      const slackChannelId = Slack.getChannelId(event.channel.id)
      let cursor: string | undefined
      do {
        const body = new URLSearchParams()
        body.set('channel', slackChannelId)
        if (cursor) body.set('cursor', cursor)
        const response = await getSlack().withBotToken(installation.botToken, () =>
          fetch(`${env.SLACK_API_URL}/conversations.members`, {
            body,
            headers: { authorization: `Bearer ${installation.botToken}` },
            method: 'POST',
          }),
        )
        const json = z.parse(
          z.object({
            error: z.string().optional(),
            members: z.array(z.string()).optional(),
            ok: z.boolean().optional(),
            response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
          }),
          await response.json(),
        )
        if (!json.ok)
          return {
            message: Slack.formatConversationMembersError(json.error),
            ok: false as const,
          }
        providerUserIds.push(...(json.members ?? []))
        cursor = json.response_metadata?.next_cursor || undefined
      } while (cursor)

      // @channel includes all conversation members; @here narrows that list to active members.
      if (usergroup.providerUsergroupId === 'channel') return { ok: true as const, providerUserIds }

      const activeProviderUserIds = [] as string[]
      for (const providerUserId of providerUserIds) {
        const presence = await (async () => {
          // Slack Connect can return user_not_found for a shared-channel member when using the
          // host workspace token. Try every installed shared workspace before skipping that member.
          for (const providerId of [ctx.provider.id, ...conversation.teamIds]) {
            const tokenInstallation = await getSlack().getInstallation(providerId)
            if (!tokenInstallation) continue
            const body = new URLSearchParams()
            body.set('user', providerUserId)
            const response = await getSlack().withBotToken(tokenInstallation.botToken, () =>
              fetch(`${env.SLACK_API_URL}/users.getPresence`, {
                body,
                headers: { authorization: `Bearer ${tokenInstallation.botToken}` },
                method: 'POST',
              }),
            )
            const json = z.parse(
              z.object({
                error: z.string().optional(),
                ok: z.boolean().optional(),
                presence: z.string().optional(),
              }),
              await response.json(),
            )
            if (json.ok) return { ok: true as const, presence: json.presence }
            if (json.error !== 'user_not_found')
              return {
                message:
                  json.error === 'missing_scope'
                    ? 'Payment not sent. Tipbot could not read active channel members because Tipbot is missing Slack permissions. Reinstall Tipbot and try again.'
                    : `Payment not sent. Tipbot could not read active channel members${json.error ? ` (${json.error})` : ''}.`,
                ok: false as const,
              }
          }
          return { ok: true as const, presence: 'away' }
        })()
        if (!presence.ok) return presence
        if (presence.presence === 'active') activeProviderUserIds.push(providerUserId)
      }
      return { ok: true as const, providerUserIds: activeProviderUserIds }
    })()
    if (!users.ok) return { message: users.message, ok: false }
    for (const providerUserId of users.providerUserIds) {
      if (!/^[UW][A-Z0-9_]+$/.test(providerUserId)) continue
      const user = await Slack.getUserInfo({
        apiUrl: env.SLACK_API_URL,
        botToken: installation.botToken,
        providerUserId,
        withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
      })
      if (!user || user.deleted || user.is_app_user || user.is_bot) continue
      targets.push({
        recipient: { recipientProviderUserId: providerUserId },
        source: 'usergroup' as const,
      })
    }
  }

  const recipients = [] as Tip.TipRecipientInput[]
  const skippedRecipients = [] as Tip.TipSkippedRecipient[]
  const senderAccount = await ctx.db
    .selectFrom('workspace')
    .innerJoin('member', 'member.workspace_id', 'workspace.id')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .select('provider_identity.account_id')
    .where('workspace.provider', '=', 'slack')
    .where('workspace.provider_id', '=', ctx.provider.id)
    .where('member.provider_user_id', '=', event.user.userId)
    .executeTakeFirst()
  const seen = new Set<string>()
  for (const target of targets) {
    if (seen.has(target.recipient.recipientProviderUserId)) continue
    seen.add(target.recipient.recipientProviderUserId)
    if (target.recipient.recipientProviderUserId === event.user.userId) {
      if (target.source === 'explicit')
        return { message: 'Payment not sent. Cannot send a payment to yourself.', ok: false }
      continue
    }

    const allowUnconnectedSingleRecipient = Boolean(
      conversation.isShared && target.source === 'explicit' && targets.length === 1,
    )
    const recipient = conversation.isShared
      ? await resolveSlackConnectRecipient(ctx, conversation.teamIds, target.recipient, {
          allowUnconnected: allowUnconnectedSingleRecipient,
        })
      : await resolveLocalSlackRecipient(ctx, target.recipient)
    if ('message' in recipient) return { message: recipient.message, ok: false }
    if (!recipient.value) {
      skippedRecipients.push({
        queueable: target.source === 'explicit' && !conversation.isShared,
        reason: 'not_connected',
        recipientProviderLabel: target.recipient.recipientProviderLabel,
        recipientProviderUserId: target.recipient.recipientProviderUserId,
        recipientProviderWorkspaceId: target.recipient.recipientProviderWorkspaceId,
      })
      continue
    }
    if (recipient.accountId && recipient.accountId === senderAccount?.account_id) {
      if (target.source === 'explicit')
        return { message: 'Payment not sent. Cannot send a payment to yourself.', ok: false }
      continue
    }
    recipients.push(recipient.value)
  }

  if (recipients.length === 0) {
    if (skippedRecipients.some((recipient) => recipient.queueable))
      return {
        ok: true,
        previewRequired: false,
        recipients,
        skippedRecipients,
      }
    const usergroup = parsed.usergroups?.[0]
    return {
      message: usergroup
        ? usergroup.providerUsergroupId === 'here'
          ? 'Payment not sent. No online members besides you are connected to Tipbot.'
          : `Payment not sent. None of the members of ${Slack.formatUsergroupMention(usergroup.providerUsergroupId, usergroup.providerUsergroupLabel)} are connected to Tipbot yet.`
        : 'Payment not sent. None of the mentioned accounts are connected to Tipbot yet.',
      ok: false,
    }
  }
  if (recipients.length > Tip.maxTipBatchRecipients)
    return {
      message: `Payment not sent. This tip has ${recipients.length} connected recipients; multi-tip currently supports up to ${Tip.maxTipBatchRecipients}.`,
      ok: false,
    }
  const groupPreviewRequired = Boolean(
    // Small group tips send immediately; require Slack confirmation only for larger groups or
    // more expensive total sends.
    parsed.usergroups?.length &&
    (recipients.length > 15 || (options.amountEach ?? 0) * recipients.length > 10_000_000),
  )
  return {
    ok: true,
    previewRequired:
      groupPreviewRequired || (!parsed.usergroups?.length && skippedRecipients.length > 0),
    recipients,
    skippedRecipients,
    usergroupId: parsed.usergroups?.[0]?.providerUsergroupId,
    usergroupLabel: parsed.usergroups?.[0]?.providerUsergroupLabel,
  }
}

async function resolveLocalSlackRecipient(ctx: HandlerContext, recipient: Tip.TipRecipientInput) {
  const workspace = await ctx.db
    .selectFrom('workspace')
    .select('id')
    .where('workspace.provider', '=', 'slack')
    .where('workspace.provider_id', '=', ctx.provider.id)
    .executeTakeFirst()
  if (!workspace) return { value: null }
  const member = await ctx.db
    .selectFrom('member')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .innerJoin('account', 'account.id', 'provider_identity.account_id')
    .select(['member.id', 'provider_identity.account_id'])
    .where('member.provider_user_id', '=', recipient.recipientProviderUserId)
    .where('member.workspace_id', '=', workspace.id)
    .executeTakeFirst()
  return { accountId: member?.account_id, value: member ? recipient : null }
}

async function resolveSlackConnectRecipient(
  ctx: Pick<HandlerContext, 'channelProviderId' | 'db' | 'provider'>,
  teamIds: Set<string>,
  recipient: Tip.TipRecipientInput,
  options: { allowUnconnected?: boolean } = {},
) {
  let resolvedUnconnectedRecipient: Tip.TipRecipientInput | null = null
  const candidates = [...teamIds, ctx.channelProviderId, ctx.provider.id]
    .filter((providerWorkspaceId) => providerWorkspaceId !== undefined)
    .map((providerWorkspaceId) => ({
      providerUserId: recipient.recipientProviderUserId,
      providerWorkspaceId,
    }))
  for (const tokenTeamId of [...teamIds, ctx.channelProviderId, ctx.provider.id].filter(
    (providerWorkspaceId) => providerWorkspaceId !== undefined,
  )) {
    const tokenInstallation = await getSlack().getInstallation(tokenTeamId)
    if (!tokenInstallation) continue
    const info = await Slack.getUserInfo({
      apiUrl: env.SLACK_API_URL,
      botToken: tokenInstallation.botToken,
      providerUserId: recipient.recipientProviderUserId,
      withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
    })
    if (!info?.id || !info.team_id) continue
    if (options.allowUnconnected)
      resolvedUnconnectedRecipient = {
        ...recipient,
        recipientProviderUserId: info.id,
        recipientProviderWorkspaceId: info.team_id,
      }
    candidates.push({ providerUserId: info.id, providerWorkspaceId: info.team_id })
  }

  const seen = new Set<string>()
  const matches = [] as Array<{
    accountId: string | null
    providerUserId: string
    providerWorkspaceId: string
  }>
  for (const candidate of candidates) {
    const key = `${candidate.providerWorkspaceId}:${candidate.providerUserId}`
    if (seen.has(key)) continue
    seen.add(key)
    const candidateWorkspace = await ctx.db
      .selectFrom('workspace')
      .select('id')
      .where('provider', '=', 'slack')
      .where('provider_id', '=', candidate.providerWorkspaceId)
      .executeTakeFirst()
    if (!candidateWorkspace) continue
    const candidateMember = await ctx.db
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .innerJoin('account', 'account.id', 'provider_identity.account_id')
      .select(['member.id', 'provider_identity.account_id'])
      .where('member.provider_user_id', '=', candidate.providerUserId)
      .where('member.workspace_id', '=', candidateWorkspace.id)
      .executeTakeFirst()
    if (candidateMember) matches.push({ ...candidate, accountId: candidateMember.account_id })
  }
  if (matches.length > 1)
    return {
      message: `Payment not sent. <@${recipient.recipientProviderUserId}> could not be resolved safely across Slack workspaces.`,
    }
  if (matches.length === 0)
    return {
      accountId: null,
      value: options.allowUnconnected ? resolvedUnconnectedRecipient : null,
    }
  return {
    accountId: matches[0]!.accountId,
    value: {
      ...recipient,
      recipientProviderUserId: matches[0]!.providerUserId,
      recipientProviderWorkspaceId: matches[0]!.providerWorkspaceId,
    },
  }
}

async function handleSlackReactionTip(event: Slack.ReactionEvent, context: ReactionHandlerContext) {
  const { db, provider, reactionTipConfig } = context
  let workspace = context.workspace

  const installation = await getSlack().getInstallation(provider.id)
  if (!installation) return

  const slackConnectActor = isReceiptBoostReaction(event.reaction)
    ? { blocked: false as const, external: false as const }
    : await Slack.resolveConnectActor({
        apiUrl: env.SLACK_API_URL,
        channelId: event.item.channel,
        getInstallation: (providerId) => getSlack().getInstallation(providerId),
        providerId: provider.id,
        providerUserId: event.user,
        withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
      })
  if (slackConnectActor.blocked) return
  if (slackConnectActor.external) {
    const senderWorkspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', 'slack')
      .where('provider_id', '=', slackConnectActor.providerId)
      .executeTakeFirst()
    if (!senderWorkspace) return
    if (senderWorkspace.installed_at) {
      await postSlackEphemeral(
        provider.id,
        event.item.channel,
        event.user,
        'Payment not sent. Use your workspace’s Tipbot app to send payments here.',
      )
      return
    }
    const sender = await db
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .select('member.id')
      .where('member.workspace_id', '=', senderWorkspace.id)
      .where('member.provider_user_id', '=', event.user)
      .where('provider_identity.account_id', 'is not', null)
      .executeTakeFirst()
    if (!sender) return
    workspace = senderWorkspace
  }

  const conversation = await Slack.getConversationInfo({
    apiUrl: env.SLACK_API_URL,
    botToken: installation.botToken,
    channelId: event.item.channel,
    withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
  })
  if (conversation.isIm || conversation.isMpim) return

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
                blocks: z.unknown().optional(),
                subtype: z.string().optional(),
                text: z.string().optional(),
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
                  blocks: z.unknown().optional(),
                  subtype: z.string().optional(),
                  text: z.string().optional(),
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
  if (isReceiptBoostReaction(event.reaction)) {
    const receipt = await (async () => {
      // Prefer the receipt index recorded when Tipbot posted the receipt.
      const existing = await db
        .selectFrom('tip_receipt_message')
        .select(['channel_id', 'message_ts', 'thread_ts', 'tip_batch_id', 'workspace_id'])
        .where('workspace_id', '=', workspace.id)
        .where('channel_id', '=', event.item.channel)
        .where('message_ts', '=', event.item.ts)
        .executeTakeFirst()
      if (existing) {
        let threadTs = message?.thread_ts ?? existing.thread_ts
        if (threadTs === existing.message_ts) {
          const batch = await db
            .selectFrom('tip_batch')
            .select('provider_thread_id')
            .where('id', '=', existing.tip_batch_id)
            .executeTakeFirst()
          threadTs = batch?.provider_thread_id ?? threadTs
        }
        if (threadTs !== existing.thread_ts)
          await recordSlackReceiptMessage(db, {
            channelId: existing.channel_id,
            messageTs: existing.message_ts,
            threadTs,
            tipBatchId: existing.tip_batch_id,
            workspaceId: existing.workspace_id,
          })
        return {
          channelId: existing.channel_id,
          messageTs: existing.message_ts,
          threadTs,
          tipBatchId: existing.tip_batch_id,
          workspaceId: existing.workspace_id,
        }
      }

      const originalMentionBatch = await db
        .selectFrom('tip_batch')
        .select(['id', 'provider_thread_id', 'workspace_id'])
        .where('workspace_id', '=', workspace.id)
        .where(
          'idempotency_key',
          '=',
          `mention:${provider.id}:${event.item.channel}:${event.item.ts}`,
        )
        .executeTakeFirst()
      if (originalMentionBatch) {
        const threadTs =
          originalMentionBatch.provider_thread_id ?? message.thread_ts ?? event.item.ts
        await recordSlackReceiptMessage(db, {
          channelId: event.item.channel,
          messageTs: event.item.ts,
          threadTs,
          tipBatchId: originalMentionBatch.id,
          workspaceId: originalMentionBatch.workspace_id,
        })
        return {
          channelId: event.item.channel,
          messageTs: event.item.ts,
          threadTs,
          tipBatchId: originalMentionBatch.id,
          workspaceId: originalMentionBatch.workspace_id,
        }
      }

      // Backfill older receipts by parsing the receipt link from the Slack message.
      if (
        message?.text?.startsWith('Reaction tips received in this thread:') ||
        message?.text?.startsWith('Reaction tips\n') ||
        message?.text?.startsWith('Boosts received in this thread:')
      )
        return null
      const transactionHash = JSON.stringify(message ?? {}).match(
        /\/receipt\/(0x[0-9a-fA-F]{64})/,
      )?.[1]
      if (!transactionHash) return null
      const batch = await db
        .selectFrom('tip_batch')
        .select(['id', 'workspace_id'])
        .where('workspace_id', '=', workspace.id)
        .where((eb) =>
          eb.or([
            eb('provider_channel_id', '=', event.item.channel),
            eb('provider_channel_id', '=', `slack:${event.item.channel}`),
            eb('provider_channel_id', '=', ''),
          ]),
        )
        .where('transaction_hash', '=', transactionHash)
        .where('status', '=', 'confirmed')
        .executeTakeFirst()
      if (!batch) return null
      const threadTs = message.thread_ts ?? event.item.ts
      await recordSlackReceiptMessage(db, {
        channelId: event.item.channel,
        messageTs: event.item.ts,
        threadTs,
        tipBatchId: batch.id,
        workspaceId: batch.workspace_id,
      })
      return {
        channelId: event.item.channel,
        messageTs: event.item.ts,
        threadTs,
        tipBatchId: batch.id,
        workspaceId: batch.workspace_id,
      }
    })()
    if (!receipt) return

    const sender = await db
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .select(['member.id as member_id', 'member.provider_user_id', 'provider_identity.account_id'])
      .where('member.workspace_id', '=', receipt.workspaceId)
      .where('member.provider_user_id', '=', event.user)
      .where('provider_identity.account_id', 'is not', null)
      .executeTakeFirst()
    if (!sender) {
      await postSlackEphemeral(
        provider.id,
        event.item.channel,
        event.user,
        `Boost not sent. Connect to Tipbot with \`@${getSlackBotDisplayName(env.HOST)} connect\` or \`${getSlackCommand(env.HOST)} connect\` and try again.`,
        { threadTs: receipt.threadTs },
      )
      return
    }

    const idempotencyKey = [
      receiptBoostIdempotencyPrefix.replace(/:$/, ''),
      receipt.workspaceId,
      event.item.channel,
      receipt.messageTs,
      sender.member_id,
    ].join(':')
    const existing = await db
      .selectFrom('tip_batch')
      .select('id')
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst()
    if (existing) return

    const rows = await db
      .selectFrom('tip_batch')
      .innerJoin('tip', 'tip.batch_id', 'tip_batch.id')
      .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
      .innerJoin(
        'provider_identity as recipient_identity',
        'recipient_identity.id',
        'recipient.provider_identity_id',
      )
      .innerJoin('workspace as receipt_workspace', 'receipt_workspace.id', 'tip_batch.workspace_id')
      .innerJoin(
        'workspace as recipient_workspace',
        'recipient_workspace.id',
        'recipient.workspace_id',
      )
      .select([
        'receipt_workspace.provider_id as receipt_provider_id',
        'recipient.provider_user_id as recipient_provider_user_id',
        'recipient_identity.account_id as recipient_account_id',
        'recipient_workspace.provider_id as recipient_provider_workspace_id',
        'tip.chain_id',
        'tip_batch.amount_each',
        'tip_batch.status',
        'tip_batch.token_address',
        'tip_batch.transaction_hash',
      ])
      .where('tip_batch.id', '=', receipt.tipBatchId)
      .orderBy('tip.created_at', 'asc')
      .execute()
    if (!rows[0] || rows[0].status !== 'confirmed' || !rows[0].transaction_hash) {
      await postSlackEphemeral(
        provider.id,
        event.item.channel,
        event.user,
        'Boost not sent. Original payment is not confirmed yet.',
        { threadTs: receipt.threadTs },
      )
      return
    }

    const recipients: Tip.TipRecipientInput[] = []
    const skippedRecipients: Tip.TipSkippedRecipient[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const key = `${row.recipient_provider_workspace_id}:${row.recipient_provider_user_id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!row.recipient_account_id) {
        skippedRecipients.push({
          reason: 'not_connected',
          recipientProviderUserId: row.recipient_provider_user_id,
        })
        continue
      }
      if (row.recipient_account_id === sender.account_id) {
        skippedRecipients.push({
          reason: 'you',
          recipientProviderUserId: row.recipient_provider_user_id,
        })
        continue
      }
      recipients.push({
        recipientProviderUserId: row.recipient_provider_user_id,
        ...(row.recipient_provider_workspace_id !== row.receipt_provider_id
          ? { recipientProviderWorkspaceId: row.recipient_provider_workspace_id }
          : {}),
      })
    }
    if (recipients.length === 0) {
      await postSlackEphemeral(
        provider.id,
        event.item.channel,
        event.user,
        'Boost not sent. None of the original recipients can receive this payment now.',
        { threadTs: receipt.threadTs },
      )
      return
    }

    const result = await Tip.handleTipBatchRequest(env, {
      amount: rows[0].amount_each,
      chainId: rows[0].chain_id,
      idempotencyKey,
      memo: null,
      provider: provider.type,
      providerChannelId: event.item.channel,
      providerId: provider.id,
      providerThreadId: receipt.threadTs,
      recipients,
      senderProviderUserId: sender.provider_user_id,
      skippedRecipients,
      source: 'reaction',
      tokenAddress: rows[0].token_address,
      workspaceProviderId: rows[0].receipt_provider_id,
    }).catch(
      (error) =>
        ({
          code: 'failed',
          message: error instanceof Error ? error.message : 'Boost failed.',
          ok: false,
        }) satisfies Tip.TipBatchResult,
    )

    if (result.ok) {
      if (result.status === 'sent') {
        if (receipt.threadTs === receipt.messageTs)
          await postSlackReceiptMessage(
            {
              channel: getChat().channel(`slack:${event.item.channel}`),
              threadTs: receipt.threadTs,
              user: { userId: event.user } as chat.Author,
            },
            { db, provider, text: '', threadTs: receipt.threadTs },
            `<@${sender.provider_user_id}> boosted`,
            result.chainId,
            result.transactionHash,
            undefined,
            undefined,
            receipt.threadTs,
          )
        else
          await updateReceiptBoostAggregate(provider.id, {
            channelId: event.item.channel,
            threadTs: receipt.threadTs,
            workspaceId: receipt.workspaceId,
          })
        if (skippedRecipients.length)
          await postSlackEphemeral(
            provider.id,
            event.item.channel,
            event.user,
            `Boost sent to ${recipients.length} ${recipients.length === 1 ? 'account' : 'accounts'}. Skipped ${skippedRecipients.length} ${skippedRecipients.length === 1 ? 'account' : 'accounts'} that can no longer receive payments.`,
            { threadTs: receipt.threadTs },
          )
      }
      return
    }

    if (result.code === 'confirmation_required' && result.confirmUrl) {
      await postSlackPaymentConfirmation(
        {
          channel: getChat().channel(`slack:${event.item.channel}`),
          threadTs: receipt.threadTs,
          user: { userId: event.user } as chat.Author,
        },
        { db, provider, text: '', threadTs: receipt.threadTs },
        result.confirmUrl,
        {
          label: 'Confirm boost',
          message: `Tipbot needs your approval to boost${receipt.threadTs === receipt.messageTs ? '' : ` ${Slack.formatMessageLink(provider.id, event.item.channel, receipt.messageTs)}`}.`,
          threadTs: receipt.threadTs,
        },
      )
      return
    }

    await postSlackEphemeral(
      provider.id,
      event.item.channel,
      event.user,
      (() => {
        if (result.code === 'insufficient_funds')
          return 'Boost not sent. Your wallet has insufficient funds.'
        if (result.code === 'pending') return 'Boost still sending.'
        if (result.code === 'recipient_unconnected')
          return 'Boost not sent. A recipient needs to connect Tipbot before receiving payments.'
        if (result.code === 'self_tip') return 'Boost not sent. Cannot send a payment to yourself.'
        return result.message ?? 'Boost failed.'
      })(),
      { threadTs: receipt.threadTs },
    )
    return
  }
  if (!reactionTipConfig) return
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
      `Payment not sent. Connect to Tipbot with \`@${getSlackBotDisplayName(env.HOST)} connect\` or \`${getSlackCommand(env.HOST)} connect\` and try again.`,
    )
    return
  }
  const resolvedRecipient = conversation.isShared
    ? await resolveSlackConnectRecipient(
        { db, provider },
        conversation.teamIds,
        { recipientProviderUserId },
        { allowUnconnected: true },
      )
    : { value: { recipientProviderUserId } }
  if ('message' in resolvedRecipient) {
    await postSlackEphemeral(
      provider.id,
      event.item.channel,
      event.user,
      resolvedRecipient.message ?? 'Payment not sent. Recipient could not be resolved safely.',
    )
    return
  }
  const recipient = resolvedRecipient.value
    ? await getConnectedSlackRecipient(db, provider.type, workspace, resolvedRecipient.value)
    : null
  const idempotencyKey = [
    reactionTipIdempotencyPrefix,
    workspace.id,
    event.item.channel,
    event.item.ts,
    event.reaction,
    sender.memberId,
    event.event_ts,
  ].join(':')
  if (!recipient) {
    const result = await Tip.handleTipRequest(env, {
      amount: reactionTipConfig.amount,
      idempotencyKey,
      memo: null,
      provider: provider.type,
      providerChannelId: event.item.channel,
      providerId: provider.id,
      providerThreadId: message.thread_ts ?? event.item.ts,
      recipientProviderUserId,
      recipientProviderWorkspaceId:
        resolvedRecipient.value && 'recipientProviderWorkspaceId' in resolvedRecipient.value
          ? resolvedRecipient.value.recipientProviderWorkspaceId
          : undefined,
      senderProviderUserId: sender.providerUserId,
      settingsProviderId: provider.id,
      source: 'reaction',
      workspaceProviderId: workspace.provider_id,
    }).catch(
      (error) =>
        ({
          code: 'failed',
          message: error instanceof Error ? error.message : 'Reaction tip failed.',
          ok: false,
        }) satisfies Tip.TipResult,
    )
    if (result.ok && result.status === 'queued') {
      const messageTs = await postSlackQueuedTipMessage(
        { db, provider, text: '', threadTs: message.thread_ts ?? event.item.ts },
        result,
        {
          channelId: `slack:${event.item.channel}`,
          mentionUser: (providerUserId) => `<@${providerUserId}>`,
          recipientProviderWorkspaceId:
            resolvedRecipient.value && 'recipientProviderWorkspaceId' in resolvedRecipient.value
              ? resolvedRecipient.value.recipientProviderWorkspaceId
              : undefined,
          threadTs: message.thread_ts ?? event.item.ts,
        },
      )
      await Tip.recordPendingTipMessage(env, {
        pendingTipId: result.pendingTipId,
        providerMessageTs: messageTs,
      })
      return
    }
    await postSlackEphemeral(provider.id, event.item.channel, event.user, 'Payment not sent.')
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
    amount: reactionTipConfig.amount,
    idempotencyKey,
    memo: null,
    provider: provider.type,
    providerChannelId: event.item.channel,
    providerId: provider.id,
    recipients: [recipient.input],
    senderProviderUserId: sender.providerUserId,
    settingsProviderId: provider.id,
    source: 'reaction',
    workspaceProviderId: workspace.provider_id,
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

function isReceiptBoostReaction(reaction: string) {
  return ['+', 'heavy_plus_sign', 'plus', receiptBoostReaction].includes(reaction)
}

async function postSlackEphemeral(
  providerId: string,
  channelId: string,
  userId: string,
  text: string,
  options?: { blocks?: unknown[]; threadTs?: string },
) {
  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return

  const body = new URLSearchParams()
  if (options?.blocks) body.set('blocks', JSON.stringify(options.blocks))
  body.set('channel', channelId)
  body.set('text', text)
  if (options?.threadTs) body.set('thread_ts', options.threadTs)
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

async function postSlackPaymentConfirmation(
  event: TipEvent,
  ctx: HandlerContext,
  confirmUrl: string,
  options: { label: string; message: string; threadTs?: string },
) {
  const confirmUrlLabel = confirmUrl.replace(/(\/confirm\/.{8}).+$/, '$1...')
  const body = new URLSearchParams()
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set(
    'blocks',
    JSON.stringify([
      {
        text: { text: options.message, type: 'mrkdwn' },
        type: 'section',
      },
      {
        elements: [
          {
            action_id: 'confirm_payment',
            style: 'primary',
            text: { text: options.label, type: 'plain_text' },
            type: 'button',
            url: confirmUrl,
          },
          {
            action_id: 'confirm_cancel',
            text: { text: 'Cancel', type: 'plain_text' },
            type: 'button',
          },
        ],
        type: 'actions',
      },
      {
        elements: [
          {
            text: `Link expires in 10 minutes. <${confirmUrl}|${confirmUrlLabel}>`,
            type: 'mrkdwn',
          },
        ],
        type: 'context',
      },
    ]),
  )
  body.set(
    'text',
    `${options.message}\nConfirm payment: ${confirmUrl}\nLink expires in 10 minutes.`,
  )
  await postSlackPrivateReply(
    ctx.channelProviderId ?? ctx.provider.id,
    event.channel.id.replace(/^slack:/, ''),
    event.user.userId,
    body,
    { threadTs: options.threadTs ?? ctx.threadTs },
  )
}

async function postSlackPrivateReply(
  providerId: string,
  channelId: string,
  userId: string,
  body: URLSearchParams,
  options: { threadTs?: string } = {},
) {
  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return

  const method = Slack.isDMChannelId(channelId) ? 'chat.postMessage' : 'chat.postEphemeral'
  if (method === 'chat.postEphemeral') body.set('user', userId)
  if (options.threadTs && method === 'chat.postEphemeral') body.set('thread_ts', options.threadTs)
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
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .select(['member.id', 'member.provider_user_id'])
    .where('workspace_id', '=', workspaceId)
    .where('member.provider_user_id', '=', providerUserId)
    .where('provider_identity.account_id', 'is not', null)
    .executeTakeFirst()
  if (!member) return null
  return { memberId: member.id, providerUserId: member.provider_user_id }
}

async function getConnectedSlackRecipient(
  db: DB.Type,
  provider: ProviderContext['type'],
  workspace: DB_gen.Selectable.workspace,
  recipient: Tip.TipRecipientInput,
) {
  const recipientWorkspace = recipient.recipientProviderWorkspaceId
    ? await db
        .selectFrom('workspace')
        .select(['id'])
        .where('provider', '=', provider)
        .where('provider_id', '=', recipient.recipientProviderWorkspaceId)
        .executeTakeFirst()
    : workspace
  if (!recipientWorkspace) return null

  const member = await getConnectedSlackMember(
    db,
    recipientWorkspace.id,
    recipient.recipientProviderUserId,
  )
  if (!member) return null
  return { ...member, input: recipient }
}

export async function updateTipAskMessage(providerId: string, options: { tipAskId: string }) {
  const db = DB.create(env.DB)
  const tipAsk = await db
    .selectFrom('tip_ask')
    .innerJoin('workspace', 'workspace.id', 'tip_ask.workspace_id')
    .innerJoin('member as requester', 'requester.id', 'tip_ask.requester_member_id')
    .select([
      'requester.provider_user_id as requester_provider_user_id',
      'tip_ask.beneficiary_provider_user_id',
      'tip_ask.chain_id',
      'tip_ask.closed_at',
      'tip_ask.creator_fee_basis_points',
      'tip_ask.dollar_amount',
      'tip_ask.id',
      'tip_ask.memo',
      'tip_ask.money_with_wings_amount',
      'tip_ask.moneybag_amount',
      'tip_ask.provider_channel_id',
      'tip_ask.provider_message_ts',
      'tip_ask.token_address',
      'workspace.default_token_address as workspace_default_token_address',
    ])
    .where('tip_ask.id', '=', options.tipAskId)
    .executeTakeFirst()
  if (!tipAsk) return

  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return

  const imageFiles = await db
    .selectFrom('tip_ask_image_file')
    .select(['alt_text', 'provider_file_id'])
    .where('tip_ask_id', '=', tipAsk.id)
    .orderBy('position', 'asc')
    .execute()
  const message = await tipAskMessage(db, { ...tipAsk, image_files: imageFiles })
  const body = new URLSearchParams()
  body.set('blocks', JSON.stringify(message.blocks))
  body.set('channel', tipAsk.provider_channel_id)
  body.set('text', message.text)
  body.set('ts', tipAsk.provider_message_ts)
  body.set('unfurl_links', 'false')
  body.set('unfurl_media', 'false')
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
    .updateTable('tip_ask')
    .set({ updated_at: new Date().toISOString() })
    .where('id', '=', tipAsk.id)
    .execute()
}

export async function updateTipRaffleMessage(providerId: string, options: { tipRaffleId: string }) {
  const db = DB.create(env.DB)
  const tipRaffle = await selectTipRaffleMessageInput(db, options.tipRaffleId)
  if (!tipRaffle) return

  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return

  const message = await tipRaffleMessage(db, tipRaffle)
  const body = new URLSearchParams()
  body.set('blocks', JSON.stringify(message.blocks))
  body.set('channel', tipRaffle.provider_channel_id)
  body.set('text', message.text)
  body.set('ts', tipRaffle.provider_message_ts)
  body.set('unfurl_links', 'false')
  body.set('unfurl_media', 'false')
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
    .updateTable('tip_raffle')
    .set({ updated_at: new Date().toISOString() })
    .where('id', '=', tipRaffle.id)
    .execute()
}

export async function closeExpiredTipRaffles() {
  const db = DB.create(env.DB)
  const staleSettlingTipRaffleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString() // 10 minutes
  const rows = await db
    .selectFrom('tip_raffle')
    .select(['id', 'provider_id'])
    .where((eb) =>
      eb.or([
        eb('status', '=', 'open'),
        eb.and([eb('status', '=', 'settling'), eb('updated_at', '<=', staleSettlingTipRaffleAt)]),
      ]),
    )
    .where('ends_at', '<=', new Date().toISOString())
    .orderBy('ends_at', 'asc')
    .limit(20)
    .execute()
  for (const row of rows)
    await closeTipRaffle(db, row.id, row.provider_id).catch((error) => {
      console.error('Failed to close expired tip raffle:', row.id, error)
    })

  const staleMessageRows = await db
    .selectFrom('tip_raffle')
    .select(['id', 'provider_id'])
    .where('status', '=', 'ended')
    .where('ended_at', 'is not', null)
    .whereRef('updated_at', '=', 'ended_at')
    .orderBy('ended_at', 'asc')
    .limit(20)
    .execute()
  for (const row of staleMessageRows)
    await updateTipRaffleMessage(row.provider_id, { tipRaffleId: row.id }).catch(async (error) => {
      console.error('Failed to update ended tip raffle message:', row.id, error)
      if ((error as { code?: unknown }).code !== 'message_not_found') return
      await db
        .updateTable('tip_raffle')
        .set({ updated_at: new Date().toISOString() })
        .where('id', '=', row.id)
        .execute()
    })
}

async function handleTipRaffleBuy(event: chat.ActionEvent, input: { ticketCount: 1 | 5 }) {
  const payload = z
    .object({
      nonce: z.string().min(1),
      tipRaffleId: z.string().min(1),
    })
    .safeParse(
      (() => {
        try {
          return JSON.parse(event.value ?? 'null')
        } catch {
          return null
        }
      })(),
    )
  if (!payload.success) return

  const raw = z.parse(
    z.object({
      channel: z.object({ id: z.string().min(1) }),
      team: z.object({ id: z.string().min(1) }),
    }),
    event.raw,
  )
  const db = DB.create(env.DB)
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .innerJoin('workspace', 'workspace.id', 'tip_raffle.workspace_id')
    .select([
      'tip_raffle.chain_id',
      'tip_raffle.ends_at',
      'tip_raffle.id',
      'tip_raffle.memo',
      'tip_raffle.provider_channel_id',
      'tip_raffle.provider_id',
      'tip_raffle.status',
      'tip_raffle.ticket_amount',
      'tip_raffle.token_address',
      'workspace.id as workspace_id',
      'workspace.provider_id as workspace_provider_id',
    ])
    .where('tip_raffle.id', '=', payload.data.tipRaffleId)
    .where('tip_raffle.provider_id', '=', raw.team.id)
    .executeTakeFirst()
  if (!tipRaffle) return
  if (tipRaffle.status !== 'open' || tipRaffle.ends_at <= new Date().toISOString()) {
    await closeTipRaffle(db, tipRaffle.id, tipRaffle.provider_id)
    await postSlackEphemeral(
      tipRaffle.provider_id,
      raw.channel.id,
      event.user.userId,
      'Raffle ended.',
    )
    return
  }

  const ticketLockKey = `${tipRaffleIdempotencyPrefix}${tipRaffle.id}:ticket:${event.user.userId}:sending`
  const ticketLockTtlMs = 2 * 60 * 1000 // 2 minutes
  if (!(await getChat().getState().setIfNotExists(ticketLockKey, true, ticketLockTtlMs))) return
  try {
    const accessKey = await Tip.checkReusableTipAccessKey(env, {
      amount: input.ticketCount * tipRaffle.ticket_amount,
      chainId: tipRaffle.chain_id,
      memo: tipRaffle.memo,
      providerUserId: event.user.userId,
      tokenAddress: tipRaffle.token_address,
      workspaceId: tipRaffle.workspace_id,
    })
    if (!accessKey.ok) {
      if (
        accessKey.code === 'sender_unconnected' ||
        accessKey.code === 'missing_sender_access_key'
      ) {
        await postConnectLink(
          {
            channel: getChat().channel(`slack:${tipRaffle.provider_channel_id}`),
            user: event.user,
          },
          {
            db,
            forceConnectRefresh: accessKey.code === 'missing_sender_access_key',
            provider: { id: tipRaffle.provider_id, type: 'slack' },
            text: '',
          },
        )
        return
      }
      await postSlackEphemeral(
        tipRaffle.provider_id,
        raw.channel.id,
        event.user.userId,
        accessKey.code === 'insufficient_funds'
          ? 'Ticket not bought. Your wallet has insufficient funds.'
          : 'Ticket not bought. Try again.',
      )
      return
    }
    const buyerMemberId = accessKey.memberId
    if (!buyerMemberId) return
    const escrowMember = await ensureTipRaffleEscrowMember(db, {
      chainId: tipRaffle.chain_id,
      providerId: tipRaffle.provider_id,
      workspaceId: tipRaffle.workspace_id,
    })
    const ticketIdempotencyKey = `${tipRaffleIdempotencyPrefix}${tipRaffle.id}:ticket:${event.user.userId}:${slackActionInteractionId(event) ?? payload.data.nonce}`
    const result = await Tip.handleTipRequest(env, {
      amount: input.ticketCount * tipRaffle.ticket_amount,
      chainId: tipRaffle.chain_id,
      idempotencyKey: ticketIdempotencyKey,
      memo: tipRaffle.memo,
      provider: 'slack',
      providerChannelId: tipRaffle.provider_channel_id,
      providerId: tipRaffle.provider_id,
      recipientProviderUserId: escrowMember.providerUserId,
      senderProviderUserId: event.user.userId,
      source: 'command',
      tokenAddress: tipRaffle.token_address,
      workspaceProviderId: tipRaffle.provider_id,
    }).catch(
      (error) =>
        ({
          chainId: tipRaffle.chain_id,
          code: 'failed',
          message: error instanceof Error ? error.message : 'Ticket payment failed.',
          ok: false,
        }) satisfies Tip.TipResult,
    )
    if (!result.ok) {
      if (
        result.code === 'sender_unconnected' ||
        result.code === 'missing_sender_access_key' ||
        result.code === 'confirmation_required'
      ) {
        await postConnectLink(
          {
            channel: getChat().channel(`slack:${tipRaffle.provider_channel_id}`),
            user: event.user,
          },
          {
            db,
            forceConnectRefresh: result.code !== 'sender_unconnected',
            provider: { id: tipRaffle.provider_id, type: 'slack' },
            text: '',
          },
        )
        return
      }
      if (result.code !== 'insufficient_funds' && result.code !== 'pending')
        console.warn('Tip raffle ticket payment failed:', {
          chainId: result.chainId,
          code: result.code,
          message: result.message,
          tipRaffleId: tipRaffle.id,
        })
      if (result.code === 'pending') return
      await postSlackEphemeral(
        tipRaffle.provider_id,
        raw.channel.id,
        event.user.userId,
        result.code === 'insufficient_funds'
          ? 'Ticket not bought. Your wallet has insufficient funds.'
          : 'Ticket not bought. Try again.',
      )
      return
    }

    await db
      .insertInto('tip_raffle_ticket')
      .values({
        buyer_member_id: buyerMemberId,
        created_at: new Date().toISOString(),
        id: Nanoid.generate(),
        idempotency_key: ticketIdempotencyKey,
        raffle_id: tipRaffle.id,
        ticket_count: input.ticketCount,
        updated_at: new Date().toISOString(),
      })
      .execute()
      .catch((error) => {
        if (!isUniqueConstraintError(error)) throw error
      })
    await updateTipRaffleMessage(tipRaffle.provider_id, { tipRaffleId: tipRaffle.id }).catch(
      (error) => {
        console.error('Failed to update Slack raffle:', error)
      },
    )
  } finally {
    await getChat()
      .getState()
      .delete(ticketLockKey)
      .catch(() => {})
  }
}

async function closeTipRaffle(db: DB.Type, tipRaffleId: string, providerId: string) {
  const now = new Date().toISOString()
  await db
    .updateTable('tip_raffle')
    .set({ status: 'settling', updated_at: now })
    .where('id', '=', tipRaffleId)
    .where('status', '=', 'open')
    .execute()
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('id', '=', tipRaffleId)
    .executeTakeFirst()
  if (!tipRaffle || tipRaffle.status === 'ended') return

  const rows = await db
    .selectFrom('tip_raffle_ticket')
    .innerJoin('member as buyer', 'buyer.id', 'tip_raffle_ticket.buyer_member_id')
    .innerJoin(
      'provider_identity as buyer_identity',
      'buyer_identity.id',
      'buyer.provider_identity_id',
    )
    .innerJoin('account as buyer_account', 'buyer_account.id', 'buyer_identity.account_id')
    .select([
      'buyer_account.address as buyer_account_address',
      'buyer_account.id as buyer_account_id',
      'buyer.id as buyer_member_id',
      'buyer.provider_user_id as buyer_provider_user_id',
      sql<number>`sum(tip_raffle_ticket.ticket_count)`.as('ticket_count'),
    ])
    .where('tip_raffle_ticket.raffle_id', '=', tipRaffle.id)
    .groupBy(['buyer.id', 'buyer.provider_user_id', 'buyer_account.id', 'buyer_account.address'])
    .orderBy('buyer.id', 'asc')
    .execute()
  const buyerCount = rows.length
  const ticketCount = rows.reduce((total, row) => total + Number(row.ticket_count), 0)
  if (buyerCount < 2 || ticketCount < 2) {
    await db
      .updateTable('tip_raffle')
      .set({ ended_at: now, status: 'ended', updated_at: now })
      .where('id', '=', tipRaffle.id)
      .execute()
    await updateTipRaffleMessage(providerId, { tipRaffleId: tipRaffle.id })
    return
  }

  let winningTicketNumber = tipRaffle.winning_ticket_number
  let winner = tipRaffle.winner_member_id
    ? rows.find((row) => row.buyer_member_id === tipRaffle.winner_member_id)
    : undefined
  if (!winner || !winningTicketNumber) {
    const drawnTicketNumber = (() => {
      const array = new Uint32Array(1)
      crypto.getRandomValues(array)
      return (array[0]! % ticketCount) + 1
    })()
    let cursor = 0
    const drawnWinner = rows.find((row) => {
      cursor += Number(row.ticket_count)
      return drawnTicketNumber <= cursor
    })
    if (!drawnWinner) return
    await db
      .updateTable('tip_raffle')
      .set({
        updated_at: now,
        winner_member_id: drawnWinner.buyer_member_id,
        winning_ticket_number: drawnTicketNumber,
      })
      .where('id', '=', tipRaffle.id)
      .where('winner_member_id', 'is', null)
      .where('winning_ticket_number', 'is', null)
      .execute()
    const persistedWinner = await db
      .selectFrom('tip_raffle')
      .select(['winner_member_id', 'winning_ticket_number'])
      .where('id', '=', tipRaffle.id)
      .executeTakeFirst()
    winningTicketNumber = persistedWinner?.winning_ticket_number ?? drawnTicketNumber
    winner = rows.find(
      (row) =>
        row.buyer_member_id === (persistedWinner?.winner_member_id ?? drawnWinner.buyer_member_id),
    )
  }
  if (!winner) return
  if (!winningTicketNumber) return

  const payableAmount = ticketCount * tipRaffle.ticket_amount
  const receipts: Array<Extract<Tip.TipResult, { ok: true; status: 'duplicate' | 'sent' }>> = []
  const result = await sendTipRaffleEscrowPayout(db, {
    amount: payableAmount,
    chainId: tipRaffle.chain_id,
    channelId: tipRaffle.provider_channel_id,
    idempotencyKey: `${tipRaffleIdempotencyPrefix}${tipRaffle.id}:payout`,
    memo: tipRaffle.memo,
    providerId,
    tokenAddress: tipRaffle.token_address,
    winner,
    workspaceId: tipRaffle.workspace_id,
  })
  receipts.push(result)

  await db
    .updateTable('tip_raffle')
    .set({
      ended_at: now,
      failed_ticket_count: 0,
      settled_amount: payableAmount,
      status: 'ended',
      updated_at: now,
      winner_member_id: winner.buyer_member_id,
      winning_ticket_number: winningTicketNumber,
    })
    .where('id', '=', tipRaffle.id)
    .execute()
  await updateTipRaffleMessage(providerId, { tipRaffleId: tipRaffle.id }).catch((error) => {
    console.error('Failed to update ended tip raffle message:', tipRaffle.id, error)
  })
  if (!tipRaffle.provider_message_ts) return
  for (const receipt of receipts)
    await postTipRaffleReceiptMessage(db, {
      channelId: tipRaffle.provider_channel_id,
      providerId,
      receipt,
      threadTs: tipRaffle.provider_message_ts,
    }).catch((error) => {
      console.error('Failed to post tip raffle receipt:', tipRaffle.id, error)
    })
}

async function ensureTipRaffleEscrowMember(
  db: DB.Type,
  input: { chainId: number; providerId: string; workspaceId: string },
) {
  const privateKey = Tempo.getFeePayerPrivateKey(env, input.chainId)
  if (!privateKey) throw new Error('Tip raffle escrow wallet is not configured.')
  const installation = await getSlack().getInstallation(input.providerId)
  if (!installation?.botUserId) throw new Error('Slack app installation missing bot user id.')
  const botUserId = installation.botUserId

  const now = new Date().toISOString()
  const address = privateKeyToAccount(privateKey).address
  await db
    .insertInto('account')
    .values({ created_at: now, id: Nanoid.generate(), address, updated_at: now })
    .onConflict((oc) => oc.column('address').doNothing())
    .execute()
  const account = await db
    .selectFrom('account')
    .select(['id', 'address'])
    .where('address', '=', address)
    .executeTakeFirstOrThrow()
  const existingIdentity = await db
    .selectFrom('provider_identity')
    .select(['id'])
    .where('provider', '=', 'slack')
    .where('provider_workspace_id', '=', input.providerId)
    .where('provider_user_id', '=', botUserId)
    .executeTakeFirst()
  const identity = await (async () => {
    if (existingIdentity) {
      await db
        .updateTable('provider_identity')
        .set({ account_id: account.id, updated_at: now })
        .where('id', '=', existingIdentity.id)
        .execute()
      return existingIdentity
    }

    const id = Nanoid.generate()
    await db
      .insertInto('provider_identity')
      .values({
        account_id: account.id,
        created_at: now,
        display_name: 'tipbot',
        id,
        metadata: null,
        provider: 'slack',
        provider_global_user_id: null,
        provider_user_id: botUserId,
        provider_workspace_id: input.providerId,
        real_name: 'tipbot',
        updated_at: now,
      })
      .execute()
    return { id }
  })()
  await db
    .insertInto('member')
    .values({
      created_at: now,
      id: Nanoid.generate(),
      login: 'tipbot',
      name: 'tipbot',
      provider_identity_id: identity.id,
      provider_user_id: botUserId,
      updated_at: now,
      workspace_id: input.workspaceId,
    })
    .onConflict((oc) =>
      oc
        .columns(['workspace_id', 'provider_user_id'])
        .doUpdateSet({ provider_identity_id: identity.id, updated_at: now }),
    )
    .execute()
  const member = await db
    .selectFrom('member')
    .select(['id', 'provider_user_id'])
    .where('workspace_id', '=', input.workspaceId)
    .where('provider_user_id', '=', botUserId)
    .executeTakeFirstOrThrow()
  return {
    accountAddress: account.address,
    accountId: account.id,
    memberId: member.id,
    providerUserId: member.provider_user_id,
  }
}

async function sendTipRaffleEscrowPayout(
  db: DB.Type,
  input: {
    amount: number
    chainId: number
    channelId: string
    idempotencyKey: string
    memo: string
    providerId: string
    tokenAddress: string
    winner: {
      buyer_account_address: string
      buyer_account_id: string
      buyer_member_id: string
      buyer_provider_user_id: string
    }
    workspaceId: string
  },
): Promise<Extract<Tip.TipResult, { ok: true; status: 'duplicate' | 'sent' }>> {
  const existing = await db
    .selectFrom('tip')
    .innerJoin('tip_batch', 'tip_batch.id', 'tip.batch_id')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .select([
      'tip.amount',
      'tip.chain_id',
      'tip.memo',
      'tip.token_address',
      'tip_batch.status',
      'tip_batch.transaction_hash',
      'workspace.default_token_address',
    ])
    .where('tip.idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()
  if (existing?.status === 'confirmed' && existing.transaction_hash) {
    const token = await Tapimo.getTokenMetadata(existing.chain_id, existing.token_address)
    return {
      amount: formatAmount(existing.amount),
      chainId: existing.chain_id,
      feePayer: 'sender',
      isDefaultToken: Address.isEqual(
        Address.checksum(existing.token_address),
        Address.checksum(existing.default_token_address ?? Tempo.addressLookup.pathUsd),
      ),
      memo: existing.memo,
      ok: true,
      recipientProviderUserId: input.winner.buyer_provider_user_id,
      senderProviderUserId: (
        await ensureTipRaffleEscrowMember(db, {
          chainId: existing.chain_id,
          providerId: input.providerId,
          workspaceId: input.workspaceId,
        })
      ).providerUserId,
      status: 'duplicate',
      tokenCurrency: token.currency,
      tokenSymbol: token.symbol,
      transactionHash: existing.transaction_hash,
    }
  }
  if (existing) throw new Error('Raffle payout is still pending.')

  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('id', '=', input.workspaceId)
    .executeTakeFirstOrThrow()
  const escrow = await ensureTipRaffleEscrowMember(db, {
    chainId: input.chainId,
    providerId: input.providerId,
    workspaceId: input.workspaceId,
  })
  const now = new Date().toISOString()
  const batchId = Nanoid.generate()
  const tipId = Nanoid.generate()
  await db
    .insertInto('tip_batch')
    .values({
      amount_each: input.amount,
      created_at: now,
      failure_reason: null,
      id: batchId,
      idempotency_key: input.idempotencyKey,
      memo: input.memo,
      provider: 'slack',
      provider_channel_id: input.channelId,
      provider_id: input.providerId,
      provider_thread_id: null,
      recipient_count: 1,
      sender_member_id: escrow.memberId,
      source: 'command',
      status: 'pending',
      token_address: input.tokenAddress,
      total_amount: input.amount,
      updated_at: now,
      workspace_id: input.workspaceId,
    })
    .execute()
  await db
    .insertInto('tip')
    .values({
      access_key_id: null,
      amount: input.amount,
      batch_id: batchId,
      chain_id: input.chainId,
      confirmed_at: null,
      created_at: now,
      failed_at: null,
      failure_reason: null,
      id: tipId,
      idempotency_key: input.idempotencyKey,
      memo: input.memo,
      recipient_id: input.winner.buyer_account_id,
      recipient_member_id: input.winner.buyer_member_id,
      sender_id: escrow.accountId,
      sender_member_id: escrow.memberId,
      sponsorship_memo: null,
      token_address: input.tokenAddress,
      transfer_log_index: null,
      updated_at: now,
      workspace_id: input.workspaceId,
    })
    .execute()

  try {
    await db
      .updateTable('tip_batch')
      .set({ status: 'submitting', updated_at: new Date().toISOString() })
      .where('id', '=', batchId)
      .execute()
    const privateKey = Tempo.getFeePayerPrivateKey(env, input.chainId)
    if (!privateKey) throw new Error('Tip raffle escrow wallet is not configured.')
    const client = createClient({
      chain: Tempo.getChain(input.chainId),
      transport: http(Tempo.getRpcUrl(env, input.chainId)),
    })
    const receipt = await sendTransactionSync(client, {
      accessList: [
        {
          address: escrow.accountAddress as Address.Address,
          storageKeys: [Hash.keccak256(Hex.fromString(input.idempotencyKey))],
        },
      ],
      account: privateKeyToAccount(privateKey),
      calls: [
        Actions.token.transfer.call({
          amount: BigInt(input.amount),
          ...(input.memo ? { memo: Tip.encodeTransferMemo(input.memo) } : {}),
          to: input.winner.buyer_account_address as Address.Address,
          token: input.tokenAddress as Address.Address,
        }),
      ],
      chain: Tempo.getChain(input.chainId),
      feeToken: input.tokenAddress as Address.Address,
      nonceKey: 'expiring' as const,
    } as never)
    if (!receipt.transactionHash) throw new Error('Tempo transaction did not return a hash.')
    await db
      .updateTable('tip_batch')
      .set({
        status: 'confirmed',
        transaction_hash: receipt.transactionHash,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', batchId)
      .execute()
    await db
      .updateTable('tip')
      .set({ confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .where('id', '=', tipId)
      .execute()

    const token = await Tapimo.getTokenMetadata(input.chainId, input.tokenAddress)
    return {
      amount: formatAmount(input.amount),
      chainId: input.chainId,
      feePayer: 'sender',
      isDefaultToken: Address.isEqual(
        Address.checksum(input.tokenAddress),
        Address.checksum(workspace.default_token_address ?? Tempo.addressLookup.pathUsd),
      ),
      memo: input.memo,
      ok: true,
      recipientProviderUserId: input.winner.buyer_provider_user_id,
      senderProviderUserId: escrow.providerUserId,
      status: 'sent',
      tokenCurrency: token.currency,
      tokenSymbol: token.symbol,
      transactionHash: receipt.transactionHash,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Raffle payout failed.'
    await db
      .updateTable('tip_batch')
      .set({ failure_reason: message, status: 'failed', updated_at: new Date().toISOString() })
      .where('id', '=', batchId)
      .execute()
    await db
      .updateTable('tip')
      .set({
        failed_at: new Date().toISOString(),
        failure_reason: message,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', tipId)
      .execute()
    throw error
  }
}

async function postTipRaffleReceiptMessage(
  db: DB.Type,
  options: {
    channelId: string
    providerId: string
    receipt: Extract<Tip.TipResult, { ok: true; status: 'duplicate' | 'sent' }>
    threadTs: string
  },
) {
  const existing = await db
    .selectFrom('tip_receipt_message')
    .innerJoin('tip_batch', 'tip_batch.id', 'tip_receipt_message.tip_batch_id')
    .select('tip_receipt_message.id')
    .where('tip_batch.transaction_hash', '=', options.receipt.transactionHash)
    .executeTakeFirst()
  if (existing) return

  const amount = options.receipt.isDefaultToken
    ? formatCurrencyAmount(options.receipt.amount, options.receipt.tokenCurrency)
    : formatTipAmount(
        options.receipt.amount,
        options.receipt.tokenCurrency,
        options.receipt.tokenSymbol,
      )
  await postSlackReceiptMessage(
    {
      channel: getChat().channel(`slack:${options.channelId}`),
      user: { userId: options.receipt.senderProviderUserId } as chat.Author,
    },
    {
      db,
      provider: { id: options.providerId, type: 'slack' },
      text: '',
    },
    `<@${options.receipt.senderProviderUserId}> paid raffle winner <@${options.receipt.recipientProviderUserId}> ${amount}${options.receipt.memo ? ` for ${options.receipt.memo}` : ''}.`,
    options.receipt.chainId,
    options.receipt.transactionHash,
    undefined,
    undefined,
    options.threadTs,
  )
}

export function getTipAskIdFromIdempotencyKey(value: string) {
  const parts = value.split(':')
  return parts[0] === 'tip_ask' && parts[1] ? parts[1] : null
}

function tipAskIdempotencyKey(input: {
  interactionId?: string
  nonce?: string
  providerUserId: string
  reaction: TipAskReaction
  tipAskId: string
}) {
  return `${tipAskIdempotencyPrefix}${input.tipAskId}:${input.reaction}:${input.providerUserId}${input.interactionId ? `:${input.interactionId}` : input.nonce ? `:${input.nonce}` : ''}`
}

function slackActionInteractionId(event: chat.ActionEvent) {
  const raw = z
    .looseObject({
      actions: z.array(z.looseObject({ action_ts: z.string().min(1).optional() })).optional(),
      trigger_id: z.string().min(1).optional(),
    })
    .safeParse(event.raw)
  return event.triggerId ?? raw.data?.trigger_id ?? raw.data?.actions?.[0]?.action_ts
}

function tipAskAmount(
  tipAsk: Pick<
    DB_gen.Selectable.tip_ask,
    'dollar_amount' | 'money_with_wings_amount' | 'moneybag_amount'
  >,
  reaction: TipAskReaction,
) {
  if (reaction === 'dollar') return tipAsk.dollar_amount
  if (reaction === 'moneybag') return tipAsk.moneybag_amount
  return tipAsk.money_with_wings_amount
}

async function selectTipRaffleMessageInput(db: DB.Type, tipRaffleId: string) {
  return await db
    .selectFrom('tip_raffle')
    .innerJoin('workspace', 'workspace.id', 'tip_raffle.workspace_id')
    .innerJoin('member as creator', 'creator.id', 'tip_raffle.creator_member_id')
    .leftJoin('member as winner', 'winner.id', 'tip_raffle.winner_member_id')
    .select([
      'creator.provider_user_id as creator_provider_user_id',
      'tip_raffle.chain_id',
      'tip_raffle.ended_at',
      'tip_raffle.ends_at',
      'tip_raffle.failed_ticket_count',
      'tip_raffle.id',
      'tip_raffle.memo',
      'tip_raffle.provider_channel_id',
      'tip_raffle.provider_message_ts',
      'tip_raffle.settled_amount',
      'tip_raffle.status',
      'tip_raffle.ticket_amount',
      'tip_raffle.token_address',
      'tip_raffle.winning_ticket_number',
      'winner.provider_user_id as winner_provider_user_id',
      'workspace.default_token_address as workspace_default_token_address',
    ])
    .where('tip_raffle.id', '=', tipRaffleId)
    .executeTakeFirst()
}

async function tipRaffleMessage(db: DB.Type, tipRaffle: TipRaffleMessageInput) {
  const token = await Tapimo.getTokenMetadata(tipRaffle.chain_id, tipRaffle.token_address)
  const formatTipRaffleAmount = (amount: number) => {
    const value = formatAmount(amount)
    return Address.isEqual(
      Address.checksum(tipRaffle.token_address),
      Address.checksum(tipRaffle.workspace_default_token_address ?? Tempo.addressLookup.pathUsd),
    )
      ? formatCurrencyAmount(value, token.currency)
      : formatTipAmount(value, token.currency, token.symbol)
  }
  const rows = await db
    .selectFrom('tip_raffle_ticket')
    .innerJoin('member as buyer', 'buyer.id', 'tip_raffle_ticket.buyer_member_id')
    .select([
      'buyer.provider_user_id as buyer_provider_user_id',
      sql<number>`sum(tip_raffle_ticket.ticket_count)`.as('ticket_count'),
    ])
    .where('tip_raffle_ticket.raffle_id', '=', tipRaffle.id)
    .groupBy('buyer.provider_user_id')
    .orderBy('ticket_count', 'desc')
    .orderBy('buyer.provider_user_id', 'asc')
    .execute()
  const ticketCount = rows.reduce((total, row) => total + Number(row.ticket_count), 0)
  const pledgedAmount = ticketCount * tipRaffle.ticket_amount
  const payableAmount = pledgedAmount
  const entrantLines = rows.map(
    (row) => `<@${row.buyer_provider_user_id}> x${Number(row.ticket_count)}`,
  )
  const title = `<@${tipRaffle.creator_provider_user_id}> opened a raffle: ${tipRaffle.memo}`
  const entrants = entrantLines.length ? `Entrants: ${entrantLines.join(', ')}` : null
  const ticketContext = `Ticket: ${formatTipRaffleAmount(tipRaffle.ticket_amount)} · Tickets: ${ticketCount}`
  const summary = (() => {
    if (tipRaffle.status === 'ended') {
      if (!tipRaffle.winner_provider_user_id)
        return [
          `Ended · No winner · ${ticketCount} ${ticketCount === 1 ? 'ticket' : 'tickets'}`,
          ticketContext,
          ...(entrants ? [entrants] : []),
        ].join('\n')
      const settledText = formatTipRaffleAmount(tipRaffle.settled_amount)
      const payableText = formatTipRaffleAmount(payableAmount)
      const paidOutText =
        tipRaffle.settled_amount === payableAmount ? settledText : `${settledText} / ${payableText}`
      return [
        `Ended · Winner: <@${tipRaffle.winner_provider_user_id}>`,
        `Paid out: ${paidOutText}`,
        `Winning ticket: #${tipRaffle.winning_ticket_number}`,
        ticketContext,
        ...(entrants ? [entrants] : []),
        ...(tipRaffle.failed_ticket_count
          ? [
              `${tipRaffle.failed_ticket_count} ${tipRaffle.failed_ticket_count === 1 ? 'ticket' : 'tickets'} failed payment`,
            ]
          : []),
      ].join('\n')
    }
    return [
      `Pot: ${formatTipRaffleAmount(pledgedAmount)}`,
      `Ends: ${(() => {
        const date = new Date(tipRaffle.ends_at)
        return `<!date^${Math.floor(date.getTime() / 1000)}^{date_short_pretty} {time}|${date.toISOString()}>`
      })()}`,
      ...(entrants ? [entrants] : []),
    ].join('\n')
  })()
  const text = [title, summary, ...(tipRaffle.status === 'open' ? [ticketContext] : [])].join('\n')
  return {
    blocks: [
      {
        text: { text: `${title}\n${summary}`, type: 'mrkdwn' },
        type: 'section',
      },
      ...(tipRaffle.status === 'open'
        ? [
            {
              elements: [1, 5].map((ticketCount) => ({
                action_id: `tip_raffle_buy_${ticketCount}`,
                text: {
                  emoji: true,
                  text: `Buy ${ticketCount}`,
                  type: 'plain_text',
                },
                type: 'button',
                value: JSON.stringify({
                  nonce: Nanoid.generate(),
                  tipRaffleId: tipRaffle.id,
                }),
              })),
              type: 'actions',
            },
            {
              elements: [
                {
                  text: ticketContext,
                  type: 'mrkdwn',
                },
              ],
              type: 'context',
            },
          ]
        : []),
    ],
    text,
  }
}

async function tipAskMessage(db: DB.Type, tipAsk: TipAskMessageInput) {
  const token = await Tapimo.getTokenMetadata(tipAsk.chain_id, tipAsk.token_address)
  const formatTipAskAmount = (amount: number) => {
    const value = formatAmount(amount)
    return Address.isEqual(
      Address.checksum(tipAsk.token_address),
      Address.checksum(tipAsk.workspace_default_token_address ?? Tempo.addressLookup.pathUsd),
    )
      ? formatCurrencyAmount(value, token.currency)
      : formatTipAmount(value, token.currency, token.symbol)
  }
  const tipRows = (
    await db
      .selectFrom('tip')
      .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
      .select([
        'sender.provider_user_id as sender_provider_user_id',
        'tip.amount',
        'tip.idempotency_key',
      ])
      .where('tip.idempotency_key', 'like', `${tipAskIdempotencyPrefix}${tipAsk.id}:%`)
      .where('tip.confirmed_at', 'is not', null)
      .orderBy('tip.created_at', 'asc')
      .execute()
  ).filter((row) => !row.idempotency_key.endsWith(':creator_fee'))
  const pendingRows = (
    await db
      .selectFrom('pending_tip')
      .select([
        'pending_tip.amount',
        'pending_tip.idempotency_key',
        'pending_tip.sender_provider_user_id',
      ])
      .where('pending_tip.idempotency_key', 'like', `${tipAskIdempotencyPrefix}${tipAsk.id}:%`)
      .where('pending_tip.status', 'in', ['pending', 'sending', 'sent'])
      .orderBy('pending_tip.created_at', 'asc')
      .execute()
  ).filter((row) => !row.idempotency_key.endsWith(':creator_fee'))
  const rows = [...tipRows, ...pendingRows]
  const tipCount = rows.length
  const total = rows.reduce((total, row) => total + row.amount, 0)
  const summary = tipCount
    ? `${tipCount} ${tipCount === 1 ? 'tip' : 'tips'} · ${formatTipAskAmount(total)} total`
    : 'No tips yet'
  const status = tipAsk.closed_at ? 'Closed' : null
  const reactionLines = tipAskReactions
    .map((reaction) => {
      const tipperCounts = new Map<string, number>()
      const tipperAmounts = new Map<string, number>()
      for (const row of rows) {
        if (row.idempotency_key.split(':')[2] !== reaction.name) continue
        tipperCounts.set(
          row.sender_provider_user_id,
          (tipperCounts.get(row.sender_provider_user_id) ?? 0) + 1,
        )
        tipperAmounts.set(
          row.sender_provider_user_id,
          (tipperAmounts.get(row.sender_provider_user_id) ?? 0) + row.amount,
        )
      }
      const tippers = [...tipperCounts]
        .sort(([providerUserIdA, countA], [providerUserIdB, countB]) => {
          const amountA = tipperAmounts.get(providerUserIdA) ?? 0
          const amountB = tipperAmounts.get(providerUserIdB) ?? 0
          if (amountA !== amountB) return amountB - amountA
          if (countA !== countB) return countB - countA
          return providerUserIdA.localeCompare(providerUserIdB)
        })
        .map(([providerUserId, count]) => `<@${providerUserId}>${count > 1 ? ` x${count}` : ''}`)
      if (!tippers.length) return null
      return `${reaction.emoji} ${tippers.join(' ')}`
    })
    .filter((line) => line !== null)
  const title = tipAsk.beneficiary_provider_user_id
    ? `<@${tipAsk.requester_provider_user_id}> opened a tip jar for <@${tipAsk.beneficiary_provider_user_id}>${tipAsk.memo ? `'s ${tipAsk.memo}` : ''}`
    : `<@${tipAsk.requester_provider_user_id}> opened a tip jar${tipAsk.memo ? ` for ${tipAsk.memo}` : ''}`
  const text = [
    title,
    ...(status ? [status] : []),
    summary,
    ...(tipAsk.closed_at
      ? []
      : [
          '',
          tipAskReactions
            .map(
              (reaction) =>
                `[${reaction.emoji} ${formatTipAskAmount(tipAskAmount(tipAsk, reaction.name))}]`,
            )
            .join(' '),
        ]),
    ...(reactionLines.length ? ['', ...reactionLines] : []),
  ].join('\n')
  return {
    blocks: [
      {
        text: {
          text: `${title}\n${[...(status ? [status] : []), summary].join('\n')}`,
          type: 'mrkdwn',
        },
        type: 'section',
      },
      ...tipAsk.image_files.map((imageFile) => ({
        alt_text: imageFile.alt_text,
        slack_file: { id: imageFile.provider_file_id },
        type: 'image',
      })),
      ...(tipAsk.closed_at
        ? []
        : [
            {
              elements: tipAskReactions.map((reaction) => ({
                action_id: `tip_ask_option_${reaction.name}`,
                text: {
                  emoji: true,
                  text: `${reaction.emoji} ${formatTipAskAmount(tipAskAmount(tipAsk, reaction.name))}`,
                  type: 'plain_text',
                },
                type: 'button',
                value: JSON.stringify({
                  nonce: Nanoid.generate(),
                  reaction: reaction.name,
                  tipAskId: tipAsk.id,
                }),
              })),
              type: 'actions',
            },
          ]),
      ...(reactionLines.length
        ? [
            {
              text: { text: reactionLines.join('\n'), type: 'mrkdwn' },
              type: 'section',
            },
          ]
        : []),
    ],
    text,
  }
}

export async function updateReactionTipAggregate(
  providerId: string,
  options: {
    channelId: string
    threadTs: string
    workspaceId: string
  },
) {
  const db = DB.create(env.DB)
  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return
  const text = await reactionTipAggregateText(db, {
    channelId: options.channelId,
    providerId,
    threadTs: options.threadTs,
    workspaceId: options.workspaceId,
  })
  if (!text) return
  const existing = await db
    .selectFrom('reaction_tip_thread')
    .selectAll()
    .where('workspace_id', '=', options.workspaceId)
    .where('channel_id', '=', options.channelId)
    .where('message_ts', '=', options.threadTs)
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
    return existing.reply_ts
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
        reply_ts: json.ts,
        updated_at: now,
        workspace_id: options.workspaceId,
      })
      .execute()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
  }
  return json.ts
}

export async function updateReceiptBoostAggregate(
  providerId: string,
  options: {
    channelId: string
    threadTs: string
    workspaceId: string
  },
) {
  const db = DB.create(env.DB)
  const rows = await db
    .selectFrom('tip_batch')
    .innerJoin('member as sender', 'sender.id', 'tip_batch.sender_member_id')
    .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
    .select([
      'sender.provider_user_id as sender_provider_user_id',
      'tip_batch.amount_each',
      'tip_batch.idempotency_key',
      'tip_batch.token_address',
      'tip_batch.transaction_hash',
      'workspace.chain_id',
      'workspace.default_token_address',
    ])
    .where('tip_batch.workspace_id', '=', options.workspaceId)
    .where((eb) =>
      eb.or([
        eb('tip_batch.provider_channel_id', '=', options.channelId),
        eb('tip_batch.provider_channel_id', '=', `slack:${options.channelId}`),
      ]),
    )
    .where('tip_batch.provider_thread_id', '=', options.threadTs)
    .where('tip_batch.idempotency_key', 'like', `${receiptBoostIdempotencyPrefix}%`)
    .where('tip_batch.status', '=', 'confirmed')
    .where('tip_batch.transaction_hash', 'is not', null)
    .orderBy('tip_batch.created_at', 'asc')
    .execute()
  if (rows.length === 0) return

  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return

  const groups = rows.reduce(
    (groups, row) => {
      const [, workspaceId, channelId, messageTs] = row.idempotency_key.split(':')
      if (
        workspaceId !== options.workspaceId ||
        channelId !== options.channelId ||
        !messageTs ||
        !row.transaction_hash
      )
        return groups
      const group = groups.find((group) => group.messageTs === messageTs)
      const line = `• <@${row.sender_provider_user_id}> boosted · <${Tempo.formatTxLink(row.chain_id, row.transaction_hash)}|Receipt>`
      if (group) {
        group.lines.push(line)
        return groups
      }
      groups.push({
        amount: row.amount_each,
        chainId: row.chain_id,
        defaultTokenAddress: row.default_token_address,
        lines: [line],
        messageTs,
        tokenAddress: row.token_address,
      })
      return groups
    },
    [] as Array<{
      amount: number
      chainId: number
      defaultTokenAddress: string | null
      lines: string[]
      messageTs: string
      tokenAddress: string
    }>,
  )
  if (groups.length === 0) return

  const groupTexts = await Promise.all(
    groups.map(async (group) => {
      const token = await Tapimo.getTokenMetadata(group.chainId, group.tokenAddress)
      const amount = formatAmount(group.amount)
      const displayAmount = Address.isEqual(
        Address.checksum(group.tokenAddress),
        Address.checksum(group.defaultTokenAddress ?? Tempo.addressLookup.pathUsd),
      )
        ? formatCurrencyAmount(amount, token.currency)
        : formatTipAmount(amount, token.currency, token.symbol)
      const recipients = await db
        .selectFrom('tip_receipt_message')
        .innerJoin('tip', 'tip.batch_id', 'tip_receipt_message.tip_batch_id')
        .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
        .select('recipient.provider_user_id')
        .where('tip_receipt_message.workspace_id', '=', options.workspaceId)
        .where('tip_receipt_message.channel_id', '=', options.channelId)
        .where('tip_receipt_message.message_ts', '=', group.messageTs)
        .orderBy('tip.created_at', 'asc')
        .execute()
      const recipientCount = recipients.length
      const recipientMentions = formatProviderUserMentionSummary(
        recipients.map((recipient) => recipient.provider_user_id),
      )
      const recipientText =
        recipientCount === 1
          ? `<@${recipients[0]!.provider_user_id}> received a boost`
          : `${recipientMentions} received boosts`
      const amountText = recipientCount === 1 ? displayAmount : `${displayAmount} each`
      return `${recipientText} on ${Slack.formatMessageLink(providerId, options.channelId, group.messageTs)} ${amountText}:\n${group.lines.join('\n')}`
    }),
  )
  const text = `Boosts received in this thread:\n\n${groupTexts.join('\n\n')}`
  const existing = await db
    .selectFrom('receipt_boost_thread')
    .selectAll()
    .where('workspace_id', '=', options.workspaceId)
    .where('channel_id', '=', options.channelId)
    .where('thread_ts', '=', options.threadTs)
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
      .updateTable('receipt_boost_thread')
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
      .insertInto('receipt_boost_thread')
      .values({
        channel_id: options.channelId,
        created_at: now,
        id: Nanoid.generate(),
        reply_ts: json.ts,
        thread_ts: options.threadTs,
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

function hasInvalidMentionIntent(text: string) {
  return /\b(connect|configure|get started|install|link|mine|set ?up|start|tip|send|pay|thank you|thanks|ty|thx|thank u|creature|creatures|dragon|dragons|elf|elves|fae|fairy|goblin|goblins|gnome|gnomes|gremlin|gremlins|kobold|kobolds|monster|monsters|orc|orcs|troll|trolls)\b/i.test(
    text,
  )
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
    ctx.channelProviderId ?? ctx.provider.id,
    event.channel.id.replace(/^slack:/, ''),
    event.user.userId,
    body,
    { threadTs: options.threadTs ?? event.threadTs },
  )
}

async function postInvalidMentionReply(
  event: TipEvent,
  ctx: HandlerContext,
  mentionText: string,
  threadTs: string,
) {
  const installation = await getSlack().getInstallation(ctx.channelProviderId ?? ctx.provider.id)
  if (!installation) throw new Error('Tibot app not installed for this workspace.')

  const body = new URLSearchParams()
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set(
    'text',
    await generateInvalidMentionReply(mentionText, {
      slackMentions: await (async () => {
        // AI is only used for chatter; allow it to mention the author and reject other @names.
        const user = await Slack.getUserInfo({
          apiUrl: env.SLACK_API_URL,
          botToken: installation.botToken,
          providerUserId: event.user.userId,
          withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
        })
        if (!user) return []
        const targets = [
          user.profile?.display_name,
          user.profile?.real_name,
          user.real_name,
          user.name,
        ]
          .map((label) => label?.replace(/^@+/, '').trim())
          .filter((label): label is string => Boolean(label))
          .map((label) => ({ label, providerUserId: event.user.userId }))
        const seen = new Set<string>()
        return targets.filter((target) => {
          const key = `${target.providerUserId}:${target.label.toLowerCase()}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      })(),
    }),
  )
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

const creaturePattern =
  /\b(creature|creatures|dragon|dragons|elf|elves|fae|fairy|goblin|goblins|gnome|gnomes|gremlin|gremlins|kobold|kobolds|monster|monsters|orc|orcs|troll|trolls)\b/i

async function generateInvalidMentionReply(
  mentionText: string,
  options: { slackMentions?: Array<{ label: string; providerUserId: string }> } = {},
) {
  const text = mentionText.trim()
  const creatureMatch = text.match(creaturePattern)
  const hasPaymentWord = /\b(tip|send|pay)\b/i.test(text)
  const hasRecipientMention = /<@[A-Z0-9_]+/.test(text)
  const isSetupText = /\b(connect|configure|get started|install|link|mine|set ?up|start)\b/i.test(
    text,
  )
  const isThanksText = /^(thank you|thanks|ty|thx|thank u)\b/i.test(text)
  const fallback = (() => {
    if (creatureMatch && (hasPaymentWord || hasRecipientMention))
      return `${creatureMatch[0].toUpperCase()}? Excellent. For tips: \`@${getSlackBotDisplayName(env.HOST)} @account for coffee\`.`
    if (creatureMatch) return `${creatureMatch[0].toUpperCase()}? Now we are talking.`
    if (isThanksText) return 'Anytime.'
    if (isSetupText)
      return `Run \`@${getSlackBotDisplayName(env.HOST)} connect\`, then try \`@${getSlackBotDisplayName(env.HOST)} @account for coffee\`.`
    if (hasPaymentWord || hasRecipientMention)
      return `Almost. Try \`@${getSlackBotDisplayName(env.HOST)} @account for coffee\`.`
    return 'Anytime.'
  })()
  try {
    const paymentSyntaxRequired = hasPaymentWord || hasRecipientMention
    const result = z
      .parse(
        z.object({ response: z.string().default('') }),
        await env.AI.run('@cf/meta/llama-3.2-1b-instruct', {
          max_tokens: 48,
          messages: [
            {
              content: paymentSyntaxRequired
                ? `You are ${getSlackBotDisplayName(env.HOST)} in Slack. Reply to an invalid @${getSlackBotDisplayName(env.HOST)} payment mention. Keep it under 140 chars. Be helpful and concise. You must include this exact syntax: \`@${getSlackBotDisplayName(env.HOST)} @account for coffee\`. Do not mention users.`
                : `You are ${getSlackBotDisplayName(env.HOST)} in Slack. Reply to an invalid @${getSlackBotDisplayName(env.HOST)} mention. Keep it under 140 chars. Be short and pithy. Do not mention users. If the user mentions goblins or other creatures, get REALLY EXCITED. Otherwise just acknowledge or deflect lightly.`,
              role: 'system',
            },
            { content: text || '(empty mention)', role: 'user' },
          ],
        }),
      )
      .response.replace(/[\r\n]+/g, ' ')
      .trim()
      .replace(/^['"]|['"]$/g, '')
    const reply = formatInvalidMentionAiReply(result, { ...options, paymentSyntaxRequired })
    if (reply) return reply
  } catch (error) {
    console.error('Failed to generate invalid mention reply:', error)
  }
  return fallback
}

function formatInvalidMentionAiReply(
  value: string,
  options: {
    paymentSyntaxRequired?: boolean
    slackMentions?: Array<{ label: string; providerUserId: string }>
  } = {},
) {
  const reply = (options.slackMentions ?? [])
    // Convert only known labels to Slack mention tokens; any remaining @name is rejected below.
    .filter((mention) => mention.label && !/\s/.test(mention.label))
    .sort((a, b) => b.label.length - a.label.length)
    .reduce(
      (text, mention) =>
        text.replace(
          new RegExp(
            `(^|[^\\p{L}\\p{N}_<])@${mention.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}._-])`,
            'giu',
          ),
          `$1<@${mention.providerUserId}>`,
        ),
      value,
    )
  if (!isValidInvalidMentionAiReply(reply, options)) return null
  return reply
}

function isValidInvalidMentionAiReply(
  value: string,
  options: {
    paymentSyntaxRequired?: boolean
    slackMentions?: Array<{ label: string; providerUserId: string }>
  } = {},
) {
  if (!value || value.length > 200) return false
  if (/^@?tipbot[.!?]?$/i.test(value)) return false
  const syntax = `@${getSlackBotDisplayName(env.HOST)} @account for coffee`
  if (options.paymentSyntaxRequired && !value.includes(syntax)) return false
  const text = value.replace(syntax, '')
  if (text.includes(`@${getSlackBotDisplayName(env.HOST)}`) || /@Tipbot/i.test(text)) return false
  if (/(^|[^\p{L}\p{N}_<])@[\p{L}\p{N}][\p{L}\p{N}._-]*/iu.test(text)) return false
  const allowedProviderUserIds = new Set(
    (options.slackMentions ?? []).map((mention) => mention.providerUserId),
  )
  if (
    [...value.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]+)?>/g)].some(
      (match) => !match[1] || !allowedProviderUserIds.has(match[1]),
    )
  )
    return false
  return true
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
    ctx.channelProviderId ?? ctx.provider.id,
    event.channel.id.replace(/^slack:/, ''),
    event.user.userId,
    body,
    { threadTs: ctx.threadTs },
  )
}

async function updateAirdropMessage(
  providerId: string,
  channelId: string,
  messageTs: string,
  tipAirdropId: string,
) {
  const installation = await getSlack().getInstallation(providerId)
  if (!installation) throw new Error('Tipbot app not installed for this workspace.')

  const message = await tipAirdropMessage(DB.create(env.DB), tipAirdropId)
  const body = new URLSearchParams()
  body.set('blocks', JSON.stringify(message.blocks))
  body.set('channel', channelId)
  body.set('text', message.text)
  body.set('ts', messageTs)
  body.set('unfurl_links', 'false')
  body.set('unfurl_media', 'false')
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
  await DB.create(env.DB)
    .updateTable('tip_airdrop')
    .set({ updated_at: new Date().toISOString() })
    .where('id', '=', tipAirdropId)
    .execute()
}

export async function closeExpiredTipAirdrops() {
  const db = DB.create(env.DB)
  const rows = await db
    .selectFrom('tip_airdrop')
    .select(['id', 'provider_channel_id', 'provider_id', 'provider_message_ts'])
    .where('status', '=', 'open')
    .where('ends_at', '<=', new Date().toISOString())
    .orderBy('ends_at', 'asc')
    .limit(20)
    .execute()
  for (const row of rows) {
    const now = new Date().toISOString()
    await db
      .updateTable('tip_airdrop')
      .set({ ended_at: now, status: 'ended', updated_at: now })
      .where('id', '=', row.id)
      .execute()
    await updateAirdropMessage(
      row.provider_id,
      row.provider_channel_id,
      row.provider_message_ts,
      row.id,
    ).catch(async (error) => {
      if ((error as { code?: unknown }).code !== 'message_not_found') {
        console.error('Failed to update ended airdrop message:', row.id, error)
        return
      }
      await db
        .updateTable('tip_airdrop')
        .set({ updated_at: new Date().toISOString() })
        .where('id', '=', row.id)
        .execute()
    })
  }

  const staleMessageRows = await db
    .selectFrom('tip_airdrop')
    .select(['id', 'provider_channel_id', 'provider_id', 'provider_message_ts'])
    .where('status', '=', 'ended')
    .where('ended_at', 'is not', null)
    .whereRef('updated_at', '=', 'ended_at')
    .orderBy('ended_at', 'asc')
    .limit(20)
    .execute()
  for (const row of staleMessageRows)
    await updateAirdropMessage(
      row.provider_id,
      row.provider_channel_id,
      row.provider_message_ts,
      row.id,
    ).catch(async (error) => {
      if ((error as { code?: unknown }).code !== 'message_not_found') {
        console.error('Failed to update ended airdrop message:', row.id, error)
        return
      }
      await db
        .updateTable('tip_airdrop')
        .set({ updated_at: new Date().toISOString() })
        .where('id', '=', row.id)
        .execute()
    })
}

const airdropClaimAmount = 10_000 // $0.01

async function tipAirdropMessage(db: DB.Type, input: TipAirdropMessageInput | string) {
  const tipAirdrop =
    typeof input === 'string'
      ? await db
          .selectFrom('tip_airdrop')
          .innerJoin('workspace', 'workspace.id', 'tip_airdrop.workspace_id')
          .select([
            'tip_airdrop.chain_id',
            'tip_airdrop.claim_amount',
            'tip_airdrop.claimed_amount',
            'tip_airdrop.ended_at',
            'tip_airdrop.ends_at',
            'tip_airdrop.id',
            'tip_airdrop.name',
            'tip_airdrop.status',
            'tip_airdrop.token_address',
            'tip_airdrop.total_amount',
            'workspace.default_token_address as workspace_default_token_address',
          ])
          .where('tip_airdrop.id', '=', input)
          .executeTakeFirstOrThrow()
      : input
  const claimedProviderUserIds =
    typeof input === 'string'
      ? await db
          .selectFrom('tip_airdrop_claim')
          .innerJoin('member', 'member.id', 'tip_airdrop_claim.recipient_member_id')
          .select('member.provider_user_id')
          .where('tip_airdrop_claim.airdrop_id', '=', input)
          .orderBy('tip_airdrop_claim.created_at', 'asc')
          .execute()
          .then((rows) => rows.map((row) => row.provider_user_id))
      : input.claimed_provider_user_ids
  return {
    blocks: airdropBlocks({ ...tipAirdrop, claimed_provider_user_ids: claimedProviderUserIds }),
    text: airdropText({ ...tipAirdrop, claimed_provider_user_ids: claimedProviderUserIds }),
  }
}

function airdropBlocks(tipAirdrop: TipAirdropMessageInput) {
  return [
    {
      text: {
        text: `🚨 ${escapeSlackMrkdwn(tipAirdrop.name)} airdrop time 🚨`,
        type: 'mrkdwn',
      },
      type: 'section',
    },
    {
      text: {
        text:
          tipAirdrop.status === 'ended'
            ? `Ended · Pot: ${airdropPotText(tipAirdrop)}\n${airdropClaimedText(tipAirdrop.claimed_provider_user_ids)}`
            : `Pot: ${airdropPotText(tipAirdrop)}\nEnds: ${airdropCountdownText(tipAirdrop.ends_at)}\n${airdropClaimedText(tipAirdrop.claimed_provider_user_ids)}`,
        type: 'mrkdwn',
      },
      type: 'section',
    },
    ...(tipAirdrop.status === 'open'
      ? [
          {
            elements: [
              {
                action_id: 'airdrop_claim',
                style: 'primary',
                text: { text: 'Claim', type: 'plain_text' },
                type: 'button',
                value: JSON.stringify({ tipAirdropId: tipAirdrop.id }),
              },
            ],
            type: 'actions',
          },
          {
            elements: [{ text: 'Claim while supplies last!', type: 'mrkdwn' }],
            type: 'context',
          },
        ]
      : []),
  ]
}

function airdropPotText(tipAirdrop: TipAirdropMessageInput) {
  const remainingAmount = Math.max(0, tipAirdrop.total_amount - tipAirdrop.claimed_amount)
  const token = Tempo.getTokenMetadataFallback(
    Address.checksum(tipAirdrop.token_address ?? tipAirdrop.workspace_default_token_address),
  )
  return `${formatCurrencyAmount(formatAmount(remainingAmount), token.currency)} left of ${formatCurrencyAmount(formatAmount(tipAirdrop.total_amount), token.currency)}`
}

function airdropCountdownText(expiresAt: string) {
  const date = new Date(expiresAt)
  return `<!date^${Math.floor(date.getTime() / 1000)}^{date_short_pretty} {time}|${date.toISOString()}>`
}

function airdropClaimedText(claimedProviderUserIds: string[]) {
  const claimedCounts = claimedProviderUserIds.reduce((counts, providerUserId) => {
    counts.set(providerUserId, (counts.get(providerUserId) ?? 0) + 1)
    return counts
  }, new Map<string, number>())
  return claimedCounts.size
    ? `Claimed: ${[...claimedCounts].map(([providerUserId, count]) => `<@${providerUserId}>${count > 1 ? `×${count}` : ''}`).join(' ')}`
    : 'Claimed: No one yet'
}

function airdropText(tipAirdrop: TipAirdropMessageInput) {
  return tipAirdrop.status === 'ended'
    ? `🚨 ${escapeSlackMrkdwn(tipAirdrop.name)} airdrop time 🚨\nEnded · Pot: ${airdropPotText(tipAirdrop)}\n${airdropClaimedText(tipAirdrop.claimed_provider_user_ids)}`
    : `🚨 ${escapeSlackMrkdwn(tipAirdrop.name)} airdrop time 🚨\nPot: ${airdropPotText(tipAirdrop)}\nEnds: ${airdropCountdownText(tipAirdrop.ends_at)}\n${airdropClaimedText(tipAirdrop.claimed_provider_user_ids)}\nClaim with Tipbot. Claim while supplies last!`
}

function escapeSlackMrkdwn(value: string) {
  return value.replace(/[<>&]/g, (char) =>
    char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&amp;',
  )
}

async function postConnectLink(event: TipEvent, ctx: HandlerContext) {
  let workspace =
    (await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()) ??
    (ctx.allowUninstalledWorkspaceCreate
      ? await (async () => {
          const now = new Date().toISOString()
          await ctx.db
            .insertInto('workspace')
            .values({
              created_at: now,
              default_amount: 1000,
              id: Nanoid.generate(),
              installed_at: null,
              provider: ctx.provider.type,
              provider_id: ctx.provider.id,
              uninstalled_at: null,
              updated_at: now,
            })
            .onConflict((oc) => oc.columns(['provider', 'provider_id']).doNothing())
            .execute()
          return await ctx.db
            .selectFrom('workspace')
            .selectAll()
            .where('provider', '=', ctx.provider.type)
            .where('provider_id', '=', ctx.provider.id)
            .executeTakeFirst()
        })()
      : null)
  if (!workspace) {
    await postPrivateReply(
      event,
      event.user,
      'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
    )
    return
  }
  if (ctx.settingsProviderId && !workspace.installed_at) {
    const settingsWorkspace = await ctx.db
      .selectFrom('workspace')
      .select(['chain_id', 'default_amount', 'default_token_address'])
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.settingsProviderId)
      .executeTakeFirst()
    if (settingsWorkspace) {
      await ctx.db
        .updateTable('workspace')
        .set({
          chain_id: settingsWorkspace.chain_id,
          default_amount: settingsWorkspace.default_amount,
          default_token_address: settingsWorkspace.default_token_address,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', workspace.id)
        .execute()
      workspace = { ...workspace, ...settingsWorkspace }
    }
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
    const providerIdentityId = Nanoid.generate()
    await ctx.db
      .insertInto('provider_identity')
      .values({
        account_id: null,
        created_at: createdAt,
        display_name: null,
        id: providerIdentityId,
        metadata: null,
        provider: workspace.provider,
        provider_global_user_id: null,
        provider_user_id: event.user.userId,
        provider_workspace_id: workspace.provider_id,
        real_name: null,
        updated_at: createdAt,
      })
      .execute()
      .catch((error) => {
        if (!isUniqueConstraintError(error)) throw error
      })
    const identity = await ctx.db
      .selectFrom('provider_identity')
      .select('id')
      .where('provider', '=', workspace.provider)
      .where('provider_workspace_id', '=', workspace.provider_id)
      .where('provider_user_id', '=', event.user.userId)
      .executeTakeFirstOrThrow()
    await ctx.db
      .insertInto('member')
      .values({
        created_at: createdAt,
        id,
        login: null,
        name: null,
        provider_identity_id: identity.id,
        provider_user_id: event.user.userId,
        updated_at: createdAt,
        workspace_id: workspace.id,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'provider_user_id']).doNothing())
      .execute()
    member = await ctx.db
      .selectFrom('member')
      .selectAll()
      .where('workspace_id', '=', workspace.id)
      .where('provider_user_id', '=', event.user.userId)
      .executeTakeFirstOrThrow()
  }

  const accountId = member.provider_identity_id
    ? (
        await ctx.db
          .selectFrom('provider_identity')
          .select('account_id')
          .where('id', '=', member.provider_identity_id)
          .executeTakeFirstOrThrow()
      ).account_id
    : null

  if (accountId) {
    const accessKeys = await ctx.db
      .selectFrom('access_key')
      .select(['id', 'token_address'])
      .where('account_id', '=', accountId)
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
    if (accessKey && !ctx.forceConnectRefresh) {
      await postPrivateReply(event, event.user, 'Already connected', { threadTs: ctx.threadTs })
      return
    }
  }

  const now = new Date()
  const token = Nanoid.generate()
  const accessKey = AccessKey.generate()
  const linkButtonLabel = accountId ? 'Refresh connection' : 'Connect to Tipbot'
  const linkDescription = 'Link expires in 10 minutes.'
  const linkUrl = `https://${env.HOST}/connect/${token}`
  const linkText = `${accountId ? 'Refresh Tipbot connection' : 'Connect to Tipbot'}: ${linkUrl}\n${linkDescription}`
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
      channel_provider_id: ctx.channelProviderId ?? ctx.provider.id,
      token_hash: await AccountLink.hashToken(env, token),
      used_at: null,
    })
    .execute()

  await postPrivateReply(
    event,
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
    { threadTs: ctx.threadTs },
  )
}

async function postPrivateReply(
  event: TipEvent,
  user: chat.Author,
  message: Parameters<TipEvent['channel']['postEphemeral']>[1],
  options: { providerId?: string; threadTs?: string } = {},
) {
  const threadTs = options.threadTs ?? event.threadTs
  if (options.providerId && typeof message === 'string') {
    const body = new URLSearchParams()
    body.set('channel', Slack.getChannelId(event.channel.id))
    body.set('text', message)
    await postSlackPrivateReply(
      options.providerId,
      Slack.getChannelId(event.channel.id),
      user.userId,
      body,
      {
        threadTs,
      },
    )
    return
  }
  if (Slack.isDMChannelId(event.channel.id)) {
    await event.channel.post(message)
    return
  }

  const channel = threadTs
    ? getChat().channel(`slack:${Slack.getChannelId(event.channel.id)}:${threadTs}`)
    : event.channel
  await channel.postEphemeral(user, message, { fallbackToDM: false })
}

async function postSlackTipPreview(
  event: TipEvent,
  pending: PendingSlackTip & { amountText: string },
) {
  const token = Nanoid.generate()
  await (async () => {
    // Store Slack confirmation state briefly; the button value only carries the opaque token.
    const state = createCloudflareState({
      name: 'tipbot',
      namespace: env.CHAT_STATE,
      shardKey(threadId) {
        return threadId.split(':', 1)[0] || 'default'
      },
    })
    await state.connect()
    await state.set(`pending_tip:${token}`, pending, 10 * 60 * 1000) // 10 minutes
    await state.disconnect()
  })()
  const skippedLines = pending.skippedRecipients?.length
    ? [
        '',
        '*Skipped:*',
        ...pending.skippedRecipients.map(
          (recipient) =>
            `• ${event.channel.mentionUser(recipient.recipientProviderUserId)} (${recipient.reason === 'you' ? 'you' : 'not connected yet'})`,
        ),
      ]
    : []
  const totalAmount = pending.amount
    ? formatCurrencyAmount(formatAmount(pending.amount * pending.recipients.length), 'USD')
    : undefined
  await postPrivateReply(event, event.user, {
    card: chat.Card({
      children: [
        chat.CardText(
          [
            `You’re about to tip ${pending.usergroupId ? `${Slack.formatUsergroupMention(pending.usergroupId, pending.usergroupLabel)} ` : ''}${formatProviderUserMentionSummary(
              pending.recipients.map((recipient) => recipient.recipientProviderUserId),
              (providerUserId) => event.channel.mentionUser(providerUserId),
            )} ${pending.amountText} each${pending.memo ? ` for ${pending.memo}` : ''}.`,
            ...(totalAmount ? [`Total: ${totalAmount}`] : []),
            '',
            '*Recipients:*',
            ...pending.recipients.map(
              (recipient) => `• ${event.channel.mentionUser(recipient.recipientProviderUserId)}`,
            ),
            ...skippedLines,
          ].join('\n'),
        ),
        chat.Actions([
          chat.Button({ id: 'confirm_tip', label: 'Confirm tip', style: 'primary', value: token }),
          chat.Button({ id: 'confirm_cancel', label: 'Cancel' }),
        ]),
      ],
    }),
    fallbackText: `Confirm tip: ${formatProviderUserMentionSummary(
      pending.recipients.map((recipient) => recipient.recipientProviderUserId),
      (providerUserId) => event.channel.mentionUser(providerUserId),
    )} ${pending.amountText} each.`,
  })
}

async function postTipResult(
  event: TipEvent,
  ctx: HandlerContext,
  result: Tip.TipBatchResult,
  options: {
    skippedRecipients?: Tip.TipSkippedRecipient[]
    threadTs?: string
    usergroupId?: string
    usergroupLabel?: string
  } = {},
) {
  const threadTs = options.threadTs ?? event.threadTs
  if (!result.ok) {
    if (result.code === 'confirmation_required' && result.confirmUrl) {
      await postSlackPaymentConfirmation(event, ctx, result.confirmUrl, {
        label: 'Review and approve',
        message: 'Tipbot needs wallet approval to send this payment.',
        threadTs,
      })
      return
    }
    if (result.code === 'sender_unconnected' || result.code === 'missing_sender_access_key') {
      await postConnectLink(event, ctx)
      return
    }
    if (result.code === 'insufficient_funds') {
      await postSlackInsufficientFunds(event, ctx, threadTs)
      return
    }
    await postPrivateReply(
      event,
      event.user,
      result.code === 'pending' ? 'Payment still sending.' : (result.message ?? 'Payment failed.'),
    )
    return
  }
  if (result.status === 'queued') {
    await postQueuedTipResults(event, ctx, result.queuedTips, { threadTs })
    return
  }
  if (result.status === 'sent') {
    const amount = result.isDefaultToken
      ? formatCurrencyAmount(result.amount, result.tokenCurrency)
      : formatTipAmount(result.amount, result.tokenCurrency, result.tokenSymbol)
    const skippedRecipients = result.skippedRecipients ?? options.skippedRecipients ?? []
    const skippedLines = skippedRecipients
      .slice(0, 10)
      .map(
        (recipient) =>
          `• ${event.channel.mentionUser(recipient.recipientProviderUserId)} (${recipient.reason === 'you' ? 'you' : 'not connected yet'})`,
      )
    if (skippedRecipients.length > skippedLines.length)
      skippedLines.push(
        `…and ${skippedRecipients.length - skippedLines.length} more not connected yet`,
      )
    const recipientSummary = formatProviderUserMentionSummary(
      result.recipients.map((recipient) => recipient.recipientProviderUserId),
      (providerUserId) => event.channel.mentionUser(providerUserId),
    )
    const target = options.usergroupId
      ? ['channel', 'here'].includes(options.usergroupId)
        ? `${Slack.formatUsergroupMention(options.usergroupId, options.usergroupLabel)} ${recipientSummary}`
        : Slack.formatUsergroupMention(options.usergroupId, options.usergroupLabel)
      : recipientSummary
    await postSlackReceiptMessage(
      event,
      ctx,
      `${event.channel.mentionUser(result.senderProviderUserId)} ${result.memo ? 'sent' : 'tipped'} ${target} ${amount} each${result.memo ? ` for ${result.memo}` : ''}.\n${[
        ...result.recipients.map(
          (recipient) => `• ${event.channel.mentionUser(recipient.recipientProviderUserId)}`,
        ),
        ...skippedLines,
      ].join('\n')}`,
      result.chainId,
      result.transactionHash,
      undefined,
      result.feePayer === 'sender'
        ? 'Fee sponsor unavailable; fee paid from your balance.'
        : undefined,
      threadTs,
    )
    if (result.memo && threadTs) await postSlackMemoReply(event, ctx, result.memo, threadTs)
    if (result.queuedTips?.length)
      await postQueuedTipResults(event, ctx, result.queuedTips, { threadTs })
    return
  }
  await postPrivateReply(event, event.user, 'Payment already sent.')
}

async function postQueuedTipResults(
  event: TipEvent,
  ctx: HandlerContext,
  queuedTips: Tip.QueuedTipResult[],
  options: { threadTs?: string } = {},
) {
  if (queuedTips.length <= 1) {
    const queuedTip = queuedTips[0]
    if (!queuedTip) return
    const messageTs = await postSlackQueuedTipMessage(ctx, queuedTip, {
      channelId: event.channel.id,
      mentionUser: (providerUserId) => event.channel.mentionUser(providerUserId),
      recipientProviderWorkspaceId: queuedTip.recipientProviderWorkspaceId,
      threadTs: options.threadTs,
    })
    await Tip.recordPendingTipMessage(env, {
      pendingTipId: queuedTip.pendingTipId,
      providerMessageTs: messageTs,
    })
    return
  }

  const installation = await getSlack().getInstallation(ctx.channelProviderId ?? ctx.provider.id)
  if (!installation) throw new Error('Tibot app not installed for this workspace.')
  const groups = new Map<string, Tip.QueuedTipResult[]>()
  for (const queuedTip of queuedTips) {
    const connectCommand = await getQueuedTipConnectCommand(ctx, installation, queuedTip, {
      channelId: event.channel.id,
      recipientProviderWorkspaceId: queuedTip.recipientProviderWorkspaceId,
    })
    groups.set(connectCommand, [...(groups.get(connectCommand) ?? []), queuedTip])
  }
  for (const [connectCommand, groupedQueuedTips] of groups) {
    const messageTs = await (async () => {
      // Aggregate queued multi-tip recipients into one visible Slack message while each
      // pending_tip row keeps its own claim lifecycle.
      const first = groupedQueuedTips[0]
      if (!first) throw new Error('Expected queued tips.')
      const amount = first.isDefaultToken
        ? formatCurrencyAmount(first.amount, first.tokenCurrency)
        : formatTipAmount(first.amount, first.tokenCurrency, first.tokenSymbol)
      const text = [
        `${event.channel.mentionUser(first.senderProviderUserId)} queued ${groupedQueuedTips.length} accounts ${amount} each${first.memo ? ` for ${first.memo}` : ''}`,
        ...groupedQueuedTips.map(
          (queuedTip) => `- ${event.channel.mentionUser(queuedTip.recipientProviderUserId)}`,
        ),
      ].join('\n')
      const context = `Run \`${connectCommand}\` to receive it`
      const body = new URLSearchParams()
      body.set(
        'blocks',
        JSON.stringify([
          {
            text: { text, type: 'mrkdwn' },
            type: 'section',
          },
          {
            elements: [{ text: context, type: 'mrkdwn' }],
            type: 'context',
          },
        ]),
      )
      body.set('channel', event.channel.id.replace(/^slack:/, ''))
      body.set('text', `${text}. ${context}`)
      if (options.threadTs) body.set('thread_ts', options.threadTs)
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
      return json.ts
    })()
    for (const queuedTip of groupedQueuedTips)
      await Tip.recordPendingTipMessage(env, {
        pendingTipId: queuedTip.pendingTipId,
        providerMessageTs: messageTs,
      })
  }
}

async function postSlackQueuedTipMessage(
  ctx: HandlerContext,
  result: Extract<Tip.TipResult, { ok: true; status: 'queued' }>,
  options: {
    channelId: string
    mentionUser: (providerUserId: string) => string
    recipientProviderWorkspaceId?: string
    threadTs?: string
  },
) {
  const installation = await getSlack().getInstallation(ctx.channelProviderId ?? ctx.provider.id)
  if (!installation) throw new Error('Tibot app not installed for this workspace.')

  const amount = result.isDefaultToken
    ? formatCurrencyAmount(result.amount, result.tokenCurrency)
    : formatTipAmount(result.amount, result.tokenCurrency, result.tokenSymbol)
  const text =
    result.source === 'reaction'
      ? `${options.mentionUser(result.senderProviderUserId)} queued a tip for ${options.mentionUser(result.recipientProviderUserId)}`
      : `${options.mentionUser(result.senderProviderUserId)} queued ${options.mentionUser(result.recipientProviderUserId)} ${amount}${result.memo ? ` for ${result.memo}` : ''}`
  const connectCommand = await getQueuedTipConnectCommand(ctx, installation, result, options)
  const context = `Run \`${connectCommand}\` to receive it`
  if (result.source === 'reaction') {
    const messageTs = await updateSlackQueuedReactionTipMessage(
      ctx.db,
      installation.botToken,
      result,
      {
        channelId: options.channelId,
        context,
        mentionUser: options.mentionUser,
      },
    )
    if (messageTs) return messageTs
  }
  const body = new URLSearchParams()
  body.set(
    'blocks',
    JSON.stringify([
      {
        text: { text, type: 'mrkdwn' },
        type: 'section',
      },
      {
        elements: [{ text: context, type: 'mrkdwn' }],
        type: 'context',
      },
    ]),
  )
  body.set('channel', options.channelId.replace(/^slack:/, ''))
  body.set('text', `${text}. ${context}`)
  if (options.threadTs) body.set('thread_ts', options.threadTs)
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
  if (result.source === 'reaction') {
    await Tip.recordPendingTipMessage(env, {
      pendingTipId: result.pendingTipId,
      providerMessageTs: json.ts,
    })
    return (
      (await updateSlackQueuedReactionTipMessage(ctx.db, installation.botToken, result, {
        channelId: options.channelId,
        context,
        deleteDuplicateMessages: true,
        mentionUser: options.mentionUser,
      })) ?? json.ts
    )
  }
  return json.ts
}

async function getQueuedTipConnectCommand(
  ctx: HandlerContext,
  installation: { botToken: string },
  result: Pick<Tip.QueuedTipResult, 'recipientProviderUserId'>,
  options: { channelId?: string; recipientProviderWorkspaceId?: string } = {},
) {
  const conversation = options.channelId
    ? await Slack.getConversationInfo({
        apiUrl: env.SLACK_API_URL,
        botToken: installation.botToken,
        channelId: options.channelId,
        withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
      }).catch(() => undefined)
    : undefined
  if (conversation?.isShared) {
    const providerIds = [...conversation.teamIds].filter(
      (providerId) => providerId !== conversation.contextTeamId,
    )
    if (providerIds.length) {
      const workspaces = await ctx.db
        .selectFrom('workspace')
        .select(['installed_at', 'provider_id'])
        .where('provider', '=', 'slack')
        .where('provider_id', 'in', providerIds)
        .execute()
      if (
        providerIds.some(
          (providerId) =>
            !workspaces.some(
              (workspace) => workspace.provider_id === providerId && workspace.installed_at,
            ),
        )
      )
        return `@${getSlackBotDisplayName(env.HOST)} connect`
    }
  }
  const recipientWorkspace = await (async () => {
    if (
      !options.recipientProviderWorkspaceId ||
      options.recipientProviderWorkspaceId === ctx.provider.id
    )
      return null
    return await ctx.db
      .selectFrom('workspace')
      .select('installed_at')
      .where('provider', '=', 'slack')
      .where('provider_id', '=', options.recipientProviderWorkspaceId)
      .executeTakeFirst()
  })()
  if (recipientWorkspace?.installed_at) return `${getSlackCommand(env.HOST)} connect`
  // Slack Connect users without an installed app and single-channel guests need mention commands because slash commands are unavailable.
  if (recipientWorkspace || ctx.externalSlackConnect)
    return `@${getSlackBotDisplayName(env.HOST)} connect`
  if (ctx.channelProviderId && ctx.channelProviderId !== ctx.provider.id)
    return `@${getSlackBotDisplayName(env.HOST)} connect`
  const user = await Slack.getUserInfo({
    apiUrl: env.SLACK_API_URL,
    botToken: installation.botToken,
    providerUserId: result.recipientProviderUserId,
    withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
  }).catch(() => undefined)
  if (user?.is_restricted || user?.is_ultra_restricted)
    return `@${getSlackBotDisplayName(env.HOST)} connect`
  return `${getSlackCommand(env.HOST)} connect`
}

async function updateSlackQueuedReactionTipMessage(
  db: DB.Type,
  botToken: string,
  result: Extract<Tip.TipResult, { ok: true; status: 'queued' }>,
  options: {
    channelId: string
    context: string
    deleteDuplicateMessages?: boolean
    mentionUser: (providerUserId: string) => string
  },
) {
  const pending = await db
    .selectFrom('pending_tip')
    .select([
      'provider_channel_id',
      'provider_id',
      'provider_thread_id',
      'recipient_provider_user_id',
      'workspace_id',
    ])
    .where('id', '=', result.pendingTipId)
    .executeTakeFirst()
  if (!pending) return null
  const existing = await db
    .selectFrom('reaction_tip_thread')
    .selectAll()
    .where('workspace_id', '=', pending.workspace_id)
    .where('channel_id', '=', pending.provider_channel_id.replace(/^slack:/, ''))
    .where('message_ts', '=', pending.provider_thread_id)
    .executeTakeFirst()
  const { messageTs, rows } = await (async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const rows = await db
        .selectFrom('pending_tip')
        .innerJoin('workspace', 'workspace.id', 'pending_tip.workspace_id')
        .select([
          'pending_tip.amount',
          'pending_tip.chain_id',
          'pending_tip.created_at',
          'pending_tip.idempotency_key',
          'pending_tip.provider_message_ts',
          'pending_tip.recipient_provider_user_id',
          'pending_tip.sender_provider_user_id',
          'pending_tip.token_address',
          'workspace.default_token_address',
        ])
        .where('pending_tip.workspace_id', '=', pending.workspace_id)
        .where('pending_tip.provider_id', '=', pending.provider_id)
        .where('pending_tip.provider_channel_id', '=', pending.provider_channel_id)
        .where('pending_tip.provider_thread_id', '=', pending.provider_thread_id)
        .where('pending_tip.recipient_provider_user_id', '=', pending.recipient_provider_user_id)
        .where('pending_tip.source', '=', 'reaction')
        .where('pending_tip.status', 'in', ['pending', 'sending'])
        .orderBy('pending_tip.created_at', 'asc')
        .execute()
      const messageTs =
        existing?.reply_ts ?? rows.find((row) => row.provider_message_ts)?.provider_message_ts
      if (messageTs || rows.length <= 1) return { messageTs, rows }
      await new Promise((resolve) => setTimeout(resolve, 25)) // 25 milliseconds
    }
    return { messageTs: null, rows: [] }
  })()
  if (!messageTs) return null

  const text = await reactionTipAggregateText(db, {
    channelId: options.channelId,
    connectContext: options.context,
    providerId: pending.provider_id,
    threadTs: pending.provider_thread_id ?? messageTs,
    workspaceId: pending.workspace_id,
  })
  if (!text) return null
  const body = new URLSearchParams()
  body.set(
    'blocks',
    JSON.stringify([
      {
        text: { text, type: 'mrkdwn' },
        type: 'section',
      },
    ]),
  )
  body.set('channel', options.channelId.replace(/^slack:/, ''))
  body.set('text', text)
  body.set('ts', messageTs)
  body.set('unfurl_links', 'false')
  body.set('unfurl_media', 'false')
  const response = await getSlack().withBotToken(botToken, () =>
    fetch(`${env.SLACK_API_URL}/chat.update`, {
      body,
      headers: { authorization: `Bearer ${botToken}` },
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
  if (existing)
    await db
      .updateTable('reaction_tip_thread')
      .set({ updated_at: new Date().toISOString() })
      .where('id', '=', existing.id)
      .execute()
  else {
    const now = new Date().toISOString()
    try {
      await db
        .insertInto('reaction_tip_thread')
        .values({
          channel_id: options.channelId.replace(/^slack:/, ''),
          created_at: now,
          id: Nanoid.generate(),
          message_ts: pending.provider_thread_id ?? messageTs,
          reply_ts: messageTs,
          updated_at: now,
          workspace_id: pending.workspace_id,
        })
        .execute()
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
    }
  }
  if (options.deleteDuplicateMessages) {
    for (const duplicateMessageTs of new Set(
      rows
        .map((row) => row.provider_message_ts)
        .filter(
          (duplicateMessageTs): duplicateMessageTs is string =>
            Boolean(duplicateMessageTs) && duplicateMessageTs !== messageTs,
        ),
    )) {
      const deleteResponse = await getSlack().withBotToken(botToken, () =>
        fetch(`${env.SLACK_API_URL}/chat.delete`, {
          body: new URLSearchParams({
            channel: options.channelId.replace(/^slack:/, ''),
            ts: duplicateMessageTs,
          }),
          headers: { authorization: `Bearer ${botToken}` },
          method: 'POST',
        }),
      )
      const deleteJson = z.parse(
        z.object({
          ok: z.boolean().optional(),
        }),
        await deleteResponse.json(),
      )
      if (deleteJson.ok)
        await db
          .updateTable('pending_tip')
          .set({ provider_message_ts: messageTs, updated_at: new Date().toISOString() })
          .where('workspace_id', '=', pending.workspace_id)
          .where('provider_id', '=', pending.provider_id)
          .where('provider_channel_id', '=', pending.provider_channel_id)
          .where('provider_thread_id', '=', pending.provider_thread_id)
          .where('provider_message_ts', '=', duplicateMessageTs)
          .execute()
    }
  }
  return messageTs
}

async function reactionTipAggregateText(
  db: DB.Type,
  options: {
    channelId: string
    connectContext?: string
    providerId: string
    threadTs: string
    workspaceId: string
  },
) {
  const sentRows = await db
    .selectFrom('reaction_tip')
    .innerJoin('tip', 'tip.id', 'reaction_tip.tip_id')
    .innerJoin('tip_batch', 'tip_batch.id', 'tip.batch_id')
    .innerJoin('member as sender', 'sender.id', 'reaction_tip.sender_member_id')
    .innerJoin('member as recipient', 'recipient.id', 'reaction_tip.recipient_member_id')
    .innerJoin('workspace', 'workspace.id', 'reaction_tip.workspace_id')
    .select([
      'reaction_tip.created_at',
      'reaction_tip.message_ts',
      'reaction_tip.reaction',
      'recipient.provider_user_id as recipient_provider_user_id',
      'sender.provider_user_id as sender_provider_user_id',
      'tip.amount',
      'tip.chain_id',
      'tip.token_address',
      'tip_batch.transaction_hash',
      'workspace.default_token_address',
    ])
    .where('reaction_tip.workspace_id', '=', options.workspaceId)
    .where('reaction_tip.channel_id', '=', options.channelId.replace(/^slack:/, ''))
    .where('reaction_tip.thread_ts', '=', options.threadTs)
    .where('tip.confirmed_at', 'is not', null)
    .where('tip_batch.transaction_hash', 'is not', null)
    .execute()
  const queuedRows = await db
    .selectFrom('pending_tip')
    .innerJoin('workspace', 'workspace.id', 'pending_tip.workspace_id')
    .select([
      'pending_tip.amount',
      'pending_tip.chain_id',
      'pending_tip.created_at',
      'pending_tip.idempotency_key',
      'pending_tip.recipient_provider_user_id',
      'pending_tip.sender_provider_user_id',
      'pending_tip.token_address',
      'workspace.default_token_address',
    ])
    .where('pending_tip.workspace_id', '=', options.workspaceId)
    .where('pending_tip.provider_channel_id', '=', options.channelId.replace(/^slack:/, ''))
    .where('pending_tip.provider_thread_id', '=', options.threadTs)
    .where('pending_tip.source', '=', 'reaction')
    .where('pending_tip.status', 'in', ['pending', 'sending'])
    .execute()
  const sentPendingRows = await db
    .selectFrom('pending_tip')
    .innerJoin('tip', 'tip.id', 'pending_tip.tip_id')
    .innerJoin('tip_batch', 'tip_batch.id', 'tip.batch_id')
    .innerJoin('workspace', 'workspace.id', 'pending_tip.workspace_id')
    .select([
      'pending_tip.amount',
      'pending_tip.chain_id',
      'pending_tip.created_at',
      'pending_tip.idempotency_key',
      'pending_tip.recipient_provider_user_id',
      'pending_tip.sender_provider_user_id',
      'pending_tip.token_address',
      'tip_batch.transaction_hash',
      'workspace.default_token_address',
    ])
    .where('pending_tip.workspace_id', '=', options.workspaceId)
    .where('pending_tip.provider_channel_id', '=', options.channelId.replace(/^slack:/, ''))
    .where('pending_tip.provider_thread_id', '=', options.threadTs)
    .where('pending_tip.source', '=', 'reaction')
    .where('pending_tip.status', '=', 'sent')
    .where('tip_batch.transaction_hash', 'is not', null)
    .execute()
  if (sentRows.length === 0 && queuedRows.length === 0 && sentPendingRows.length === 0) return null

  const sentRowTexts = await Promise.all(
    sentRows.map(async (row) => {
      const token = await Tapimo.getTokenMetadata(row.chain_id, row.token_address)
      const amount = formatAmount(row.amount)
      const displayAmount = Address.isEqual(
        Address.checksum(row.token_address),
        Address.checksum(row.default_token_address ?? Tempo.addressLookup.pathUsd),
      )
        ? formatCurrencyAmount(amount, token.currency)
        : formatTipAmount(amount, token.currency, token.symbol)
      return {
        createdAt: row.created_at,
        messageTs: row.message_ts,
        recipientProviderUserId: row.recipient_provider_user_id,
        text: `• :${row.reaction}: <@${row.sender_provider_user_id}> tipped ${displayAmount} · <${Tempo.formatTxLink(row.chain_id, row.transaction_hash!)}|Receipt>`,
      }
    }),
  )
  const queuedRowTexts = await Promise.all(
    queuedRows.map(async (row) => {
      const token = await Tapimo.getTokenMetadata(row.chain_id, row.token_address)
      const amount = formatAmount(row.amount)
      const displayAmount = Address.isEqual(
        Address.checksum(row.token_address),
        Address.checksum(row.default_token_address ?? Tempo.addressLookup.pathUsd),
      )
        ? formatCurrencyAmount(amount, token.currency)
        : formatTipAmount(amount, token.currency, token.symbol)
      const reactionTip = (() => {
        const parts = row.idempotency_key
          .replace(reactionTipIdempotencyPrefix, '')
          .replace(/^:/, '')
          .split(':')
        return { messageTs: parts[2] ?? '', reaction: parts[3] ?? 'money_with_wings' }
      })()
      return {
        createdAt: row.created_at,
        messageTs: reactionTip.messageTs,
        recipientProviderUserId: row.recipient_provider_user_id,
        text: `• :${reactionTip.reaction}: <@${row.sender_provider_user_id}> queued ${displayAmount}`,
      }
    }),
  )
  const sentPendingRowTexts = await Promise.all(
    sentPendingRows.map(async (row) => {
      const token = await Tapimo.getTokenMetadata(row.chain_id, row.token_address)
      const amount = formatAmount(row.amount)
      const displayAmount = Address.isEqual(
        Address.checksum(row.token_address),
        Address.checksum(row.default_token_address ?? Tempo.addressLookup.pathUsd),
      )
        ? formatCurrencyAmount(amount, token.currency)
        : formatTipAmount(amount, token.currency, token.symbol)
      const reactionTip = (() => {
        const parts = row.idempotency_key
          .replace(reactionTipIdempotencyPrefix, '')
          .replace(/^:/, '')
          .split(':')
        return { messageTs: parts[2] ?? '', reaction: parts[3] ?? 'money_with_wings' }
      })()
      return {
        createdAt: row.created_at,
        messageTs: reactionTip.messageTs,
        recipientProviderUserId: row.recipient_provider_user_id,
        text: `• :${reactionTip.reaction}: <@${row.sender_provider_user_id}> tipped ${displayAmount} · <${Tempo.formatTxLink(row.chain_id, row.transaction_hash!)}|Receipt>`,
      }
    }),
  )
  const rowTexts = [...sentRowTexts, ...queuedRowTexts, ...sentPendingRowTexts].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
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
  const title = 'Reaction tips received in this thread:'
  const text = (() => {
    if (messageGroups.length === 1) {
      const reactedMessageUrl = new URL('slack://channel')
      reactedMessageUrl.searchParams.set('team', options.providerId)
      reactedMessageUrl.searchParams.set('id', options.channelId.replace(/^slack:/, ''))
      reactedMessageUrl.searchParams.set('message', messageGroups[0]!.messageTs)
      return `${title}\n\n<@${messageGroups[0]!.recipientProviderUserId}> received ${rowTexts.length === 1 ? 'a tip' : 'tips'} on <${reactedMessageUrl}|this message>:\n${messageGroups[0]!.lines.join('\n')}`
    }
    return `${title}\n\n${messageGroups
      .map((group) => {
        const reactedMessageUrl = new URL('slack://channel')
        reactedMessageUrl.searchParams.set('team', options.providerId)
        reactedMessageUrl.searchParams.set('id', options.channelId.replace(/^slack:/, ''))
        reactedMessageUrl.searchParams.set('message', group.messageTs)
        return `<@${group.recipientProviderUserId}> received ${group.lines.length === 1 ? 'a tip' : 'tips'} on <${reactedMessageUrl}|this message>:\n${group.lines.join('\n')}`
      })
      .join('\n\n')}`
  })()
  if (queuedRows.length === 0) return text
  return `${text}\n\n${options.connectContext ?? `Run \`${getSlackCommand(env.HOST)} connect\` to receive it`}`
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
  const installation = await getSlack().getInstallation(ctx.channelProviderId ?? ctx.provider.id)
  if (!installation) throw new Error('Tibot app not installed for this workspace.')

  const receiptText = text.replace(/\.$/, '')
  const body = new URLSearchParams()
  body.set(
    'blocks',
    JSON.stringify(
      (() => {
        const receiptLink = `<${Tempo.formatTxLink(chainId, transactionHash)}|Receipt>`
        return [
          {
            text: {
              text: formatReceiptText(receiptText, receiptLink),
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
      })(),
    ),
  )
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set('text', formatReceiptText(`${receiptText}${context ? ` ${context}` : ''}`, 'Receipt'))
  if (threadTs) body.set('thread_ts', threadTs)
  if (user && !Slack.isDMChannelId(event.channel.id)) body.set('user', user.userId)
  else {
    body.set('unfurl_links', 'false')
    body.set('unfurl_media', 'false')
  }
  const method =
    user && !Slack.isDMChannelId(event.channel.id) ? 'chat.postEphemeral' : 'chat.postMessage'
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
      ts: z.string().optional(),
    }),
    await response.json(),
  )
  if (!json.ok) throw Slack.slackApiError(method, json.error)
  if (method === 'chat.postMessage' && json.ts)
    await recordSlackReceiptMessageForTransaction(ctx.db, {
      channelId: event.channel.id.replace(/^slack:/, ''),
      messageTs: json.ts,
      threadTs: threadTs ?? json.ts,
      transactionHash,
    })
}

export async function recordSlackReceiptMessageForTransaction(
  db: DB.Type,
  options: { channelId: string; messageTs: string; threadTs: string; transactionHash: string },
) {
  const batch = await db
    .selectFrom('tip_batch')
    .select(['id', 'workspace_id'])
    .where('transaction_hash', '=', options.transactionHash)
    .where((eb) =>
      eb.or([
        eb('provider_channel_id', '=', options.channelId),
        eb('provider_channel_id', '=', `slack:${options.channelId}`),
      ]),
    )
    .where('status', '=', 'confirmed')
    .executeTakeFirst()
  if (!batch) return
  await recordSlackReceiptMessage(db, {
    channelId: options.channelId,
    messageTs: options.messageTs,
    threadTs: options.threadTs,
    tipBatchId: batch.id,
    workspaceId: batch.workspace_id,
  })
}

export async function updateSlackPendingTipMessage(db: DB.Type, result: Tip.PendingTipClaimResult) {
  const installation = await getSlack().getInstallation(result.pendingTip.provider_id)
  if (!installation) return

  const channelId = result.pendingTip.provider_channel_id.replace(/^slack:/, '')
  if (
    result.pendingTip.source === 'reaction' &&
    result.ok &&
    result.pendingTip.provider_thread_id
  ) {
    await updateReactionTipAggregate(result.pendingTip.provider_id, {
      channelId,
      threadTs: result.pendingTip.provider_thread_id,
      workspaceId: result.pendingTip.workspace_id,
    })
    return
  }
  if (!result.pendingTip.provider_message_ts) return
  const tokenMetadata = await Tapimo.getTokenMetadata(
    result.pendingTip.chain_id,
    result.pendingTip.token_address,
  )
  const workspace = await db
    .selectFrom('workspace')
    .select('default_token_address')
    .where('id', '=', result.pendingTip.workspace_id)
    .executeTakeFirst()
  const amount = Address.isEqual(
    Address.checksum(result.pendingTip.token_address),
    Address.checksum(workspace?.default_token_address ?? Tempo.addressLookup.pathUsd),
  )
    ? formatCurrencyAmount(formatAmount(result.pendingTip.amount), tokenMetadata.currency)
    : formatTipAmount(
        formatAmount(result.pendingTip.amount),
        tokenMetadata.currency,
        tokenMetadata.symbol,
      )
  const originalText =
    result.pendingTip.source === 'reaction'
      ? `<@${result.pendingTip.sender_provider_user_id}> queued a tip for <@${result.pendingTip.recipient_provider_user_id}>`
      : `<@${result.pendingTip.sender_provider_user_id}> queued <@${result.pendingTip.recipient_provider_user_id}> ${amount}${result.pendingTip.memo ? ` for ${result.pendingTip.memo}` : ''}`
  const text = (() => {
    if (!result.ok) return originalText
    if (result.pendingTip.source === 'reaction')
      return `<@${result.senderProviderUserId}> tipped this message`
    return `<@${result.senderProviderUserId}> ${result.memo ? 'sent' : 'tipped'} <@${result.recipientProviderUserId}> ${amount}${result.memo ? ` for ${result.memo}` : ''}`
  })()
  const context = result.ok
    ? undefined
    : result.status === 'expired'
      ? `Expired before <@${result.pendingTip.recipient_provider_user_id}> connected. No payment was sent`
      : 'Could not be sent. No payment was sent'
  const receiptLink = result.ok
    ? `<${Tempo.formatTxLink(result.chainId, result.transactionHash)}|Receipt>`
    : undefined
  const blocks = [
    {
      text: { text: receiptLink ? formatReceiptText(text, receiptLink) : text, type: 'mrkdwn' },
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
  const body = new URLSearchParams()
  body.set('blocks', JSON.stringify(blocks))
  body.set('channel', channelId)
  body.set(
    'text',
    receiptLink ? formatReceiptText(text, 'Receipt') : `${text}${context ? `. ${context}` : ''}`,
  )
  body.set('ts', result.pendingTip.provider_message_ts)
  body.set('unfurl_links', 'false')
  body.set('unfurl_media', 'false')
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
      ts: z.string().optional(),
    }),
    await response.json(),
  )
  if (json.ok) {
    if (result.ok)
      await recordSlackReceiptMessageForTransaction(db, {
        channelId,
        messageTs: result.pendingTip.provider_message_ts,
        threadTs: result.pendingTip.provider_thread_id ?? result.pendingTip.provider_message_ts,
        transactionHash: result.transactionHash,
      })
    return
  }
  if (!result.ok) {
    console.error('Failed to update queued tip message:', json.error)
    return
  }
  const fallback = new URLSearchParams()
  fallback.set('blocks', JSON.stringify(blocks))
  fallback.set('channel', channelId)
  fallback.set('text', formatReceiptText(text, 'Receipt'))
  if (result.pendingTip.provider_thread_id)
    fallback.set('thread_ts', result.pendingTip.provider_thread_id)
  fallback.set('unfurl_links', 'false')
  fallback.set('unfurl_media', 'false')
  const fallbackResponse = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/chat.postMessage`, {
      body: fallback,
      headers: { authorization: `Bearer ${installation.botToken}` },
      method: 'POST',
    }),
  )
  const fallbackJson = z.parse(
    z.object({
      error: z.string().optional(),
      ok: z.boolean().optional(),
      ts: z.string().optional(),
    }),
    await fallbackResponse.json(),
  )
  if (!fallbackJson.ok || !fallbackJson.ts)
    throw Slack.slackApiError('chat.postMessage', fallbackJson.error)
  await recordSlackReceiptMessageForTransaction(db, {
    channelId,
    messageTs: fallbackJson.ts,
    threadTs: result.pendingTip.provider_thread_id ?? fallbackJson.ts,
    transactionHash: result.transactionHash,
  })
}

async function recordSlackReceiptMessage(
  db: DB.Type,
  options: {
    channelId: string
    messageTs: string
    threadTs: string
    tipBatchId: string
    workspaceId: string
  },
) {
  const now = new Date().toISOString()
  try {
    await db
      .insertInto('tip_receipt_message')
      .values({
        channel_id: options.channelId,
        created_at: now,
        id: Nanoid.generate(),
        message_ts: options.messageTs,
        thread_ts: options.threadTs,
        tip_batch_id: options.tipBatchId,
        updated_at: now,
        workspace_id: options.workspaceId,
      })
      .execute()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    await db
      .updateTable('tip_receipt_message')
      .set({ thread_ts: options.threadTs, tip_batch_id: options.tipBatchId, updated_at: now })
      .where('workspace_id', '=', options.workspaceId)
      .where('channel_id', '=', options.channelId)
      .where('message_ts', '=', options.messageTs)
      .execute()
  }
}

async function postSlackMemoReply(
  event: TipEvent,
  ctx: HandlerContext,
  memo: string,
  threadTs: string,
) {
  const creatureMatch = memo.match(creaturePattern)
  if (!creatureMatch) return

  const installation = await getSlack().getInstallation(ctx.channelProviderId ?? ctx.provider.id)
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
    reply = formatInvalidMentionAiReply(result) ?? reply
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

function formatReceiptText(text: string, receipt: string) {
  const lineBreakIndex = text.indexOf('\n')
  if (lineBreakIndex === -1) return `${text} · ${receipt}`
  return `${text.slice(0, lineBreakIndex).replace(/\.$/, '')} · ${receipt}${text.slice(lineBreakIndex)}`
}

export function formatProviderUserMentionSummary(
  providerUserIds: readonly string[],
  mentionUser: (providerUserId: string) => string = (providerUserId) => `<@${providerUserId}>`,
) {
  const mentions = providerUserIds.slice(0, 5).map((providerUserId) => mentionUser(providerUserId))
  if (providerUserIds.length > mentions.length) {
    const extra = providerUserIds.length - mentions.length
    mentions.push(`+ ${extra} ${extra === 1 ? 'other' : 'others'}`)
  }
  return mentions.join(' ')
}

async function canManageSlackWorkspaceSettings(providerId: string, providerUserId: string) {
  const installation = await getSlack().getInstallation(providerId)
  if (
    installation &&
    (await Slack.isAdmin({
      apiUrl: env.SLACK_API_URL,
      botToken: installation.botToken,
      providerUserId,
      withBotToken: (botToken, fn) => getSlack().withBotToken(botToken, fn),
    }))
  )
    return true

  const member = await DB.create(env.DB)
    .selectFrom('workspace')
    .innerJoin('member', 'member.workspace_id', 'workspace.id')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .innerJoin('account', 'account.id', 'provider_identity.account_id')
    .select('member.id')
    .where('workspace.provider', '=', 'slack')
    .where('workspace.provider_id', '=', providerId)
    .where('member.provider_user_id', '=', providerUserId)
    .where(sql<string>`lower("account"."address")`, 'in', workspaceSettingsAccountAddressAllowlist)
    .executeTakeFirst()
  return Boolean(member)
}

async function getReactionTipConfigs(db: DB.Type, workspaceId: string | undefined) {
  if (!workspaceId) return [...Tip.defaultReactionTipConfigs]
  const configs = await db
    .selectFrom('reaction_tip_config')
    .select(['amount', 'emoji'])
    .where('workspace_id', '=', workspaceId)
    .orderBy('amount', 'asc')
    .orderBy('emoji', 'asc')
    .execute()
  if (configs.length > 0) return configs
  return [...Tip.defaultReactionTipConfigs]
}

function reactionTipConfigsText(configs: ReactionTipConfig[]) {
  return configs
    .map((config) => `:${config.emoji}: \`:${config.emoji}:\` → ${formatAmount(config.amount)}`)
    .join('\n')
}

async function configCard(
  db: DB.Type,
  workspace: DB_gen.Selectable.workspace,
  options?: { canEdit?: boolean; updated?: boolean },
) {
  const reactionTipConfigs = await getReactionTipConfigs(db, workspace.id)
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
            ['Reaction tips', reactionTipConfigsText(reactionTipConfigs)],
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
        ...(options?.updated
          ? [chat.CardText('Workspace settings updated', { style: 'muted' })]
          : []),
      ],
    }),
    fallbackText: `Network ${networkLabel}\nDefault token ${token.symbol} ${Tempo.explorerLink(workspace.chain_id, tokenAddress)}\nDefault amount ${formatAmount(workspace.default_amount)}\nReaction tips ${reactionTipConfigsText(reactionTipConfigs)}${options?.updated ? '\nWorkspace settings updated' : ''}`,
  }
}

async function postConfigEphemeral(
  event: chat.SlashCommandEvent | TipEvent,
  ctx: HandlerContext,
  workspace: DB_gen.Selectable.workspace,
  options?: { canEdit?: boolean },
) {
  const reactionTipConfigs = await getReactionTipConfigs(ctx.db, workspace.id)
  const body = new URLSearchParams()
  body.set('channel', event.channel.id.replace(/^slack:/, ''))
  body.set('text', configFallbackText(workspace, reactionTipConfigs))
  body.set(
    'blocks',
    JSON.stringify([
      {
        rows: [
          [Slack.tableCell('Setting'), Slack.tableCell('Value')],
          [Slack.tableCell('Network'), Slack.tableCell(configNetworkLabel(workspace))],
          [Slack.tableCell('Default token'), Slack.tableCell(configToken(workspace).symbol)],
          [
            Slack.tableCell('Default amount'),
            Slack.tableCell(formatAmount(workspace.default_amount)),
          ],
          [
            Slack.tableCell('Reaction tips'),
            {
              elements: [
                {
                  elements: reactionTipConfigs.flatMap((config, index) => [
                    ...(index ? [{ text: '\n', type: 'text' }] : []),
                    { name: config.emoji, type: 'emoji' },
                    { text: ' ', type: 'text' },
                    { style: { code: true }, text: `:${config.emoji}:`, type: 'text' },
                    { text: ` → ${formatAmount(config.amount)}`, type: 'text' },
                  ]),
                  type: 'rich_text_section',
                },
              ],
              type: 'rich_text',
            },
          ],
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
    { threadTs: ctx.threadTs },
  )
}

function configFallbackText(
  workspace: DB_gen.Selectable.workspace,
  reactionTipConfigs: ReactionTipConfig[],
  options?: { updated?: boolean },
) {
  const tokenAddress = workspace.default_token_address ?? Tempo.addressLookup.pathUsd
  return `Setting Value\nNetwork ${configNetworkLabel(workspace)}\nDefault token ${configToken(workspace).symbol} ${Tempo.explorerLink(workspace.chain_id, tokenAddress)}\nDefault amount ${formatAmount(workspace.default_amount)}\nReaction tips ${reactionTipConfigsText(reactionTipConfigs)}${options?.updated ? '\nWorkspace settings updated' : ''}`
}

function configNetworkLabel(workspace: DB_gen.Selectable.workspace) {
  return workspace.chain_id === Tempo.chainLookup.mainnet ? 'Mainnet' : 'Testnet'
}

function configToken(workspace: DB_gen.Selectable.workspace) {
  return Tempo.getTokenMetadataFallback(
    workspace.default_token_address ?? Tempo.addressLookup.pathUsd,
  )
}

function slackTipAskImageFiles(
  files:
    | Array<{
        filetype?: string
        id?: string
        mimetype?: string
        name?: string
        title?: string
      }>
    | undefined,
) {
  return (files ?? [])
    .filter((file) => {
      if (!file.id) return false
      if (['gif', 'jpeg', 'jpg', 'png'].includes(file.filetype ?? '')) return true
      return ['image/gif', 'image/jpeg', 'image/png'].includes(file.mimetype ?? '')
    })
    .slice(0, tipAskImageFileLimit)
    .map((file) => ({
      alt_text: (file.title || file.name || 'Tip jar image').slice(0, 2000),
      provider_file_id: file.id!,
    }))
}

function workspaceTokenOptions(chainId?: number) {
  if (chainId === undefined) return tokenOptions
  return tokenOptions.filter((option) => Tempo.isAllowedToken(chainId, option.address))
}
