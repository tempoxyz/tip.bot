import '@tanstack/react-start/server-only'
import { env } from 'cloudflare:workers'
import { Client } from 'tapimo'
import * as Tempo from '#/lib/tempo.ts'

export const client = Client.create({
  apiKey: env.TEMPO_API_KEY,
})

export async function getTokenMetadata(chainId: number, tokenAddress: string) {
  if (chainId === Tempo.chainLookup.localnet) return Tempo.getTokenMetadataFallback(tokenAddress)

  try {
    const tokenMetadataTimeoutMs = 1_000 // 1 second
    const response = await client.v1.tokens[':token'].$get(
      {
        param: { token: tokenAddress as `0x${string}` },
        query: { chainId: String(chainId) },
      },
      { init: { signal: AbortSignal.timeout(tokenMetadataTimeoutMs) } },
    )
    if (response.status !== 200) throw new Error(`Tempo API returned ${response.status}.`)
    const metadata = await response.json()
    return { currency: metadata.currency, symbol: metadata.symbol }
  } catch {
    return Tempo.getTokenMetadataFallback(tokenAddress)
  }
}
