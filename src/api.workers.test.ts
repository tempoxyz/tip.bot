import { env } from 'cloudflare:workers'
import { testClient } from 'hono/testing'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '#/api.ts'
import { createSlackHeaders } from '#test/slack.ts'

let waitUntil: Promise<unknown>[] = []
const executionCtx = {
  passThroughOnException: vi.fn(),
  props: {},
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    waitUntil.push(promise)
  }),
}
const client = testClient(api, env, executionCtx)

beforeEach(() => {
  waitUntil = []
  executionCtx.passThroughOnException.mockClear()
  executionCtx.waitUntil.mockClear()
})

describe('/api/chat/slack', () => {
  test('Slack URL verification reaches the Worker API route', async () => {
    const body = JSON.stringify({
      challenge: 'slack-challenge',
      event_id: 'Ev000000001',
      team_id: 'T000000001',
      type: 'url_verification',
    })

    const response = await client.api.chat.slack.$post(
      {},
      {
        headers: {
          ...(await createSlackHeaders(body)),
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
