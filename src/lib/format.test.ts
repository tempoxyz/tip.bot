import { expect, test } from 'vitest'
import { formatAmount, formatCurrencyAmount, formatPeriod, formatTipAmount } from '#/lib/format.ts'

test('formats integer token amounts', () => {
  expect(formatAmount(1_000_000)).toBe('1')
  expect(formatAmount(1_500_000)).toBe('1.5')
  expect(formatAmount(1_000_001)).toBe('1.000001')
})

test('formats currency amounts with narrow symbols', () => {
  expect(formatCurrencyAmount('10', 'USD')).toBe('$10.00')
  expect(formatCurrencyAmount('10', 'EUR')).toBe('€10.00')
  expect(formatCurrencyAmount('10', 'GBP')).toBe('£10.00')
  expect(formatCurrencyAmount('10.1234567', 'USD')).toBe('$10.123457')
})

test('falls back when currency code is invalid', () => {
  expect(formatCurrencyAmount('10', 'TOKEN')).toBe('TOKEN10')
})

test('formats tip amounts with token symbol', () => {
  expect(formatTipAmount('0.001', 'USD', 'pathUSD')).toBe('$0.001 pathUSD')
  expect(formatTipAmount('0.001', 'EUR', 'pathEUR')).toBe('€0.001 pathEUR')
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
