import * as DB from '#db/client.ts'
import type { DB as DB_gen } from '#db/types.gen.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as AccessKey from '#/lib/accessKey.ts'
import { formatAmount } from '#/lib/format.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Tip from '#/lib/tip.ts'
import { createCloudflareState } from '#/vendor/chatStateCloudflareDO.ts'
import { createSlackAdapter } from '@chat-adapter/slack'
import { env } from 'cloudflare:workers'
import { Chat, type SlashCommandEvent } from 'chat'
import { z } from 'zod'

let chat: Chat | null = null
export function getChat() {
  if (chat) return chat
  chat = new Chat({
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
  chat.onSlashCommand('/tip', async (event) => {
    const context = {
      db: DB.create(env.DB),
      provider: getProvider(event),
      text: event.text.trim(),
    } satisfies HandlerContext

    const match = context.text.match(commandPattern)
    if (match) {
      const name = z.parse(z.enum(commandNames), match[1])
      await handlers[name](event, { ...context, text: match[2]?.trim() ?? '' })
      return
    }
    await handlers.default(event, context)
  })
  return chat
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
        'Tipbot is not configured for this Slack workspace. Reinstall Tipbot and try again.',
        { fallbackToDM: false },
      )
      return
    }

    const parts = ctx.text.trim().split(/\s+/)
    const key = parts[0]
    const value = parts[1]
    if (!key || !value) {
      await event.channel.postEphemeral(
        event.user,
        `Current config: amount ${formatAmount(workspace.default_amount)}`,
        { fallbackToDM: false },
      )
      return
    }

    if (ctx.provider.type !== 'slack') throw new Error('Provider is not implemented yet.')

    const installation = await getSlack().getInstallation(ctx.provider.id)
    if (!installation) throw new Error('Slack app is not installed for this workspace.')

    const body = new URLSearchParams()
    body.set('user', event.user.userId)
    const response = await getSlack().withBotToken(installation.botToken, () =>
      fetch(`${env.SLACK_API_URL}/users.info`, {
        body,
        headers: { authorization: `Bearer ${installation.botToken}` },
        method: 'POST',
      }),
    )
    const info = z.parse(
      z.object({
        error: z.string().optional(),
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
    if (!info.ok) throw new Error(info.error ?? 'Slack API users.info failed.')

    if (!info.user?.is_admin && !info.user?.is_owner) {
      await event.channel.postEphemeral(event.user, 'Only Slack admins can change tip config.', {
        fallbackToDM: false,
      })
      return
    }

    if (key !== 'amount') {
      await event.channel.postEphemeral(event.user, 'Config keys: amount.', { fallbackToDM: false })
      return
    }

    const amount = Tip.parseAmount(value)
    if (amount === null) {
      await event.channel.postEphemeral(
        event.user,
        'Amount must be a positive decimal with at most 6 decimal places.',
        { fallbackToDM: false },
      )
      return
    }

    await ctx.db
      .updateTable('workspace')
      .set({
        default_amount: amount,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', workspace.id)
      .execute()

    await event.channel.postEphemeral(event.user, `Updated ${key}.`, { fallbackToDM: false })
  },
  async connect(event, ctx) {
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()
    if (!workspace) {
      await event.channel.postEphemeral(
        event.user,
        'Tipbot is not configured for this Slack workspace. Reinstall Tipbot and try again.',
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
      const now = new Date().toISOString()
      await ctx.db
        .insertInto('member')
        .values({
          account_id: null,
          created_at: now,
          id,
          login: null,
          name: null,
          provider_user_id: event.user.userId,
          updated_at: now,
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
      await event.channel.postEphemeral(
        event.user,
        'Connected to Tipbot\nUse `/tip disconnect` to disconnect.',
        { fallbackToDM: false },
      )
      return
    }

    const now = new Date()
    const token = Nanoid.generate()
    const accessKey = AccessKey.generate()
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
      `Connect to Tipbot: https://${env.HOST}/connect/${token}\nThis link expires in 10 minutes.`,
      { fallbackToDM: false },
    )
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
        'Tipbot is not configured for this Slack workspace. Reinstall Tipbot and try again.',
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
      await event.channel.postEphemeral(event.user, 'No account is connected.', {
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
    await event.channel.postEphemeral(event.user, 'Disconnected from Tipbot', {
      fallbackToDM: false,
    })
  },
  async help(event, _ctx) {
    await event.channel.postEphemeral(
      event.user,
      'I’m Tipbot: sometime tipper, sometime messenger, always bot.\nMock tips are enabled while payment rails are paused. Try `/tip @account for coffee`. Subcommands: `/tip connect`, `/tip disconnect`, `/tip config`, `/tip help`, `/tip whoami`.',
      { fallbackToDM: false },
    )
  },
  async whoami(event, ctx) {
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()
    if (!workspace) {
      await event.channel.postEphemeral(
        event.user,
        'Tipbot is not configured for this Slack workspace. Reinstall Tipbot and try again.',
        { fallbackToDM: false },
      )
      return
    }

    const member = await ctx.db
      .selectFrom('member')
      .innerJoin('account', 'account.id', 'member.account_id')
      .select([
        'account.address as account_address',
        'account.id as account_id',
        'member.provider_user_id',
      ])
      .where('member.workspace_id', '=', workspace.id)
      .where('member.provider_user_id', '=', event.user.userId)
      .executeTakeFirst()
    if (!member) {
      await event.channel.postEphemeral(event.user, 'No account is connected.', {
        fallbackToDM: false,
      })
      return
    }

    await event.channel.postEphemeral(
      event.user,
      `Account ID: ${member.account_id}\nAddress: ${member.account_address}\nProvider user ID: ${member.provider_user_id}`,
      { fallbackToDM: false },
    )
  },
  async default(event, ctx) {
    const parsed = (() => {
      const text = ctx.text.trim()
      const mention = text.match(/<@([A-Z0-9_]+)(?:\|[^>]+)?>/)
      if (!mention) return null
      const afterMention = text.slice((mention.index ?? 0) + mention[0].length).trim()
      return {
        memo: afterMention.replace(/^for\s+/i, '').trim() || null,
        recipientProviderUserId: mention[1]!,
      }
    })()
    if (!parsed) {
      if (ctx.provider.type !== 'slack') throw new Error('Provider is not implemented yet.')

      const installation = await getSlack().getInstallation(ctx.provider.id)
      if (!installation) throw new Error('Slack app is not installed for this workspace.')

      const body = new URLSearchParams()
      body.set('channel', event.channel.id.replace(/^slack:/, ''))
      body.set('text', 'Usage: /tip @account')
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
      if (!json.ok) throw new Error(json.error ?? 'Slack API chat.postEphemeral failed.')
      return
    }

    const sentMessage = await event.channel.post('Sending tip.')

    const result = await Tip.handleTipRequest(env, {
      idempotencyKey: `command:${ctx.provider.id}:${event.triggerId ?? Nanoid.generate()}`,
      memo: parsed.memo,
      provider: ctx.provider.type,
      providerId: ctx.provider.id,
      recipientProviderUserId: parsed.recipientProviderUserId,
      senderProviderUserId: event.user.userId,
    }).catch(
      (error) =>
        ({
          code: 'failed',
          message: error instanceof Error ? error.message : 'Command failed.',
          ok: false,
        }) satisfies Tip.TipResult,
    )
    const textResult = (() => {
      if (result.ok)
        return `${result.status === 'already_sent' ? 'Already sent' : 'Mock tip sent'}: ${event.channel.mentionUser(result.senderProviderUserId)} → ${event.channel.mentionUser(result.recipientProviderUserId)} ${result.amount} mock stablecoins${result.memo ? ` for ${result.memo}` : ''}. ${Tip.formatTxLink(env, result.transactionHash)}`

      if (result.code === 'self_tip') return 'You cannot tip yourself.'
      return `Could not mock tip: ${result.message ?? 'Tip submission failed.'}`
    })()

    if (result.ok) await sentMessage.edit(textResult)
    else {
      await sentMessage.delete()
      await event.channel.postEphemeral(event.user, textResult, { fallbackToDM: false })
    }
  },
} as const satisfies Record<
  (typeof commandNames)[number] | 'default',
  (event: SlashCommandEvent, ctx: HandlerContext) => Promise<void>
>

const commandNames = ['config', 'connect', 'disconnect', 'help', 'whoami'] as const
const commandPattern = new RegExp(`^(${commandNames.join('|')})(?:\\s+([\\s\\S]*))?$`)

type HandlerContext = {
  db: DB.Type
  provider: ReturnType<typeof getProvider>
  text: string
}

function getProvider(event: SlashCommandEvent): {
  id: string
  type: DB_gen.Selectable.workspace['provider']
} {
  if (event.adapter === getSlack()) {
    const slackSlashCommandRaw = z.object({
      team_id: z.string().min(1),
    })
    const raw = z.parse(slackSlashCommandRaw, event.raw)
    return {
      id: raw.team_id,
      type: 'slack',
    }
  }
  throw new Error('Provider is not implemented yet.')
}
