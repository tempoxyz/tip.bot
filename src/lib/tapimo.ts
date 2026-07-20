import '@tanstack/react-start/server-only'
import * as Client from 'tapimo/client'
import * as Tempo from '#/lib/tempo.ts'

export const client = Client.create()

export async function getTokenBalances(
  env: Pick<Env, 'TEMPO_API_KEY'>,
  chainId: number,
  address: string,
) {
  if (chainId === Tempo.chainLookup.localnet) return null

  try {
    const tokenBalancesTimeoutMs = 1_500 // 1.5 seconds
    const response = await client.v1.addresses[':address'].balances.$get(
      {
        param: { address: address as `0x${string}` },
        query: { chainId: String(chainId), limit: '200', verified: 'true' },
      },
      {
        init: {
          headers: { 'tempo-api-key': env.TEMPO_API_KEY },
          signal: AbortSignal.timeout(tokenBalancesTimeoutMs),
        },
      },
    )
    if (response.status !== 200) throw new Error(`Tempo API returned ${response.status}.`)
    return (await response.json()).data.filter((balance) =>
      Tempo.isAllowedToken(chainId, balance.token.address),
    )
  } catch {
    return null
  }
}

export async function getTokenMetadata(
  env: Pick<Env, 'TEMPO_API_KEY'>,
  chainId: number,
  tokenAddress: string,
) {
  if (chainId === Tempo.chainLookup.localnet) return Tempo.getTokenMetadataFallback(tokenAddress)

  try {
    const tokenMetadataTimeoutMs = 1_000 // 1 second
    const response = await client.v1.tokens[':token'].$get(
      {
        param: { token: tokenAddress as `0x${string}` },
        query: { chainId: String(chainId) },
      },
      {
        init: {
          headers: { 'tempo-api-key': env.TEMPO_API_KEY },
          signal: AbortSignal.timeout(tokenMetadataTimeoutMs),
        },
      },
    )
    if (response.status !== 200) throw new Error(`Tempo API returned ${response.status}.`)
    const metadata = await response.json()
    return { currency: metadata.currency, symbol: metadata.symbol }
  } catch {
    return Tempo.getTokenMetadataFallback(tokenAddress)
  }
}
