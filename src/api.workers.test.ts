// oxlint-disable-next-line typescript-eslint/triple-slash-reference: Workers pool module types are ambient.
/// <reference path="./worker-configuration.d.ts" />

import { exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'

const signingSecret = 'test-signing-secret'

test('Slack URL verification reaches the Worker API route', async () => {
  const body = JSON.stringify({
    challenge: 'slack-challenge',
    event_id: 'Ev000000001',
    team_id: 'T000000001',
    type: 'url_verification',
  })

  const response = await worker.fetch('https://tip.test/api/slack/events', {
    body,
    headers: {
      ...(await createSlackHeaders(body)),
      'content-type': 'application/json',
    },
    method: 'POST',
  })

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('slack-challenge')
})

test('invalid Slack signatures are rejected by the Worker API route', async () => {
  const response = await worker.fetch('https://tip.test/api/slack/events', {
    body: '{}',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-slack-signature': 'v0=bad',
    },
    method: 'POST',
  })

  expect(response.status).toBe(401)
})

test('server relay transport does not fetch the public Worker from the Worker runtime', async () => {
  const response = await worker.fetch('https://tip.test/__test/serverRelayTransport')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
})

test('relay fill response adds missing Tempo fee caps before signing', async () => {
  const response = await worker.fetch('https://tip.test/__test/relayFillAddsFeeCaps')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    gas: '0x4c4b40',
    maxFeePerGas: '0xcb',
    maxPriorityFeePerGas: '0x3',
  })
})

const worker = exports.default as { fetch: typeof fetch }

async function createSlackHeaders(body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  )
  return {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${bytesToHex(new Uint8Array(digest))}`,
  }
}

function bytesToHex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
