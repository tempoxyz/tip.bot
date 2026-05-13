import { expect, test } from 'vitest'
import * as Tip from '#/lib/tip.ts'

test('parses positive decimal amounts', () => {
  expect(Tip.parseAmount('1')).toBe(1_000_000)
  expect(Tip.parseAmount('1.5')).toBe(1_500_000)
  expect(Tip.parseAmount('0.000001')).toBe(1)
  expect(Tip.parseAmount('123.456789')).toBe(123_456_789)
})

test('rejects invalid decimal amounts', () => {
  expect(Tip.parseAmount('0')).toBe(null)
  expect(Tip.parseAmount('0.000000')).toBe(null)
  expect(Tip.parseAmount('-1')).toBe(null)
  expect(Tip.parseAmount('01')).toBe(null)
  expect(Tip.parseAmount('1.0000001')).toBe(null)
  expect(Tip.parseAmount('1.')).toBe(null)
  expect(Tip.parseAmount('abc')).toBe(null)
  expect(Tip.parseAmount('9007199255')).toBe(null)
})

test('parses tip mentions and memos', () => {
  expect(Tip.parseTipText('<@UMEMBER>')).toEqual({
    memo: null,
    recipientProviderUserId: 'UMEMBER',
  })
  expect(Tip.parseTipText('<@UMEMBER> for great work')).toEqual({
    memo: 'great work',
    recipientProviderUserId: 'UMEMBER',
  })
  expect(Tip.parseTipText('<@UMEMBER|member> for great work')).toEqual({
    memo: 'great work',
    recipientProviderUserId: 'UMEMBER',
  })
  expect(Tip.parseTipText('<@UMEMBER> coffee')).toEqual({
    memo: 'coffee',
    recipientProviderUserId: 'UMEMBER',
  })
})

test('rejects text without tip mentions', () => {
  expect(Tip.parseTipText('')).toBe(null)
  expect(Tip.parseTipText('hello')).toBe(null)
})
