import { Dialog, Provider, dialog } from 'accounts'

export { defaultChain, pathUsd, pathUsdDecimals } from '#/lib/tempoConstants.ts'

export const accessKeyTtlSeconds = 7 * 24 * 60 * 60 // 7 days
export const connectTokenTtlMs = 15 * 60 * 1000 // 15 minutes
export const tipAttemptTtlMs = 5 * 60 * 1000 // 5 minutes

let provider: ReturnType<typeof Provider.create> | undefined

export function getTempoProvider() {
  provider ??= Provider.create({ adapter: dialog({ dialog: Dialog.iframe() }) })
  return provider
}
