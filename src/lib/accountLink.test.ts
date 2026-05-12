import { Secp256k1 } from 'ox'
import { Account } from 'viem/tempo'
import { expect, test, vi } from 'vitest'
import * as AccessKey from '#/lib/accessKey.ts'
import * as Tempo from '#/lib/tempo.ts'

test('hashes tokens deterministically', async () => {
  const AccountLink = await import('#/lib/accountLink.ts')
  const env = { SECRET_KEY: 'test-secret' } satisfies Pick<Env, 'SECRET_KEY'>

  await expect(AccountLink.hashToken(env, 'token')).resolves.toBe(
    await AccountLink.hashToken(env, 'token'),
  )
  await expect(AccountLink.hashToken(env, 'token')).resolves.not.toBe(
    await AccountLink.hashToken(env, 'other'),
  )
})

test('verifies key authorizations against Tipbot policy', async () => {
  const verifyHash = vi.fn(async () => true)
  vi.resetModules()
  vi.doMock('viem/actions', () => ({ verifyHash }))

  try {
    const AccountLink = await import('#/lib/accountLink.ts')
    const accessKey = AccessKey.generate()
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
    const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
      accessKeyAddress: accessKey.address,
      expiresAt,
      tokenAddress: Tempo.pathUsdAddress,
    })

    const verified = await AccountLink.verifyKeyAuthorization({
      accessKeyAddress: accessKey.address,
      expiresAt,
      keyAuthorization,
      rootAddress: root.address,
      tokenAddress: Tempo.pathUsdAddress,
    })

    expect(verified.rootAddress).toBe(root.address)
    expect(verified.serialized).toBe(JSON.stringify(keyAuthorization))
    expect(verifyHash).toHaveBeenCalledOnce()
  } finally {
    vi.doUnmock('viem/actions')
    vi.resetModules()
  }
})

test('rejects key authorizations with mismatched policy', async () => {
  const AccountLink = await import('#/lib/accountLink.ts')
  const accessKey = AccessKey.generate()
  const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
  const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
    accessKeyAddress: accessKey.address,
    expiresAt,
    tokenAddress: Tempo.pathUsdAddress,
  })

  await expect(
    AccountLink.verifyKeyAuthorization({
      accessKeyAddress: accessKey.address,
      expiresAt,
      keyAuthorization,
      rootAddress: root.address,
      tokenAddress: '0x0000000000000000000000000000000000000001',
    }),
  ).rejects.toThrow('Key authorization limits do not match Tipbot policy.')
})
