import { createDb } from '#db/client.ts'
import { decryptSecret, encryptSecret, hashValue } from '#/lib/crypto.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { connectTokenTtlMs } from '#/lib/tempo.ts'

export type SlackEnv = Env & {
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

export async function completeSlackInstall(request: Request, env: SlackEnv) {
  const url = new URL(request.url)
  const error = url.searchParams.get('error')
  if (error) throw new Error(`Slack install failed: ${error}`)

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) throw new Error('Slack install callback is missing code or state.')

  const expectedRedirectUri = `${getSlackAppOrigin(request, env)}/api/slack/oauth/callback`
  const stateData = await verifySlackOAuthState(env, state)
  if (stateData.redirectUri !== expectedRedirectUri)
    throw new Error('Slack install callback redirect URI does not match state.')

  const oauth = await exchangeSlackOAuthCode(env, code, expectedRedirectUri)
  if (!oauth.ok) throw new Error(oauth.error ?? 'Slack OAuth token exchange failed.')
  if (!oauth.access_token) throw new Error('Slack OAuth response did not include a bot token.')
  if (!oauth.team?.id) throw new Error('Slack OAuth response did not include a team ID.')
  if (!env.ACCESS_KEY_ENCRYPTION_SECRET)
    throw new Error('ACCESS_KEY_ENCRYPTION_SECRET is not configured.')

  const teamId = oauth.team.id
  const teamName = oauth.team.name ?? null
  const workspace = await ensureWorkspace(env, teamId)
  const now = new Date().toISOString()
  const installationId = Nanoid.generate()
  const botTokenCiphertext = await encryptSecret(
    oauth.access_token,
    env.ACCESS_KEY_ENCRYPTION_SECRET,
  )

  await createDb(env.DB)
    .updateTable('workspace')
    .set({ name: teamName, updated_at: now })
    .where('id', '=', workspace.id)
    .execute()
  await createDb(env.DB)
    .insertInto('slack_installation')
    .values({
      bot_token_ciphertext: botTokenCiphertext,
      bot_user_id: oauth.bot_user_id ?? null,
      created_at: now,
      enterprise_id: oauth.enterprise?.id ?? null,
      id: installationId,
      installed_by: oauth.authed_user?.id ?? null,
      scopes: oauth.scope ?? null,
      team_id: teamId,
      team_name: teamName,
      updated_at: now,
      workspace_id: workspace.id,
    })
    .onConflict((oc) =>
      oc.column('team_id').doUpdateSet({
        bot_token_ciphertext: botTokenCiphertext,
        bot_user_id: oauth.bot_user_id ?? null,
        enterprise_id: oauth.enterprise?.id ?? null,
        installed_by: oauth.authed_user?.id ?? null,
        scopes: oauth.scope ?? null,
        team_name: teamName,
        updated_at: now,
        workspace_id: workspace.id,
      }),
    )
    .execute()

  return { teamId, teamName: teamName ?? teamId }
}

export async function createSlackInstallUrl(request: Request, env: SlackEnv) {
  if (!env.SLACK_CLIENT_ID) throw new Error('SLACK_CLIENT_ID is not configured.')

  const redirectUri = `${getSlackAppOrigin(request, env)}/api/slack/oauth/callback`
  const url = new URL('https://slack.com/oauth/v2/authorize')
  url.searchParams.set('client_id', env.SLACK_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', slackBotScopes.join(','))
  url.searchParams.set('state', await createSlackOAuthState(env, redirectUri))
  return url.toString()
}

export async function createConnectUrl(request: Request, env: SlackEnv, data: SlackAccountRef) {
  const workspace = await ensureWorkspace(env, data.teamId)
  const token = Nanoid.generate(24)
  const now = Date.now()
  const expiresAt = new Date(now + connectTokenTtlMs).toISOString()
  const nowIso = new Date(now).toISOString()

  await createDb(env.DB)
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

export async function ensureWorkspace(env: SlackEnv, teamId: string) {
  const existing = await createDb(env.DB)
    .selectFrom('workspace')
    .selectAll()
    .where('platform', '=', 'slack')
    .where('platform_team_id', '=', teamId)
    .executeTakeFirst()
  if (existing) return existing

  const id = Nanoid.generate()
  await createDb(env.DB)
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
  return await createDb(env.DB)
    .selectFrom('workspace')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

export async function getConnectedAccount(env: SlackEnv, data: SlackAccountRef) {
  const workspace = await ensureWorkspace(env, data.teamId)
  return await createDb(env.DB)
    .selectFrom('account')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .where('platform', '=', 'slack')
    .where('platform_account_id', '=', data.accountId)
    .executeTakeFirst()
}

export async function getSlackClient(env: SlackEnv, teamId?: string) {
  const token = await getSlackBotToken(env, teamId)
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

export async function verifySlackRequest(request: Request, env: SlackEnv, rawBody: string) {
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

export type SlackAccountRef = {
  accountId: string
  teamId: string
}

async function createSlackOAuthState(env: SlackEnv, redirectUri: string) {
  const payload = base64UrlEncode(
    JSON.stringify({ expiresAt: Date.now() + slackOAuthStateTtlMs, redirectUri }),
  )
  return `${payload}.${await signSlackOAuthState(env, payload)}`
}

async function exchangeSlackOAuthCode(env: SlackEnv, code: string, redirectUri: string) {
  if (!env.SLACK_CLIENT_ID) throw new Error('SLACK_CLIENT_ID is not configured.')
  if (!env.SLACK_CLIENT_SECRET) throw new Error('SLACK_CLIENT_SECRET is not configured.')

  const response = await fetch(`${getSlackApiUrl(env)}oauth.v2.access`, {
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  })
  return (await response.json()) as SlackOAuthAccessResponse
}

async function slackApi<T = SlackApiResponse>(
  env: SlackEnv,
  token: string,
  method: string,
  params: SlackApiParams,
) {
  const body = new URLSearchParams()
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (value !== undefined) body.set(key, String(value))
  }

  const response = await fetch(`${getSlackApiUrl(env)}${method}`, {
    body,
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
  })
  const json = (await response.json()) as SlackApiResponse
  if (json.ok) return json as T

  throw new Error(json.error ?? `Slack API ${method} failed.`)
}

async function getSlackBotToken(env: SlackEnv, teamId?: string) {
  if (teamId) {
    const installation = await createDb(env.DB)
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

function getSlackApiUrl(env: SlackEnv) {
  const url = env.SLACK_API_URL ?? 'https://slack.com/api/'
  return url.endsWith('/') ? url : `${url}/`
}

function getSlackAppOrigin(request: Request, env: SlackEnv) {
  if (env.HOST) return `https://${env.HOST.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
  return new URL(request.url).origin.replace(/\/+$/, '')
}

async function signSlackOAuthState(env: SlackEnv, payload: string) {
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

async function verifySlackOAuthState(env: SlackEnv, state: string) {
  const [payload, signature] = state.split('.')
  if (!payload || !signature) throw new Error('Slack install state is invalid.')
  if (!timingSafeEqual(signature, await signSlackOAuthState(env, payload)))
    throw new Error('Slack install state signature is invalid.')

  const data = JSON.parse(base64UrlDecode(payload)) as SlackOAuthState
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

type SlackOAuthAccessResponse = {
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

type SlackOAuthState = {
  expiresAt: number
  redirectUri: string
}
