import { tempo, tempoModerato } from 'viem/chains'
import { Addresses } from 'viem/tempo'

export type TempoChain = 'testnet' | 'mainnet'

export const defaultChain = tempoModerato
export const pathUsd = Addresses.pathUsd
export const pathUsdDecimals = 6

export function getTempoChain(value: string | undefined) {
  if (value === 'mainnet') return tempo
  if (value === 'testnet') return tempoModerato
  throw new Error('TEMPO_CHAIN must be testnet or mainnet.')
}
