import { createHmac } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { createEmulator, type Emulator } from 'emulate'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { api } from '#/lib/api.ts'
import { encryptSecret } from '#/lib/crypto.ts'
import { createDb } from '#/lib/db.ts'
import { handleSlackCommandRequest, handleSlackEventRequest } from '#/lib/slackHandlers.ts'
import { Env as TestEnv, type TestEnv as TestEnvironment } from './env.ts'

const signingSecret = 'test-signing-secret'

let slack: SlackEmulator

beforeAll(async () => {
  slack = await startSlackEmulator()
})

afterAll(async () => {
  await slack?.stop()
})

test('slash config uses Emulate Slack admin lookup', async () => {
  const body = new URLSearchParams({
    team_id: 'T000000001',
    text: 'config',
    trigger_id: 'trigger-1',
    user_id: 'U000000001',
  }).toString()

  const response = await handleSlackCommandRequest(
    await createEnv(slack.apiUrl),
    createSlackRequest('/api/slack/commands', body),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    response_type: 'ephemeral',
    text: 'Current config: emoji money_with_wings, amount 0.0001, cap 1',
  })
})

test('/tip connect response is only visible to the command sender', async () => {
  const body = new URLSearchParams({
    team_id: 'T000000001',
    text: 'connect',
    trigger_id: 'trigger-1',
    user_id: 'U000000001',
  }).toString()

  const response = await handleSlackCommandRequest(
    await createEnv(slack.apiUrl),
    createSlackRequest('/api/slack/commands', body),
  )

  expect(response.status).toBe(200)
  const json = (await response.json()) as { response_type: string; text: string }
  expect(json).toMatchObject({
    response_type: 'ephemeral',
  })

  const url = new URL(json.text.match(/https?:\S+/)?.[0] ?? '')
  expect(url.searchParams.get('token')).toMatch(/^[0-9a-z]{24}$/)
})

test('/tip success is public and links the transaction', async () => {
  const env = await createEnv(slack.apiUrl)
  const now = new Date().toISOString()
  const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
  await createDb(env.DB)
    .insertInto('account')
    .values([
      {
        access_key_address: '0x1111111111111111111111111111111111111111',
        access_key_authorization: '{}',
        access_key_ciphertext: await encryptSecret('0xprivate', env.ACCESS_KEY_ENCRYPTION_SECRET),
        access_key_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
        created_at: now,
        id: 'account-sender',
        platform: 'slack',
        platform_account_id: 'U000000001',
        tempo_address: '0x1111111111111111111111111111111111111111',
        updated_at: now,
        workspace_id: 'workspace-test',
      },
      {
        access_key_address: null,
        access_key_authorization: null,
        access_key_ciphertext: null,
        access_key_expires_at: null,
        created_at: now,
        id: 'account-recipient',
        platform: 'slack',
        platform_account_id: 'U000000002',
        tempo_address: '0x2222222222222222222222222222222222222222',
        updated_at: now,
        workspace_id: 'workspace-test',
      },
    ])
    .execute()
  await createDb(env.DB)
    .insertInto('tip')
    .values({
      amount: '0.0001',
      created_at: now,
      id: 'tip-existing',
      idempotency_key: 'command:T000000001:trigger-public',
      reason: 'coffee',
      recipient_account_id: 'account-recipient',
      sender_account_id: 'account-sender',
      source_type: 'command',
      status: 'confirmed',
      token_address: '0x0000000000000000000000000000000000000000',
      tx_hash: txHash,
      updated_at: now,
      workspace_id: 'workspace-test',
    })
    .execute()
  const body = new URLSearchParams({
    team_id: 'T000000001',
    text: '<@U000000002> for coffee',
    trigger_id: 'trigger-public',
    user_id: 'U000000001',
  }).toString()

  const response = await handleSlackCommandRequest(
    env,
    createSlackRequest('/api/slack/commands', body),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    response_type: 'in_channel',
    text: `Already sent: <@U000000001> → <@U000000002> 0.0001 stablecoins for coffee. <https://explore.testnet.tempo.xyz/tx/${txHash}|Tx 0x1234…cdef>`,
  })
})

