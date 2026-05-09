import * as DB from '#db/client.ts'
import { createSlackAdapter, type SlackEvent, type SlackReactionEvent } from '@chat-adapter/slack'
import { env } from 'cloudflare:workers'
import { Chat, type Message, type ReactionEvent, type SlashCommandEvent, type Thread } from 'chat'
import { createChatState } from '#/lib/chatState.ts'
import {
  ensureWorkspace,
  formatTxLink,
  handleTipRequest,
  type Platform,
  type TipInput,
  type TipResult,
} from '#/lib/mockTips.ts'

const slackEventContexts = new Map<string, { eventId: string; teamId: string; timestamp: number }>()

export const slack = createSlackAdapter({
  apiUrl: `${env.SLACK_API_URL}/`,
  clientId: env.SLACK_CLIENT_ID,
  clientSecret: env.SLACK_CLIENT_SECRET,
  encryptionKey: env.SECRET_KEY,
  signingSecret: env.SLACK_SIGNING_SECRET,
})

export const bot = new Chat({
  adapters: { slack },
  state: createChatState(env),
  userName: 'tipbot',
})

bot.onSlashCommand('/tip', async (event) => {
  await handleSlashCommand(event)
})
bot.onNewMention(async (thread, message) => {
  await handleMention(thread, message as Message<SlackEvent>)
})
bot.onReaction(async (event) => {
  await handleReaction(event as ReactionEvent<SlackReactionEvent>)
})

export function parseTipText(text: string) {
  const mention = text.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/)
  if (!mention) return null

  const afterMention = text.slice((mention.index ?? 0) + mention[0].length).trim()
  return {
    reason: afterMention.replace(/^for\s+/i, '').trim() || null,
    recipientAccountId: mention[1]!,
  }
}

async function handleSlashCommand(event: SlashCommandEvent) {
  const raw = event.raw as Record<string, string | undefined>
  const text = event.text.trim()
  const teamId = raw.team_id ?? ''
  const senderAccountId = event.user.userId

  if (text === 'connect') {
    await event.channel.postEphemeral(
      event.user,
      'Mock tipping is enabled. No wallet connection is required right now.',
      { fallbackToDM: false },
    )
    return
  }

  if (text.startsWith('config')) {
    await event.channel.postEphemeral(
      event.user,
      await handleConfigCommand(teamId, senderAccountId, text),
      { fallbackToDM: false },
    )
    return
  }

  const parsed = parseTipText(text)
  if (!parsed) {
    await event.channel.postEphemeral(event.user, 'Usage: /tip @account or /tip config', {
      fallbackToDM: false,
    })
    return
  }

  const responseUrl = raw.response_url
  if (responseUrl)
    await postSlackResponseUrl(responseUrl, { response_type: 'in_channel', text: 'Sending tip.' })

  const input = {
    idempotencyKey: `command:${teamId}:${event.triggerId ?? crypto.randomUUID()}`,
    platform: 'slack',
    platformTeamId: teamId,
    reason: parsed.reason,
    recipientAccountId: parsed.recipientAccountId,
    senderAccountId,
    sourceType: 'command',
  } satisfies TipInput
  const result = await handleTipRequest(env, input).catch(
    (error) =>
      ({
        code: 'failed',
        message: error instanceof Error ? error.message : 'Command failed.',
        ok: false,
      }) satisfies TipResult,
  )
  const textResult = await renderTipResult(input, result)

  if (responseUrl) {
    await postSlackResponseUrl(responseUrl, {
      replace_original: true,
      response_type: result.ok ? 'in_channel' : 'ephemeral',
      text: textResult,
    })
    return
  }

  if (result.ok) await event.channel.post(textResult)
  else await event.channel.postEphemeral(event.user, textResult, { fallbackToDM: false })
}

