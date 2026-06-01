import { Provider, dangerous_secp256k1 } from 'accounts'
import { WebClient } from '@slack/web-api'
import { env } from 'cloudflare:workers'
import { testClient } from 'hono/testing'
import { HttpResponse, http as mswHttp } from 'msw'
import { Address, Secp256k1 } from 'ox'
import { createClient, http, parseUnits, toHex } from 'viem'
import { Account, Actions } from 'viem/tempo'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '#/api.ts'
import * as Chat from '#/chat.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as AccessKey from '#/lib/accessKey.ts'
import * as App from '#/lib/app.ts'
import * as Confirmation from '#/lib/confirmation.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { createSlackHeaders } from '#/lib/slack.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Tip from '#/lib/tip.ts'
import * as Twitter from '#/lib/twitter.ts'
import * as DB from '#db/client.ts'
import * as Schema from '#db/schemas.gen.ts'
import type { DB as DB_gen } from '#db/types.gen.ts'
import * as Constants from '#test/constants.ts'
import * as Factory from '#test/factory.ts'
import { server } from '#test/workers.server.ts'

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
  const consoleError = console.error
  const consoleLog = console.log
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (isExpectedApiWorkerLog(args)) return
    consoleError(...args)
  })
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    if (isExpectedApiWorkerLog(args)) return
    consoleLog(...args)
  })
})

function isExpectedApiWorkerLog(args: unknown[]) {
  const message = typeof args[0] === 'string' ? args[0] : ''
  return (
    message.startsWith('Twitter webhook ') || message.startsWith('Twitter OAuth callback failed:')
  )
}

test('/api/health returns ok', async () => {
  const response = await client.api.health.$get()

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ ok: true })
})

test('/api/auth responds to Tempo wallet CORS preflight', async () => {
  const response = await api.fetch(
    new Request('https://tipbot.localhost/api/auth/challenge', {
      headers: {
        'access-control-request-headers': 'x-accounts-request,content-type',
        'access-control-request-method': 'POST',
        origin: 'https://embedded.wallet.example',
      },
      method: 'OPTIONS',
    }),
    env,
    executionCtx,
  )

  expect(response.status).toBe(204)
  expect(response.headers.get('access-control-allow-origin')).toBe(
    'https://embedded.wallet.example',
  )
  expect(response.headers.get('access-control-allow-credentials')).toBe('true')
  expect(response.headers.get('access-control-allow-headers')).toBe(
    'x-accounts-request,content-type',
  )
})

test('/api/auth limits non-challenge CORS preflight to trusted origins', async () => {
  const response = await api.fetch(
    new Request('https://tipbot.localhost/api/auth/logout', {
      headers: {
        'access-control-request-method': 'POST',
        origin: 'https://embedded.wallet.example',
      },
      method: 'OPTIONS',
    }),
    env,
    executionCtx,
  )

  expect(response.status).toBe(204)
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
})

