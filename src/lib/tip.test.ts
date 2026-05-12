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
