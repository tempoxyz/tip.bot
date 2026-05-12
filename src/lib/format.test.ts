import { expect, test } from 'vitest'
import { formatCurrencyAmount, formatPeriod } from '#/lib/format.ts'

test('formats currency amounts with narrow symbols', () => {
  expect(formatCurrencyAmount('10', 'USD')).toBe('$10.00')
  expect(formatCurrencyAmount('10', 'EUR')).toBe('€10.00')
  expect(formatCurrencyAmount('10', 'GBP')).toBe('£10.00')
  expect(formatCurrencyAmount('10.1234567', 'USD')).toBe('$10.123457')
})

test('falls back when currency code is invalid', () => {
  expect(formatCurrencyAmount('10', 'TOKEN')).toBe('TOKEN10')
})

test('formats singular periods without a count', () => {
  expect(formatPeriod(1)).toBe('second')
  expect(formatPeriod(60)).toBe('minute')
  expect(formatPeriod(60 * 60)).toBe('hour')
  expect(formatPeriod(24 * 60 * 60)).toBe('day')
  expect(formatPeriod(30 * 24 * 60 * 60)).toBe('month')
})

test('formats plural periods with counts', () => {
  expect(formatPeriod(45)).toBe('45 seconds')
  expect(formatPeriod(2 * 60)).toBe('2 minutes')
  expect(formatPeriod(3 * 60 * 60)).toBe('3 hours')
  expect(formatPeriod(4 * 24 * 60 * 60)).toBe('4 days')
  expect(formatPeriod(2 * 30 * 24 * 60 * 60)).toBe('2 months')
})
