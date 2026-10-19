import { Address } from 'ox'
import { tempo, tempoLocalnet, tempoModerato } from 'viem/tempo/chains'
import { alphausd, betausd, pathusd, thetausd, usdce, usdt0 as core_usdt0 } from 'viem/tokens'
import { getAddress } from 'viem'

export const addressLookup = {
  alphaUsd: Address.checksum(alphausd(42431).address),
  betaUsd: Address.checksum(betausd(42431).address),
  pathUsd: Address.checksum(pathusd(42431).address),
  thetaUsd: Address.checksum(thetausd(42431).address),
  usdcE: Address.checksum(getAddress(usdce(4217).address)),
  usdt0: Address.checksum(core_usdt0(4217).address),
} as const

export const chainLookup = {
  localnet: tempoLocalnet.id,
  mainnet: tempo.id,
  testnet: tempoModerato.id,
} as const

export function getChain(chainId: number) {
  if (chainId === chainLookup.mainnet) return tempo
  if (chainId === chainLookup.testnet) return tempoModerato
  if (chainId === chainLookup.localnet) return tempoLocalnet
  throw new Error(`Unsupported Tempo chain ${chainId}.`)
}

export function getRpcUrl(
  env: Pick<Env, 'RPC_CREDENTIALS' | 'RPC_URL_MAINNET' | 'RPC_URL_TESTNET'>,
  chainId: number,
) {
  if (chainId === chainLookup.mainnet) {
    const auth = env.RPC_CREDENTIALS
    return env.RPC_URL_MAINNET || `https://${auth ? `${auth}@` : ''}rpc.tempo.xyz`
  }
  if (chainId === chainLookup.testnet || chainId === chainLookup.localnet)
    return env.RPC_URL_TESTNET || undefined
  return undefined
}

export function getFeePayerPrivateKey(
  env: Pick<Env, 'FEE_PAYER_PRIVATE_KEY_MAINNET' | 'FEE_PAYER_PRIVATE_KEY_TESTNET'>,
  chainId: number,
) {
  if (chainId === chainLookup.mainnet) return env.FEE_PAYER_PRIVATE_KEY_MAINNET
  if (chainId === chainLookup.testnet || chainId === chainLookup.localnet)
    return env.FEE_PAYER_PRIVATE_KEY_TESTNET
  return undefined
}

export function getChainName(chainId: number) {
  return getChain(chainId).name
}

export function formatTxLink(chainId: number, transactionHash: string) {
  const chain = getChain(chainId)
  return `${chain.blockExplorers?.default.url ?? chain.rpcUrls.default.http[0]}/receipt/${transactionHash}`
}

export function explorerLink(chainId: number, address: string) {
  const chain = getChain(chainId)
  return `${chain.blockExplorers?.default.url ?? chain.rpcUrls.default.http[0]}/address/${address}`
}

export function isAllowedToken(chainId: number, tokenAddress: string) {
  const token = Address.checksum(tokenAddress)
  if (chainId === chainLookup.mainnet)
    return [addressLookup.pathUsd, addressLookup.usdcE, addressLookup.usdt0].some((allowed) =>
      Address.isEqual(token, allowed),
    )
  if (chainId === chainLookup.testnet || chainId === chainLookup.localnet)
    return [
      addressLookup.pathUsd,
      addressLookup.alphaUsd,
      addressLookup.betaUsd,
      addressLookup.thetaUsd,
    ].some((allowed) => Address.isEqual(token, allowed))
  return false
}

export function getTokenAddress(chainId: number, value: string) {
  const address = Address.validate(value) ? Address.checksum(value) : null
  if (address && isAllowedToken(chainId, address)) return address

  const normalized = value.toLowerCase().replace(/[.\-_\s]/g, '')
  const tokenAddress = (() => {
    if (normalized === 'pathusd' || normalized === 'path' || normalized === 'usd')
      return addressLookup.pathUsd
    if (normalized === 'usdce' || normalized === 'usdc') return addressLookup.usdcE
    if (normalized === 'usdt0' || normalized === 'usdt') return addressLookup.usdt0
    if (normalized === 'alphausd' || normalized === 'alpha') return addressLookup.alphaUsd
    if (normalized === 'betausd' || normalized === 'beta') return addressLookup.betaUsd
    if (normalized === 'thetausd' || normalized === 'theta') return addressLookup.thetaUsd
    return null
  })()
  if (tokenAddress && isAllowedToken(chainId, tokenAddress)) return tokenAddress
  return null
}

export function getTokenMetadataFallback(tokenAddress: string) {
  if (Address.isEqual(Address.checksum(tokenAddress), addressLookup.pathUsd))
    return { currency: 'USD', symbol: 'PathUSD' }
  if (Address.isEqual(Address.checksum(tokenAddress), addressLookup.alphaUsd))
    return { currency: 'USD', symbol: 'AlphaUSD' }
  if (Address.isEqual(Address.checksum(tokenAddress), addressLookup.betaUsd))
    return { currency: 'USD', symbol: 'BetaUSD' }
  if (Address.isEqual(Address.checksum(tokenAddress), addressLookup.thetaUsd))
    return { currency: 'USD', symbol: 'ThetaUSD' }
  if (Address.isEqual(Address.checksum(tokenAddress), addressLookup.usdcE))
    return { currency: 'USD', symbol: 'USDC.e' }
  if (Address.isEqual(Address.checksum(tokenAddress), addressLookup.usdt0))
    return { currency: 'USD', symbol: 'USDT0' }
  return { currency: 'USD', symbol: `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}` }
}
