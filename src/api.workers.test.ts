import { WebClient } from '@slack/web-api'
import { env } from 'cloudflare:workers'
import { testClient } from 'hono/testing'
import { Address, Secp256k1 } from 'ox'
import { Account } from 'viem/tempo'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '#/api.ts'
import * as Chat from '#/chat.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as AccessKey from '#/lib/accessKey.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { createSlackHeaders } from '#/lib/slack.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as DB from '#db/client.ts'
import * as Schema from '#db/schemas.gen.ts'
import * as Constants from '#test/constants.ts'
import * as Factory from '#test/factory.ts'

let waitUntil: Promise<unknown>[] = []
const db = DB.create(env.DB)
const factory = Factory.create(db)
const executionCtx = {
  passThroughOnException: vi.fn(),
  props: {},
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    waitUntil.push(promise)
  }),
}
const client = testClient(api, env, executionCtx)
const slack = new WebClient(Constants.slack.botToken, { slackApiUrl: env.SLACK_API_URL })

beforeEach(async () => {
  waitUntil = []
  executionCtx.passThroughOnException.mockClear()
  executionCtx.waitUntil.mockClear()
  vi.restoreAllMocks()
  await db.deleteFrom('workspace').execute()
})

test('/api/health returns ok', async () => {
  const response = await client.api.health.$get()

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ ok: true })
})

describe('/api/chat/slack', () => {
  test('Slack URL verification reaches the Worker API route', async () => {
    const body = JSON.stringify({
      challenge: 'slack-challenge',
      event_id: 'Ev000000001',
      team_id: Constants.slack.teamId,
      type: 'url_verification',
    })

    const response = await client.api.chat.slack.$post(
      {},
      {
        headers: {
          ...(await createSlackHeaders(body, env.SLACK_SIGNING_SECRET)),
          'content-type': 'application/json',
        },
        init: { body },
      },
    )
    await Promise.all(waitUntil)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ challenge: 'slack-challenge' })
  })

  test('invalid Slack signatures are rejected by the Worker API route', async () => {
    const response = await client.api.chat.slack.$post(
      {},
      {
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
          'x-slack-signature': 'v0=bad',
        },
        init: { body: '{}' },
      },
    )
    await Promise.all(waitUntil)

    expect(response.status).toBe(401)
  })
})

