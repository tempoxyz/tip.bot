import { expect, test } from 'vitest'
import * as Slack from '#/lib/slack.ts'

test('classifies invalid Slack destinations as non-retryable', () => {
  expect(
    Slack.classifySlackError(Slack.slackApiError('chat.postMessage', 'not_in_channel')),
  ).toMatchObject({
    code: 'not_in_channel',
    errorClass: 'invalid_destination',
    retryable: false,
  })
})

test('classifies Slack rate limits as retryable', () => {
  expect(Slack.classifySlackError({ response: { status: 429 } })).toMatchObject({
    errorClass: 'rate_limited',
    retryable: true,
    status: 429,
  })
})

test('classifies oversized Slack payloads as non-retryable payload errors', () => {
  expect(Slack.classifySlackError(new Error('Slack API error: msg_too_long'))).toMatchObject({
    errorClass: 'invalid_payload',
    retryable: false,
  })
})
