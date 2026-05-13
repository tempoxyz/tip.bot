import { Hex } from 'ox'

export async function createSlackHeaders(body: string, signingSecret: string) {
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
    'x-slack-signature': `v0=${Hex.fromBytes(new Uint8Array(digest)).slice(2)}`,
  }
}

export async function verifySlackSignature(input: {
  body: string
  signature: string | null
  signingSecret: string
  timestamp: string | null
}) {
  if (!input.timestamp || !input.signature) return false
  const timestamp = Number.parseInt(input.timestamp, 10)
  if (!Number.isFinite(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300)
    return false

  const signature = input.signature.match(/^v0=([0-9a-f]{64})$/i)?.[1]?.toLowerCase()
  if (!signature) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.signingSecret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${input.timestamp}:${input.body}`),
  )
  const expected = Hex.fromBytes(new Uint8Array(digest)).slice(2)
  let result = 0
  for (let i = 0; i < expected.length; i++)
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return result === 0
}
