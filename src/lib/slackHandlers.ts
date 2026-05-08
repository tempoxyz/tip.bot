import { createDb } from '#/lib/db.ts'
import {
  createConnectUrl,
  ensureWorkspace,
  getSlackClient,
  parseTipText,
  verifySlackRequest,
} from '#/lib/slack.ts'
import { handleTipRequest } from '#/lib/tipEngine.ts'

export async function handleSlackCommandRequest(
  env: Env,
  request: Request,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
) {
  const rawBody = await request.text()
  if (!(await verifySlackRequest(request, env, rawBody)))
    return new Response('Invalid Slack signature.', { status: 401 })

  const form = new URLSearchParams(rawBody)
  const text = (form.get('text') ?? '').trim()
  const teamId = form.get('team_id') ?? ''
  const senderAccountId = form.get('user_id') ?? ''

  if (text === 'connect')
    return jsonSlack(
      `Connect your Tempo Wallet: ${await createConnectUrl(request, env, { accountId: senderAccountId, teamId })}`,
      true,
    )

  try {
    if (text.startsWith('config'))
      return jsonSlack(await handleConfigCommand(env, teamId, senderAccountId, text), true)

    const parsed = parseTipText(text)
    if (!parsed) return jsonSlack('Usage: /tip @account or /tip connect', true)

    const tip = handleTipRequest(env, request, {
      idempotencyKey: `command:${teamId}:${form.get('trigger_id') ?? crypto.randomUUID()}`,
      reason: parsed.reason,
      recipientAccountId: parsed.recipientAccountId,
      senderAccountId,
      sourceType: 'command',
      teamId,
    })
    if (ctx) {
      ctx.waitUntil(postCommandTipResult(env, form, tip))
      return jsonSlack('Sending tip.', false)
    }

    const result = await tip
    return jsonSlack(result.text, !result.ok)
  } catch (error) {
    return jsonSlack(getErrorMessage(error), true)
  }
}

export async function handleSlackEventRequest(env: Env, request: Request) {
  const rawBody = await request.text()
  if (!(await verifySlackRequest(request, env, rawBody)))
    return new Response('Invalid Slack signature.', { status: 401 })

  const json = JSON.parse(rawBody) as SlackEventEnvelope
  if (json.type === 'url_verification') return new Response(json.challenge ?? '')
  if (!json.event) return Response.json({ ok: true })

  if (json.event.type === 'app_mention') await handleMention(env, request, json)
  if (json.event.type === 'reaction_added') await handleReaction(env, request, json)

  return Response.json({ ok: true })
}

async function handleMention(env: Env, request: Request, envelope: SlackEventEnvelope) {
  const event = envelope.event!
  if (!event.user || !event.text) return

  const text = event.text.replace(/^<@[A-Z0-9]+>\s*/i, '')
  if (isIntroText(text)) {
    await (
      await getSlackClient(env, envelope.team_id)
    ).chat.postMessage({
      channel: event.channel!,
      text: 'I’m Tipbot: sometime tipper, sometime messenger, always bot.\nConnect with `/tip connect`, then send stablecoins with `/tip @account for coffee`, `@Tipbot @account for coffee`, or a :money_with_wings: reaction.',
    })
    return
  }

  const tipText = text.replace(/^tip\s+/i, '')
  const parsed = parseTipText(tipText)
  if (!parsed) return

  const result = await handleTipRequest(env, request, {
    idempotencyKey: `mention:${envelope.team_id}:${envelope.event_id}`,
    reason: parsed.reason,
    recipientAccountId: parsed.recipientAccountId,
    senderAccountId: event.user,
    sourceType: 'mention',
    teamId: envelope.team_id,
  })

  await (
    await getSlackClient(env, envelope.team_id)
  ).chat.postMessage({
    channel: event.channel!,
    text: result.text,
  })
}

async function handleReaction(env: Env, request: Request, envelope: SlackEventEnvelope) {
  const event = envelope.event!
  if (!event.item?.channel || !event.item.ts || !event.reaction || !event.user) return

  const workspace = await ensureWorkspace(env, envelope.team_id)
  if (event.reaction !== workspace.tip_emoji) return

  const client = await getSlackClient(env, envelope.team_id)
  const history = await client.conversations.history({
    channel: event.item.channel,
    inclusive: true,
    latest: event.item.ts,
    limit: 1,
  })
  const message = history.messages?.[0]
  if (!message?.user || message.user === event.user) return

  const result = await handleTipRequest(env, request, {
    idempotencyKey: `reaction:${envelope.team_id}:${event.item.channel}:${event.item.ts}:${event.user}:${event.reaction}`,
    reason: 'reaction tip',
    recipientAccountId: message.user,
    senderAccountId: event.user,
    sourceType: 'reaction',
    teamId: envelope.team_id,
  })

  await client.chat.postMessage({
    channel: event.item.channel,
    text: result.text,
    thread_ts: event.item.ts,
  })
}

async function handleConfigCommand(
  env: Env,
  teamId: string,
  senderAccountId: string,
  text: string,
) {
  const workspace = await ensureWorkspace(env, teamId)
  const parts = text.split(/\s+/)
  const key = parts[1]
  const value = parts[2]

  if (!key || !value)
    return `Current config: emoji ${workspace.tip_emoji}, amount ${workspace.tip_amount}, cap ${workspace.daily_cap}`

  if (!(await isAdmin(env, teamId, senderAccountId)))
    return 'Only Slack admins can change tip config.'

  if (!['amount', 'cap', 'emoji'].includes(key)) return 'Config keys: emoji, amount, cap.'
  await createDb(env.DB)
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

async function isAdmin(env: Env, teamId: string, accountId: string) {
  const info = await (await getSlackClient(env, teamId)).users.info({ user: accountId })
  return Boolean(info.user?.is_admin || info.user?.is_owner)
}

function jsonSlack(text: string, ephemeral: boolean) {
  return Response.json({ response_type: ephemeral ? 'ephemeral' : 'in_channel', text })
}

async function postCommandTipResult(
  env: Env,
  form: URLSearchParams,
  tip: Promise<{ ok: boolean; text: string }>,
) {
  const result = await tip.catch((error) => ({ ok: false, text: getErrorMessage(error) }))
  const responseUrl = form.get('response_url')
  if (responseUrl) {
    await fetch(responseUrl, {
      body: JSON.stringify({
        replace_original: true,
        response_type: result.ok ? 'in_channel' : 'ephemeral',
        text: result.text,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    return
  }
  await (
    await getSlackClient(env, form.get('team_id') ?? '')
  ).chat.postMessage({
    channel: form.get('channel_id') ?? '',
    text: result.text,
  })
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return 'Command failed.'
}

function isIntroText(text: string) {
  return /^(?:hi|hello|hey|help|introduce yourself\b.*|intro|what do you do|who are you)\??$/i.test(
    text.trim(),
  )
}

type SlackEventEnvelope = {
  challenge?: string
  event?: {
    channel?: string
    item?: { channel?: string; ts?: string; type?: string }
    reaction?: string
    text?: string
    thread_ts?: string
    ts?: string
    type: string
    user?: string
  }
  event_id: string
  team_id: string
  type: string
}