async function handleMention(thread: Thread, message: Message<SlackEvent>) {
  const raw = message.raw
  if (!raw.user) return

  const context = getCachedSlackEventContext(slackMessageContextKey(raw))
  const teamId = raw.team_id ?? raw.team ?? context?.teamId
  if (!teamId) return

  const text = (raw.text ?? message.text).replace(/^<@[A-Z0-9]+>\s*/i, '')
  if (isIntroText(text)) {
    await thread.post(
      'I’m Tipbot: sometime tipper, sometime messenger, always bot.\nMock tips are enabled while payment rails are paused. Try `/tip @account for coffee`, `@Tipbot @account for coffee`, or a :money_with_wings: reaction.',
    )
    return
  }

  const parsed = parseTipText(text.replace(/^tip\s+/i, ''))
  if (!parsed) return

  const input = {
    idempotencyKey: `mention:${teamId}:${context?.eventId ?? message.id}`,
    platform: 'slack',
    platformTeamId: teamId,
    reason: parsed.reason,
    recipientAccountId: parsed.recipientAccountId,
    senderAccountId: raw.user,
    sourceType: 'mention',
  } satisfies TipInput
  await thread.post(await renderTipResult(input, await handleTipRequest(env, input)))
}

async function handleReaction(event: ReactionEvent<SlackReactionEvent>) {
  if (!event.added) return

  const raw = event.raw as SlackReactionEvent
  const context = getCachedSlackEventContext(slackReactionContextKey(raw))
  if (!context) return

  const workspace = await ensureWorkspace(env, 'slack', context.teamId)
  if (event.rawEmoji !== workspace.tip_emoji) return

  const senderAccountId = event.user.userId
  const recipientAccountId =
    event.message?.author.userId ??
    raw.item_user ??
    (await getSlackReactionMessageAuthor(context.teamId, raw))
  if (!recipientAccountId || recipientAccountId === senderAccountId) return

  const input = {
    idempotencyKey: `reaction:${context.teamId}:${raw.item.channel}:${raw.item.ts}:${senderAccountId}:${event.rawEmoji}`,
    platform: 'slack',
    platformTeamId: context.teamId,
    reason: 'reaction tip',
    recipientAccountId,
    senderAccountId,
    sourceType: 'reaction',
  } satisfies TipInput
  await event.thread.post(await renderTipResult(input, await handleTipRequest(env, input)))
}

