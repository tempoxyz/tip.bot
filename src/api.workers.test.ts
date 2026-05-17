import { Provider, dangerous_secp256k1 } from 'accounts'
import { WebClient } from '@slack/web-api'
import { env } from 'cloudflare:workers'
import { testClient } from 'hono/testing'
import { Address, Secp256k1 } from 'ox'
import { http, toHex } from 'viem'
import { Account } from 'viem/tempo'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '#/api.ts'
import * as Chat from '#/chat.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as AccessKey from '#/lib/accessKey.ts'
import * as Confirmation from '#/lib/confirmation.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { createSlackHeaders } from '#/lib/slack.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as DB from '#db/client.ts'
import * as Schema from '#db/schemas.gen.ts'
import * as Constants from '#test/constants.ts'
import * as Factory from '#test/factory.ts'

let apiChannelId = ''
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

beforeAll(async () => {
  const channel = await slack.conversations.create({ name: `api${Date.now()}` })
  apiChannelId = channel.channel?.id ?? ''
  if (!apiChannelId) throw new Error('Expected Slack API test channel.')
})

beforeEach(async () => {
  waitUntil = []
  executionCtx.passThroughOnException.mockClear()
  executionCtx.waitUntil.mockClear()
  vi.restoreAllMocks()
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
    expect(url.searchParams.get('scope')).toBe(
      'app_mentions:read,assistant:write,channels:history,channels:read,chat:write,commands,groups:history,groups:read,reactions:read,users:read',
    )
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
      tokenAddress: Tempo.addressLookup.pathUsd,
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
    expect(accessKey.expires_at).toBe(
      new Date(
        Math.floor(new Date(pending.link.access_key_expires_at).getTime() / 1000) * 1000,
      ).toISOString(),
    )
    expect(link.account_id).toBe(account.id)
    expect(link.access_key_authorization).toEqual(JSON.stringify(keyAuthorization))
    expect(link.used_at).toEqual(expect.any(String))
  })

  test('notifies Slack member when wallet connection completes', async () => {
    const providerId = `T${Nanoid.generate()}`
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(providerId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })
    const initialize = vi.spyOn(Chat.getChat(), 'initialize')
    const channel = await slack.conversations.create({ name: `connect${Date.now()}` })
    const channelId = channel.channel?.id
    if (!channelId) throw new Error('Expected Slack test channel.')
    const pending = await createPendingAccountLink({
      providerChannelId: channelId,
      providerId,
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
    expect(initialize).toHaveBeenCalled()
    await expectSlackMessage(channelId, 'Connected')
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

describe('/api/confirm/:token', () => {
  test('returns confirmation metadata', async () => {
    const confirmation = await createConfirmationToken()

    const response = await client.api.confirm[':token'].$get({
      param: { token: confirmation.token },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      accessKeyAddress: confirmation.accessKey.address,
      accessKeyPublicKey: confirmation.accessKey.publicKey,
      amount: '5',
      kind: 'onetime_payment',
      ok: true,
      tokenAddress: Tempo.addressLookup.pathUsd,
      tokenSymbol: 'PathUSD',
    })
  })

  test('resolves missing confirmation recipient label from Slack', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(env.SLACK_API_URL) && url.includes('/users.info'))
        return Promise.resolve(
          Response.json({
            ok: true,
            user: {
              id: Constants.slack.memberUserId,
              name: Constants.slack.memberUserName,
            },
          }),
        )
      return originalFetch(input, init)
    })
    const confirmation = await createConfirmationToken()
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(confirmation.payload.providerId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })

    const response = await client.api.confirm[':token'].$get({
      param: { token: confirmation.token },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      recipientProviderLabel: Constants.slack.memberUserName,
      recipientProviderUserId: Constants.slack.memberUserId,
    })
    fetchSpy.mockRestore()
  })

  test('rejects invalid confirmation links generically', async () => {
    const response = await client.api.confirm[':token'].$get({ param: { token: 'missing' } })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ ok: false })
  })

  test('confirms one-time payments', async () => {
    const confirmation = await createConfirmationToken({
      amount: 1,
      memo: `confirmed-${Nanoid.generate()}`,
    })
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(confirmation.payload.providerId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })
    const signedTransaction = await signConfirmationTransaction(confirmation)

    const response = await client.api.confirm[':token'].$post({
      json: { address: confirmation.senderRoot.address, signedTransaction },
      param: { token: confirmation.token },
    })
    await Promise.all(waitUntil)
    const tip = await db
      .selectFrom('tip')
      .selectAll()
      .where('idempotency_key', '=', confirmation.payload.idempotencyKey)
      .executeTakeFirstOrThrow()
    const accessKeys = await db
      .selectFrom('access_key')
      .selectAll()
      .where('account_id', '=', confirmation.senderAccount.id)
      .execute()
    const history = await slack.conversations.history({ channel: apiChannelId })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(tip.confirmed_at).toEqual(expect.any(String))
    expect(tip.transaction_hash).toEqual(expect.any(String))
    expect(accessKeys).toHaveLength(0)
    expect(
      history.messages?.some((message) => message.text?.includes(confirmation.payload.memo!)),
    ).toBe(true)
  }, 20_000) // 20 seconds

  test('posts confirmed mention payment receipts in the source thread and clears status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const parent = await slack.chat.postMessage({
      channel: apiChannelId,
      text: 'thread confirmation parent',
    })
    if (!parent.ts) throw new Error('Expected Slack parent message timestamp.')
    const confirmation = await createConfirmationToken({
      amount: 1,
      memo: `thread-${Nanoid.generate()}`,
      providerThreadId: parent.ts,
    })
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(confirmation.payload.providerId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })
    const signedTransaction = await signConfirmationTransaction(confirmation)

    const response = await client.api.confirm[':token'].$post({
      json: { address: confirmation.senderRoot.address, signedTransaction },
      param: { token: confirmation.token },
    })
    await Promise.all(waitUntil)
    const replies = await slack.conversations.replies({ channel: apiChannelId, ts: parent.ts })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(
      replies.messages?.some((message) => message.text?.includes(confirmation.payload.memo!)),
      JSON.stringify(replies.messages),
    ).toBe(true)
    await expectSlackAssistantStatusCall(fetchSpy, apiChannelId, parent.ts, '')
    fetchSpy.mockRestore()
  }, 20_000) // 20 seconds

  test('updates reaction tip aggregate after confirmed payment', async () => {
    const parent = await slack.chat.postMessage({
      channel: apiChannelId,
      text: 'reaction confirmation parent',
    })
    if (!parent.ts) throw new Error('Expected Slack parent message timestamp.')
    const idempotencyKey = `${Chat.reactionTipIdempotencyPrefix}${Nanoid.generate()}`
    const confirmation = await createConfirmationToken({ idempotencyKey })
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(confirmation.payload.providerId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })
    await factory.reaction_tip.insert({
      channel_id: apiChannelId,
      idempotency_key: idempotencyKey,
      message_ts: parent.ts,
      reaction: 'money_with_wings',
      recipient_member_id: confirmation.recipientMember.id,
      sender_member_id: confirmation.senderMember.id,
      thread_ts: parent.ts,
      tip_id: null,
      workspace_id: confirmation.workspace.id,
    })
    const signedTransaction = await signConfirmationTransaction(confirmation)

    const response = await client.api.confirm[':token'].$post({
      json: { address: confirmation.senderRoot.address, signedTransaction },
      param: { token: confirmation.token },
    })
    await Promise.all(waitUntil)
    const reactionTip = await db
      .selectFrom('reaction_tip')
      .select('tip_id')
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirstOrThrow()
    const replies = await slack.conversations.replies({ channel: apiChannelId, ts: parent.ts })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(reactionTip.tip_id).toEqual(expect.any(String))
    expect(
      replies.messages?.some((message) =>
        message.text?.includes(
          `<@${Constants.slack.memberUserId}> received a tip on <slack://channel?team=${confirmation.payload.providerId}&id=${apiChannelId}&message=${parent.ts}|this> message:\n• <@${Constants.slack.adminUserId}> tipped $5.00 · <`,
        ),
      ),
      JSON.stringify(replies.messages),
    ).toBe(true)
  }, 20_000) // 20 seconds

  test('confirms reusable access keys', async () => {
    const confirmation = await createConfirmationToken({
      amount: 1,
      kind: 'reusable_access_key',
      memo: `reusable-${Nanoid.generate()}`,
    })
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(confirmation.payload.providerId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })
    const keyAuthorization = await AccountLink.signKeyAuthorization(confirmation.senderRoot, {
      accessKeyAddress: confirmation.accessKey.address,
      chainId: confirmation.payload.chainId,
      expiresAt: confirmation.payload.accessKeyExpiresAt!,
      tokenAddress: confirmation.payload.tokenAddress,
    })

    const response = await client.api.confirm[':token'].$post({
      json: { address: confirmation.senderRoot.address, keyAuthorization },
      param: { token: confirmation.token },
    })
    await Promise.all(waitUntil)
    const tip = await db
      .selectFrom('tip')
      .selectAll()
      .where('idempotency_key', '=', confirmation.payload.idempotencyKey)
      .executeTakeFirstOrThrow()
    const accessKeys = await db
      .selectFrom('access_key')
      .selectAll()
      .where('account_id', '=', confirmation.senderAccount.id)
      .execute()
    const history = await slack.conversations.history({ channel: apiChannelId })

    expect(response.status).toBe(200)
    expect(tip.confirmed_at).toEqual(expect.any(String))
    expect(accessKeys).toHaveLength(1)
    expect(accessKeys[0]).toMatchObject({
      address: confirmation.accessKey.address,
      token_address: Tempo.addressLookup.pathUsd,
    })
    expect(
      history.messages?.some((message) => message.text?.includes(confirmation.payload.memo!)),
    ).toBe(true)
  }, 20_000) // 20 seconds

  test('confirms multi-recipient one-time payments', async () => {
    const secondRecipientProviderUserId = 'U000000003'
    const confirmation = await createConfirmationToken({
      amount: 1,
      memo: `batch-${Nanoid.generate()}`,
      recipientProviderUserIds: [Constants.slack.memberUserId, secondRecipientProviderUserId],
    })
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(confirmation.payload.providerId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })
    const signedTransaction = await signConfirmationTransaction(confirmation)

    const response = await client.api.confirm[':token'].$post({
      json: { address: confirmation.senderRoot.address, signedTransaction },
      param: { token: confirmation.token },
    })
    await Promise.all(waitUntil)
    const batch = await db
      .selectFrom('tip_batch')
      .selectAll()
      .where('idempotency_key', '=', confirmation.payload.idempotencyKey)
      .executeTakeFirstOrThrow()
    const tips = await db
      .selectFrom('tip')
      .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
      .select(['recipient.provider_user_id', 'tip.confirmed_at', 'tip.transaction_hash'])
      .where('tip.batch_id', '=', batch.id)
      .orderBy('recipient.provider_user_id', 'asc')
      .execute()
    const history = await slack.conversations.history({ channel: apiChannelId })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(batch).toMatchObject({
      amount_each: 1,
      recipient_count: 2,
      status: 'confirmed',
      total_amount: 2,
      transaction_hash: expect.any(String),
    })
    expect(tips).toEqual([
      expect.objectContaining({
        confirmed_at: expect.any(String),
        provider_user_id: Constants.slack.memberUserId,
        transaction_hash: null,
      }),
      expect.objectContaining({
        confirmed_at: expect.any(String),
        provider_user_id: secondRecipientProviderUserId,
        transaction_hash: null,
      }),
    ])
    expect(
      history.messages?.some(
        (message) =>
          message.text?.includes(
            `2 accounts $0.000001 each for ${confirmation.payload.memo} · Receipt`,
          ) &&
          message.text.includes(`<@${Constants.slack.memberUserId}>`) &&
          message.text.includes(`<@${secondRecipientProviderUserId}>`),
      ),
      JSON.stringify(history.messages),
    ).toBe(true)
  }, 20_000) // 20 seconds

  test('does not post duplicate receipt when confirmation is retried', async () => {
    const memo = `duplicate-${Nanoid.generate()}`
    const confirmation = await createConfirmationToken({ amount: 1, memo })
    await factory.tip.insert({
      amount: confirmation.payload.amount,
      chain_id: confirmation.payload.chainId,
      confirmed_at: new Date().toISOString(),
      idempotency_key: confirmation.payload.idempotencyKey,
      memo,
      recipient_id: confirmation.recipientAccount.id,
      recipient_member_id: confirmation.recipientMember.id,
      sender_id: confirmation.senderAccount.id,
      sender_member_id: confirmation.senderMember.id,
      token_address: confirmation.payload.tokenAddress,
      transaction_hash: `0x${'1'.repeat(64)}`,
      workspace_id: confirmation.workspace.id,
    })
    const signedTransaction = await signConfirmationTransaction(confirmation)
    const json = { address: confirmation.senderRoot.address, signedTransaction }

    const first = await client.api.confirm[':token'].$post({
      json,
      param: { token: confirmation.token },
    })
    await Promise.all(waitUntil)
    waitUntil = []
    const second = await client.api.confirm[':token'].$post({
      json,
      param: { token: confirmation.token },
    })
    await Promise.all(waitUntil)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(executionCtx.waitUntil).not.toHaveBeenCalled()
  }, 20_000) // 20 seconds
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
    await deleteSlackOauthWorkspace()
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
    await deleteSlackOauthWorkspace()
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

