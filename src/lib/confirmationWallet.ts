// The dialog SDK also returns 4001 when its remembered account is absent
// from the wallet. That path clears eth_accounts without showing approval.
export async function isLostWalletSession(
  error: unknown,
  provider: { request: (parameters: { method: string }) => Promise<unknown> },
) {
  const seen = new Set<unknown>()
  let current = error
  let rejected = false
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if ('code' in current && current.code === 4001) rejected = true
    current = 'cause' in current ? current.cause : undefined
  }
  if (!rejected) return false
  try {
    const accounts = await provider.request({ method: 'eth_accounts' })
    return Array.isArray(accounts) && accounts.length === 0
  } catch {
    return false
  }
}
