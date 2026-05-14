import { Address } from 'ox'
import { createClient, http } from 'viem'
import { Actions } from 'viem/tempo'
import { tempo, tempoLocalnet, tempoModerato } from 'viem/chains'

export const addressLookup = {
  alphaUsd: Address.checksum('0x20c0000000000000000000000000000000000001'),
  betaUsd: Address.checksum('0x20c0000000000000000000000000000000000002'),
  pathUsd: Address.checksum('0x20c0000000000000000000000000000000000000'),
  thetaUsd: Address.checksum('0x20c0000000000000000000000000000000000003'),
  usdcE: Address.checksum('0x20C000000000000000000000b9537d11c60E8b50'),
  usdt0: Address.checksum('0x20c00000000000000000000014f22ca97301eb73'),
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

export function getRpcUrl(env: Pick<Env, 'RPC_URL_MAINNET' | 'RPC_URL_TESTNET'>, chainId: number) {
  if (chainId === chainLookup.mainnet) return env.RPC_URL_MAINNET || undefined
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
  return `${chain.blockExplorers?.default.url ?? chain.rpcUrls.default.http[0]}/tx/${transactionHash}`
}

export function formatTokenLink(chainId: number, tokenAddress: string) {
  const chain = getChain(chainId)
  return `${chain.blockExplorers?.default.url ?? chain.rpcUrls.default.http[0]}/address/${tokenAddress}`
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

export async function getTokenMetadata(
  env: Pick<Env, 'RPC_URL_MAINNET' | 'RPC_URL_TESTNET'>,
  chainId: number,
  tokenAddress: string,
) {
  try {
    const token = Address.checksum(tokenAddress)
    const tokenMetadataTimeoutMs = 1_000 // 1 second
    const metadata = await Actions.token.getMetadata(
      createClient({
        chain: getChain(chainId),
        transport: http(getRpcUrl(env, chainId), {
          retryCount: 0,
          timeout: tokenMetadataTimeoutMs,
        }),
      }),
      { token },
    )
    return { currency: metadata.currency, symbol: metadata.symbol }
  } catch {
    return getTokenMetadataFallback(tokenAddress)
  }
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