async function createConfirmationToken(
  options: {
    amount?: number
    idempotencyKey?: string
    kind?: Confirmation.Payload['kind']
    memo?: string | null
    providerId?: string
    providerThreadId?: string
    recipientProviderUserIds?: string[]
  } = {},
) {
  const providerId = options.providerId ?? `T${Nanoid.generate()}`
  const senderRoot = Account.fromSecp256k1(Constants.tip.senderRootPrivateKey)
  const recipientRoot = Account.fromSecp256k1(Constants.tip.recipientRootPrivateKey)
  const workspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    provider_id: providerId,
  })
  const senderAccount = await findOrCreateAccount(senderRoot.address)
  const recipientAccount = await findOrCreateAccount(recipientRoot.address)
  const senderMember = await factory.member.insert({
    account_id: senderAccount.id,
    provider_user_id: Constants.slack.adminUserId,
    workspace_id: workspace.id,
  })
  const recipientMember = await factory.member.insert({
    account_id: recipientAccount.id,
    provider_user_id: Constants.slack.memberUserId,
    workspace_id: workspace.id,
  })
  const recipientProviderUserIds = options.recipientProviderUserIds ?? [
    Constants.slack.memberUserId,
  ]
  for (const recipientProviderUserId of recipientProviderUserIds.slice(1)) {
    const account = await factory.account.insert({})
    await factory.member.insert({
      account_id: account.id,
      provider_user_id: recipientProviderUserId,
      workspace_id: workspace.id,
    })
  }
  const nonce = Nanoid.generate()
  const kind = options.kind ?? 'onetime_payment'
  const amount = options.amount ?? 5_000_000
  const payload = {
    ...(kind === 'reusable_access_key'
      ? {
          accessKeyExpiresAt: new Date(
            Date.now() + AccountLink.reusableAccessKeyTtlMs,
          ).toISOString(), // 30 days
        }
      : {}),
    amount,
    chainId: Tempo.chainLookup.localnet,
    expiresAt: new Date(Date.now() + AccountLink.confirmationLinkTtlMs).toISOString(), // 10 minutes
    idempotencyKey: options.idempotencyKey ?? `confirm:${nonce}`,
    kind,
    memo: options.memo ?? null,
    nonce,
    provider: 'slack',
    providerChannelId: apiChannelId,
    providerId,
    providerThreadId: options.providerThreadId,
    recipientProviderUserId: recipientProviderUserIds[0] ?? Constants.slack.memberUserId,
    ...(recipientProviderUserIds.length > 1
      ? {
          recipients: recipientProviderUserIds.map((recipientProviderUserId) => ({
            recipientProviderUserId,
          })),
        }
      : {}),
    senderProviderUserId: Constants.slack.adminUserId,
    tokenAddress: Tempo.addressLookup.pathUsd,
    workspaceId: workspace.id,
  } satisfies Confirmation.Payload
  const token = await Confirmation.encrypt(env, payload)
  const accessKey = await Confirmation.deriveAccessKey(env, payload.nonce)
  return {
    accessKey,
    payload,
    recipientAccount,
    recipientMember,
    senderAccount,
    senderMember,
    senderRoot,
    token,
    workspace,
  }
}

