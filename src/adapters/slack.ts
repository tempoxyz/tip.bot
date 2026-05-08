import { createClient } from '#db/client.ts'
import { decryptSecret, hashValue } from '#/lib/crypto.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { connectTokenTtlMs } from '#/lib/tempo.ts'
import { handleTipRequest } from '#/lib/tipEngine.ts'

export type Environment = Env & {
  ACCESS_KEY_ENCRYPTION_SECRET?: string
  HOST?: string
  SLACK_API_URL?: string
  SLACK_CLIENT_ID?: string
  SLACK_CLIENT_SECRET?: string
  SLACK_SIGNING_SECRET?: string
}

const slackBotScopes = [
  'app_mentions:read',
  'channels:history',
  'chat:write',
  'commands',
  'groups:history',
  'reactions:read',
  'users:read',
]
const slackOAuthStateTtlMs = 10 * 60 * 1000 // 10 minutes

export async function createInstallUrl(request: Request, env: Environment) {
  if (!env.SLACK_CLIENT_ID) throw new Error('SLACK_CLIENT_ID is not configured.')

  const redirectUri = `${getAppOrigin(request, env)}/api/slack/oauth/callback`
  const url = new URL('https://slack.com/oauth/v2/authorize')
  url.searchParams.set('client_id', env.SLACK_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', slackBotScopes.join(','))
  url.searchParams.set('state', await createOAuthState(env, redirectUri))
  return url.toString()
}

export async function createConnectUrl(request: Request, env: Environment, data: AccountRef) {
  const workspace = await ensureWorkspace(env, data.teamId)
  const token = Nanoid.generate(24)
  const now = Date.now()
  const expiresAt = new Date(now + connectTokenTtlMs).toISOString()
  const nowIso = new Date(now).toISOString()

  await createClient(env.DB)
    .insertInto('connect_token')
    .values({
      created_at: nowIso,
      expires_at: expiresAt,
      id: Nanoid.generate(),
      platform: 'slack',
      platform_account_id: data.accountId,
      token_hash: await hashValue(token),
      workspace_id: workspace.id,
    })
    .execute()

  const url = new URL('/connect', new URL(request.url).origin)
  url.searchParams.set('chain', env.TEMPO_CHAIN)
  url.searchParams.set('token', token)
  return url.toString()
}

export async function ensureWorkspace(env: Environment, teamId: string) {
  const existing = await createClient(env.DB)
    .selectFrom('workspace')
    .selectAll()
    .where('platform', '=', 'slack')
    .where('platform_team_id', '=', teamId)
    .executeTakeFirst()
  if (existing) return existing

  const id = Nanoid.generate()
  await createClient(env.DB)
    .insertInto('workspace')
    .values({
      created_at: new Date().toISOString(),
      daily_cap: '1',
      id,
      platform: 'slack',
      platform_team_id: teamId,
      tip_amount: '0.001',
      tip_emoji: 'money_with_wings',
      updated_at: new Date().toISOString(),
    })
    .execute()
  return await createClient(env.DB)
    .selectFrom('workspace')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

export async function getConnectedAccount(env: Environment, data: AccountRef) {
  const workspace = await ensureWorkspace(env, data.teamId)
  return await createClient(env.DB)
    .selectFrom('account')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .where('platform', '=', 'slack')
    .where('platform_account_id', '=', data.accountId)
    .executeTakeFirst()
}

export async function getClient(env: Environment, teamId?: string) {
  const token = await getBotToken(env, teamId)
  if (!token) throw new Error('Slack app is not installed for this workspace.')

  return {
    chat: {
      postMessage: (params: SlackApiParams) => slackApi(env, token, 'chat.postMessage', params),
    },
    conversations: {
      history: (params: SlackApiParams) =>
        slackApi<SlackConversationsHistoryResponse>(env, token, 'conversations.history', params),
    },
    users: {
      info: (params: SlackApiParams) =>
        slackApi<SlackUsersInfoResponse>(env, token, 'users.info', params),
    },
  }
}

export function parseTipText(text: string) {
  const mention = text.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/)
  if (!mention) return null

  const afterMention = text.slice((mention.index ?? 0) + mention[0].length).trim()
  return {
    reason: afterMention.replace(/^for\s+/i, '').trim() || null,
    recipientAccountId: mention[1]!,
  }
}

export async function verifyRequest(request: Request, env: Environment, rawBody: string) {
  if (!env.SLACK_SIGNING_SECRET) throw new Error('SLACK_SIGNING_SECRET is not configured.')

  const signature = request.headers.get('x-slack-signature') ?? ''
  const timestamp = request.headers.get('x-slack-request-timestamp') ?? ''
  const nowSeconds = Math.floor(Date.now() / 1000) // current Unix time in seconds
  if (Math.abs(nowSeconds - Number(timestamp)) > 5 * 60) return false // 5 minutes

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  )
  return timingSafeEqual(signature, `v0=${bytesToHex(new Uint8Array(digest))}`)
}

