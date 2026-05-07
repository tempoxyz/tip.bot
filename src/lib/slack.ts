import type { WebClient } from '@slack/web-api'

import { hashValue } from '#/lib/crypto.ts'
import { createDb } from '#/lib/db.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { connectTokenTtlMs } from '#/lib/tempo.ts'

export type SlackEnv = Env & {
  SLACK_ADMIN_ACCOUNT_IDS?: string
  SLACK_API_URL?: string
  SLACK_BOT_TOKEN?: string
  SLACK_SIGNING_SECRET?: string
}

let SlackWebClient: typeof WebClient | null = null

export async function createConnectUrl(request: Request, env: SlackEnv, data: SlackAccountRef) {
  const workspace = await ensureWorkspace(env, data.teamId)
  const token = crypto.randomUUID()
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

  return `${new URL(request.url).origin}/connect?token=${encodeURIComponent(token)}`
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
      tip_amount: '0.0001',
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

export async function getSlackClient(env: SlackEnv) {
  if (!env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN is not configured.')
  SlackWebClient ??= (await import('@slack/web-api')).WebClient
  return new SlackWebClient(
    env.SLACK_BOT_TOKEN,
    env.SLACK_API_URL ? { slackApiUrl: env.SLACK_API_URL } : undefined,
  )
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

function bytesToHex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let result = 0
  for (let i = 0; i < left.length; i += 1) result |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return result === 0
}
