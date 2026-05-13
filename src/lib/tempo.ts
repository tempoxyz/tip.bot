import { Address } from 'ox'
import { createClient, http } from 'viem'
import { Actions } from 'viem/tempo'
import { tempo, tempoLocalnet, tempoModerato } from 'viem/chains'

export const pathUsdAddress = Address.checksum('0x20c0000000000000000000000000000000000000')
export const alphaUsdAddress = Address.checksum('0x20c0000000000000000000000000000000000001')
export const betaUsdAddress = Address.checksum('0x20c0000000000000000000000000000000000002')
export const thetaUsdAddress = Address.checksum('0x20c0000000000000000000000000000000000003')

export const mainnetChainId = tempo.id
export const moderatoChainId = tempoModerato.id
export const localnetChainId = tempoLocalnet.id

export function getChain(chainId: number) {
  if (chainId === tempo.id) return tempo
  if (chainId === tempoModerato.id) return tempoModerato
  if (chainId === tempoLocalnet.id) return tempoLocalnet
  throw new Error(`Unsupported Tempo chain ${chainId}.`)
}

export function getRpcUrl(env: Pick<Env, 'RPC_URL_MAINNET' | 'RPC_URL_TESTNET'>, chainId: number) {
  if (chainId === tempo.id) return env.RPC_URL_MAINNET || undefined
  if (chainId === tempoModerato.id || chainId === tempoLocalnet.id)
    return env.RPC_URL_TESTNET || undefined
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
  if (chainId === tempo.id) return Address.isEqual(token, pathUsdAddress)
  if (chainId === tempoModerato.id || chainId === tempoLocalnet.id)
    return [pathUsdAddress, alphaUsdAddress, betaUsdAddress, thetaUsdAddress].some((allowed) =>
      Address.isEqual(token, allowed),
    )
  return false
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
  if (Address.isEqual(Address.checksum(tokenAddress), pathUsdAddress))
    return { currency: 'USD', symbol: 'pathUSD' }
  if (Address.isEqual(Address.checksum(tokenAddress), alphaUsdAddress))
    return { currency: 'USD', symbol: 'AlphaUSD' }
  if (Address.isEqual(Address.checksum(tokenAddress), betaUsdAddress))
    return { currency: 'USD', symbol: 'BetaUSD' }
  if (Address.isEqual(Address.checksum(tokenAddress), thetaUsdAddress))
    return { currency: 'USD', symbol: 'ThetaUSD' }
  return { currency: 'USD', symbol: `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}` }
}
