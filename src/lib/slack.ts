import { Hex } from 'ox'

export type SlackErrorClass =
  | 'duplicate_or_conflict'
  | 'invalid_destination'
  | 'invalid_payload'
  | 'rate_limited'
  | 'restricted_destination'
  | 'transient_slack_error'
  | 'unknown_slack_error'

export type SlackErrorInfo = {
  code?: string
  errorClass: SlackErrorClass
  message: string
  retryable: boolean
  status?: number
}

export function classifySlackError(error: unknown): SlackErrorInfo {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const response =
    record.response && typeof record.response === 'object'
      ? (record.response as Record<string, unknown>)
      : {}
  const data =
    response.data && typeof response.data === 'object'
      ? (response.data as Record<string, unknown>)
      : {}
  const status = typeof response.status === 'number' ? response.status : undefined
  const code = stringValue(
    record.code ?? record.error ?? data.code ?? data.error ?? data.error_code,
  )
    .trim()
    .toLowerCase()
  const message = (() => {
    if (error instanceof Error) return error.message
    if (typeof record.message === 'string') return record.message
    if (typeof record.error === 'string') return record.error
    if (typeof data.error === 'string') return data.error
    return stringValue(error) || 'Slack API error'
  })()
  const lowerMessage = message.toLowerCase()
  const matches = (values: string[]) =>
    Boolean(code && values.includes(code)) || values.some((value) => lowerMessage.includes(value))

  if (status === 409)
    return {
      code: code || undefined,
      errorClass: 'duplicate_or_conflict',
      message,
      retryable: false,
      status,
    }
  if (matches(['channel_not_found', 'not_in_channel', 'user_not_found']))
    return {
      code: code || undefined,
      errorClass: 'invalid_destination',
      message,
      retryable: false,
      status,
    }
  if (matches(['restricted_action', 'restricted_action_thread_locked']))
    return {
      code: code || undefined,
      errorClass: 'restricted_destination',
      message,
      retryable: false,
      status,
    }
  if (matches(['invalid_blocks', 'invalid_payload', 'msg_too_long', 'msg_blocks_too_long']))
    return {
      code: code || undefined,
      errorClass: 'invalid_payload',
      message,
      retryable: false,
      status,
    }
  if (status === 429 || matches(['rate_limited', 'ratelimited']))
    return { code: code || undefined, errorClass: 'rate_limited', message, retryable: true, status }
  if (status && status >= 500)
    return {
      code: code || undefined,
      errorClass: 'transient_slack_error',
      message,
      retryable: true,
      status,
    }
  if (matches(['internal_error', 'timeout', 'timed out', 'network']))
    return {
      code: code || undefined,
      errorClass: 'transient_slack_error',
      message,
      retryable: true,
      status,
    }
  return {
    code: code || undefined,
    errorClass: 'unknown_slack_error',
    message,
    retryable: false,
    status,
  }
}

export function slackApiError(method: string, error: string | undefined) {
  const value = new Error(error ?? `Slack API ${method} failed.`)
  Object.assign(value, { code: error, error })
  return value
}

function stringValue(value: unknown) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

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
