import { Secp256k1 } from 'ox'
import { Account } from 'viem/tempo'
import { expect, test, vi } from 'vitest'
import * as AccessKey from '#/lib/accessKey.ts'
import * as Tempo from '#/lib/tempo.ts'

const rpcEnv = {
  RPC_URL_MAINNET: 'https://mainnet.example',
  RPC_URL_TESTNET: 'https://testnet.example',
} satisfies Pick<Env, 'RPC_URL_MAINNET' | 'RPC_URL_TESTNET'>

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
      chainId: Tempo.chainLookup.testnet,
      expiresAt,
      tokenAddress: Tempo.addressLookup.pathUsd,
    })

    const verified = await AccountLink.verifyKeyAuthorization({
      accessKeyAddress: accessKey.address,
      chainId: Tempo.chainLookup.testnet,
      env: rpcEnv,
      expiresAt,
      keyAuthorization,
      rootAddress: root.address,
      tokenAddress: Tempo.addressLookup.pathUsd,
    })

    expect(verified.rootAddress).toBe(root.address)
    expect(verified.serialized).toBe(JSON.stringify(keyAuthorization))
    expect(verifyHash).toHaveBeenCalledOnce()
  } finally {
    vi.doUnmock('viem/actions')
    vi.resetModules()
  }
})

test('accepts user-edited key authorization amount and expiry', async () => {
  const verifyHash = vi.fn(async () => true)
  vi.resetModules()
  vi.doMock('viem/actions', () => ({ verifyHash }))

  try {
    const AccountLink = await import('#/lib/accountLink.ts')
    const accessKey = AccessKey.generate()
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const requestedExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
    const approvedExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() // 365 days
    const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
      accessKeyAddress: accessKey.address,
      chainId: Tempo.chainLookup.testnet,
      expiresAt: approvedExpiresAt,
      limit: 100_000_000n, // 100 PathUSD
      tokenAddress: Tempo.addressLookup.pathUsd,
    })

    const verified = await AccountLink.verifyKeyAuthorization({
      accessKeyAddress: accessKey.address,
      chainId: Tempo.chainLookup.testnet,
      env: rpcEnv,
      expiresAt: requestedExpiresAt,
      keyAuthorization,
      rootAddress: root.address,
      tokenAddress: Tempo.addressLookup.pathUsd,
    })

    expect(verified.expiresAt).toBe(
      new Date(Math.floor(new Date(approvedExpiresAt).getTime() / 1000) * 1000).toISOString(),
    )
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
    chainId: Tempo.chainLookup.testnet,
    expiresAt,
    tokenAddress: Tempo.addressLookup.pathUsd,
  })

  await expect(
    AccountLink.verifyKeyAuthorization({
      accessKeyAddress: accessKey.address,
      chainId: Tempo.chainLookup.testnet,
      env: rpcEnv,
      expiresAt,
      keyAuthorization,
      rootAddress: root.address,
      tokenAddress: '0x0000000000000000000000000000000000000001',
    }),
  ).rejects.toThrow('Key authorization limits must apply to the Tipbot token.')
})

test.each([
  {
    input: (_accessKey: ReturnType<typeof AccessKey.generate>, expiresAt: string) => ({
      accessKeyAddress: AccessKey.generate().address,
      chainId: Tempo.chainLookup.testnet,
      expiresAt,
      tokenAddress: Tempo.addressLookup.pathUsd,
    }),
    message: 'Key authorization does not match link access key.',
    name: 'access key',
  },
  {
    input: (accessKey: ReturnType<typeof AccessKey.generate>, expiresAt: string) => ({
      accessKeyAddress: accessKey.address,
      chainId: Tempo.chainLookup.mainnet,
      expiresAt,
      tokenAddress: Tempo.addressLookup.pathUsd,
    }),
    message: 'Key authorization chain does not match Tipbot policy.',
    name: 'chain',
  },
])('rejects key authorizations with mismatched $name', async (case_) => {
  const AccountLink = await import('#/lib/accountLink.ts')
  const accessKey = AccessKey.generate()
  const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
  const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
    accessKeyAddress: accessKey.address,
    chainId: Tempo.chainLookup.testnet,
    expiresAt,
    tokenAddress: Tempo.addressLookup.pathUsd,
  })

  await expect(
    AccountLink.verifyKeyAuthorization({
      env: rpcEnv,
      keyAuthorization,
      rootAddress: root.address,
      ...case_.input(accessKey, expiresAt),
    }),
  ).rejects.toThrow(case_.message)
})

test('rejects expired key authorizations', async () => {
  const AccountLink = await import('#/lib/accountLink.ts')
  const accessKey = AccessKey.generate()
  const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
  const requestedExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
  const approvedExpiresAt = new Date(Date.now() - 60 * 1000).toISOString() // 1 minute ago
  const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
    accessKeyAddress: accessKey.address,
    chainId: Tempo.chainLookup.testnet,
    expiresAt: approvedExpiresAt,
    tokenAddress: Tempo.addressLookup.pathUsd,
  })

  await expect(
    AccountLink.verifyKeyAuthorization({
      accessKeyAddress: accessKey.address,
      chainId: Tempo.chainLookup.testnet,
      env: rpcEnv,
      expiresAt: requestedExpiresAt,
      keyAuthorization,
      rootAddress: root.address,
      tokenAddress: Tempo.addressLookup.pathUsd,
    }),
  ).rejects.toThrow('Key authorization has expired.')
})

test('rejects key authorizations with invalid signatures', async () => {
  const verifyHash = vi.fn(async () => false)
  vi.resetModules()
  vi.doMock('viem/actions', () => ({ verifyHash }))

  try {
    const AccountLink = await import('#/lib/accountLink.ts')
    const accessKey = AccessKey.generate()
    const root = Account.fromSecp256k1(Secp256k1.randomPrivateKey())
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
    const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
      accessKeyAddress: accessKey.address,
      chainId: Tempo.chainLookup.testnet,
      expiresAt,
      tokenAddress: Tempo.addressLookup.pathUsd,
    })

    await expect(
      AccountLink.verifyKeyAuthorization({
        accessKeyAddress: accessKey.address,
        chainId: Tempo.chainLookup.testnet,
        env: rpcEnv,
        expiresAt,
        keyAuthorization,
        rootAddress: root.address,
        tokenAddress: Tempo.addressLookup.pathUsd,
      }),
    ).rejects.toThrow('Key authorization signature is invalid.')
    expect(verifyHash).toHaveBeenCalledOnce()
  } finally {
    vi.doUnmock('viem/actions')
    vi.resetModules()
  }
})