async function findOrCreateAccount(address: string) {
  const existing = await db
    .selectFrom('account')
    .selectAll()
    .where('address', '=', address)
    .executeTakeFirst()
  if (existing) return existing
  return await factory.account.insert({ address })
}

async function signConfirmationTransaction(
  confirmation: Awaited<ReturnType<typeof createConfirmationToken>>,
) {
  const response = await client.api.confirm[':token'].$get({
    param: { token: confirmation.token },
  })
  const json = await response.json()
  if (!json.ok || !json.transactionRequest) throw new Error('Expected transaction request.')
  const provider = Provider.create({
    adapter: dangerous_secp256k1({ privateKey: Constants.tip.senderRootPrivateKey }),
    chains: [
      {
        ...Tempo.getChain(confirmation.payload.chainId),
        rpcUrls: { default: { http: [env.RPC_URL_TESTNET!] } },
      },
    ],
    transports: { [confirmation.payload.chainId]: http(env.RPC_URL_TESTNET) },
  })
  await provider.request({
    method: 'wallet_connect',
    params: [{ capabilities: { method: 'register' } }],
  })
  return await provider.request({
    method: 'eth_signTransaction',
    params: [{ ...json.transactionRequest, chainId: toHex(confirmation.payload.chainId) } as never],
  })
}

