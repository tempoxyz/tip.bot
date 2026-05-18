import { defineChain } from 'viem/chains/utils'

// viem/chains exports every chain definition. Worker tests only need Tempo chains, and
// loading the full barrel dominates cold CI transform/import time.
// @ts-expect-error viem does not export chainConfig as a public subpath.
import { chainConfig } from '../node_modules/viem/_esm/tempo/chainConfig.js'

export const tempo = defineChain({
  ...chainConfig,
  blockExplorers: {
    default: {
      name: 'Tempo Explorer',
      url: 'https://explore.tempo.xyz',
    },
  },
  id: 4217,
  name: 'Tempo Mainnet',
  nativeCurrency: {
    decimals: 6,
    name: 'USD',
    symbol: 'USD',
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.tempo.xyz'],
      webSocket: ['wss://rpc.tempo.xyz'],
    },
  },
})

export const tempoLocalnet = defineChain({
  ...chainConfig,
  hardfork: 't3',
  id: 1337,
  name: 'Tempo',
  nativeCurrency: {
    decimals: 6,
    name: 'USD',
    symbol: 'USD',
  },
  rpcUrls: {
    default: { http: ['http://localhost:8545'] },
  },
})

export const tempoModerato = defineChain({
  ...chainConfig,
  blockExplorers: {
    default: {
      name: 'Tempo Explorer',
      url: 'https://explore.testnet.tempo.xyz',
    },
  },
  id: 42431,
  name: 'Tempo Testnet (Moderato)',
  nativeCurrency: {
    decimals: 6,
    name: 'USD',
    symbol: 'USD',
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.moderato.tempo.xyz'],
      webSocket: ['wss://rpc.moderato.tempo.xyz'],
    },
  },
  testnet: true,
})
