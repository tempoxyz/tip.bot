import { createHmac } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { createEmulator, type Emulator } from 'emulate'
import { createClient } from 'viem'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createClient as createDb } from '#db/client.ts'
import * as Slack from '#/adapters/slack.ts'
import { api } from '#/api.ts'
import { encryptSecret } from '#/lib/crypto.ts'
import { createRelayTransport } from '#/lib/relay.ts'
import { getTempoChain } from '#/lib/tempo.ts'
import { Env as TestEnv, type TestEnv as TestEnvironment } from '../../test/env.ts'
import { Factory } from '../../test/factory.ts'

const signingSecret = 'test-signing-secret'

let slack: SlackEmulator

beforeAll(async () => {
  slack = await startSlackEmulator()
})

afterAll(async () => {
  await slack?.stop()
})

test('slash config returns current workspace config', async () => {
  const body = new URLSearchParams({
    team_id: 'T000000001',
    text: 'config',
    trigger_id: 'trigger-1',
    user_id: 'U000000001',
  }).toString()

  const response = await Slack.handleCommandRequest(
    await createEnv(slack.apiUrl),
    createSlackRequest('/api/slack/commands', body),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    response_type: 'ephemeral',
    text: 'Current config: emoji money_with_wings, amount 0.001, cap 1',
  })
})

test('slash config does not require Slack bot lookup for read-only config', async () => {
  const env = await createEnv(slack.apiUrl)
  await createDb(env.DB).deleteFrom('slack_installation').execute()
  const body = new URLSearchParams({
    team_id: 'T000000001',
    text: 'config',
    trigger_id: 'trigger-1',
    user_id: 'U000000001',
  }).toString()

  const response = await Slack.handleCommandRequest(
    env,
    createSlackRequest('/api/slack/commands', body),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    response_type: 'ephemeral',
    text: 'Current config: emoji money_with_wings, amount 0.001, cap 1',
  })
})

test('/tip connect response is only visible to the command sender', async () => {
  const body = new URLSearchParams({
    team_id: 'T000000001',
    text: 'connect',
    trigger_id: 'trigger-1',
    user_id: 'U000000001',
  }).toString()

  const response = await Slack.handleCommandRequest(
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
  const txHash = await insertConfirmedTip(env, 'trigger-public')
  const body = new URLSearchParams({
    team_id: 'T000000001',
    text: '<@U000000002> for coffee',
    trigger_id: 'trigger-public',
    user_id: 'U000000001',
  }).toString()

  const response = await Slack.handleCommandRequest(
    env,
    createSlackRequest('/api/slack/commands', body),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    response_type: 'in_channel',
    text: `Already sent: <@U000000001> → <@U000000002> 0.001 stablecoins for coffee. <https://explore.testnet.tempo.xyz/tx/${txHash}|Tx 0x1234…cdef>`,
  })
})

test('/tip retries a previously failed idempotency key', async () => {
  const env = await createEnv(slack.apiUrl)
  const factory = Factory.create(createDb(env.DB))
  const [sender, recipient] = await factory.account.insert(
    {
      access_key_address: '0x1111111111111111111111111111111111111111',
      access_key_authorization: '{}',
      access_key_ciphertext: await encryptSecret(
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        env.ACCESS_KEY_ENCRYPTION_SECRET,
      ),
      access_key_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
      platform_account_id: 'U000000001',
      tempo_address: '0x1111111111111111111111111111111111111111',
      workspace_id: 'workspace-test',
    },
    {
      platform_account_id: 'U000000002',
      tempo_address: '0x2222222222222222222222222222222222222222',
      workspace_id: 'workspace-test',
    },
  )
  const tip = await factory.tip.insert({
    error: 'previous failure',
    idempotency_key: 'command:T000000001:trigger-failed',
    recipient_account_id: recipient.id,
    sender_account_id: sender.id,
    status: 'failed',
    workspace_id: 'workspace-test',
  })
  const body = new URLSearchParams({
    team_id: 'T000000001',
    text: '<@U000000002> for coffee',
    trigger_id: 'trigger-failed',
    user_id: 'U000000001',
  }).toString()

  const response = await Slack.handleCommandRequest(
    env,
    createSlackRequest('/api/slack/commands', body),
  )

  const retry = await createDb(env.DB)
    .selectFrom('tip_attempt')
    .select('id')
    .where('tip_id', '=', tip.id)
    .executeTakeFirst()
  const stored = await createDb(env.DB)
    .selectFrom('tip')
    .select(['error', 'status'])
    .where('id', '=', tip.id)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(((await response.json()) as { text: string }).text).not.toContain(
    'Tip already recorded with status failed.',
  )
  expect(retry?.id).toBeTruthy()
  expect(stored.status).toBe('failed')
  expect(stored.error).not.toBe('previous failure')
})

