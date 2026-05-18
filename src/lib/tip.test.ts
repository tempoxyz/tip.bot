import * as Tempo from '#/lib/tempo.ts'
import * as Tip from '#/lib/tip.ts'
import { expect, test } from 'vitest'

test('parses positive decimal amounts', () => {
  expect(Tip.parseAmount('1')).toBe(1_000_000)
  expect(Tip.parseAmount('$1')).toBe(1_000_000)
  expect(Tip.parseAmount('1.5')).toBe(1_500_000)
  expect(Tip.parseAmount('$1.5')).toBe(1_500_000)
  expect(Tip.parseAmount('0.000001')).toBe(1)
  expect(Tip.parseAmount('123.456789')).toBe(123_456_789)
})

test('truncates extra decimals beyond 6 places', () => {
  expect(Tip.parseAmount('1.1234567')).toBe(1_123_456)
  expect(Tip.parseAmount('$1.12345678')).toBe(1_123_456)
  expect(Tip.parseAmount('0.0000001')).toBe(null)
  expect(Tip.parseAmount('$0.00000001')).toBe(null)
})

test('rejects invalid decimal amounts', () => {
  expect(Tip.parseAmount('0')).toBe(null)
  expect(Tip.parseAmount('0.000000')).toBe(null)
  expect(Tip.parseAmount('-1')).toBe(null)
  expect(Tip.parseAmount('01')).toBe(null)
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
    recipientProviderLabel: 'member',
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
  expect(Tip.parseTipText('<@UMEMBER> $0.002')).toEqual({
    amount: 2_000,
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
  expect(Tip.parseTipText('<@UMEMBER> 5 usdc for lunch')).toEqual({
    amount: 5_000_000,
    memo: 'lunch',
    recipientProviderUserId: 'UMEMBER',
    token: 'usdc',
  })
  expect(Tip.parseTipText('<@UMEMBER> 5 BetaUSD', { chainId: Tempo.chainLookup.localnet })).toEqual(
    {
      amount: 5_000_000,
      memo: null,
      recipientProviderUserId: 'UMEMBER',
      token: 'BetaUSD',
    },
  )
  expect(
    Tip.parseTipText('<@UMEMBER> 5 beta for lunch', { chainId: Tempo.chainLookup.localnet }),
  ).toEqual({
    amount: 5_000_000,
    memo: 'lunch',
    recipientProviderUserId: 'UMEMBER',
    token: 'beta',
  })
  expect(Tip.parseTipText('<@UMEMBER> 5 pathUSD')).toEqual({
    amount: 5_000_000,
    memo: null,
    recipientProviderUserId: 'UMEMBER',
    token: 'pathUSD',
  })
  expect(Tip.parseTipText('<@UMEMBER> 5 BetaUSD')).toEqual({
    amount: 5_000_000,
    memo: null,
    recipientProviderUserId: 'UMEMBER',
    token: 'BetaUSD',
  })
  expect(Tip.parseTipText('<@UMEMBER> 5 FAKE')).toEqual({
    amount: 5_000_000,
    memo: null,
    recipientProviderUserId: 'UMEMBER',
    token: 'FAKE',
  })
  expect(Tip.parseTipText('<@UMEMBER> $0.001 thanks for the help')).toEqual({
    amount: 1_000,
    memo: 'thanks for the help',
    recipientProviderUserId: 'UMEMBER',
    token: null,
  })
  expect(Tip.parseTipText('<@UMEMBER> $0.001 great work')).toEqual({
    amount: 1_000,
    memo: 'great work',
    recipientProviderUserId: 'UMEMBER',
    token: null,
  })
  expect(Tip.parseTipText('<@UMEMBER> $0.001 v2 launch')).toEqual({
    amount: 1_000,
    memo: 'v2 launch',
    recipientProviderUserId: 'UMEMBER',
    token: null,
  })
  expect(Tip.parseTipText('<@UMEMBER> $0.001 ship-it')).toEqual({
    amount: 1_000,
    memo: 'ship-it',
    recipientProviderUserId: 'UMEMBER',
    token: null,
  })
  expect(Tip.parseTipText("<@UMEMBER> $0.00000001 let's see")).toBe(null)
})

test('parses multi-recipient tip mentions', () => {
  expect(Tip.parseTipBatchText('<@UFOO> <@UBAR>')).toEqual({
    amount: undefined,
    memo: null,
    recipients: [{ recipientProviderUserId: 'UFOO' }, { recipientProviderUserId: 'UBAR' }],
    token: null,
  })
  expect(Tip.parseTipBatchText('<@UFOO|foo> <@UBAR|bar> for coffee')).toEqual({
    amount: undefined,
    memo: 'coffee',
    recipients: [
      { recipientProviderLabel: 'foo', recipientProviderUserId: 'UFOO' },
      { recipientProviderLabel: 'bar', recipientProviderUserId: 'UBAR' },
    ],
    token: null,
  })
  expect(Tip.parseTipBatchText('<@UFOO> <@UBAR> 0.005 USDC for launch')).toEqual({
    amount: 5000,
    memo: 'launch',
    recipients: [{ recipientProviderUserId: 'UFOO' }, { recipientProviderUserId: 'UBAR' }],
    token: 'USDC',
  })
  expect(Tip.parseTipBatchText('<@UFOO> <@UFOO> <@UBAR> coffee')).toEqual({
    amount: undefined,
    memo: 'coffee',
    recipients: [{ recipientProviderUserId: 'UFOO' }, { recipientProviderUserId: 'UBAR' }],
    token: null,
  })
  expect(Tip.parseTipBatchText('<@UFOO> for <@UBAR>')).toBe(null)
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
  // Slack emoji shortcodes should be converted to unicode
  expect(Tip.encodeTransferMemo(':wine_glass:')).toBe(Tip.encodeTransferMemo('🍷'))
  expect(Tip.encodeTransferMemo(':+1::skin-tone-4:')).toBe(Tip.encodeTransferMemo('👍🏽'))
})

test('rejects transfer memos longer than bytes32', () => {
  expect(Tip.isTransferMemoTooLong('x'.repeat(32))).toBe(false)
  expect(Tip.isTransferMemoTooLong('x'.repeat(33))).toBe(true)
  expect(Tip.isTransferMemoTooLong(':wine_glass:'.repeat(11))).toBe(true)
  expect(() => Tip.encodeTransferMemo('x'.repeat(33))).toThrow('Memo must be at most 32 bytes.')
})
