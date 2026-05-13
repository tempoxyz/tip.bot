import { Hono } from 'hono'
import { Address, Base64, Hex } from 'ox'
import { z } from 'zod'
import * as Chat from '#/chat.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as hono from '#/lib/hono.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Slack from '#/lib/slack.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Tip from '#/lib/tip.ts'
import * as DB from '#db/client.ts'

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
  .get('/api/account/link/:token', async (c) => {
    const link = await c.var.db
      .selectFrom('account_link_token')
      .innerJoin('member', 'member.id', 'account_link_token.member_id')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .select([
        'account_link_token.access_key_address',
        'account_link_token.access_key_ciphertext',
        'account_link_token.access_key_expires_at',
        'account_link_token.access_key_public_key',
        'account_link_token.expires_at',
        'account_link_token.id',
        'account_link_token.member_id',
        'account_link_token.used_at',
        'workspace.chain_id',
        'workspace.default_token_address',
        'workspace.id as workspace_id',
      ])
      .where(
        'account_link_token.token_hash',
        '=',
        await AccountLink.hashToken(c.env, c.req.param('token')),
      )
      .executeTakeFirst()
    if (!link || link.used_at || Date.now() > new Date(link.expires_at).getTime())
      return c.json(
        {
          code: 'invalid_account_link' as const,
          message: 'This connection link is invalid or expired.',
          ok: false as const,
        },
        404,
      )

    return c.json({
      accessKeyAddress: link.access_key_address,
      accessKeyExpiry: link.access_key_expires_at,
      accessKeyLimit: '10',
      accessKeyLimitPeriodSeconds: 24 * 60 * 60, // 1 day
      accessKeyPublicKey: link.access_key_public_key as `0x${string}`,
      chainId: link.chain_id,
      chainName: Tempo.getChainName(link.chain_id),
      expiresAt: link.expires_at,
      ok: true as const,
      tokenAddress: Address.checksum(link.default_token_address ?? Tempo.pathUsdAddress),
    })
  })
  .post(
    '/api/account/link/:token',
    hono.validator(
      'json',
      z.object({
        address: z.string().min(1),
        disconnectExistingAccount: z.boolean().optional(),
        keyAuthorization: z.unknown(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json')
      const link = await c.var.db
        .selectFrom('account_link_token')
        .innerJoin('member', 'member.id', 'account_link_token.member_id')
        .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
        .select([
          'account_link_token.access_key_address',
          'account_link_token.access_key_ciphertext',
          'account_link_token.access_key_expires_at',
          'account_link_token.access_key_public_key',
          'account_link_token.expires_at',
          'account_link_token.id',
          'account_link_token.member_id',
          'account_link_token.provider_channel_id',
          'account_link_token.used_at',
          'member.provider_user_id as member_provider_user_id',
          'workspace.chain_id',
          'workspace.default_token_address',
          'workspace.id as workspace_id',
          'workspace.provider_id',
        ])
        .where(
          'account_link_token.token_hash',
          '=',
          await AccountLink.hashToken(c.env, c.req.param('token')),
        )
        .executeTakeFirst()
      if (!link || link.used_at || Date.now() > new Date(link.expires_at).getTime())
        return c.json(
          {
            code: 'invalid_account_link' as const,
            message: 'This connection link is invalid or expired.',
            ok: false as const,
          },
          404,
        )

      try {
        const verified = await AccountLink.verifyKeyAuthorization({
          accessKeyAddress: link.access_key_address,
          chainId: link.chain_id,
          env: c.env,
          expiresAt: link.access_key_expires_at,
          keyAuthorization: body.keyAuthorization,
          rootAddress: body.address,
          tokenAddress: Address.checksum(link.default_token_address ?? Tempo.pathUsdAddress),
        })
        const now = new Date().toISOString()
        const existingAccount = await c.var.db
          .selectFrom('account')
          .selectAll()
          .where('address', '=', verified.rootAddress)
          .executeTakeFirst()
        const account = await (async () => {
          if (existingAccount) {
            await c.var.db
              .updateTable('account')
              .set({ updated_at: now })
              .where('id', '=', existingAccount.id)
              .execute()
            return existingAccount
          }

          const id = Nanoid.generate()
          await c.var.db
            .insertInto('account')
            .values({
              address: verified.rootAddress,
              created_at: now,
              id,
              updated_at: now,
            })
            .execute()
          return await c.var.db
            .selectFrom('account')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        })()

        const duplicate = await c.var.db
          .selectFrom('member')
          .select(['id'])
          .where('workspace_id', '=', link.workspace_id)
          .where('account_id', '=', account.id)
          .where('id', '!=', link.member_id)
          .executeTakeFirst()
        if (duplicate && !body.disconnectExistingAccount)
          return c.json(
            {
              code: 'account_already_connected' as const,
              message:
                'This wallet is already connected to another Slack account in this workspace.',
            },
            409,
          )
        if (duplicate && body.disconnectExistingAccount)
          await c.var.db
            .updateTable('member')
            .set({ account_id: null, updated_at: now })
            .where('workspace_id', '=', link.workspace_id)
            .where('account_id', '=', account.id)
            .where('id', '!=', link.member_id)
            .execute()

        await c.var.db
          .deleteFrom('access_key')
          .where('account_id', '=', account.id)
          .where('chain_id', '=', link.chain_id)
          .execute()
        await c.var.db
          .insertInto('access_key')
          .values({
            account_id: account.id,
            address: link.access_key_address,
            authorization: verified.serialized,
            chain_id: link.chain_id,
            ciphertext: link.access_key_ciphertext,
            created_at: now,
            expires_at: link.access_key_expires_at,
            id: Nanoid.generate(),
            revoked_at: null,
            updated_at: now,
          })
          .execute()
        await c.var.db
          .updateTable('member')
          .set({ account_id: account.id, updated_at: now })
          .where('id', '=', link.member_id)
          .execute()
        await c.var.db
          .updateTable('account_link_token')
          .set({
            access_key_authorization: verified.serialized,
            account_id: account.id,
            used_at: now,
          })
          .where('id', '=', link.id)
          .execute()

        if (link.provider_channel_id)
          c.executionCtx.waitUntil(
            (async () => {
              await Chat.getChat().initialize()
              const installation = await Chat.getSlack().getInstallation(link.provider_id)
              if (!installation) return

              await Chat.getSlack().withBotToken(installation.botToken, () =>
                Chat.getChat()
                  .channel(
                    link.provider_channel_id!.startsWith('slack:')
                      ? link.provider_channel_id!
                      : `slack:${link.provider_channel_id!}`,
                  )
                  .postEphemeral(link.member_provider_user_id, 'Connected', {
                    fallbackToDM: false,
                  }),
              )
            })().catch((error) => {
              console.error('Failed to notify Slack member after wallet connection:', error)
            }),
          )

        return c.json({ ok: true as const })
      } catch (error) {
        return c.json(
          {
            code: 'invalid_key_authorization' as const,
            message: error instanceof Error ? error.message : 'Invalid key authorization.',
          },
          400,
        )
      }
    },
  )
  .post('/api/chat/slack', async (c) => {
    const request = c.req.raw
    const body = await request.text()
    const params = request.headers
      .get('content-type')
      ?.includes('application/x-www-form-urlencoded')
      ? new URLSearchParams(body)
      : null
    if (params?.has('command') && !params.has('payload')) {
      if (
        !(await Slack.verifySlackSignature({
          body,
          signature: request.headers.get('x-slack-signature'),
          signingSecret: c.env.SLACK_SIGNING_SECRET,
          timestamp: request.headers.get('x-slack-request-timestamp'),
        }))
      )
        return new Response('Invalid signature', { status: 401 })

      const tasks: Promise<unknown>[] = []
      const task = (async () => {
        await Chat.getChat().webhooks.slack(
          new Request(request.url, {
            body,
            headers: request.headers,
            method: request.method,
          }),
          {
            waitUntil(promise) {
              tasks.push(promise)
              try {
                c.executionCtx.waitUntil(promise)
              } catch {}
            },
          },
        )
        await Promise.all(tasks)
      })()
      c.executionCtx.waitUntil(task)
      return new Response('', { status: 200 })
    }

    return await Chat.getChat().webhooks.slack(
      new Request(request.url, {
        body,
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

        await Chat.getChat().initialize()
        const result = await Chat.getSlack().handleOAuthCallback(c.req.raw, { redirectUri })
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
  .get('/api/health', async (c) => {
    await c.env.DB.prepare('SELECT 1').first()
    return c.json({ ok: true })
  })
  .post(
    '/api/relay/:chainId{[0-9]+}',
    hono.validator('param', z.object({ chainId: z.coerce.number().int() })),
    async (c) => {
      const params = c.req.valid('param')
      return await Tip.handleRelayRequest(c.env, c.req.raw, params.chainId)
    },
  )
