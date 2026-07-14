import { afterEach, expect, test, vi } from 'vitest'
import * as Tempo from '#/lib/tempo.ts'

afterEach(() => vi.restoreAllMocks())

test('returns supported Tempo chains', () => {
  expect(Tempo.getChain(Tempo.chainLookup.mainnet).id).toBe(Tempo.chainLookup.mainnet)
  expect(Tempo.getChain(Tempo.chainLookup.testnet).id).toBe(Tempo.chainLookup.testnet)
  expect(Tempo.getChain(Tempo.chainLookup.localnet).id).toBe(Tempo.chainLookup.localnet)
  expect(() => Tempo.getChain(1)).toThrow('Unsupported Tempo chain 1.')
})

test('returns optional RPC URLs by chain', () => {
  expect(
    Tempo.getRpcUrl({ RPC_URL_MAINNET: 'https://mainnet.example' }, Tempo.chainLookup.mainnet),
  ).toBe('https://mainnet.example')
  expect(Tempo.getRpcUrl({ RPC_CREDENTIALS: 'account:secret' }, Tempo.chainLookup.mainnet)).toBe(
    'https://account:secret@rpc.tempo.xyz',
  )
  expect(
    Tempo.getRpcUrl({ RPC_URL_TESTNET: 'https://testnet.example' }, Tempo.chainLookup.testnet),
  ).toBe('https://testnet.example')
  expect(
    Tempo.getRpcUrl({ RPC_URL_TESTNET: 'https://testnet.example' }, Tempo.chainLookup.localnet),
  ).toBe('https://testnet.example')
  expect(Tempo.getRpcUrl({}, Tempo.chainLookup.mainnet)).toBe('https://rpc.tempo.xyz')
  expect(Tempo.getRpcUrl({}, 1)).toBe(undefined)
})

test('checks allowed tokens by chain', () => {
  expect(Tempo.isAllowedToken(Tempo.chainLookup.mainnet, Tempo.addressLookup.pathUsd)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.chainLookup.mainnet, Tempo.addressLookup.usdcE)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.chainLookup.mainnet, Tempo.addressLookup.usdt0)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.chainLookup.mainnet, Tempo.addressLookup.alphaUsd)).toBe(false)
  expect(Tempo.isAllowedToken(Tempo.chainLookup.testnet, Tempo.addressLookup.pathUsd)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.chainLookup.testnet, Tempo.addressLookup.alphaUsd)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.chainLookup.testnet, Tempo.addressLookup.betaUsd)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.chainLookup.testnet, Tempo.addressLookup.thetaUsd)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.chainLookup.localnet, Tempo.addressLookup.pathUsd)).toBe(true)
  expect(Tempo.isAllowedToken(1, Tempo.addressLookup.pathUsd)).toBe(false)
})

test('resolves supported token aliases', () => {
  expect(Tempo.getTokenAddress(Tempo.chainLookup.mainnet, 'USDC.e')).toBe(Tempo.addressLookup.usdcE)
  expect(Tempo.getTokenAddress(Tempo.chainLookup.mainnet, 'usdc')).toBe(Tempo.addressLookup.usdcE)
  expect(Tempo.getTokenAddress(Tempo.chainLookup.mainnet, 'USDT')).toBe(Tempo.addressLookup.usdt0)
  expect(Tempo.getTokenAddress(Tempo.chainLookup.testnet, 'beta')).toBe(Tempo.addressLookup.betaUsd)
  expect(Tempo.getTokenAddress(Tempo.chainLookup.mainnet, 'beta')).toBe(null)
})

test('formats Tempo token symbols and transaction links', () => {
  expect(Tempo.getTokenMetadataFallback(Tempo.addressLookup.pathUsd)).toEqual({
    currency: 'USD',
    symbol: 'PathUSD',
  })
  expect(Tempo.getTokenMetadataFallback(Tempo.addressLookup.alphaUsd)).toEqual({
    currency: 'USD',
    symbol: 'AlphaUSD',
  })
  expect(Tempo.getTokenMetadataFallback(Tempo.addressLookup.betaUsd)).toEqual({
    currency: 'USD',
    symbol: 'BetaUSD',
  })
  expect(Tempo.getTokenMetadataFallback(Tempo.addressLookup.thetaUsd)).toEqual({
    currency: 'USD',
    symbol: 'ThetaUSD',
  })
  expect(Tempo.getTokenMetadataFallback(Tempo.addressLookup.usdcE)).toEqual({
    currency: 'USD',
    symbol: 'USDC.e',
  })
  expect(Tempo.getTokenMetadataFallback(Tempo.addressLookup.usdt0)).toEqual({
    currency: 'USD',
    symbol: 'USDT0',
  })
  expect(Tempo.getTokenMetadataFallback('0x0000000000000000000000000000000000000002')).toEqual({
    currency: 'USD',
    symbol: '0x0000…0002',
  })
  expect(Tempo.explorerLink(Tempo.chainLookup.testnet, Tempo.addressLookup.pathUsd)).toContain(
    `/address/${Tempo.addressLookup.pathUsd}`,
  )
  expect(Tempo.formatTxLink(Tempo.chainLookup.testnet, '0xabc')).toContain('/receipt/0xabc')
})

test('gets token metadata from the Tempo API', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ currency: 'USD', symbol: 'USDC.e' }), { status: 200 }),
    )
  vi.stubGlobal('fetch', fetch)

  await expect(
    Tempo.getTokenMetadata(
      { TEMPO_API_URL: 'https://api.example' },
      Tempo.chainLookup.mainnet,
      Tempo.addressLookup.usdcE,
    ),
  ).resolves.toEqual({ currency: 'USD', symbol: 'USDC.e' })
  expect(fetch.mock.calls[0]?.[0]).toBe(
    `https://api.example/v1/tokens/${Tempo.addressLookup.usdcE}?chainId=${Tempo.chainLookup.mainnet}`,
  )
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) })
})

test('falls back when the Tempo API request fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))

  await expect(
    Tempo.getTokenMetadata(
      { TEMPO_API_URL: 'https://api.example' },
      Tempo.chainLookup.mainnet,
      Tempo.addressLookup.pathUsd,
    ),
  ).resolves.toEqual({ currency: 'USD', symbol: 'PathUSD' })
})