test('app mention can tip without an extra tip verb', async () => {
  const parent = await slackApi<{ ok: boolean; ts: string }>(slack.apiUrl, 'chat.postMessage', {
    channel: 'C000000001',
    text: '<@U000000001> tip <@U000000002> for coffee',
  })
  const body = JSON.stringify({
    event: {
      channel: 'C000000001',
      text: '<@B000000001> <@U000000002> for coffee',
      ts: parent.ts,
      type: 'app_mention',
      user: 'U000000001',
    },
    event_id: 'Ev000000001',
    team_id: 'T000000001',
    type: 'event_callback',
  })

  const response = await handleSlackEventRequest(
    await createEnv(slack.apiUrl),
    createSlackRequest('/api/slack/events', body, 'application/json'),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })

  const replies = await slackApi<{ messages: Array<{ text?: string }> }>(
    slack.apiUrl,
    'conversations.replies',
    {
      channel: 'C000000001',
      ts: parent.ts,
    },
  )
  expect(
    replies.messages.some((message) => message.text?.includes('connect your Tempo Wallet')),
  ).toBe(true)
})

test('app mention can introduce Tipbot', async () => {
  const parent = await slackApi<{ ok: boolean; ts: string }>(slack.apiUrl, 'chat.postMessage', {
    channel: 'C000000001',
    text: '<@U000000001> ask Tipbot for help',
  })
  const body = JSON.stringify({
    event: {
      channel: 'C000000001',
      text: '<@B000000001> introduce yourself',
      ts: parent.ts,
      type: 'app_mention',
      user: 'U000000001',
    },
    event_id: 'Ev000000002',
    team_id: 'T000000001',
    type: 'event_callback',
  })

  const response = await handleSlackEventRequest(
    await createEnv(slack.apiUrl),
    createSlackRequest('/api/slack/events', body, 'application/json'),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })

  const replies = await slackApi<{ messages: Array<{ text?: string }> }>(
    slack.apiUrl,
    'conversations.replies',
    {
      channel: 'C000000001',
      ts: parent.ts,
    },
  )
  expect(replies.messages.some((message) => message.text?.includes('I’m Tipbot'))).toBe(true)
})

test('invalid Slack signatures are rejected', async () => {
  const response = await handleSlackCommandRequest(
    await createEnv(slack.apiUrl),
    new Request('http://tip.test/api/slack/commands', {
      body: 'text=config',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-slack-signature': 'v0=bad',
      },
      method: 'POST',
    }),
  )

  expect(response.status).toBe(401)
})

test('relay is served from the Hono API route', async () => {
  const response = await api.fetch(new Request('http://tip.test/api/relay'), {
    ...TestEnv.get(),
    FEE_PAYER_PRIVATE_KEY: '',
  } as unknown as Env)

  expect(response.status).toBe(500)
  expect(await response.text()).toBe('Fee payer is not configured.')
})

test('Slack OAuth install stores workspace bot token', async () => {
  const env = await createEnv(slack.apiUrl, {
    ACCESS_KEY_ENCRYPTION_SECRET: 'oauth-test-secret',
    SLACK_APP_BASE_URL: 'https://tip-public.test',
    SLACK_CLIENT_ID: '123.456',
    SLACK_CLIENT_SECRET: 'client-secret',
  })
  const installResponse = await api.fetch(new Request('http://tip.test/api/slack/install'), env)
  const installLocation = installResponse.headers.get('location')
  const installUrl = new URL(installLocation ?? '')
  expect(installResponse.status).toBe(302)
  expect(installUrl.origin).toBe('https://slack.com')
  expect(installUrl.searchParams.get('client_id')).toBe('123.456')
  expect(installUrl.searchParams.get('redirect_uri')).toBe(
    'https://tip-public.test/api/slack/oauth/callback',
  )

  const fetchBefore = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe(`${slack.apiUrl}oauth.v2.access`)
    expect((init?.body as URLSearchParams).get('code')).toBe('oauth-code')
    expect((init?.body as URLSearchParams).get('redirect_uri')).toBe(
      'https://tip-public.test/api/slack/oauth/callback',
    )
    return Response.json({
      access_token: 'xoxb-installed',
      authed_user: { id: 'UINSTALLER' },
      bot_user_id: 'B000000001',
      ok: true,
      scope: 'commands,chat:write',
      team: { id: 'T000000001', name: 'Tip Test' },
    })
  }) as typeof fetch

  try {
    const callbackResponse = await api.fetch(
      new Request(
        `http://tip.test/api/slack/oauth/callback?code=oauth-code&state=${installUrl.searchParams.get('state')}`,
      ),
      env,
    )
    expect(callbackResponse.status).toBe(302)
  } finally {
    globalThis.fetch = fetchBefore
  }

  const installation = await createDb(env.DB)
    .selectFrom('slack_installation')
    .select(['bot_user_id', 'team_id', 'team_name'])
    .executeTakeFirstOrThrow()
  expect(installation).toEqual({
    bot_user_id: 'B000000001',
    team_id: 'T000000001',
    team_name: 'Tip Test',
  })
})