describe('/api/chat/slack/install', () => {
  test('redirects to Slack OAuth', async () => {
    const response = await client.api.chat.slack.install.$get()
    const location = response.headers.get('location')
    if (!location) throw new Error('Expected Slack install redirect location.')

    const url = new URL(location)
    expect(response.status).toBe(302)
    expect(url.origin).toBe(env.SLACK_API_URL.replace(/\/api$/, ''))
    expect(url.pathname).toBe('/oauth/v2/authorize')
    expect(url.searchParams.get('client_id')).toBe(env.SLACK_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(
      `https://${env.HOST}/api/chat/slack/oauth/callback`,
    )
    expect(url.searchParams.get('scope')).toBe('chat:write,commands,users:read')
    expect(url.searchParams.get('state')).toMatch(/^[^.]+\.[^.]+$/)
  })
})

describe('/api/account/link/:token', () => {
  test('returns pending link metadata', async () => {
    const pending = await createPendingAccountLink()

    const response = await client.api.account.link[':token'].$get({
      param: { token: pending.token },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      accessKeyAddress: pending.accessKey.address,
      accessKeyPublicKey: pending.accessKey.publicKey,
      ok: true,
      tokenAddress: Tempo.pathUsdAddress,
    })
  })

  test('rejects invalid links generically', async () => {
    const response = await client.api.account.link[':token'].$get({ param: { token: 'missing' } })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      message: 'This connection link is invalid or expired.',
      ok: false,
    })
  })

  test('completes wallet connection and stores access key', async () => {
    const pending = await createPendingAccountLink()
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const keyAuthorization = await signKeyAuthorization(root, pending)

    const response = await client.api.account.link[':token'].$post({
      json: { address: root.address, keyAuthorization },
      param: { token: pending.token },
    })
    const member = await db
      .selectFrom('member')
      .selectAll()
      .where('id', '=', pending.member.id)
      .executeTakeFirstOrThrow()
    const account = await db
      .selectFrom('account')
      .selectAll()
      .where('id', '=', member.account_id)
      .executeTakeFirstOrThrow()
    const accessKey = await db
      .selectFrom('access_key')
      .selectAll()
      .where('account_id', '=', account.id)
      .executeTakeFirstOrThrow()
    const link = await db
      .selectFrom('account_link_token')
      .selectAll()
      .where('id', '=', pending.link.id)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(member).toEqual(expect.schemaMatching(Schema.member))
    expect(account).toEqual(expect.schemaMatching(Schema.account))
    expect(accessKey).toEqual(expect.schemaMatching(Schema.access_key))
    expect(link).toEqual(expect.schemaMatching(Schema.account_link_token))
    expect(account.address).toBe(root.address)
    expect(accessKey.address).toBe(pending.accessKey.address)
    expect(accessKey.ciphertext).toBe(pending.link.access_key_ciphertext)
    expect(accessKey.expires_at).toBe(pending.link.access_key_expires_at)
    expect(link.account_id).toBe(account.id)
    expect(link.access_key_authorization).toEqual(JSON.stringify(keyAuthorization))
    expect(link.used_at).toEqual(expect.any(String))
  })

  test('notifies Slack member when wallet connection completes', async () => {
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(Constants.slack.teamId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })
    const channel = await slack.conversations.create({ name: `connect${Date.now()}` })
    const channelId = channel.channel?.id
    if (!channelId) throw new Error('Expected Slack test channel.')
    const pending = await createPendingAccountLink({
      providerChannelId: channelId,
      providerId: Constants.slack.teamId,
      providerUserId: Constants.slack.adminUserId,
    })
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const keyAuthorization = await signKeyAuthorization(root, pending)

    const response = await client.api.account.link[':token'].$post({
      json: { address: root.address, keyAuthorization },
      param: { token: pending.token },
    })
    await Promise.all(waitUntil)

    expect(response.status).toBe(200)
    await expectSlackMessage(channelId, 'Connected to Tipbot')
    await expectSlackMessage(channelId, 'Use `/tip disconnect` to disconnect.')
  })

  test('rejects token reuse', async () => {
    const pending = await createPendingAccountLink()
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const keyAuthorization = await signKeyAuthorization(root, pending)
    const json = { address: root.address, keyAuthorization }

    const first = await client.api.account.link[':token'].$post({
      json,
      param: { token: pending.token },
    })
    const second = await client.api.account.link[':token'].$post({
      json,
      param: { token: pending.token },
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(404)
  })

  test('rejects mismatched access key authorization', async () => {
    const pending = await createPendingAccountLink()
    const other = await createPendingAccountLink({ providerUserId: 'UOTHER' })
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const keyAuthorization = await signKeyAuthorization(root, other)

    const response = await client.api.account.link[':token'].$post({
      json: { address: root.address, keyAuthorization },
      param: { token: pending.token },
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_key_authorization' })
  })

  test('rejects same wallet linked to another member in same workspace', async () => {
    const pending = await createPendingAccountLink()
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const account = await factory.account.insert({ address: root.address })
    await factory.member.insert({
      account_id: account.id,
      provider_user_id: 'UOTHER',
      workspace_id: pending.workspace.id,
    })
    const keyAuthorization = await signKeyAuthorization(root, pending)

    const response = await client.api.account.link[':token'].$post({
      json: { address: root.address, keyAuthorization },
      param: { token: pending.token },
    })

    expect(response.status).toBe(409)
  })

  test('disconnects same wallet from another member when requested', async () => {
    const pending = await createPendingAccountLink()
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const account = await factory.account.insert({ address: root.address })
    const duplicate = await factory.member.insert({
      account_id: account.id,
      provider_user_id: 'UOTHER',
      workspace_id: pending.workspace.id,
    })
    const oldAccessKey = await factory.access_key.insert({ account_id: account.id })
    const keyAuthorization = await signKeyAuthorization(root, pending)

    const response = await client.api.account.link[':token'].$post({
      json: { address: root.address, disconnectExistingAccount: true, keyAuthorization },
      param: { token: pending.token },
    })
    const currentMember = await db
      .selectFrom('member')
      .selectAll()
      .where('id', '=', pending.member.id)
      .executeTakeFirstOrThrow()
    const duplicateMember = await db
      .selectFrom('member')
      .selectAll()
      .where('id', '=', duplicate.id)
      .executeTakeFirstOrThrow()
    const accessKeys = await db
      .selectFrom('access_key')
      .selectAll()
      .where('account_id', '=', account.id)
      .execute()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(currentMember.account_id).toBe(account.id)
    expect(duplicateMember.account_id).toBe(null)
    expect(accessKeys).toHaveLength(1)
    expect(accessKeys[0]?.address).toBe(pending.accessKey.address)
    expect(accessKeys[0]?.id).not.toBe(oldAccessKey.id)
  })
})

describe('/api/chat/slack/oauth/callback', () => {
  test('rejects missing code or state', async () => {
    const response = await client.api.chat.slack.oauth.callback.$get({ query: {} as never })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'validation_error',
      message: 'Validation failed',
    })
  })

  test('rejects Slack error', async () => {
    const response = await client.api.chat.slack.oauth.callback.$get({
      query: { error: 'access_denied' },
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 'slack_install_failed',
      message: 'Slack install failed: access_denied',
    })
  })

  test('rejects tampered state', async () => {
    const installResponse = await client.api.chat.slack.install.$get()
    const location = installResponse.headers.get('location')
    if (!location) throw new Error('Expected Slack install redirect location.')

    const state = new URL(location).searchParams.get('state')
    if (!state) throw new Error('Expected Slack install state.')

    const response = await client.api.chat.slack.oauth.callback.$get({
      query: { code: 'oauth-code', state: `${state}tampered` },
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 'invalid_slack_install_state',
      message: 'Slack install state signature is invalid.',
    })
  })

  test('stores workspace and redirects', async () => {
    const installResponse = await client.api.chat.slack.install.$get()
    const location = installResponse.headers.get('location')
    if (!location) throw new Error('Expected Slack install redirect location.')

    const authorizeUrl = new URL(location)
    const authorizeResponse = await fetch(`${authorizeUrl.origin}/oauth/v2/authorize/callback`, {
      body: new URLSearchParams({
        client_id: authorizeUrl.searchParams.get('client_id') ?? '',
        redirect_uri: authorizeUrl.searchParams.get('redirect_uri') ?? '',
        scope: authorizeUrl.searchParams.get('scope') ?? '',
        state: authorizeUrl.searchParams.get('state') ?? '',
        user_id: Constants.slack.adminUserId,
      }),
      method: 'POST',
      redirect: 'manual',
    })
    const callbackLocation = authorizeResponse.headers.get('location')
    if (!callbackLocation) throw new Error('Expected Slack OAuth callback redirect location.')
    const callbackUrl = new URL(callbackLocation)

    const response = await client.api.chat.slack.oauth.callback.$get({
      query: {
        code: callbackUrl.searchParams.get('code') ?? '',
        state: callbackUrl.searchParams.get('state') ?? '',
      },
    })
    const workspace = await db
      .selectFrom('workspace')
      .select(['name', 'provider', 'provider_id'])
      .where('provider_id', '=', Constants.slack.teamId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('http://localhost/?slack=installed&team=Emulate')
    expect(workspace).toEqual({
      name: 'Emulate',
      provider: 'slack',
      provider_id: Constants.slack.teamId,
    })
  })

  test('updates existing workspace and redirects', async () => {
    await factory.workspace.insert({ name: 'Old Name', provider_id: Constants.slack.teamId })
    const installResponse = await client.api.chat.slack.install.$get()
    const location = installResponse.headers.get('location')
    if (!location) throw new Error('Expected Slack install redirect location.')

    const authorizeUrl = new URL(location)
    const authorizeResponse = await fetch(`${authorizeUrl.origin}/oauth/v2/authorize/callback`, {
      body: new URLSearchParams({
        client_id: authorizeUrl.searchParams.get('client_id') ?? '',
        redirect_uri: authorizeUrl.searchParams.get('redirect_uri') ?? '',
        scope: authorizeUrl.searchParams.get('scope') ?? '',
        state: authorizeUrl.searchParams.get('state') ?? '',
        user_id: Constants.slack.adminUserId,
      }),
      method: 'POST',
      redirect: 'manual',
    })
    const callbackLocation = authorizeResponse.headers.get('location')
    if (!callbackLocation) throw new Error('Expected Slack OAuth callback redirect location.')
    const callbackUrl = new URL(callbackLocation)

    const response = await client.api.chat.slack.oauth.callback.$get({
      query: {
        code: callbackUrl.searchParams.get('code') ?? '',
        state: callbackUrl.searchParams.get('state') ?? '',
      },
    })
    const workspaces = await db
      .selectFrom('workspace')
      .select(['name', 'provider', 'provider_id'])
      .where('provider_id', '=', Constants.slack.teamId)
      .execute()

    expect(response.status).toBe(302)
    expect(workspaces).toEqual([
      { name: 'Emulate', provider: 'slack', provider_id: Constants.slack.teamId },
    ])
  })
})

async function createPendingAccountLink(
  options: {
    providerChannelId?: string
    providerId?: string
    providerUserId?: string
    workspaceId?: string
  } = {},
) {
  const workspace = options.workspaceId
    ? await db
        .selectFrom('workspace')
        .selectAll()
        .where('id', '=', options.workspaceId)
        .executeTakeFirstOrThrow()
    : await factory.workspace.insert({ provider_id: options.providerId ?? `T${Nanoid.generate()}` })
  const member = await factory.member.insert({
    provider_user_id: options.providerUserId ?? `U${Nanoid.generate()}`,
    workspace_id: workspace.id,
  })
  const token = Nanoid.generate()
  const now = Date.now()
  const accessKey = AccessKey.generate()
  const link = await factory.account_link_token.insert({
    access_key_address: accessKey.address,
    access_key_ciphertext: await AccessKey.encrypt(env, accessKey.privateKey),
    access_key_expires_at: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    access_key_public_key: accessKey.publicKey,
    expires_at: new Date(now + 10 * 60 * 1000).toISOString(), // 10 minutes
    member_id: member.id,
    provider_channel_id: options.providerChannelId ?? null,
    token_hash: await AccountLink.hashToken(env, token),
  })
  return { accessKey, link, member, token, workspace }
}

async function expectSlackMessage(channelId: string, text: string) {
  const history = await slack.conversations.history({ channel: channelId })

  expect(history.ok).toBe(true)
  expect(history.messages?.some((message) => message.text?.includes(text))).toBe(true)
}

async function signKeyAuthorization(
  account: ReturnType<typeof Account.fromSecp256k1>,
  pending: Awaited<ReturnType<typeof createPendingAccountLink>>,
) {
  return await AccountLink.signKeyAuthorization(account, {
    accessKeyAddress: pending.accessKey.address,
    expiresAt: pending.link.access_key_expires_at,
    tokenAddress: Address.checksum(pending.workspace.default_token_address ?? Tempo.pathUsdAddress),
  })
}
