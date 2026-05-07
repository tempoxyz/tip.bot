import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { createEmulator, type Emulator } from 'emulate'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { handleSlackCommandRequest, handleSlackEventRequest } from '#/lib/slackHandlers.ts'
import type { TipEnv } from '#/lib/tipEngine.ts'

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
    createEnv(slack.apiUrl),
    createSlackRequest('/api/slack/commands', body),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    response_type: 'ephemeral',
    text: 'Current config: emoji money_with_wings, amount 0.0001, cap 1',
  })
})

test('app mention posts a thread reply through Emulate Slack', async () => {
  const parent = await slackApi<{ ok: boolean; ts: string }>(slack.apiUrl, 'chat.postMessage', {
    channel: 'C000000001',
    text: '<@U000000001> tip <@U000000002> for coffee',
  })
  const body = JSON.stringify({
    event: {
      channel: 'C000000001',
      text: '<@B000000001> tip <@U000000002> for coffee',
      ts: parent.ts,
      type: 'app_mention',
      user: 'U000000001',
    },
    event_id: 'Ev000000001',
    team_id: 'T000000001',
    type: 'event_callback',
  })

  const response = await handleSlackEventRequest(
    createEnv(slack.apiUrl),
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

test('invalid Slack signatures are rejected', async () => {
  const response = await handleSlackCommandRequest(
    createEnv(slack.apiUrl),
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

function createEnv(apiUrl: string) {
  return {
    DB: createTestDatabase(),
    SLACK_API_URL: apiUrl,
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: signingSecret,
  } as TipEnv
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
  sqlite.exec(readFileSync(resolve('migrations/0001_initial.sql'), 'utf8'))
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
