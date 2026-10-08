import { expect, test, vi } from 'vitest'
import { isLostWalletSession } from './confirmationWallet.ts'

test('recognizes SDK rejection after the wallet invalidates the local account', async () => {
  const provider = { request: vi.fn().mockResolvedValue([]) }
  expect(await isLostWalletSession({ cause: { code: 4001 } }, provider)).toBe(true)
  expect(provider.request).toHaveBeenCalledWith({ method: 'eth_accounts' })
})

test('does not turn a genuine decline with an active account into reconnection', async () => {
  expect(
    await isLostWalletSession({ code: 4001 }, { request: vi.fn().mockResolvedValue(['0x123']) }),
  ).toBe(false)
})

test('does not treat transaction failures or an unavailable provider as an expired session', async () => {
  const request = vi.fn().mockResolvedValue([])
  expect(await isLostWalletSession({ code: -32000 }, { request })).toBe(false)
  expect(request).not.toHaveBeenCalled()
  expect(
    await isLostWalletSession({ code: 4001 }, { request: vi.fn().mockRejectedValue(new Error()) }),
  ).toBe(false)
})

test('handles cyclic error causes without hanging', async () => {
  const error: { cause?: unknown } = {}
  error.cause = error
  expect(await isLostWalletSession(error, { request: vi.fn() })).toBe(false)
})
