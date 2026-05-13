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
    amount: undefined,
    memo: null,
    recipientProviderUserId: 'UMEMBER',
    token: null,
  })
  expect(Tip.parseTipText('<@UMEMBER> for great work')).toEqual({
    amount: undefined,
    memo: 'great work',
    recipientProviderUserId: 'UMEMBER',
    token: null,
  })
  expect(Tip.parseTipText('<@UMEMBER|member> for great work')).toEqual({
    amount: undefined,
    memo: 'great work',
    recipientProviderUserId: 'UMEMBER',
    token: null,
  })
  expect(Tip.parseTipText('<@UMEMBER> coffee')).toEqual({
    amount: undefined,
    memo: 'coffee',
    recipientProviderUserId: 'UMEMBER',
    token: null,
  })
  expect(Tip.parseTipText('<@UMEMBER> 5')).toEqual({
    amount: 5_000_000,
    memo: null,
    recipientProviderUserId: 'UMEMBER',
    token: null,
  })
  expect(Tip.parseTipText('<@UMEMBER> 5 USDC.e for lunch')).toEqual({
    amount: 5_000_000,
    memo: 'lunch',
    recipientProviderUserId: 'UMEMBER',
    token: 'USDC.e',
  })
})

test('rejects text without tip mentions', () => {
  expect(Tip.parseTipText('')).toBe(null)
  expect(Tip.parseTipText('hello')).toBe(null)
  expect(Tip.parseTipText('<@UMEMBER> 5 USDC.e lunch')).toBe(null)
})

test('encodes transfer memos as bytes32', () => {
  expect(Tip.encodeTransferMemo(null)).toBe(
    '0x0000000000000000000000000000000000000000000000000000000000000000',
  )
  expect(Tip.encodeTransferMemo('coffee')).toBe(
    '0x636f666665650000000000000000000000000000000000000000000000000000',
  )
})

test('rejects transfer memos longer than bytes32', () => {
  expect(() => Tip.encodeTransferMemo('x'.repeat(33))).toThrow('Memo must be at most 32 bytes.')
})
