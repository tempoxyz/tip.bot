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

test('normalizes Slack adapter channel ids', () => {
  expect(Slack.getChannelId('slack:C123:1700000000.000100')).toBe('C123')
  expect(Slack.getChannelId('D123')).toBe('D123')
  expect(Slack.isDMChannelId('slack:D123:1700000000.000100')).toBe(true)
  expect(Slack.isDMChannelId('slack:C123')).toBe(false)
})
