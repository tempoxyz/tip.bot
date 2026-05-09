import { Hono } from 'hono'
import { Base64, Hex } from 'ox'
import * as DB from '#db/client.ts'
import * as Chat from '#/chat.ts'
import { ensureWorkspace } from '#/lib/mockTips.ts'

export const api = new Hono<{
  Bindings: Env
  Variables: {
    db: DB.Type
  }
}>()
  .use(async (c, next) => {
    c.set('db', DB.create(c.env.DB))
    await next()
  })
  .post('/api/chat/slack', async (c) => {
    const request = c.req.raw
    const rawBody = await request.text()
    Chat.cacheSlackEventContext(rawBody, request.headers.get('content-type') ?? '')
    return await Chat.bot.webhooks.slack(
      new Request(request.url, {
        body: rawBody,
        headers: request.headers,
        method: request.method,
      }),
      {
        waitUntil(promise) {
          try {
            c.executionCtx.waitUntil(promise)
          } catch {}
        },
      },
    )
  })
  .get('/api/chat/slack/install', async (c) => {
    const redirectUri = `https://${c.env.HOST}/api/chat/slack/oauth/callback`
    const url = new URL('https://slack.com/oauth/v2/authorize')
    url.searchParams.set('client_id', c.env.SLACK_CLIENT_ID)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set(
      'scope',
      [
        'app_mentions:read',
        'channels:history',
        'channels:read',
        'chat:write',
        'commands',
        'groups:history',
        'groups:read',
        'reactions:read',
        'reactions:write',
        'users:read',
      ].join(','),
    )
    url.searchParams.set('state', await createOAuthState(c.env, redirectUri))
    return Response.redirect(url.toString(), 302)
  })
  .get('/api/chat/slack/oauth/callback', async (c) => {
    try {
      const url = new URL(c.req.url)
      const error = url.searchParams.get('error')
      if (error) throw new Error(`Slack install failed: ${error}`)

      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code || !state) throw new Error('Slack install callback is missing code or state.')

      const redirectUri = `https://${c.env.HOST}/api/chat/slack/oauth/callback`
      const stateData = await verifyOAuthState(c.env, state)
      if (stateData.redirectUri !== redirectUri)
        throw new Error('Slack install callback redirect URI does not match state.')

      await Chat.bot.initialize()
      const result = await Chat.slack.handleOAuthCallback(c.req.raw, { redirectUri })
      const workspace = await ensureWorkspace(c.env, 'slack', result.teamId)
      await DB.create(c.env.DB)
        .updateTable('workspace')
        .set({ name: result.installation.teamName ?? null, updated_at: new Date().toISOString() })
        .where('id', '=', workspace.id)
        .execute()

      return Response.redirect(
        `${url.origin}/?slack=installed&team=${encodeURIComponent(result.installation.teamName ?? result.teamId)}`,
        302,
      )
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'Request failed.', {
        status: 400,
      })
    }
  })

async function createOAuthState(env: Pick<Env, 'SECRET_KEY'>, redirectUri: string) {
  const payload = Base64.fromString(
    JSON.stringify({ expiresAt: Date.now() + 10 * 60 * 1000, redirectUri }), // 10 minutes
    { pad: false, url: true },
  )
  return `${payload}.${await signOAuthState(env, payload)}`
}

async function verifyOAuthState(env: Pick<Env, 'SECRET_KEY'>, state: string) {
  const [payload, signature] = state.split('.')
  if (!payload || !signature) throw new Error('Slack install state is invalid.')
  if (!timingSafeEqual(signature, await signOAuthState(env, payload)))
    throw new Error('Slack install state signature is invalid.')

  const data = JSON.parse(Base64.toString(payload)) as { expiresAt: number; redirectUri: string }
  if (Date.now() > data.expiresAt) throw new Error('Slack install state expired.')
  return data
}

async function signOAuthState(env: Pick<Env, 'SECRET_KEY'>, payload: string) {
  if (!env.SECRET_KEY) throw new Error('SECRET_KEY is not configured.')

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SECRET_KEY),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return Hex.fromBytes(new Uint8Array(digest))
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let result = 0
  for (let i = 0; i < left.length; i += 1) result |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return result === 0
}
