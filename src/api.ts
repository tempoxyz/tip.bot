import { Hono } from 'hono'

import { createClient } from '#db/client.ts'
import { encryptSecret } from '#/lib/crypto.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { handleRelay, type RelayEnv } from '#/lib/relay.ts'
import {
  ensureWorkspace,
  exchangeSlackOAuthCode,
  getSlackAppOrigin,
  verifySlackOAuthState,
} from '#/lib/slack.ts'
import { handleSlackCommandRequest, handleSlackEventRequest } from '#/lib/slackHandlers.ts'

export const api = new Hono<{ Bindings: Env }>()

api
  .get('/api/relay', async (c) => {
    return handleRelay(c.req.raw, c.env as RelayEnv)
  })
  .get('/api/relay/:chainId', async (c) => {
    return handleRelay(c.req.raw, c.env as RelayEnv)
  })
  .post('/api/relay', async (c) => {
    return handleRelay(c.req.raw, c.env as RelayEnv)
  })
  .post('/api/relay/:chainId', async (c) => {
    return handleRelay(c.req.raw, c.env as RelayEnv)
  })
  .post('/api/slack/commands', async (c) => {
    let ctx: Pick<ExecutionContext, 'waitUntil'> | undefined
    try {
      ctx = c.executionCtx
    } catch {}
    return handleSlackCommandRequest(c.env, c.req.raw, ctx)
  })
  .post('/api/slack/events', (c) => handleSlackEventRequest(c.env, c.req.raw))
  .get('/api/slack/oauth/callback', async (c) => {
    try {
      const url = new URL(c.req.url)
      const error = url.searchParams.get('error')
      if (error) throw new Error(`Slack install failed: ${error}`)

      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code || !state) throw new Error('Slack install callback is missing code or state.')

      const expectedRedirectUri = `${getSlackAppOrigin(c.req.raw, c.env)}/api/slack/oauth/callback`
      const stateData = await verifySlackOAuthState(c.env, state)
      if (stateData.redirectUri !== expectedRedirectUri)
        throw new Error('Slack install callback redirect URI does not match state.')

      const oauth = await exchangeSlackOAuthCode(c.env, code, expectedRedirectUri)
      if (!oauth.ok) throw new Error(oauth.error ?? 'Slack OAuth token exchange failed.')
      if (!oauth.access_token) throw new Error('Slack OAuth response did not include a bot token.')
      if (!oauth.team?.id) throw new Error('Slack OAuth response did not include a team ID.')
      if (!c.env.ACCESS_KEY_ENCRYPTION_SECRET)
        throw new Error('ACCESS_KEY_ENCRYPTION_SECRET is not configured.')

      const teamId = oauth.team.id
      const teamName = oauth.team.name ?? null
      const workspace = await ensureWorkspace(c.env, teamId)
      const now = new Date().toISOString()
      const botTokenCiphertext = await encryptSecret(
        oauth.access_token,
        c.env.ACCESS_KEY_ENCRYPTION_SECRET,
      )

      await createClient(c.env.DB)
        .updateTable('workspace')
        .set({ name: teamName, updated_at: now })
        .where('id', '=', workspace.id)
        .execute()
      await createClient(c.env.DB)
        .insertInto('slack_installation')
        .values({
          bot_token_ciphertext: botTokenCiphertext,
          bot_user_id: oauth.bot_user_id ?? null,
          created_at: now,
          enterprise_id: oauth.enterprise?.id ?? null,
          id: Nanoid.generate(),
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

      return Response.redirect(
        `${url.origin}/?slack=installed&team=${encodeURIComponent(teamName ?? teamId)}`,
        302,
      )
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'Request failed.', {
        status: 400,
      })
    }
  })