async function deleteSlackOauthWorkspace() {
  await db.deleteFrom('workspace').where('provider_id', '=', Constants.slack.teamId).execute()
}

async function expectSlackMessage(channelId: string, text: string) {
  const history = await slack.conversations.history({ channel: channelId })

  expect(history.ok).toBe(true)
  expect(history.messages?.some((message) => message.text?.includes(text))).toBe(true)
}

async function expectSlackAssistantStatusCall(
  fetchSpy: { mock: { calls: Parameters<typeof fetch>[] } },
  channelId: string,
  threadTs: string,
  status: string,
) {
  await expect
    .poll(
      () =>
        fetchSpy.mock.calls.some((call) => {
          const input = call[0]
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const params = slackFetchBodyParams(call[1]?.body)
          return (
            url.endsWith('/assistant.threads.setStatus') &&
            params.get('channel_id') === channelId &&
            params.get('status') === status &&
            params.get('thread_ts') === threadTs
          )
        }),
      { timeout: 10_000 }, // 10 seconds
    )
    .toBe(true)
}

function slackFetchBodyParams(body: BodyInit | null | undefined) {
  if (body instanceof URLSearchParams) return body
  if (typeof body === 'string') return new URLSearchParams(body)
  return new URLSearchParams()
}

async function signKeyAuthorization(
  account: ReturnType<typeof Account.fromSecp256k1>,
  pending: Awaited<ReturnType<typeof createPendingAccountLink>>,
) {
  return await AccountLink.signKeyAuthorization(account, {
    accessKeyAddress: pending.accessKey.address,
    chainId: pending.workspace.chain_id,
    expiresAt: pending.link.access_key_expires_at,
    tokenAddress: Address.checksum(
      pending.workspace.default_token_address ?? Tempo.addressLookup.pathUsd,
    ),
  })
}