test('slash tip command returns before sending tip when execution context is available', async () => {
  const env = await createEnv(slack.apiUrl)
  const txHash = await insertConfirmedTip(env, 'trigger-async')
  const waitUntil: Promise<unknown>[] = []
  const fetchBefore = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe('https://hooks.slack.test/response')
    expect(JSON.parse(String(init?.body))).toEqual({
      replace_original: true,
      response_type: 'in_channel',
      text: `Already sent: <@U000000001> → <@U000000002> 0.001 stablecoins for coffee. <https://explore.testnet.tempo.xyz/tx/${txHash}|Tx 0x1234…cdef>`,
    })
    return Response.json({ ok: true })
  }) as typeof fetch
  try {
    const body = new URLSearchParams({
      response_url: 'https://hooks.slack.test/response',
      team_id: 'T000000001',
      text: '<@U000000002> for coffee',
      trigger_id: 'trigger-async',
      user_id: 'U000000001',
    }).toString()

    const response = await Slack.handleCommandRequest(
      env,
      createSlackRequest('/api/slack/commands', body),
      { waitUntil: (promise) => waitUntil.push(promise) },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ response_type: 'in_channel', text: 'Sending tip.' })
    await Promise.all(waitUntil)
  } finally {
    globalThis.fetch = fetchBefore
  }
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

  const response = await Slack.handleEventRequest(
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
  ).toBe(false)

  const history = await slackApi<{ messages: Array<{ text?: string }> }>(
    slack.apiUrl,
    'conversations.history',
    {
      channel: 'C000000001',
      limit: '5',
    },
  )
  expect(
    history.messages.some((message) => message.text?.includes('connect your Tempo Wallet')),
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
      text: '<@B000000001> introduce yourself king!',
      ts: parent.ts,
      type: 'app_mention',
      user: 'U000000001',
    },
    event_id: 'Ev000000002',
    team_id: 'T000000001',
    type: 'event_callback',
  })

  const response = await Slack.handleEventRequest(
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
  expect(replies.messages.some((message) => message.text?.includes('I’m Tipbot'))).toBe(false)

  const history = await slackApi<{ messages: Array<{ text?: string }> }>(
    slack.apiUrl,
    'conversations.history',
    {
      channel: 'C000000001',
      limit: '5',
    },
  )
  expect(history.messages.some((message) => message.text?.includes('I’m Tipbot'))).toBe(true)
})

test('invalid Slack signatures are rejected', async () => {
  const response = await Slack.handleCommandRequest(
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

test('relay chain route is served from the Hono API route', async () => {
  const response = await api.fetch(new Request('http://tip.test/api/relay/919'), {
    ...TestEnv.get(),
    FEE_PAYER_PRIVATE_KEY: '',
  } as unknown as Env)

  expect(response.status).toBe(500)
  expect(await response.text()).toBe('Fee payer is not configured.')
})

test('server relay transport calls the relay in process', async () => {
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('global fetch should not be called')
  }
  try {
    const chain = getTempoChain('testnet')
    const client = createClient({
      chain,
      transport: createRelayTransport(
        { ...TestEnv.get(), FEE_PAYER_PRIVATE_KEY: '' } as unknown as Env,
        chain.id,
      ),
    })

    await expect(
      client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }),
    ).rejects.toThrow('Fee payer is not configured.')
  } finally {
    globalThis.fetch = fetchBefore
  }
})

test('Slack OAuth install stores workspace bot token', async () => {
  const env = await createEnv(slack.apiUrl, {
    ACCESS_KEY_ENCRYPTION_SECRET: 'oauth-test-secret',
    HOST: 'tip-public.test',
    SLACK_CLIENT_ID: '123.456',
    SLACK_CLIENT_SECRET: 'client-secret',
  })
  const installUrl = new URL(
    await Slack.createInstallUrl(new Request('http://tip.test/slack/install'), env),
  )
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
  if (!env.ACCESS_KEY_ENCRYPTION_SECRET)
    throw new Error('ACCESS_KEY_ENCRYPTION_SECRET is not configured.')

  const factory = Factory.create(createDb(env.DB))
  const workspace = await factory.workspace.insert({
    id: 'workspace-test',
    platform_team_id: 'T000000001',
  })
  await factory.slack_installation.insert({
    bot_token_ciphertext: await encryptSecret('xoxb-test', env.ACCESS_KEY_ENCRYPTION_SECRET),
    bot_user_id: 'B000000001',
    id: 'slack-installation-test',
    installed_by: 'U000000001',
    team_id: 'T000000001',
    team_name: 'Tip Test',
    workspace_id: workspace.id,
  })
}

async function insertConfirmedTip(env: Env & TestEnvironment, triggerId: string) {
  const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
  const factory = Factory.create(createDb(env.DB))
  const [sender, recipient] = await factory.account.insert(
    {
      access_key_address: '0x1111111111111111111111111111111111111111',
      access_key_authorization: '{}',
      access_key_ciphertext: await encryptSecret('0xprivate', env.ACCESS_KEY_ENCRYPTION_SECRET),
      access_key_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
      platform_account_id: 'U000000001',
      tempo_address: '0x1111111111111111111111111111111111111111',
      workspace_id: 'workspace-test',
    },
    {
      platform_account_id: 'U000000002',
      tempo_address: '0x2222222222222222222222222222222222222222',
      workspace_id: 'workspace-test',
    },
  )
  await factory.tip.insert({
    idempotency_key: `command:T000000001:${triggerId}`,
    reason: 'coffee',
    recipient_account_id: recipient.id,
    sender_account_id: sender.id,
    status: 'confirmed',
    token_address: '0x0000000000000000000000000000000000000000',
    tx_hash: txHash,
    workspace_id: 'workspace-test',
  })
  return txHash
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
  for (const migration of readdirSync(resolve('db/migrations')).sort())
    sqlite.exec(readFileSync(resolve('db/migrations', migration), 'utf8'))
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
