import { expect, test } from 'vitest'
import * as Tempo from '#/lib/tempo.ts'

test('returns supported Tempo chains', () => {
  expect(Tempo.getChain(Tempo.mainnetChainId).id).toBe(Tempo.mainnetChainId)
  expect(Tempo.getChain(Tempo.moderatoChainId).id).toBe(Tempo.moderatoChainId)
  expect(Tempo.getChain(Tempo.localnetChainId).id).toBe(Tempo.localnetChainId)
  expect(() => Tempo.getChain(1)).toThrow('Unsupported Tempo chain 1.')
})

test('returns optional RPC URLs by chain', () => {
  expect(
    Tempo.getRpcUrl({ RPC_URL_MAINNET: 'https://mainnet.example' }, Tempo.mainnetChainId),
  ).toBe('https://mainnet.example')
  expect(
    Tempo.getRpcUrl({ RPC_URL_TESTNET: 'https://testnet.example' }, Tempo.moderatoChainId),
  ).toBe('https://testnet.example')
  expect(
    Tempo.getRpcUrl({ RPC_URL_TESTNET: 'https://testnet.example' }, Tempo.localnetChainId),
  ).toBe('https://testnet.example')
  expect(Tempo.getRpcUrl({}, Tempo.mainnetChainId)).toBe(undefined)
  expect(Tempo.getRpcUrl({}, 1)).toBe(undefined)
})

test('checks allowed tokens by chain', () => {
  expect(Tempo.isAllowedToken(Tempo.mainnetChainId, Tempo.pathUsdAddress)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.mainnetChainId, Tempo.alphaUsdAddress)).toBe(false)
  expect(Tempo.isAllowedToken(Tempo.moderatoChainId, Tempo.pathUsdAddress)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.moderatoChainId, Tempo.alphaUsdAddress)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.moderatoChainId, Tempo.betaUsdAddress)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.moderatoChainId, Tempo.thetaUsdAddress)).toBe(true)
  expect(Tempo.isAllowedToken(Tempo.localnetChainId, Tempo.pathUsdAddress)).toBe(true)
  expect(Tempo.isAllowedToken(1, Tempo.pathUsdAddress)).toBe(false)
})

test('formats Tempo token symbols and transaction links', () => {
  expect(Tempo.getTokenMetadataFallback(Tempo.pathUsdAddress)).toEqual({
    currency: 'USD',
    symbol: 'PathUSD',
  })
  expect(Tempo.getTokenMetadataFallback(Tempo.alphaUsdAddress)).toEqual({
    currency: 'USD',
    symbol: 'AlphaUSD',
  })
  expect(Tempo.getTokenMetadataFallback(Tempo.betaUsdAddress)).toEqual({
    currency: 'USD',
    symbol: 'BetaUSD',
  })
  expect(Tempo.getTokenMetadataFallback(Tempo.thetaUsdAddress)).toEqual({
    currency: 'USD',
    symbol: 'ThetaUSD',
  })
  expect(Tempo.getTokenMetadataFallback('0x0000000000000000000000000000000000000002')).toEqual({
    currency: 'USD',
    symbol: '0x0000…0002',
  })
  expect(Tempo.formatTxLink(Tempo.moderatoChainId, '0xabc')).toContain('/tx/0xabc')
})
