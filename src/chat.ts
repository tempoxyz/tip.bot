import * as DB from '#db/client.ts'
import { createCloudflareState } from '#/vendor/chatStateCloudflareDO.ts'
import { createSlackAdapter } from '@chat-adapter/slack'
import { env } from 'cloudflare:workers'
import { Chat, type SlashCommandEvent } from 'chat'
import { z } from 'zod'
import {
  formatAmount,
  formatTxLink,
  handleTipRequest,
  parseAmount,
  type TipResult,
} from '#/lib/tips'

export const slack = createSlackAdapter({
  apiUrl: `${env.SLACK_API_URL}/`,
  clientId: env.SLACK_CLIENT_ID,
  clientSecret: env.SLACK_CLIENT_SECRET,
  encryptionKey: env.SECRET_KEY,
  signingSecret: env.SLACK_SIGNING_SECRET,
})

export const bot = new Chat({
  adapters: { slack },
  state: createCloudflareState({
    name: 'tipbot',
    namespace: env.CHAT_STATE,
    shardKey(threadId) {
      return threadId.split(':', 1)[0] || 'default'
    },
  }),
  userName: 'tipbot',
})

const commands = {
  async config(event, ctx) {
    const raw = z.parse(slackSlashCommandRaw, event.raw)

    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', 'slack')
      .where('provider_id', '=', raw.team_id)
      .executeTakeFirst()
    if (!workspace) {
      await event.channel.postEphemeral(
        event.user,
        'Tipbot is not configured for this Slack workspace. Reinstall Tipbot and try again.',
        { fallbackToDM: false },
      )
      return
    }

    const parts = event.text.trim().split(/\s+/)
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

    const installation = await slack.getInstallation(raw.team_id)
    if (!installation) throw new Error('Slack app is not installed for this workspace.')

    const body = new URLSearchParams()
    body.set('user', event.user.userId)
    const response = await slack.withBotToken(installation.botToken, () =>
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

    const amount = parseAmount(value)
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
  async connect(event, _ctx) {
    await event.channel.postEphemeral(
      event.user,
      'Mock tipping is enabled. No wallet connection is required right now.',
      { fallbackToDM: false },
    )
  },
  async disconnect(event, ctx) {
    const raw = z.parse(slackSlashCommandRaw, event.raw)
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', 'slack')
      .where('provider_id', '=', raw.team_id)
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

    await ctx.db
      .updateTable('member')
      .set({ account_id: null, updated_at: new Date().toISOString() })
      .where('id', '=', member.id)
      .execute()
    await event.channel.postEphemeral(event.user, 'Disconnected account.', { fallbackToDM: false })
  },
  async help(event, _ctx) {
    await event.channel.postEphemeral(
      event.user,
      'I’m Tipbot: sometime tipper, sometime messenger, always bot.\nMock tips are enabled while payment rails are paused. Try `/tip @account for coffee`.',
      { fallbackToDM: false },
    )
  },
  async tip(event, _ctx) {
    const raw = z.parse(slackSlashCommandRaw, event.raw)

    const parsed = (() => {
      const text = event.text.trim()
      const mention = text.match(/<@([A-Z0-9_]+)(?:\|[^>]+)?>/)
      if (!mention) return null
      const afterMention = text.slice((mention.index ?? 0) + mention[0].length).trim()
      return {
        memo: afterMention.replace(/^for\s+/i, '').trim() || null,
        recipientProviderUserId: mention[1]!,
      }
    })()
    if (!parsed) {
      const installation = await slack.getInstallation(raw.team_id)
      if (!installation) throw new Error('Slack app is not installed for this workspace.')

      const body = new URLSearchParams()
      body.set('channel', event.channel.id.replace(/^slack:/, ''))
      body.set('text', 'Usage: /tip @account')
      body.set('user', event.user.userId)
      const response = await slack.withBotToken(installation.botToken, () =>
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

    const result = await handleTipRequest(env, {
      idempotencyKey: `command:${raw.team_id}:${event.triggerId ?? crypto.randomUUID()}`,
      memo: parsed.memo,
      provider: 'slack',
      providerId: raw.team_id,
      recipientProviderUserId: parsed.recipientProviderUserId,
      senderProviderUserId: event.user.userId,
    }).catch(
      (error) =>
        ({
          code: 'failed',
          message: error instanceof Error ? error.message : 'Command failed.',
          ok: false,
        }) satisfies TipResult,
    )
    const textResult = (() => {
      if (result.ok)
        return `${result.status === 'already_sent' ? 'Already sent' : 'Mock tip sent'}: ${event.channel.mentionUser(result.senderProviderUserId)} → ${event.channel.mentionUser(result.recipientProviderUserId)} ${result.amount} mock stablecoins${result.memo ? ` for ${result.memo}` : ''}. ${formatTxLink(env, result.transactionHash)}`

      if (result.code === 'self_tip') return 'You cannot tip yourself.'
      return `Could not mock tip: ${result.message ?? 'Tip submission failed.'}`
    })()

    if (result.ok) await sentMessage.edit(textResult)
    else {
      await sentMessage.delete()
      await event.channel.postEphemeral(event.user, textResult, { fallbackToDM: false })
    }
  },
} satisfies Record<string, (event: SlashCommandEvent, ctx: { db: DB.Type }) => Promise<void>>

bot.onSlashCommand('/tip', async (event) => {
  await commands.tip(event, { db: DB.create(env.DB) })
})
bot.onSlashCommand('/tip-connect', async (event) => {
  await commands.connect(event, { db: DB.create(env.DB) })
})
bot.onSlashCommand('/tip-disconnect', async (event) => {
  await commands.disconnect(event, { db: DB.create(env.DB) })
})
bot.onSlashCommand('/tip-config', async (event) => {
  await commands.config(event, { db: DB.create(env.DB) })
})
bot.onSlashCommand('/tip-help', async (event) => {
  await commands.help(event, { db: DB.create(env.DB) })
})

const slackSlashCommandRaw = z.object({
  team_id: z.string().min(1),
})
