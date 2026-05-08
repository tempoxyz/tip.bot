import { Dialog, Provider, Storage, dialog } from 'accounts'

import { getTempoChain, type TempoChain } from '#/lib/tempoConstants.ts'

export { defaultChain, getTempoChain, pathUsd, pathUsdDecimals } from '#/lib/tempoConstants.ts'

export const accessKeyTtlSeconds = 7 * 24 * 60 * 60 // 7 days
export const connectTokenTtlMs = 15 * 60 * 1000 // 15 minutes
export const tipAttemptTtlMs = 5 * 60 * 1000 // 5 minutes

let provider: ReturnType<typeof Provider.create> | undefined
let providerChainId: number | undefined

export function getTempoProvider(value: TempoChain = 'testnet') {
  const chain = getTempoChain(value)
  if (providerChainId !== chain.id) provider = undefined
  provider ??= Provider.create({
    adapter: dialog({ dialog: Dialog.iframe() }),
    chains: [chain],
    storage: Storage.idb({ key: `tipbot-${value}` }),
    testnet: chain.testnet,
  })
  providerChainId = chain.id
  return provider
}
