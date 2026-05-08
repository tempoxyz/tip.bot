import { Handler } from 'accounts/server'
import { Hono } from 'hono'
import { privateKeyToAccount } from 'viem/accounts'

import { encryptSecret, hashValue } from '#/lib/crypto.ts'
import { createDb } from '#/lib/db.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { completeSlackInstall, createSlackInstallUrl } from '#/lib/slack.ts'
import { handleSlackCommandRequest, handleSlackEventRequest } from '#/lib/slackHandlers.ts'
import { getTempoChain, pathUsd } from '#/lib/tempo.ts'

type RelayEnv = Env & {
  FEE_PAYER_PRIVATE_KEY?: `0x${string}`
}

export const api = new Hono<{ Bindings: Env }>().basePath('/api')

api
  .post('/connect/complete', async (c) => {
    if (!c.env.ACCESS_KEY_ENCRYPTION_SECRET)
      return new Response('ACCESS_KEY_ENCRYPTION_SECRET is not configured.', { status: 500 })

    const json = (await c.req.json()) as {
      accessKeyAddress: string
      accessKeyAuthorization: unknown
      accessKeyExpiresAt: string
      accessKeyPrivateKey: string
      tempoAddress: string
      token: string
    }
    const token = await createDb(c.env.DB)
      .selectFrom('connect_token')
      .selectAll()
      .where('token_hash', '=', await hashValue(json.token))
      .executeTakeFirst()
    if (!token || token.used_at) return new Response('Connect token is invalid.', { status: 400 })
    if (new Date(token.expires_at).getTime() <= Date.now())
      return new Response('Connect token expired. Run /tip connect again.', { status: 400 })

    const existing = await createDb(c.env.DB)
      .selectFrom('account')
      .select('id')
      .where('workspace_id', '=', token.workspace_id)
      .where('platform', '=', 'slack')
      .where('platform_account_id', '=', token.platform_account_id)
      .executeTakeFirst()
    const accountId = existing?.id ?? Nanoid.generate()
    const encrypted = await encryptSecret(
      json.accessKeyPrivateKey,
      c.env.ACCESS_KEY_ENCRYPTION_SECRET,
    )
    const now = new Date().toISOString()

    await createDb(c.env.DB)
      .insertInto('account')
      .values({
        access_key_address: json.accessKeyAddress,
        access_key_authorization: JSON.stringify(json.accessKeyAuthorization),
        access_key_ciphertext: encrypted,
        access_key_expires_at: json.accessKeyExpiresAt,
        created_at: now,
        id: accountId,
        platform: 'slack',
        platform_account_id: token.platform_account_id,
        tempo_address: json.tempoAddress.toLowerCase(),
        updated_at: now,
        workspace_id: token.workspace_id,
      })
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'platform', 'platform_account_id']).doUpdateSet({
          access_key_address: json.accessKeyAddress,
          access_key_authorization: JSON.stringify(json.accessKeyAuthorization),
          access_key_ciphertext: encrypted,
          access_key_expires_at: json.accessKeyExpiresAt,
          tempo_address: json.tempoAddress.toLowerCase(),
          updated_at: now,
        }),
      )
      .execute()
    await createDb(c.env.DB)
      .updateTable('connect_token')
      .set({ used_at: now })
      .where('id', '=', token.id)
      .execute()

    return Response.json({ ok: true })
  })
  .get('/relay', async (c) => {
    return handleRelay(c.req.raw, c.env as RelayEnv)
  })
  .get('/relay/:chainId', async (c) => {
    return handleRelay(c.req.raw, c.env as RelayEnv)
  })
  .post('/relay', async (c) => {
    return handleRelay(c.req.raw, c.env as RelayEnv)
  })
  .post('/relay/:chainId', async (c) => {
    return handleRelay(c.req.raw, c.env as RelayEnv)
  })
  .post('/slack/commands', async (c) => {
    return await handleSlackCommandRequest(c.env, c.req.raw)
  })
  .post('/slack/events', async (c) => {
    return await handleSlackEventRequest(c.env, c.req.raw)
  })
  .get('/slack/install', async (c) => {
    try {
      return Response.redirect(await createSlackInstallUrl(c.req.raw, c.env), 302)
    } catch (error) {
      return new Response(getErrorMessage(error), { status: 500 })
    }
  })
  .get('/slack/oauth/callback', async (c) => {
    try {
      const install = await completeSlackInstall(c.req.raw, c.env)
      return Response.redirect(
        `${new URL(c.req.url).origin}/?slack=installed&team=${encodeURIComponent(install.teamName)}`,
        302,
      )
    } catch (error) {
      return new Response(getErrorMessage(error), { status: 400 })
    }
  })

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return 'Request failed.'
}

function handleRelay(request: Request, env: RelayEnv) {
  if (!env.FEE_PAYER_PRIVATE_KEY)
    return new Response('Fee payer is not configured.', { status: 500 })

  return Handler.relay({
    chains: [getTempoChain(env.TEMPO_CHAIN)],
    feePayer: {
      account: privateKeyToAccount(env.FEE_PAYER_PRIVATE_KEY) as never,
      name: 'Tip',
      validate: async (transaction: Record<string, unknown>) =>
        await shouldSponsor(env, transaction),
    },
    path: '/api/relay',
  } as never).fetch(request)
}

async function shouldSponsor(env: RelayEnv, transaction: Record<string, unknown>) {
  const call = Array.isArray(transaction.calls)
    ? (transaction.calls[0] as Call | undefined)
    : undefined
  const parsed = parseTransferCall(call)
  const sender = typeof transaction.from === 'string' ? transaction.from.toLowerCase() : null
  if (!sender || !parsed) return false

  const attempt = await createDb(env.DB)
    .selectFrom('tip_attempt')
    .selectAll()
    .where('sender_address', '=', sender)
    .where('recipient_address', '=', parsed.to)
    .where('amount', '=', parsed.amount)
    .where('token_address', '=', pathUsd)
    .where('expires_at', '>', new Date().toISOString())
    .executeTakeFirst()

  return Boolean(attempt)
}

type Call = {
  data?: string
  to?: string
}

function parseTransferCall(call: Call | undefined) {
  if (!call?.data || call.to?.toLowerCase() !== pathUsd.toLowerCase()) return null
  if (!call.data.startsWith('0xa9059cbb')) return null

  const to = `0x${call.data.slice(34, 74)}`.toLowerCase()
  const amount = BigInt(`0x${call.data.slice(74, 138)}`).toString()
  return { amount, to }
}
