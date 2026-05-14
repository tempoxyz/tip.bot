export function getErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback

  const message = error.message.trim()
  if (!message) return fallback
  if (/user rejected|rejected the request|denied|cancelled|canceled/i.test(message))
    return 'Request rejected.'

  return (
    message
      .replace(/\s*Details:[\s\S]*$/i, '')
      .replace(/\s*Version:\s*\S+[\s\S]*$/i, '')
      .split('\n')[0]
      ?.trim() || fallback
  )
}