describe('/api/chat/twitter', () => {
  test('responds to Twitter CRC challenge', async () => {
    const response = await api.fetch(
      new Request('https://tip.bot/api/chat/twitter?crc_token=twitter-crc'),
      env,
      executionCtx,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      response_token: `sha256=${await hmacBase64('twitter-consumer-secret', 'twitter-crc')}`,
    })
  })

  test('rejects Twitter webhook without valid signature', async () => {
    const response = await api.fetch(
      new Request('https://tip.bot/api/chat/twitter', {
        body: JSON.stringify({ id: 'tweet-unsigned', text: '@tipbotgg @alice' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      env,
      executionCtx,
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'invalid_signature', ok: false })
  })

  test('valid tip from unconnected Twitter sender replies with connect link', async () => {
    const posts: Array<{ authorization: string | null; body: unknown }> = []
    server.use(
      mswHttp.get('https://api.twitter.com/2/users/by/username/alice', () =>
        HttpResponse.json({ data: { id: '200', username: 'alice' } }),
      ),
      mswHttp.post('https://api.twitter.com/2/tweets', async ({ request }) => {
        posts.push({
          authorization: request.headers.get('authorization'),
          body: await request.json(),
        })
        return HttpResponse.json({ data: { id: 'reply-1', text: 'ok' } })
      }),
    )

    const response = await postTwitterWebhook({
      authorHandle: 'bob',
      authorId: '100',
      id: 'tweet-1',
      text: '@tipbotgg @alice $5',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(posts).toEqual([
      {
        authorization: expect.stringContaining('OAuth oauth_consumer_key="twitter-consumer-key"'),
        body: {
          reply: { in_reply_to_tweet_id: 'tweet-1' },
          text: 'Connect to Tipbot to send payments: https://tip.bot/link/x',
        },
      },
    ])
    expect(posts[0]?.authorization).toContain('oauth_signature=')
    expect(posts[0]?.authorization).not.toContain('Bearer')
  })

  test('parses dot-prefixed Twitter bot mention as tip command', async () => {
    server.use(
      mswHttp.get('https://api.twitter.com/2/users/by/username/alice', () =>
        HttpResponse.json({ data: { id: '200', username: 'alice' } }),
      ),
    )

    await expect(
      Twitter.parseTwitterTip(env, {
        authorHandle: 'bob',
        authorId: '100',
        id: 'tweet-parse-dot-prefix',
        text: '.@tipbotgg @alice $0.001 for coffee',
      }),
    ).resolves.toEqual({
      amount: 1000,
      memo: 'coffee',
      ok: true,
      recipients: [{ recipientProviderLabel: '@alice', recipientProviderUserId: '200' }],
      tokenAddress: null,
    })
  })

  test('real v2 Twitter webhook payload sends a tip for connected X accounts', async () => {
    const senderProviderUserId = twitterProviderUserId()
    const recipientProviderUserId = twitterProviderUserId()
    const tweetId = `tweet-${Nanoid.generate()}`
    const posts: Array<{ authorization: string | null; body: unknown }> = []
    const connected = await connectTwitterTipAccounts({
      recipientProviderUserId,
      senderProviderUserId,
    })
    if (!connected.recipientAccount || !connected.recipientMember)
      throw new Error('Expected connected Twitter recipient.')
    server.use(
      mswHttp.get('https://api.twitter.com/2/users/by/username/alice', () =>
        HttpResponse.json({ data: { id: recipientProviderUserId, username: 'alice' } }),
      ),
      mswHttp.post('https://api.twitter.com/2/tweets', async ({ request }) => {
        posts.push({
          authorization: request.headers.get('authorization'),
          body: await request.json(),
        })
        return HttpResponse.json({ data: { id: `reply-${Nanoid.generate()}`, text: 'ok' } })
      }),
    )

    const response = await postTwitterWebhook({
      data: {
        author_id: senderProviderUserId,
        conversation_id: `conversation-${Nanoid.generate()}`,
        id: tweetId,
        text: '.@tipbotgg @alice $0.001 for coffee',
      },
      includes: { users: [{ id: senderProviderUserId, username: 'bob' }] },
    })
    const tip = await db
      .selectFrom('tip')
      .selectAll()
      .where('idempotency_key', '=', `twitter:${tweetId}`)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(tip).toMatchObject({
      amount: 1000,
      confirmed_at: expect.any(String),
      failed_at: null,
      memo: 'coffee',
      recipient_id: connected.recipientAccount.id,
      recipient_member_id: connected.recipientMember.id,
      sender_id: connected.senderAccount.id,
      sender_member_id: connected.senderMember.id,
      token_address: Address.checksum(Tempo.addressLookup.pathUsd),
      workspace_id: connected.workspace.id,
    })
    expect(posts).toHaveLength(1)
    expect(posts[0]?.authorization).toContain('oauth_signature=')
    expect(posts[0]?.body).toMatchObject({
      reply: { in_reply_to_tweet_id: tweetId },
      text: expect.stringContaining('@bob sent @alice $0.001 for coffee'),
    })
  }, 20_000) // 20 seconds

  test('Twitter webhook sends multi-tip for connected X accounts', async () => {
    const senderProviderUserId = twitterProviderUserId()
    const aliceProviderUserId = twitterProviderUserId()
    const carolProviderUserId = twitterProviderUserId()
    const tweetId = `tweet-${Nanoid.generate()}`
    const posts: Array<{ body: unknown }> = []
    const connected = await connectTwitterTipAccounts({
      recipientProviderUserId: aliceProviderUserId,
      senderProviderUserId,
    })
    await linkTwitterAccount({
      handle: 'carol',
      providerUserId: carolProviderUserId,
      root: Account.fromSecp256k1(Secp256k1.randomPrivateKey()),
      workspaceId: connected.workspace.id,
    })
    server.use(
      mswHttp.get('https://api.twitter.com/2/users/by/username/alice', () =>
        HttpResponse.json({ data: { id: aliceProviderUserId, username: 'alice' } }),
      ),
      mswHttp.get('https://api.twitter.com/2/users/by/username/carol', () =>
        HttpResponse.json({ data: { id: carolProviderUserId, username: 'carol' } }),
      ),
      mswHttp.post('https://api.twitter.com/2/tweets', async ({ request }) => {
        posts.push({ body: await request.json() })
        return HttpResponse.json({ data: { id: `reply-${Nanoid.generate()}`, text: 'ok' } })
      }),
    )

    const response = await postTwitterWebhook({
      authorHandle: 'bob',
      authorId: senderProviderUserId,
      id: tweetId,
      text: '@tipbotgg @alice @carol $0.001 for coffee',
    })
    const batch = await db
      .selectFrom('tip_batch')
      .selectAll()
      .where('idempotency_key', '=', `twitter:${tweetId}`)
      .executeTakeFirstOrThrow()
    const tips = await db.selectFrom('tip').selectAll().where('batch_id', '=', batch.id).execute()

    expect(response.status).toBe(200)
    expect(batch).toMatchObject({ amount_each: 1000, recipient_count: 2, status: 'confirmed' })
    expect(tips).toHaveLength(2)
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toMatchObject({
      reply: { in_reply_to_tweet_id: tweetId },
      text: expect.stringContaining('@bob sent 2 accounts $0.001 each for coffee'),
    })
    expect((posts[0]?.body as { text: string } | undefined)?.text).toContain(
      'Recipients:\n• @alice\n• @carol',
    )
    expect((posts[0]?.body as { text: string } | undefined)?.text).toContain('Receipt:')
  }, 20_000) // 20 seconds

  test('Twitter webhook sends connected tips and queues unconnected multi-tip recipients', async () => {
    const senderProviderUserId = twitterProviderUserId()
    const aliceProviderUserId = twitterProviderUserId()
    const carolProviderUserId = twitterProviderUserId()
    const tweetId = `tweet-${Nanoid.generate()}`
    const posts: Array<{ body: unknown }> = []
    const connected = await connectTwitterTipAccounts({
      recipientProviderUserId: aliceProviderUserId,
      senderProviderUserId,
    })
    server.use(
      mswHttp.get('https://api.twitter.com/2/users/by/username/alice', () =>
        HttpResponse.json({ data: { id: aliceProviderUserId, username: 'alice' } }),
      ),
      mswHttp.get('https://api.twitter.com/2/users/by/username/carol', () =>
        HttpResponse.json({ data: { id: carolProviderUserId, username: 'carol' } }),
      ),
      mswHttp.post('https://api.twitter.com/2/tweets', async ({ request }) => {
        posts.push({ body: await request.json() })
        return HttpResponse.json({ data: { id: `reply-${Nanoid.generate()}`, text: 'ok' } })
      }),
    )

    const response = await postTwitterWebhook({
      authorHandle: 'bob',
      authorId: senderProviderUserId,
      id: tweetId,
      text: '@tipbotgg @alice @carol $0.001 for coffee',
    })
    const batch = await db
      .selectFrom('tip_batch')
      .selectAll()
      .where('idempotency_key', '=', `twitter:${tweetId}`)
      .executeTakeFirstOrThrow()
    const pending = await db
      .selectFrom('pending_tip')
      .selectAll()
      .where('idempotency_key', '=', `twitter:${tweetId}:${carolProviderUserId}`)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    expect(batch).toMatchObject({ amount_each: 1000, recipient_count: 1, status: 'confirmed' })
    expect(pending).toMatchObject({
      amount: 1000,
      memo: 'coffee',
      recipient_provider_user_id: carolProviderUserId,
      sender_member_id: connected.senderMember.id,
      status: 'pending',
    })
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toMatchObject({
      reply: { in_reply_to_tweet_id: tweetId },
      text: expect.stringContaining(
        '@bob sent 1 account and queued 1 account $0.001 each for coffee',
      ),
    })
    expect((posts[0]?.body as { text: string } | undefined)?.text).toContain(
      'Recipients:\n• @alice\n• @carol (not connected yet)',
    )
    expect((posts[0]?.body as { text: string } | undefined)?.text).toContain(
      'Connect to claim: https://tip.bot/link/x',
    )
  }, 20_000) // 20 seconds

  test('Twitter webhook deduplicates duplicate multi-tip handles', async () => {
    const senderProviderUserId = twitterProviderUserId()
    const aliceProviderUserId = twitterProviderUserId()
    const carolProviderUserId = twitterProviderUserId()
    const tweetId = `tweet-${Nanoid.generate()}`
    const posts: Array<{ body: unknown }> = []
    const connected = await connectTwitterTipAccounts({
      recipientProviderUserId: aliceProviderUserId,
      senderProviderUserId,
    })
    await linkTwitterAccount({
      handle: 'carol',
      providerUserId: carolProviderUserId,
      root: Account.fromSecp256k1(Secp256k1.randomPrivateKey()),
      workspaceId: connected.workspace.id,
    })
    server.use(
      mswHttp.get('https://api.twitter.com/2/users/by/username/alice', () =>
        HttpResponse.json({ data: { id: aliceProviderUserId, username: 'alice' } }),
      ),
      mswHttp.get('https://api.twitter.com/2/users/by/username/carol', () =>
        HttpResponse.json({ data: { id: carolProviderUserId, username: 'carol' } }),
      ),
      mswHttp.post('https://api.twitter.com/2/tweets', async ({ request }) => {
        posts.push({ body: await request.json() })
        return HttpResponse.json({ data: { id: `reply-${Nanoid.generate()}`, text: 'ok' } })
      }),
    )

    const response = await postTwitterWebhook({
      authorHandle: 'bob',
      authorId: senderProviderUserId,
      id: tweetId,
      text: '@tipbotgg @alice @alice @carol $0.001 for coffee',
    })
    const batch = await db
      .selectFrom('tip_batch')
      .selectAll()
      .where('idempotency_key', '=', `twitter:${tweetId}`)
      .executeTakeFirstOrThrow()
    const tips = await db.selectFrom('tip').selectAll().where('batch_id', '=', batch.id).execute()

    expect(response.status).toBe(200)
    expect(batch).toMatchObject({ amount_each: 1000, recipient_count: 2, status: 'confirmed' })
    expect(tips).toHaveLength(2)
    expect(posts).toHaveLength(1)
    expect((posts[0]?.body as { text: string } | undefined)?.text).toContain(
      'Recipients:\n• @alice\n• @carol',
    )
  }, 20_000) // 20 seconds

  test('Twitter webhook rejects multi-tip over recipient cap', async () => {
    const senderProviderUserId = twitterProviderUserId()
    const tweetId = `tweet-${Nanoid.generate()}`
    const posts: Array<{ body: unknown }> = []
    await connectTwitterTipAccounts({ senderProviderUserId })
    server.use(
      mswHttp.post('https://api.twitter.com/2/tweets', async ({ request }) => {
        posts.push({ body: await request.json() })
        return HttpResponse.json({ data: { id: `reply-${Nanoid.generate()}`, text: 'ok' } })
      }),
    )

    const response = await postTwitterWebhook({
      authorHandle: 'bob',
      authorId: senderProviderUserId,
      id: tweetId,
      text: `@tipbotgg ${Array.from({ length: 11 }, (_, index) => `@account${index}`).join(' ')} $0.001`,
    })

    expect(response.status).toBe(200)
    await expect(
      db
        .selectFrom('tip_batch')
        .selectAll()
        .where('idempotency_key', '=', `twitter:${tweetId}`)
        .execute(),
    ).resolves.toEqual([])
    await expect(
      db
        .selectFrom('pending_tip')
        .selectAll()
        .where('idempotency_key', 'like', `twitter:${tweetId}%`)
        .execute(),
    ).resolves.toEqual([])
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toMatchObject({
      reply: { in_reply_to_tweet_id: tweetId },
      text: 'Payment not sent. X tips support up to 10 recipients.',
    })
  }, 20_000) // 20 seconds

  test('Account Activity reply display text sends tip without reply-prefix recipients', async () => {
    const senderProviderUserId = twitterProviderUserId()
    const recipientProviderUserId = twitterProviderUserId()
    const tweetId = `tweet-${Nanoid.generate()}`
    const text = '@tipbotgg @bob @alice @tipbotgg @alice for reply test'
    const connected = await connectTwitterTipAccounts({
      recipientProviderUserId,
      senderProviderUserId,
    })
    if (!connected.recipientAccount || !connected.recipientMember)
      throw new Error('Expected connected Twitter recipient.')
    server.use(
      mswHttp.get('https://api.twitter.com/2/users/by/username/alice', () =>
        HttpResponse.json({ data: { id: recipientProviderUserId, username: 'alice' } }),
      ),
      mswHttp.post('https://api.twitter.com/2/tweets', () =>
        HttpResponse.json({ data: { id: `reply-${Nanoid.generate()}`, text: 'ok' } }),
      ),
    )

    const response = await postTwitterWebhook({
      tweet_create_events: [
        {
          display_text_range: [22, text.length],
          id_str: tweetId,
          in_reply_to_status_id_str: `conversation-${Nanoid.generate()}`,
          in_reply_to_user_id_str: 'tipbot-user',
          text,
          user: { id_str: senderProviderUserId, screen_name: 'bob' },
        },
      ],
    })
    const tip = await db
      .selectFrom('tip')
      .selectAll()
      .where('idempotency_key', '=', `twitter:${tweetId}`)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    expect(tip).toMatchObject({
      amount: 1000,
      confirmed_at: expect.any(String),
      memo: 'reply test',
      recipient_member_id: connected.recipientMember.id,
      sender_member_id: connected.senderMember.id,
    })
  }, 20_000) // 20 seconds

  test('Account Activity reply display text sends multi-tip without reply-prefix recipients', async () => {
    const senderProviderUserId = twitterProviderUserId()
    const aliceProviderUserId = twitterProviderUserId()
    const carolProviderUserId = twitterProviderUserId()
    const tweetId = `tweet-${Nanoid.generate()}`
    const text = '@bob @mallory @tipbotgg @alice @carol $0.001 for reply test'
    const connected = await connectTwitterTipAccounts({
      recipientProviderUserId: aliceProviderUserId,
      senderProviderUserId,
    })
    await linkTwitterAccount({
      handle: 'carol',
      providerUserId: carolProviderUserId,
      root: Account.fromSecp256k1(Secp256k1.randomPrivateKey()),
      workspaceId: connected.workspace.id,
    })
    server.use(
      mswHttp.get('https://api.twitter.com/2/users/by/username/alice', () =>
        HttpResponse.json({ data: { id: aliceProviderUserId, username: 'alice' } }),
      ),
      mswHttp.get('https://api.twitter.com/2/users/by/username/carol', () =>
        HttpResponse.json({ data: { id: carolProviderUserId, username: 'carol' } }),
      ),
      mswHttp.post('https://api.twitter.com/2/tweets', () =>
        HttpResponse.json({ data: { id: `reply-${Nanoid.generate()}`, text: 'ok' } }),
      ),
    )

    const response = await postTwitterWebhook({
      tweet_create_events: [
        {
          display_text_range: [text.indexOf('@tipbotgg'), text.length],
          id_str: tweetId,
          in_reply_to_status_id_str: `conversation-${Nanoid.generate()}`,
          in_reply_to_user_id_str: 'tipbot-user',
          text,
          user: { id_str: senderProviderUserId, screen_name: 'bob' },
        },
      ],
    })
    const batch = await db
      .selectFrom('tip_batch')
      .selectAll()
      .where('idempotency_key', '=', `twitter:${tweetId}`)
      .executeTakeFirstOrThrow()
    const tips = await db
      .selectFrom('tip')
      .innerJoin('member', 'member.id', 'tip.recipient_member_id')
      .select('member.provider_user_id')
      .where('tip.batch_id', '=', batch.id)
      .orderBy('member.provider_user_id', 'asc')
      .execute()

    expect(response.status).toBe(200)
    expect(batch).toMatchObject({ amount_each: 1000, recipient_count: 2, status: 'confirmed' })
    expect(tips.map((tip) => tip.provider_user_id).sort()).toEqual(
      [aliceProviderUserId, carolProviderUserId].sort(),
    )
  }, 20_000) // 20 seconds

  test('pending Twitter tip is claimed only after matching X recipient links', async () => {
    const senderProviderUserId = twitterProviderUserId()
    const recipientProviderUserId = twitterProviderUserId()
    const wrongProviderUserId = twitterProviderUserId()
    const tweetId = `tweet-${Nanoid.generate()}`
    const connected = await connectTwitterTipAccounts({ senderProviderUserId })
    server.use(
      mswHttp.get('https://api.twitter.com/2/users/by/username/alice', () =>
        HttpResponse.json({ data: { id: recipientProviderUserId, username: 'alice' } }),
      ),
      mswHttp.post('https://api.twitter.com/2/tweets', () =>
        HttpResponse.json({ data: { id: `reply-${Nanoid.generate()}`, text: 'ok' } }),
      ),
    )

    const response = await postTwitterWebhook({
      authorHandle: 'bob',
      authorId: senderProviderUserId,
      id: tweetId,
      text: '@tipbotgg @alice $0.001 for coffee',
    })
    const pending = await db
      .selectFrom('pending_tip')
      .selectAll()
      .where('idempotency_key', '=', `twitter:${tweetId}`)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    expect(pending).toMatchObject({
      amount: 1000,
      memo: 'coffee',
      provider_id: 'x',
      recipient_provider_user_id: recipientProviderUserId,
      sender_member_id: connected.senderMember.id,
      status: 'pending',
    })

    await linkTwitterAccount({
      handle: 'mallory',
      providerUserId: wrongProviderUserId,
      root: Account.fromSecp256k1(Secp256k1.randomPrivateKey()),
      workspaceId: connected.workspace.id,
    })

    await expect(
      db
        .selectFrom('pending_tip')
        .select(['status', 'tip_id'])
        .where('id', '=', pending.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'pending', tip_id: null })
    await expect(
      db
        .selectFrom('tip')
        .selectAll()
        .where('idempotency_key', '=', `pending:${pending.id}`)
        .execute(),
    ).resolves.toEqual([])

    const recipientRoot = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    await linkTwitterAccount({
      handle: 'alice',
      memberId: pending.recipient_member_id,
      providerUserId: recipientProviderUserId,
      root: recipientRoot,
      workspaceId: connected.workspace.id,
    })

    const result = await Tip.claimPendingTip(env, { pendingTipId: pending.id })
    const updated = await db
      .selectFrom('pending_tip')
      .selectAll()
      .where('id', '=', pending.id)
      .executeTakeFirstOrThrow()
    const tip = await db
      .selectFrom('tip')
      .selectAll()
      .where('idempotency_key', '=', `pending:${pending.id}`)
      .executeTakeFirstOrThrow()

    expect(result).toMatchObject({ ok: true, status: 'sent' })
    expect(updated).toMatchObject({ status: 'sent', tip_id: tip.id })
    expect(tip).toMatchObject({
      amount: 1000,
      confirmed_at: expect.any(String),
      memo: 'coffee',
      sender_id: connected.senderAccount.id,
    })
    expect(tip.recipient_id).not.toBe(connected.senderAccount.id)
  }, 20_000) // 20 seconds

  test('ignores Twitter connect chatter', async () => {
    const fetchSpy = vi.fn()
    server.use(
      mswHttp.all('https://api.twitter.com/*', () => {
        fetchSpy()
        return HttpResponse.json({ ok: true })
      }),
    )

    const response = await postTwitterWebhook({
      authorHandle: 'bob',
      authorId: '100',
      id: 'tweet-connect',
      text: '@tipbotgg connect',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('/api/link/twitter', () => {
  test('completes Twitter proof flow and stores account link', async () => {
    await ensureTwitterTestWorkspace({
      chainId: Tempo.chainLookup.mainnet,
      tokenAddress: Tempo.addressLookup.usdcE,
    })
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    mockTwitterUser({ id: 'twitter-user-1', username: 'alice' })
    const challengeResponse = await client.api.link.twitter.challenge.$post({
      json: { username: 'alice' },
    })

    expect(challengeResponse.status).toBe(200)
    if (challengeResponse.status !== 200) throw new Error('Expected Twitter challenge success.')
    const challenge = await challengeResponse.json()
    expect(challenge.chainId).toBe(Tempo.chainLookup.mainnet)
    expect(challenge.name).toBe('alice')
    expect(challenge.tokenAddress).toBe(Address.checksum(Tempo.addressLookup.usdcE))
    expect(challenge.username).toBe('alice')
    const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
      accessKeyAddress: challenge.accessKeyAddress,
      chainId: challenge.chainId,
      expiresAt: challenge.accessKeyExpiry,
      tokenAddress: challenge.tokenAddress,
    })
    const proofResponse = await client.api.link.twitter.proof.$post({
      json: {
        address: root.address,
        challengeId: challenge.challengeId,
        keyAuthorization,
      },
    })

    expect(proofResponse.status).toBe(200)
    if (proofResponse.status !== 200) throw new Error('Expected Twitter proof success.')
    const proof = await proofResponse.json()
    server.use(
      mswHttp.get('https://api.twitter.com/2/tweets/12345', () =>
        HttpResponse.json({
          data: { author_id: 'twitter-user-1', id: '12345', text: proof.tweetText },
          includes: { users: [{ id: 'twitter-user-1', username: 'alice' }] },
        }),
      ),
    )
    const verifyResponse = await client.api.link.twitter.verify.$post({
      json: {
        challengeId: challenge.challengeId,
        proof: proof.proof,
        tweetUrl: 'https://x.com/alice/status/12345',
      },
    })

    expect(verifyResponse.status).toBe(200)
    await expect(verifyResponse.json()).resolves.toEqual({ handle: '@alice', ok: true })
    const account = await db
      .selectFrom('account')
      .selectAll()
      .where('address', '=', root.address)
      .executeTakeFirstOrThrow()
    const identity = await db
      .selectFrom('provider_identity')
      .selectAll()
      .where('account_id', '=', account.id)
      .where('provider_user_id', '=', 'twitter-user-1')
      .executeTakeFirstOrThrow()
    const member = await db
      .selectFrom('member')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .select(['member.provider_user_id', 'workspace.provider_id'])
      .where('member.provider_identity_id', '=', identity.id)
      .executeTakeFirstOrThrow()
    const accessKey = await db
      .selectFrom('access_key')
      .selectAll()
      .where('account_id', '=', account.id)
      .executeTakeFirstOrThrow()

    expect(identity).toMatchObject({
      display_name: '@alice',
      provider: 'slack',
      provider_user_id: 'twitter-user-1',
      provider_workspace_id: 'x',
    })
    expect(member).toEqual({ provider_id: 'x', provider_user_id: 'twitter-user-1' })
    expect(accessKey).toMatchObject({
      address: challenge.accessKeyAddress,
      authorization: JSON.stringify(keyAuthorization),
      token_address: Address.checksum(Tempo.addressLookup.usdcE),
    })
  })

  test('uses X workspace network and default token for authorization', async () => {
    await ensureTwitterTestWorkspace({
      chainId: Tempo.chainLookup.localnet,
      tokenAddress: Tempo.addressLookup.pathUsd,
    })
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    mockTwitterUser({ id: 'twitter-localnet-user', username: 'alice' })
    const challengeResponse = await client.api.link.twitter.challenge.$post({
      json: { address: root.address, username: 'alice' },
    })

    expect(challengeResponse.status).toBe(200)
    if (challengeResponse.status !== 200) throw new Error('Expected Twitter challenge success.')
    await expect(challengeResponse.json()).resolves.toMatchObject({
      chainId: Tempo.chainLookup.localnet,
      tokenAddress: Address.checksum(Tempo.addressLookup.pathUsd),
    })
  })

  test('completes Twitter proof flow from webhook tweet', async () => {
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    mockTwitterUser({ id: 'twitter-webhook-user', username: 'alice' })
    const challengeResponse = await client.api.link.twitter.challenge.$post({
      json: { address: root.address, username: 'alice' },
    })

    expect(challengeResponse.status).toBe(200)
    if (challengeResponse.status !== 200) throw new Error('Expected Twitter challenge success.')
    const challenge = await challengeResponse.json()
    const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
      accessKeyAddress: challenge.accessKeyAddress,
      chainId: challenge.chainId,
      expiresAt: challenge.accessKeyExpiry,
      tokenAddress: challenge.tokenAddress,
    })
    const proofResponse = await client.api.link.twitter.proof.$post({
      json: {
        address: root.address,
        challengeId: challenge.challengeId,
        keyAuthorization,
      },
    })

    expect(proofResponse.status).toBe(200)
    if (proofResponse.status !== 200) throw new Error('Expected Twitter proof success.')
    const proof = await proofResponse.json()
    const response = await postTwitterWebhook({
      authorHandle: 'alice',
      authorId: 'twitter-webhook-user',
      id: 'webhook-proof-tweet',
      text: proof.tweetText,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    await expect(
      db
        .selectFrom('provider_link_challenge')
        .select(['provider_handle', 'provider_user_id', 'tweet_id', 'used_at'])
        .where('id', '=', challenge.challengeId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      provider_handle: '@alice',
      provider_user_id: 'twitter-webhook-user',
      tweet_id: 'webhook-proof-tweet',
    })
  })

  test('completes Twitter OAuth flow and stores account link', async () => {
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const challengeResponse = await client.api.link.twitter.oauth.challenge.$post({
      json: {},
    })

    expect(challengeResponse.status).toBe(200)
    if (challengeResponse.status !== 200)
      throw new Error('Expected Twitter OAuth challenge success.')
    const challenge = await challengeResponse.json()
    const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
      accessKeyAddress: challenge.accessKeyAddress,
      chainId: challenge.chainId,
      expiresAt: challenge.accessKeyExpiry,
      tokenAddress: challenge.tokenAddress,
    })
    const startResponse = await api.fetch(
      new Request('https://tip.bot/api/link/twitter/oauth/start', {
        body: JSON.stringify({
          address: root.address,
          challengeId: challenge.challengeId,
          keyAuthorization,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      env,
      executionCtx,
    )

    expect(startResponse.status).toBe(200)
    const start = (await startResponse.json()) as { authorizationUrl: string; ok: true }
    const authorizationUrl = new URL(start.authorizationUrl)
    expect(authorizationUrl.origin).toBe('https://x.com')
    expect(authorizationUrl.pathname).toBe('/i/oauth2/authorize')
    expect(authorizationUrl.searchParams.get('client_id')).toBe(env.TWITTER_OAUTH_CLIENT_ID)
    expect(authorizationUrl.searchParams.get('scope')).toBe('tweet.read users.read')
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl.searchParams.get('state')).toEqual(expect.any(String))

    if (!env.TWITTER_OAUTH_CLIENT_ID || !env.TWITTER_OAUTH_CLIENT_SECRET)
      throw new Error('Expected Twitter OAuth credentials.')
    const expectedOAuthAuthorization = `Basic ${btoa(
      `${env.TWITTER_OAUTH_CLIENT_ID}:${env.TWITTER_OAUTH_CLIENT_SECRET}`,
    )}`
    server.use(
      mswHttp.post('https://api.twitter.com/2/oauth2/token', async ({ request }) => {
        expect(request.headers.get('authorization')).toBe(expectedOAuthAuthorization)
        const body = new URLSearchParams(await request.text())
        expect(body.get('code')).toBe('oauth-code')
        expect(body.get('code_verifier')).toEqual(expect.any(String))
        expect(body.get('grant_type')).toBe('authorization_code')
        expect(body.get('redirect_uri')).toBe('https://tip.bot/api/link/twitter/oauth/callback')
        return HttpResponse.json({ access_token: 'oauth-access-token', token_type: 'bearer' })
      }),
      mswHttp.get('https://api.twitter.com/2/users/me', ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer oauth-access-token')
        return HttpResponse.json({
          data: { id: 'twitter-oauth-user', name: 'Alice', username: 'alice' },
        })
      }),
    )
    const callbackResponse = await api.fetch(
      new Request(
        `https://tip.bot/api/link/twitter/oauth/callback?code=oauth-code&state=${authorizationUrl.searchParams.get('state')}`,
      ),
      env,
      executionCtx,
    )

    expect(callbackResponse.status).toBe(302)
    expect(callbackResponse.headers.get('location')).toBe('https://tip.bot/link/x?status=connected')
    const account = await db
      .selectFrom('account')
      .selectAll()
      .where('address', '=', root.address)
      .executeTakeFirstOrThrow()
    const identity = await db
      .selectFrom('provider_identity')
      .selectAll()
      .where('account_id', '=', account.id)
      .where('provider_user_id', '=', 'twitter-oauth-user')
      .executeTakeFirstOrThrow()
    const challengeRow = await db
      .selectFrom('provider_link_challenge')
      .select(['provider_handle', 'provider_user_id', 'tweet_id', 'used_at', 'wallet_address'])
      .where('id', '=', challenge.challengeId)
      .executeTakeFirstOrThrow()
    const oauthState = await db
      .selectFrom('provider_link_oauth_state')
      .select(['used_at'])
      .where('challenge_id', '=', challenge.challengeId)
      .executeTakeFirstOrThrow()

    expect(identity).toMatchObject({
      display_name: '@alice',
      provider: 'slack',
      provider_user_id: 'twitter-oauth-user',
      provider_workspace_id: 'x',
    })
    expect(challengeRow).toMatchObject({
      provider_handle: '@alice',
      provider_user_id: 'twitter-oauth-user',
      wallet_address: root.address,
    })
    expect(challengeRow.tweet_id).toMatch(/^oauth:/)
    expect(challengeRow.used_at).toEqual(expect.any(String))
    expect(oauthState.used_at).toEqual(expect.any(String))
  })

  test('rejects invalid Twitter OAuth state', async () => {
    const callbackResponse = await api.fetch(
      new Request('https://tip.bot/api/link/twitter/oauth/callback?code=oauth-code&state=invalid'),
      env,
      executionCtx,
    )

    expect(callbackResponse.status).toBe(302)
    expect(callbackResponse.headers.get('location')).toBe(
      'https://tip.bot/link/x?error=oauth_failed',
    )
  })

  test('rejects reused Twitter OAuth state', async () => {
    const setup = await startTwitterOAuthLink(Account.fromSecp256k1(Secp256k1.randomPrivateKey()))
    mockTwitterOAuthExchange({ providerUserId: 'twitter-oauth-reuse', username: 'alice' })

    const firstResponse = await api.fetch(
      new Request(
        `https://tip.bot/api/link/twitter/oauth/callback?code=oauth-code&state=${setup.state}`,
      ),
      env,
      executionCtx,
    )
    const secondResponse = await api.fetch(
      new Request(
        `https://tip.bot/api/link/twitter/oauth/callback?code=oauth-code&state=${setup.state}`,
      ),
      env,
      executionCtx,
    )

    expect(firstResponse.status).toBe(302)
    expect(firstResponse.headers.get('location')).toBe('https://tip.bot/link/x?status=connected')
    expect(secondResponse.status).toBe(302)
    expect(secondResponse.headers.get('location')).toBe('https://tip.bot/link/x?error=oauth_failed')
  })

  test('redirects Twitter OAuth token exchange failure to error state', async () => {
    const setup = await startTwitterOAuthLink(Account.fromSecp256k1(Secp256k1.randomPrivateKey()))
    server.use(
      mswHttp.post('https://api.twitter.com/2/oauth2/token', () =>
        HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
      ),
    )
    const callbackResponse = await api.fetch(
      new Request(
        `https://tip.bot/api/link/twitter/oauth/callback?code=oauth-code&state=${setup.state}`,
      ),
      env,
      executionCtx,
    )

    expect(callbackResponse.status).toBe(302)
    expect(callbackResponse.headers.get('location')).toBe(
      'https://tip.bot/link/x?error=oauth_failed',
    )
    await expect(
      db
        .selectFrom('provider_link_challenge')
        .select(['used_at'])
        .where('id', '=', setup.challenge.challengeId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ used_at: null })
  })

  test('links wallet that already has Slack identities', async () => {
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const account = await factory.account.insert({ address: root.address })
    const workspace = await factory.workspace.insert({ provider_id: `T${Nanoid.generate()}` })
    await insertMember({
      account_id: account.id,
      provider_user_id: `U${Nanoid.generate()}`,
      workspace_id: workspace.id,
    })
    mockTwitterUser({ id: 'twitter-user-2', username: 'bob' })
    const challengeResponse = await client.api.link.twitter.challenge.$post({
      json: { address: root.address, username: 'bob' },
    })

    expect(challengeResponse.status).toBe(200)
    if (challengeResponse.status !== 200) throw new Error('Expected Twitter challenge success.')
    const challenge = await challengeResponse.json()
    const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
      accessKeyAddress: challenge.accessKeyAddress,
      chainId: challenge.chainId,
      expiresAt: challenge.accessKeyExpiry,
      tokenAddress: challenge.tokenAddress,
    })
    const proofResponse = await client.api.link.twitter.proof.$post({
      json: {
        address: root.address,
        challengeId: challenge.challengeId,
        keyAuthorization,
      },
    })

    expect(proofResponse.status).toBe(200)
    if (proofResponse.status !== 200) throw new Error('Expected Twitter proof success.')
    const proof = await proofResponse.json()
    server.use(
      mswHttp.get('https://api.twitter.com/2/tweets/67890', () =>
        HttpResponse.json({
          data: { author_id: 'twitter-user-2', id: '67890', text: proof.tweetText },
          includes: { users: [{ id: 'twitter-user-2', username: 'bob' }] },
        }),
      ),
    )
    const verifyResponse = await client.api.link.twitter.verify.$post({
      json: {
        challengeId: challenge.challengeId,
        proof: proof.proof,
        tweetUrl: 'https://x.com/bob/status/67890',
      },
    })

    expect(verifyResponse.status).toBe(200)
    await expect(verifyResponse.json()).resolves.toEqual({ handle: '@bob', ok: true })
  })

  test('rejects proof tweet posted by a different X account', async () => {
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    mockTwitterUser({ id: 'twitter-user-expected', username: 'alice' })
    const challengeResponse = await client.api.link.twitter.challenge.$post({
      json: { address: root.address, username: 'alice' },
    })

    expect(challengeResponse.status).toBe(200)
    if (challengeResponse.status !== 200) throw new Error('Expected Twitter challenge success.')
    const challenge = await challengeResponse.json()
    const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
      accessKeyAddress: challenge.accessKeyAddress,
      chainId: challenge.chainId,
      expiresAt: challenge.accessKeyExpiry,
      tokenAddress: challenge.tokenAddress,
    })
    const proofResponse = await client.api.link.twitter.proof.$post({
      json: {
        address: root.address,
        challengeId: challenge.challengeId,
        keyAuthorization,
      },
    })

    expect(proofResponse.status).toBe(200)
    if (proofResponse.status !== 200) throw new Error('Expected Twitter proof success.')
    const proof = await proofResponse.json()
    server.use(
      mswHttp.get('https://api.twitter.com/2/tweets/99999', () =>
        HttpResponse.json({
          data: { author_id: 'twitter-user-attacker', id: '99999', text: proof.tweetText },
          includes: { users: [{ id: 'twitter-user-attacker', username: 'mallory' }] },
        }),
      ),
    )
    const verifyResponse = await client.api.link.twitter.verify.$post({
      json: {
        challengeId: challenge.challengeId,
        proof: proof.proof,
        tweetUrl: 'https://x.com/mallory/status/99999',
      },
    })

    expect(verifyResponse.status).toBe(200)
    await expect(verifyResponse.json()).resolves.toEqual({ code: 'invalid_author', ok: false })
    await expect(
      db
        .selectFrom('provider_identity')
        .select('id')
        .where('provider_user_id', '=', 'twitter-user-attacker')
        .execute(),
    ).resolves.toEqual([])
  })

  test('verified Twitter relink replaces wallet previous X identity', async () => {
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const workspace = await ensureTwitterTestWorkspace()
    const account = await linkTwitterAccount({
      handle: 'alice',
      providerUserId: 'twitter-relink-old',
      root,
      workspaceId: workspace.id,
    })

    await completeTwitterProofLink({
      handle: 'bob',
      providerUserId: 'twitter-relink-new',
      root,
      tweetId: '1001001',
    })

    await expect(
      db
        .selectFrom('provider_identity')
        .select(['account_id', 'provider_user_id'])
        .where('provider', '=', 'slack')
        .where('provider_workspace_id', '=', 'x')
        .where('provider_user_id', 'in', ['twitter-relink-old', 'twitter-relink-new'])
        .orderBy('provider_user_id')
        .execute(),
    ).resolves.toEqual([
      { account_id: account.id, provider_user_id: 'twitter-relink-new' },
      { account_id: null, provider_user_id: 'twitter-relink-old' },
    ])
  })

  test('verified Twitter relink moves X identity to new wallet', async () => {
    const oldRoot = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const newRoot = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const workspace = await ensureTwitterTestWorkspace()
    const oldAccount = await linkTwitterAccount({
      handle: 'alice',
      providerUserId: 'twitter-wallet-move',
      root: oldRoot,
      workspaceId: workspace.id,
    })

    await completeTwitterProofLink({
      handle: 'alice',
      providerUserId: 'twitter-wallet-move',
      root: newRoot,
      tweetId: '1001002',
    })
    const newAccount = await db
      .selectFrom('account')
      .selectAll()
      .where('address', '=', newRoot.address)
      .executeTakeFirstOrThrow()

    await expect(
      db
        .selectFrom('provider_identity')
        .select(['account_id', 'display_name'])
        .where('provider', '=', 'slack')
        .where('provider_workspace_id', '=', 'x')
        .where('provider_user_id', '=', 'twitter-wallet-move')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ account_id: newAccount.id, display_name: '@alice' })
    await expect(
      db
        .selectFrom('provider_identity')
        .select('id')
        .where('provider', '=', 'slack')
        .where('provider_workspace_id', '=', 'x')
        .where('account_id', '=', oldAccount.id)
        .execute(),
    ).resolves.toEqual([])
  })
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

  test('publishes workspace missing Home tab on app_home_opened', async () => {
    const providerId = `T${Nanoid.generate()}`
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(providerId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })
    const fetchSpy = setupSlackViewsPublishFetchSpy()

    const response = await postSlackAppHomeOpened({
      providerId,
      providerUserId: Constants.slack.adminUserId,
    })
    await Promise.all(waitUntil)
    const publish = await expectSlackViewsPublishCall(fetchSpy)
    const viewText = JSON.stringify(publish.view)

    expect(response.status).toBe(200)
    expect(publish.user_id).toBe(Constants.slack.adminUserId)
    expect(publish.view).toMatchObject({ type: 'home' })
    expect(viewText).toContain("Tipbot isn't installed in this workspace yet")
    fetchSpy.mockRestore()
  })

  test('publishes not-connected Home tab on app_home_opened', async () => {
    const providerId = `T${Nanoid.generate()}`
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(providerId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })
    const workspace = await factory.workspace.insert({
      default_amount: 5_000_000,
      provider_id: providerId,
    })
    await factory.reaction_tip_config.insert({
      amount: 1000,
      emoji: 'tip',
      workspace_id: workspace.id,
    })
    const fetchSpy = setupSlackViewsPublishFetchSpy()

    const response = await postSlackAppHomeOpened({
      providerId,
      providerUserId: Constants.slack.memberUserId,
    })
    await Promise.all(waitUntil)
    const publish = await expectSlackViewsPublishCall(fetchSpy)
    const viewText = JSON.stringify(publish.view)

    expect(response.status).toBe(200)
    expect(publish.user_id).toBe(Constants.slack.memberUserId)
    expect(publish.view).toMatchObject({ type: 'home' })
    expect(viewText).toContain("You haven't connected an account yet")
    expect(viewText).toContain('`/tip connect`')
    expect(viewText).toContain('*Default amount* 5')
    expect(viewText).toContain('*Tip reactions* :tip: (0.001)')
    fetchSpy.mockRestore()
  })

  test('slash command returns invite instructions when Tipbot is not in the channel', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(env.SLACK_API_URL) && url.includes('/conversations.info'))
        return Promise.resolve(Response.json({ channel: { is_member: false }, ok: true }))
      return originalFetch(input, init)
    })
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(Constants.slack.teamId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })
    const body = new URLSearchParams({
      channel_id: Constants.slack.channelId,
      command: '/tip',
      team_id: Constants.slack.teamId,
      text: `<@${Constants.slack.memberUserId}> for coffee`,
      trigger_id: 'trigger-missing-channel',
      user_id: Constants.slack.adminUserId,
    }).toString()

    const response = await client.api.chat.slack.$post(
      {},
      {
        headers: {
          ...(await createSlackHeaders(body, env.SLACK_SIGNING_SECRET)),
          'content-type': 'application/x-www-form-urlencoded',
        },
        init: { body },
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      response_type: 'ephemeral',
      text: [
        'Tipbot isn’t in this channel, so it can’t send tips here yet.',
        '',
        'Run `/invite @Tipbot`, then try this again:',
        `\`/tip <@${Constants.slack.memberUserId}> for coffee\``,
      ].join('\n'),
    })
    expect(executionCtx.waitUntil).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  test('slash command does not return invite instructions when shared channel membership is ambiguous', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(env.SLACK_API_URL) && url.includes('/conversations.info'))
        return Promise.resolve(Response.json({ error: 'not_in_channel', ok: false }))
      return originalFetch(input, init)
    })
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(Constants.slack.teamId, {
      botToken: Constants.slack.botToken,
      botUserId: Constants.slack.botUserId,
      teamName: Constants.slack.teamName,
    })
    const body = new URLSearchParams({
      channel_id: Constants.slack.channelId,
      command: '/tip',
      team_id: Constants.slack.teamId,
      text: 'status',
      trigger_id: 'trigger-ambiguous-channel',
      user_id: Constants.slack.adminUserId,
    }).toString()

    const response = await client.api.chat.slack.$post(
      {},
      {
        headers: {
          ...(await createSlackHeaders(body, env.SLACK_SIGNING_SECRET)),
          'content-type': 'application/x-www-form-urlencoded',
        },
        init: { body },
      },
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(executionCtx.waitUntil).toHaveBeenCalled()
    fetchSpy.mockRestore()
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
      'app_mentions:read,assistant:write,channels:history,channels:read,chat:write,commands,emoji:read,groups:history,groups:read,reactions:read,usergroups:read,users:read',
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
      .selectFrom('provider_identity')
      .innerJoin('account', 'account.id', 'provider_identity.account_id')
      .selectAll('account')
      .where('provider_identity.id', '=', member.provider_identity_id)
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

  test('queues pending tips when wallet connection completes', async () => {
    const pending = await createPendingAccountLink()
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const senderAccount = await factory.account.insert({})
    const senderMember = await insertMember({
      account_id: senderAccount.id,
      provider_user_id: 'USENDERPENDING',
      workspace_id: pending.workspace.id,
    })
    const pendingTip = await db
      .insertInto('pending_tip')
      .values({
        access_key_id: null,
        amount: 1000,
        chain_id: pending.workspace.chain_id,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
        failure_reason: null,
        id: Nanoid.generate(),
        idempotency_key: `pending:${Nanoid.generate()}`,
        memo: null,
        provider: 'slack',
        provider_channel_id: `slack:${apiChannelId}`,
        provider_id: pending.workspace.provider_id,
        provider_message_ts: null,
        provider_thread_id: null,
        recipient_member_id: pending.member.id,
        recipient_provider_user_id: pending.member.provider_user_id,
        sender_id: senderAccount.id,
        sender_member_id: senderMember.id,
        sender_provider_user_id: senderMember.provider_user_id,
        source: 'command',
        status: 'pending',
        tip_id: null,
        token_address: Tempo.addressLookup.pathUsd,
        workspace_id: pending.workspace.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const sendSpy = vi.spyOn(env.PENDING_TIP_QUEUE, 'send').mockResolvedValue({
      metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
    })
    const keyAuthorization = await signKeyAuthorization(root, pending)

    const response = await client.api.account.link[':token'].$post({
      json: { address: root.address, keyAuthorization },
      param: { token: pending.token },
    })
    await Promise.all(waitUntil)

    expect(response.status).toBe(200)
    expect(sendSpy).toHaveBeenCalledWith({ pendingTipId: pendingTip.id })
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
    const workspace = await factory.workspace.insert({
      provider_id: providerId,
    })
    await factory.reaction_tip_config.insert({
      amount: 2_000_000,
      emoji: 'bell',
      workspace_id: workspace.id,
    })
    const pending = await createPendingAccountLink({
      providerChannelId: channelId,
      providerUserId: Constants.slack.adminUserId,
      workspaceId: workspace.id,
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
    await expectSlackMessage(channelId, 'React with :bell: `:bell:` (2) to tip a message.')
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
    await insertMember({
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
    const duplicate = await insertMember({
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
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .select('provider_identity.account_id')
      .where('member.id', '=', pending.member.id)
      .executeTakeFirstOrThrow()
    const duplicateMember = await db
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .select('provider_identity.account_id')
      .where('member.id', '=', duplicate.id)
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
              profile: { image_72: 'https://example.com/member.png' },
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
      recipients: [
        {
          recipientProviderLabel: Constants.slack.memberUserName,
          recipientProviderUserId: Constants.slack.memberUserId,
        },
      ],
      recipientAvatarUrl: 'https://example.com/member.png',
    })
    fetchSpy.mockRestore()
  })

  test('resolves missing multi-recipient confirmation labels from Slack', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(env.SLACK_API_URL) && url.includes('/users.info')) {
        const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams()
        const userId = body.get('user') ?? ''
        return Promise.resolve(
          Response.json({
            ok: true,
            user: {
              id: userId,
              name: userId === Constants.slack.memberUserId ? 'member' : 'singlechannelguest',
              profile: {
                image_72: `https://example.com/${userId}.png`,
              },
            },
          }),
        )
      }
      return originalFetch(input, init)
    })
    const confirmation = await createConfirmationToken({
      recipientProviderUserIds: [
        Constants.slack.memberUserId,
        Constants.slack.singleChannelGuestUserId,
      ],
    })
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
      recipients: [
        {
          recipientAvatarUrl: `https://example.com/${Constants.slack.memberUserId}.png`,
          recipientProviderLabel: Constants.slack.memberUserName,
          recipientProviderUserId: Constants.slack.memberUserId,
        },
        {
          recipientAvatarUrl: `https://example.com/${Constants.slack.singleChannelGuestUserId}.png`,
          recipientProviderLabel: Constants.slack.singleChannelGuestUserName,
          recipientProviderUserId: Constants.slack.singleChannelGuestUserId,
        },
      ],
    })
    fetchSpy.mockRestore()
  })

  test('resolves Twitter confirmation recipient avatar from X', async () => {
    const workspace = await ensureTwitterTestWorkspace()
    mockTwitterUser({ id: 'twitter-confirm-recipient', username: 'alice' })
    const token = await Confirmation.encrypt(env, {
      accessKeyExpiresAt: new Date(Date.now() + AccountLink.reusableAccessKeyTtlMs).toISOString(), // 30 days
      amount: 5_000_000,
      chainId: workspace.chain_id,
      expiresAt: new Date(Date.now() + AccountLink.confirmationLinkTtlMs).toISOString(), // 10 minutes
      idempotencyKey: `confirm:${Nanoid.generate()}`,
      kind: 'reusable_access_key',
      memo: null,
      nonce: Nanoid.generate(),
      provider: 'slack',
      providerChannelId: 'tweet-1',
      providerId: 'x',
      providerThreadId: 'tweet-1',
      recipientProviderLabel: '@alice',
      recipientProviderUserId: 'twitter-confirm-recipient',
      senderProviderUserId: 'twitter-confirm-sender',
      source: 'mention',
      tokenAddress: workspace.default_token_address ?? Tempo.addressLookup.pathUsd,
      workspaceId: workspace.id,
    })

    const response = await client.api.confirm[':token'].$get({ param: { token } })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      providerLabel: 'X',
      recipientAvatarUrl: 'https://example.com/alice.jpg',
      recipientProviderLabel: '@alice',
      recipients: [
        {
          recipientAvatarUrl: 'https://example.com/alice.jpg',
          recipientProviderLabel: '@alice',
          recipientProviderUserId: 'twitter-confirm-recipient',
        },
      ],
    })
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
    expect(accessKeys).toHaveLength(0)
    expect(
      history.messages?.some((message) => message.text?.includes(confirmation.payload.memo!)),
    ).toBe(true)
  }, 20_000) // 20 seconds

  test('posts confirmed mention payment receipts in the source thread and clears status', async () => {
    const originalFetch = globalThis.fetch
    const fetchCalls: Parameters<typeof fetch>[] = []
    globalThis.fetch = ((input, init) => {
      fetchCalls.push([input, init])
      return originalFetch(input, init)
    }) as typeof fetch
    const fetchSpy = { mock: { calls: fetchCalls } }
    try {
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
    } finally {
      globalThis.fetch = originalFetch
    }
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
          `<@${Constants.slack.memberUserId}> received a tip on <slack://channel?team=${confirmation.payload.providerId}&id=${apiChannelId}&message=${parent.ts}|this message>:\n• :money_with_wings: <@${Constants.slack.adminUserId}> tipped $5.00 · <`,
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
      .select(['recipient.provider_user_id', 'tip.confirmed_at'])
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
    })
    expect(tips).toEqual([
      expect.objectContaining({
        confirmed_at: expect.any(String),
        provider_user_id: Constants.slack.memberUserId,
      }),
      expect.objectContaining({
        confirmed_at: expect.any(String),
        provider_user_id: secondRecipientProviderUserId,
      }),
    ])
    expect(
      history.messages?.some(
        (message) =>
          message.text?.includes(
            `<@${Constants.slack.memberUserId}> <@${secondRecipientProviderUserId}> $0.000001 each for ${confirmation.payload.memo} · Receipt`,
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
    const batch = await factory.tip_batch.insert({
      amount_each: confirmation.payload.amount,
      idempotency_key: confirmation.payload.idempotencyKey,
      memo,
      provider: confirmation.payload.provider,
      provider_channel_id: confirmation.payload.providerChannelId,
      provider_id: confirmation.payload.providerId,
      provider_thread_id: confirmation.payload.providerThreadId ?? null,
      recipient_count: 1,
      sender_member_id: confirmation.senderMember.id,
      source: 'command',
      status: 'confirmed',
      token_address: confirmation.payload.tokenAddress,
      total_amount: confirmation.payload.amount,
      transaction_hash: `0x${'1'.repeat(64)}`,
      workspace_id: confirmation.workspace.id,
    })
    await factory.tip.insert({
      amount: confirmation.payload.amount,
      batch_id: batch.id,
      chain_id: confirmation.payload.chainId,
      confirmed_at: new Date().toISOString(),
      idempotency_key: confirmation.payload.idempotencyKey,
      memo,
      recipient_id: confirmation.recipientAccount.id,
      recipient_member_id: confirmation.recipientMember.id,
      sender_id: confirmation.senderAccount.id,
      sender_member_id: confirmation.senderMember.id,
      token_address: confirmation.payload.tokenAddress,
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
      .select(['installed_at', 'name', 'provider', 'provider_id', 'uninstalled_at'])
      .where('provider_id', '=', Constants.slack.teamId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('http://localhost/?slack=installed&team=Emulate')
    expect(workspace).toEqual({
      installed_at: expect.any(String),
      name: 'Emulate',
      provider: 'slack',
      provider_id: Constants.slack.teamId,
      uninstalled_at: null,
    })
  })

  test('stores preview reaction tip configs', async () => {
    await deleteSlackOauthWorkspace()
    const previewHost = 'pr18.tip.bot'
    const previewEnv = { ...env, HOST: previewHost as unknown as typeof env.HOST }
    const previewReactionTipEmojis = App.getPreviewReactionTipEmojis(previewHost)
    if (!previewReactionTipEmojis) throw new Error('Expected preview reaction tip emojis.')
    const previewClient = testClient(api, previewEnv, executionCtx)
    const installResponse = await previewClient.api.chat.slack.install.$get()
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

    const response = await previewClient.api.chat.slack.oauth.callback.$get({
      query: {
        code: callbackUrl.searchParams.get('code') ?? '',
        state: callbackUrl.searchParams.get('state') ?? '',
      },
    })
    const workspace = await db
      .selectFrom('workspace')
      .select(['id'])
      .where('provider_id', '=', Constants.slack.teamId)
      .executeTakeFirstOrThrow()
    const reactionTipConfigs = await db
      .selectFrom('reaction_tip_config')
      .select(['amount', 'emoji'])
      .where('workspace_id', '=', workspace.id)
      .orderBy('amount')
      .execute()

    expect(response.status).toBe(302)
    expect(reactionTipConfigs).toEqual(
      Tip.defaultReactionTipConfigs.map((config, index) => ({
        amount: config.amount,
        emoji: previewReactionTipEmojis[index],
      })),
    )
  })

  test('updates existing workspace and redirects', async () => {
    await deleteSlackOauthWorkspace()
    const workspace = await factory.workspace.insert({
      chain_id: Tempo.chainLookup.localnet,
      default_amount: 1234,
      installed_at: null,
      name: 'Old Name',
      provider_id: Constants.slack.teamId,
      uninstalled_at: new Date().toISOString(),
    })
    const account = await factory.account.insert({})
    const member = await insertMember({
      account_id: account.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
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
      .select([
        'chain_id',
        'default_amount',
        'id',
        'installed_at',
        'name',
        'provider',
        'provider_id',
        'uninstalled_at',
      ])
      .where('provider_id', '=', Constants.slack.teamId)
      .execute()
    const existingMember = await db
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .select(['member.id', 'member.workspace_id', 'provider_identity.account_id'])
      .where('member.id', '=', member.id)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(302)
    expect(workspaces).toEqual([
      {
        chain_id: Tempo.chainLookup.localnet,
        default_amount: 1234,
        id: workspace.id,
        installed_at: expect.any(String),
        name: 'Emulate',
        provider: 'slack',
        provider_id: Constants.slack.teamId,
        uninstalled_at: null,
      },
    ])
    expect(existingMember).toEqual({
      account_id: account.id,
      id: member.id,
      workspace_id: workspace.id,
    })
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
  const member = await insertMember({
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
  const senderMember = await insertMember({
    account_id: senderAccount.id,
    provider_user_id: Constants.slack.adminUserId,
    workspace_id: workspace.id,
  })
  const recipientMember = await insertMember({
    account_id: recipientAccount.id,
    provider_user_id: Constants.slack.memberUserId,
    workspace_id: workspace.id,
  })
  const recipientProviderUserIds = options.recipientProviderUserIds ?? [
    Constants.slack.memberUserId,
  ]
  for (const recipientProviderUserId of recipientProviderUserIds.slice(1)) {
    const account = await factory.account.insert({})
    await insertMember({
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

async function postSlackAppHomeOpened(input: { providerId: string; providerUserId: string }) {
  const body = JSON.stringify({
    event: {
      tab: 'home',
      type: 'app_home_opened',
      user: input.providerUserId,
    },
    event_id: `Ev${Nanoid.generate()}`,
    team_id: input.providerId,
    type: 'event_callback',
  })
  return await client.api.chat.slack.$post(
    {},
    {
      headers: {
        ...(await createSlackHeaders(body, env.SLACK_SIGNING_SECRET)),
        'content-type': 'application/json',
      },
      init: { body },
    },
  )
}

function setupSlackViewsPublishFetchSpy() {
  const originalFetch = globalThis.fetch
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  fetchSpy.mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/views.publish')) return Promise.resolve(Response.json({ ok: true }))
    return originalFetch(input, init)
  })
  return fetchSpy
}

async function expectSlackViewsPublishCall(fetchSpy: {
  mock: { calls: Parameters<typeof fetch>[] }
}) {
  const call = fetchSpy.mock.calls.find((call) => {
    const input = call[0]
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return url.endsWith('/views.publish')
  })
  if (!call) throw new Error('Expected Slack views.publish call.')
  const json = await slackFetchBodyJson(call)
  if (typeof json.user_id !== 'string') throw new Error('Expected Slack views.publish user_id.')
  return {
    user_id: json.user_id,
    view: typeof json.view === 'string' ? JSON.parse(json.view) : json.view,
  } as { user_id: string; view: Record<string, unknown> }
}

async function postTwitterWebhook(tweet: unknown) {
  const body = JSON.stringify(tweet)
  if (!env.TWITTER_CONSUMER_SECRET) throw new Error('Expected Twitter consumer secret.')
  return await api.fetch(
    new Request('https://tip.bot/api/chat/twitter', {
      body,
      headers: {
        'content-type': 'application/json',
        'x-twitter-webhooks-signature': `sha256=${await hmacBase64(
          env.TWITTER_CONSUMER_SECRET,
          body,
        )}`,
      },
      method: 'POST',
    }),
    env,
    executionCtx,
  )
}

async function connectTwitterTipAccounts(input: {
  recipientProviderUserId?: string
  senderProviderUserId: string
}) {
  const workspace = await ensureTwitterTestWorkspace()
  const senderRoot = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
  const recipientRoot = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
  const senderAccount = await findOrCreateAccount(senderRoot.address)
  const recipientAccount = await findOrCreateAccount(recipientRoot.address)
  const accessKey = AccessKey.generate()
  const accessKeyExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
  await Actions.token.mintSync(
    createClient({
      chain: Tempo.getChain(Tempo.chainLookup.localnet),
      transport: http(env.RPC_URL_TESTNET),
    }),
    {
      account: Account.fromSecp256k1(env.FEE_PAYER_PRIVATE_KEY_TESTNET),
      amount: parseUnits('1', 6),
      to: senderRoot.address,
      token: Tempo.addressLookup.pathUsd,
    },
  )
  const senderMember = await insertMember({
    account_id: senderAccount.id,
    login: '@bob',
    provider_user_id: input.senderProviderUserId,
    workspace_id: workspace.id,
  })
  const accessKeyRow = await factory.access_key.insert({
    account_id: senderAccount.id,
    address: accessKey.address,
    authorization: JSON.stringify(
      await AccountLink.signKeyAuthorization(senderRoot, {
        accessKeyAddress: accessKey.address,
        chainId: workspace.chain_id,
        expiresAt: accessKeyExpiresAt,
        tokenAddress: Tempo.addressLookup.pathUsd,
      }),
    ),
    chain_id: workspace.chain_id,
    ciphertext: await AccessKey.encrypt(env, accessKey.privateKey),
    expires_at: accessKeyExpiresAt,
    token_address: Tempo.addressLookup.pathUsd,
  })
  if (!input.recipientProviderUserId)
    return { accessKey: accessKeyRow, senderAccount, senderMember, workspace }
  const recipientMember = await insertMember({
    account_id: recipientAccount.id,
    login: '@alice',
    provider_user_id: input.recipientProviderUserId,
    workspace_id: workspace.id,
  })
  return {
    accessKey: accessKeyRow,
    recipientAccount,
    recipientMember,
    senderAccount,
    senderMember,
    workspace,
  }
}

async function ensureTwitterTestWorkspace(input?: {
  chainId?: number
  tokenAddress?: string | null
}) {
  const chainId = input?.chainId ?? Tempo.chainLookup.localnet
  const tokenAddress = input?.tokenAddress ?? Tempo.addressLookup.pathUsd
  const existing = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', 'slack')
    .where('provider_id', '=', 'x')
    .executeTakeFirst()
  if (existing) {
    await db
      .updateTable('workspace')
      .set({
        chain_id: chainId,
        default_token_address: tokenAddress,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', existing.id)
      .execute()
    return await db
      .selectFrom('workspace')
      .selectAll()
      .where('id', '=', existing.id)
      .executeTakeFirstOrThrow()
  }
  return await factory.workspace.insert({
    chain_id: chainId,
    default_token_address: tokenAddress,
    name: 'X',
    provider: 'slack',
    provider_id: 'x',
  })
}

async function linkTwitterAccount(input: {
  handle: string
  memberId?: string
  providerUserId: string
  root: ReturnType<typeof Account.fromSecp256k1>
  workspaceId: string
}) {
  const account = await findOrCreateAccount(input.root.address)
  if (!input.memberId) {
    await insertMember({
      account_id: account.id,
      login: `@${input.handle}`,
      provider_user_id: input.providerUserId,
      workspace_id: input.workspaceId,
    })
    return account
  }
  const member = await db
    .selectFrom('member')
    .select(['provider_identity_id'])
    .where('id', '=', input.memberId)
    .where('provider_user_id', '=', input.providerUserId)
    .executeTakeFirstOrThrow()
  await db
    .updateTable('provider_identity')
    .set({
      account_id: account.id,
      display_name: `@${input.handle}`,
      provider_global_user_id: input.providerUserId,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', member.provider_identity_id)
    .execute()
  await db
    .updateTable('member')
    .set({ login: `@${input.handle}`, updated_at: new Date().toISOString() })
    .where('id', '=', input.memberId)
    .execute()
  return account
}

async function completeTwitterProofLink(input: {
  handle: string
  providerUserId: string
  root: ReturnType<typeof Account.fromSecp256k1>
  tweetId: string
}) {
  mockTwitterUser({ id: input.providerUserId, username: input.handle })
  const challengeResponse = await client.api.link.twitter.challenge.$post({
    json: { address: input.root.address, username: input.handle },
  })
  expect(challengeResponse.status).toBe(200)
  if (challengeResponse.status !== 200) throw new Error('Expected Twitter challenge success.')
  const challenge = await challengeResponse.json()
  const keyAuthorization = await AccountLink.signKeyAuthorization(input.root, {
    accessKeyAddress: challenge.accessKeyAddress,
    chainId: challenge.chainId,
    expiresAt: challenge.accessKeyExpiry,
    tokenAddress: challenge.tokenAddress,
  })
  const proofResponse = await client.api.link.twitter.proof.$post({
    json: {
      address: input.root.address,
      challengeId: challenge.challengeId,
      keyAuthorization,
    },
  })
  expect(proofResponse.status).toBe(200)
  if (proofResponse.status !== 200) throw new Error('Expected Twitter proof success.')
  const proof = await proofResponse.json()
  server.use(
    mswHttp.get(`https://api.twitter.com/2/tweets/${input.tweetId}`, () =>
      HttpResponse.json({
        data: { author_id: input.providerUserId, id: input.tweetId, text: proof.tweetText },
        includes: { users: [{ id: input.providerUserId, username: input.handle }] },
      }),
    ),
  )
  const verifyResponse = await client.api.link.twitter.verify.$post({
    json: {
      challengeId: challenge.challengeId,
      proof: proof.proof,
      tweetUrl: `https://x.com/${input.handle}/status/${input.tweetId}`,
    },
  })

  expect(verifyResponse.status).toBe(200)
  await expect(verifyResponse.json()).resolves.toEqual({ handle: `@${input.handle}`, ok: true })
  return { challenge, keyAuthorization, proof }
}

async function startTwitterOAuthLink(root: ReturnType<typeof Account.fromSecp256k1>) {
  const challengeResponse = await client.api.link.twitter.oauth.challenge.$post({
    json: { address: root.address },
  })
  expect(challengeResponse.status).toBe(200)
  if (challengeResponse.status !== 200) throw new Error('Expected Twitter OAuth challenge success.')
  const challenge = await challengeResponse.json()
  const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
    accessKeyAddress: challenge.accessKeyAddress,
    chainId: challenge.chainId,
    expiresAt: challenge.accessKeyExpiry,
    tokenAddress: challenge.tokenAddress,
  })
  const startResponse = await api.fetch(
    new Request('https://tip.bot/api/link/twitter/oauth/start', {
      body: JSON.stringify({
        address: root.address,
        challengeId: challenge.challengeId,
        keyAuthorization,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
    env,
    executionCtx,
  )
  expect(startResponse.status).toBe(200)
  const start = (await startResponse.json()) as { authorizationUrl: string; ok: true }
  const authorizationUrl = new URL(start.authorizationUrl)
  return {
    authorizationUrl,
    challenge,
    keyAuthorization,
    state: authorizationUrl.searchParams.get('state'),
  }
}

function mockTwitterOAuthExchange(input: { providerUserId: string; username: string }) {
  server.use(
    mswHttp.post('https://api.twitter.com/2/oauth2/token', () =>
      HttpResponse.json({ access_token: 'oauth-access-token', token_type: 'bearer' }),
    ),
    mswHttp.get('https://api.twitter.com/2/users/me', () =>
      HttpResponse.json({
        data: { id: input.providerUserId, name: input.username, username: input.username },
      }),
    ),
  )
}

function mockTwitterUser(input: { id: string; username: string }) {
  server.use(
    mswHttp.get(`https://api.twitter.com/2/users/by/username/${input.username}`, () =>
      HttpResponse.json({
        data: {
          id: input.id,
          name: input.username,
          profile_image_url: `https://example.com/${input.username}.jpg`,
          username: input.username,
        },
      }),
    ),
  )
}

async function hmacBase64(key: string, message: string) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)),
  )
  let binary = ''
  for (const byte of signature) binary += String.fromCharCode(byte)
  return btoa(binary)
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

async function slackFetchBodyJson(
  call: Parameters<typeof fetch>,
): Promise<Record<string, unknown>> {
  const input = call[0]
  const init = call[1]
  if (input instanceof Request) return slackFetchBodyStringJson(await input.clone().text())
  return slackFetchBodyStringJson(init?.body)
}

function slackFetchBodyStringJson(body: BodyInit | null | undefined): Record<string, unknown> {
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries())
  if (typeof body !== 'string') return {}
  if (body.trim().startsWith('{')) return JSON.parse(body) as Record<string, unknown>
  return Object.fromEntries(new URLSearchParams(body).entries())
}

function twitterProviderUserId() {
  return `1${Date.now()}${Math.floor(Math.random() * 1_000_000)}`
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

async function insertMember(
  attrs: Partial<DB_gen.Insertable.member> &
    Pick<DB_gen.Insertable.member, 'workspace_id'> & { account_id?: string | null },
) {
  const member = factory.member.attrs(attrs as never)
  const { account_id: accountId, ...memberValues } = member as typeof member & {
    account_id?: string | null
  }
  if (member.provider_identity_id) return await factory.member.insert(memberValues)

  const workspace = await db
    .selectFrom('workspace')
    .select(['provider', 'provider_id'])
    .where('id', '=', member.workspace_id)
    .executeTakeFirstOrThrow()
  const identity = await factory.provider_identity.insert({
    account_id: accountId ?? null,
    created_at: member.created_at,
    display_name: member.login,
    provider: workspace.provider,
    provider_user_id: member.provider_user_id,
    provider_workspace_id: workspace.provider_id,
    real_name: member.name,
    updated_at: member.updated_at,
  })
  return await factory.member.insert({ ...memberValues, provider_identity_id: identity.id })
}
