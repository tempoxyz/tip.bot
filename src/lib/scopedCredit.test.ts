import * as ScopedCredit from '#/lib/scopedCredit.ts'
import { expect, test } from 'vitest'

test('parses scoped credit command text', () => {
  expect(ScopedCredit.parseScopedCreditText('<@UMEMBER|member> 2 prospectbutcher')).toEqual({
    amount: 2_000_000,
    merchantId: 'prospectbutcher',
    recipientProviderLabel: 'member',
    recipientProviderUserId: 'UMEMBER',
  })
  expect(ScopedCredit.parseScopedCreditText('<@UMEMBER> $2 prospect-butcher')).toMatchObject({
    amount: 2_000_000,
    merchantId: 'prospectbutcher',
    recipientProviderUserId: 'UMEMBER',
  })
})

test('rejects invalid scoped credit command text', () => {
  expect(ScopedCredit.parseScopedCreditText('hello')).toBe(null)
  expect(ScopedCredit.parseScopedCreditText('<@UMEMBER> prospectbutcher')).toBe(null)
  expect(ScopedCredit.parseScopedCreditText('<@UMEMBER> $0 prospectbutcher')?.amount).toBe(null)
})

test('builds scoped credit receipt memo', () => {
  expect(
    ScopedCredit.buildScopedCreditReceiptMemo({
      merchantName: 'Prospect Butcher Co.',
      recipientProviderUserId: 'UMEMBER',
      senderProviderUserId: 'UADMIN',
    }),
  ).toBe('Scoped credit for <@UMEMBER> from <@UADMIN>; spendable only at Prospect Butcher Co.')
})
