import { Hono } from 'hono'
import * as DB from '#db/client.ts'
import * as Chat from '#/chat.ts'
import { ensureWorkspace } from '#/lib/tips'

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
    const url = new URL('/oauth/v2/authorize', c.env.SLACK_API_URL)
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
    url.searchParams.set('state', await Chat.createOAuthState(c.env, redirectUri))
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
      const stateData = await Chat.verifyOAuthState(c.env, state)
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
