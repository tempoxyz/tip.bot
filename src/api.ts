import { Hono } from 'hono'
import { Base64, Hex } from 'ox'
import { z } from 'zod'
import * as DB from '#db/client.ts'
import * as Chat from '#/chat.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as hono from '#/lib/hono.ts'

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
    return await Chat.bot.webhooks.slack(
      new Request(request.url, {
        body: await request.text(),
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
    const payload = Base64.fromString(
      JSON.stringify({ expiresAt: Date.now() + 10 * 60 * 1000, redirectUri }), // 10 minutes
      { pad: false, url: true },
    )

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(c.env.SECRET_KEY),
      { hash: 'SHA-256', name: 'HMAC' },
      false,
      ['sign'],
    )
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
    const url = new URL('/oauth/v2/authorize', c.env.SLACK_API_URL)
    url.searchParams.set('client_id', c.env.SLACK_CLIENT_ID)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', ['chat:write', 'commands', 'users:read'].join(','))
    url.searchParams.set('state', `${payload}.${Hex.fromBytes(new Uint8Array(digest))}`)
    return Response.redirect(url.toString(), 302)
  })
  .get(
    '/api/chat/slack/oauth/callback',
    hono.validator(
      'query',
      z.union([
        z.object({ error: z.string().min(1) }).catchall(z.unknown()),
        z.object({ code: z.string().min(1), state: z.string().min(1) }).catchall(z.unknown()),
      ]),
    ),
    async (c) => {
      try {
        const query = c.req.valid('query')
        if ('error' in query)
          return c.json(
            {
              code: 'slack_install_failed' as const,
              message: `Slack install failed: ${String(query.error)}`,
            },
            400,
          )

        const [payload, signature] = query.state.split('.')
        if (!payload || !signature)
          return c.json(
            {
              code: 'invalid_slack_install_state' as const,
              message: 'Slack install state is invalid.',
            },
            400,
          )

        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(c.env.SECRET_KEY),
          { hash: 'SHA-256', name: 'HMAC' },
          false,
          ['sign'],
        )
        const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
        const expectedSignature = Hex.fromBytes(new Uint8Array(digest))
        if (signature.length !== expectedSignature.length)
          return c.json(
            {
              code: 'invalid_slack_install_state' as const,
              message: 'Slack install state signature is invalid.',
            },
            400,
          )

        let signatureDifference = 0
        for (let i = 0; i < signature.length; i += 1)
          signatureDifference |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i)
        if (signatureDifference !== 0)
          return c.json(
            {
              code: 'invalid_slack_install_state' as const,
              message: 'Slack install state signature is invalid.',
            },
            400,
          )

        const stateData = z.parse(
          z.object({ expiresAt: z.number(), redirectUri: z.string() }),
          JSON.parse(Base64.toString(payload)),
        )
        if (Date.now() > stateData.expiresAt)
          return c.json(
            {
              code: 'expired_slack_install_state' as const,
              message: 'Slack install state expired.',
            },
            400,
          )

        const redirectUri = `https://${c.env.HOST}/api/chat/slack/oauth/callback`
        if (stateData.redirectUri !== redirectUri)
          return c.json(
            {
              code: 'invalid_slack_install_state' as const,
              message: 'Slack install callback redirect URI does not match state.',
            },
            400,
          )

        await Chat.bot.initialize()
        const result = await Chat.slack.handleOAuthCallback(c.req.raw, { redirectUri })
        const workspace = await c.var.db
          .selectFrom('workspace')
          .selectAll()
          .where('provider', '=', 'slack')
          .where('provider_id', '=', result.teamId)
          .executeTakeFirst()
        const now = new Date().toISOString()
        if (workspace)
          await c.var.db
            .updateTable('workspace')
            .set({ name: result.installation.teamName ?? null, updated_at: now })
            .where('id', '=', workspace.id)
            .execute()
        else
          await c.var.db
            .insertInto('workspace')
            .values({
              created_at: now,
              default_amount: 1000,
              id: Nanoid.generate(),
              name: result.installation.teamName ?? null,
              provider: 'slack',
              provider_id: result.teamId,
              updated_at: now,
            })
            .execute()

        const url = new URL(c.req.url)
        return Response.redirect(
          `${url.origin}/?slack=installed&team=${encodeURIComponent(result.installation.teamName ?? result.teamId)}`,
          302,
        )
      } catch (error) {
        return c.json(
          {
            code: 'slack_oauth_failed' as const,
            message: error instanceof Error ? error.message : 'Request failed.',
          },
          400,
        )
      }
    },
  )
