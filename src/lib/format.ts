export function formatCurrencyAmount(value: string, currency: string) {
  try {
    return new Intl.NumberFormat('en', {
      currency,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 6,
      style: 'currency',
    }).format(Number(value))
  } catch {
    return `${currency}${value}`
  }
}

export function formatPeriod(seconds: number) {
  if (seconds === 30 * 24 * 60 * 60) return 'month' // 1 month
  if (seconds % (30 * 24 * 60 * 60) === 0) return `${seconds / (30 * 24 * 60 * 60)} months` // months
  if (seconds === 24 * 60 * 60) return 'day' // 1 day
  if (seconds % (24 * 60 * 60) === 0) return `${seconds / (24 * 60 * 60)} days` // days
  if (seconds === 60 * 60) return 'hour' // 1 hour
  if (seconds % (60 * 60) === 0) return `${seconds / (60 * 60)} hours` // hours
  if (seconds === 60) return 'minute' // 1 minute
  if (seconds % 60 === 0) return `${seconds / 60} minutes` // minutes
  if (seconds === 1) return 'second' // 1 second
  return `${seconds} seconds`
}