export type AccountRef = {
  accountId: string
  teamId: string
}

async function createOAuthState(env: Environment, redirectUri: string) {
  const payload = base64UrlEncode(
    JSON.stringify({ expiresAt: Date.now() + slackOAuthStateTtlMs, redirectUri }),
  )
  return `${payload}.${await signOAuthState(env, payload)}`
}

export async function exchangeOAuthCode(env: Environment, code: string, redirectUri: string) {
  if (!env.SLACK_CLIENT_ID) throw new Error('SLACK_CLIENT_ID is not configured.')
  if (!env.SLACK_CLIENT_SECRET) throw new Error('SLACK_CLIENT_SECRET is not configured.')

  const response = await fetch(`${getApiUrl(env)}oauth.v2.access`, {
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  })
  return (await response.json()) as OAuthAccessResponse
}

async function slackApi<T = SlackApiResponse>(
  env: Environment,
  token: string,
  method: string,
  params: SlackApiParams,
) {
  const body = new URLSearchParams()
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (value !== undefined) body.set(key, String(value))
  }

  const response = await fetch(`${getApiUrl(env)}${method}`, {
    body,
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
  })
  const json = (await response.json()) as SlackApiResponse
  if (json.ok) return json as T

  throw new Error(json.error ?? `Slack API ${method} failed.`)
}

async function getBotToken(env: Environment, teamId?: string) {
  if (teamId) {
    const installation = await createClient(env.DB)
      .selectFrom('slack_installation')
      .select('bot_token_ciphertext')
      .where('team_id', '=', teamId)
      .executeTakeFirst()
    if (installation) {
      if (!env.ACCESS_KEY_ENCRYPTION_SECRET)
        throw new Error('ACCESS_KEY_ENCRYPTION_SECRET is not configured.')
      return await decryptSecret(
        installation.bot_token_ciphertext,
        env.ACCESS_KEY_ENCRYPTION_SECRET,
      )
    }
  }
}

function getApiUrl(env: Environment) {
  const url = env.SLACK_API_URL ?? 'https://slack.com/api/'
  return url.endsWith('/') ? url : `${url}/`
}

export function getAppOrigin(request: Request, env: Environment) {
  if (env.HOST) return `https://${env.HOST.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
  return new URL(request.url).origin.replace(/\/+$/, '')
}

async function signOAuthState(env: Environment, payload: string) {
  if (!env.SLACK_CLIENT_SECRET) throw new Error('SLACK_CLIENT_SECRET is not configured.')

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SLACK_CLIENT_SECRET),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return bytesToHex(new Uint8Array(digest))
}

export async function verifyOAuthState(env: Environment, state: string) {
  const [payload, signature] = state.split('.')
  if (!payload || !signature) throw new Error('Slack install state is invalid.')
  if (!timingSafeEqual(signature, await signOAuthState(env, payload)))
    throw new Error('Slack install state signature is invalid.')

  const data = JSON.parse(base64UrlDecode(payload)) as OAuthState
  if (Date.now() > data.expiresAt) throw new Error('Slack install state expired.')
  return data
}

function base64UrlDecode(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
}

function base64UrlEncode(value: string) {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function bytesToHex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let result = 0
  for (let i = 0; i < left.length; i += 1) result |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return result === 0
}

export type OAuthAccessResponse = {
  access_token?: string
  authed_user?: { id?: string }
  bot_user_id?: string
  enterprise?: { id?: string; name?: string }
  error?: string
  ok: boolean
  scope?: string
  team?: { id?: string; name?: string }
}

type SlackApiParams = Record<string, boolean | number | string | undefined>

type SlackApiResponse = {
  error?: string
  ok?: boolean
}

type SlackConversationsHistoryResponse = SlackApiResponse & {
  messages?: Array<{
    user?: string
  }>
}

type SlackUsersInfoResponse = SlackApiResponse & {
  user?: {
    is_admin?: boolean
    is_owner?: boolean
  }
}

export type OAuthState = {
  expiresAt: number
  redirectUri: string
}

export async function handleCommandRequest(
  env: Env,
  request: Request,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
) {
  const rawBody = await request.text()
  if (!(await verifyRequest(request, env, rawBody)))
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

export async function handleEventRequest(env: Env, request: Request) {
  const rawBody = await request.text()
  if (!(await verifyRequest(request, env, rawBody)))
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
      await getClient(env, envelope.team_id)
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
    await getClient(env, envelope.team_id)
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

  const client = await getClient(env, envelope.team_id)
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
  await createClient(env.DB)
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
  const info = await (await getClient(env, teamId)).users.info({ user: accountId })
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
    await getClient(env, form.get('team_id') ?? '')
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