async function handleConfigCommand(teamId: string, senderAccountId: string, text: string) {
  const workspace = await ensureWorkspace(env, 'slack', teamId)
  const parts = text.split(/\s+/)
  const key = parts[1]
  const value = parts[2]

  if (!key || !value)
    return `Current config: emoji ${workspace.tip_emoji}, amount ${workspace.tip_amount}, cap ${workspace.daily_cap}`

  if (!(await isSlackAdmin(teamId, senderAccountId)))
    return 'Only Slack admins can change tip config.'

  if (!['amount', 'cap', 'emoji'].includes(key)) return 'Config keys: emoji, amount, cap.'

  const nextAmount = key === 'amount' ? value : workspace.tip_amount
  const nextCap = key === 'cap' ? value : workspace.daily_cap
  if (key === 'amount' || key === 'cap') {
    const error = validateTipConfigAmount(nextAmount, nextCap)
    if (error) return error
  }

  await DB.create(env.DB)
    .updateTable('workspace')
    .set({
      ...(key === 'amount' ? { tip_amount: value } : {}),
      ...(key === 'cap' ? { daily_cap: value } : {}),
      ...(key === 'emoji' ? { tip_emoji: value.replaceAll(':', '') } : {}),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', workspace.id)
    .execute()

  return `Updated ${key}.`
}

async function isSlackAdmin(teamId: string, accountId: string) {
  const info = await slackApi<{ user?: { is_admin?: boolean; is_owner?: boolean } }>(
    teamId,
    'users.info',
    { user: accountId },
  )
  return Boolean(info.user?.is_admin || info.user?.is_owner)
}

async function getSlackReactionMessageAuthor(teamId: string, event: SlackReactionEvent) {
  const history = await slackApi<{ messages?: Array<{ user?: string }> }>(
    teamId,
    'conversations.history',
    {
      channel: event.item.channel,
      inclusive: true,
      latest: event.item.ts,
      limit: 1,
    },
  )
  return history.messages?.[0]?.user ?? null
}

async function slackApi<T>(
  teamId: string,
  method: string,
  params: Record<string, boolean | number | string | undefined>,
) {
  const installation = await slack.getInstallation(teamId)
  if (!installation) throw new Error('Slack app is not installed for this workspace.')

  const body = new URLSearchParams()
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (value !== undefined) body.set(key, String(value))
  }

  const response = await slack.withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/${method}`, {
      body,
      headers: { authorization: `Bearer ${installation.botToken}` },
      method: 'POST',
    }),
  )
  const json = (await response.json()) as T & { error?: string; ok?: boolean }
  if (json.ok) return json as T

  throw new Error(json.error ?? `Slack API ${method} failed.`)
}

async function renderTipResult(input: TipInput, result: TipResult) {
  if (result.ok)
    return `${result.status === 'already_sent' ? 'Already sent' : 'Mock tip sent'}: ${formatMention(input.platform, result.senderAccountId)} → ${formatMention(input.platform, result.recipientAccountId)} ${result.amount} mock stablecoins${result.reason ? ` for ${result.reason}` : ''}. ${formatTxLink(env, result.txHash)}`

  if (result.code === 'self_tip') return 'You cannot tip yourself.'
  if (result.code === 'daily_cap')
    return `Daily tip cap reached for ${formatMention(input.platform, result.accountId ?? input.senderAccountId)}.`
  return `Could not mock tip: ${result.message ?? 'Tip submission failed.'}`
}

function validateTipConfigAmount(amount: string, cap: string) {
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0)
    return 'Amount must be a positive decimal.'
  if (!Number.isFinite(Number(cap)) || Number(cap) <= 0) return 'Cap must be a positive decimal.'

  if (Number(cap) < Number(amount)) return 'Cap must be greater than or equal to amount.'
  return null
}

async function postSlackResponseUrl(
  responseUrl: string,
  body: { replace_original?: boolean; response_type: 'ephemeral' | 'in_channel'; text: string },
) {
  await fetch(responseUrl, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
}

function formatMention(platform: Platform, accountId: string) {
  if (platform === 'slack') return `<@${accountId}>`
  return accountId
}

function isIntroText(text: string) {
  return /^(?:hi|hello|hey|help|introduce yourself\b.*|intro|what do you do|who are you)\??$/i.test(
    text.trim(),
  )
}

export function cacheSlackEventContext(rawBody: string, contentType: string) {
  cleanupSlackEventContexts()
  if (!contentType.includes('application/json')) return

  try {
    const envelope = JSON.parse(rawBody) as {
      event?: SlackEvent | (SlackReactionEvent & { item?: SlackReactionEvent['item'] })
      event_id: string
      team_id: string
      type: string
    }
    if (envelope.type !== 'event_callback' || !envelope.event || !envelope.team_id) return

    if (envelope.event.type === 'app_mention' && envelope.event.channel && envelope.event.ts)
      slackEventContexts.set(slackMessageContextKey(envelope.event), {
        eventId: envelope.event_id,
        teamId: envelope.team_id,
        timestamp: Date.now(),
      })
    const event = envelope.event as SlackReactionEvent
    if (event.type === 'reaction_added' && event.item?.channel && event.item.ts)
      slackEventContexts.set(slackReactionContextKey(event), {
        eventId: envelope.event_id,
        teamId: envelope.team_id,
        timestamp: Date.now(),
      })
  } catch {}
}

function getCachedSlackEventContext(key: string) {
  cleanupSlackEventContexts()
  return slackEventContexts.get(key)
}

function cleanupSlackEventContexts() {
  const expired = Date.now() - 10 * 60 * 1000 // 10 minutes
  for (const [key, value] of slackEventContexts) {
    if (value.timestamp < expired) slackEventContexts.delete(key)
  }
}

function slackMessageContextKey(event: Pick<SlackEvent, 'channel' | 'ts'>) {
  return `message:${event.channel ?? ''}:${event.ts ?? ''}`
}

function slackReactionContextKey(event: SlackReactionEvent) {
  return `reaction:${event.item.channel}:${event.item.ts}:${event.user}:${event.reaction}`
}