async function slackApi<T>(apiUrl: string, method: string, body: Record<string, string>) {
  const response = await fetch(`${apiUrl}${method}`, {
    body: new URLSearchParams(body),
    headers: { authorization: 'Bearer xoxb-test' },
    method: 'POST',
  })
  expect(response.ok).toBe(true)
  return (await response.json()) as T
}

async function startSlackEmulator() {
  const port = await getAvailablePort()
  const emulator = await createEmulator({ port, service: 'slack' })
  return {
    apiUrl: `${emulator.url}/api/`,
    stop: () => emulator.close(),
  }
}

async function getAvailablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  if (!address || typeof address === 'string') throw new Error('Could not allocate a port.')
  return address.port
}

async function createEnv(apiUrl: string, overrides: Partial<TestEnvironment> = {}) {
  const env = {
    ...TestEnv.get(),
    DB: createTestDatabase(),
    SLACK_API_URL: apiUrl,
    ...overrides,
  } as TestEnvironment
  await installSlackTestApp(env)
  return env as unknown as Env & TestEnvironment
}

async function installSlackTestApp(env: TestEnvironment) {
  const now = new Date().toISOString()
  if (!env.ACCESS_KEY_ENCRYPTION_SECRET)
    throw new Error('ACCESS_KEY_ENCRYPTION_SECRET is not configured.')

  await createDb(env.DB)
    .insertInto('workspace')
    .values({
      created_at: now,
      daily_cap: '1',
      id: 'workspace-test',
      platform: 'slack',
      platform_team_id: 'T000000001',
      tip_amount: '0.0001',
      tip_emoji: 'money_with_wings',
      updated_at: now,
    })
    .execute()
  await createDb(env.DB)
    .insertInto('slack_installation')
    .values({
      bot_token_ciphertext: await encryptSecret('xoxb-test', env.ACCESS_KEY_ENCRYPTION_SECRET),
      bot_user_id: 'B000000001',
      created_at: now,
      enterprise_id: null,
      id: 'slack-installation-test',
      installed_by: 'U000000001',
      scopes: 'commands,chat:write',
      team_id: 'T000000001',
      team_name: 'Tip Test',
      updated_at: now,
      workspace_id: 'workspace-test',
    })
    .execute()
}

function createSlackRequest(
  path: string,
  body: string,
  contentType = 'application/x-www-form-urlencoded',
) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  return new Request(`http://tip.test${path}`, {
    body,
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${createHmac('sha256', signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest('hex')}`,
    },
    method: 'POST',
  })
}

function createTestDatabase() {
  const sqlite = new Database(':memory:')
  for (const migration of readdirSync(resolve('migrations')).sort())
    sqlite.exec(readFileSync(resolve('migrations', migration), 'utf8'))
  return {
    prepare(sql: string) {
      let parameters: unknown[] = []
      const statement = sqlite.prepare(sql)
      const d1Statement = {
        all: async () => {
          if (statement.reader)
            return {
              error: null,
              meta: { changes: 0, last_row_id: undefined },
              results: statement.all(...parameters),
              success: true,
            }

          const result = statement.run(...parameters)
          return {
            error: null,
            meta: { changes: result.changes, last_row_id: result.lastInsertRowid },
            results: [],
            success: true,
          }
        },
        bind: (...values: unknown[]) => {
          parameters = values
          return d1Statement
        },
      }
      return d1Statement
    },
  } as unknown as D1Database
}

type SlackEmulator = {
  apiUrl: string
  stop: Emulator['close']
}
