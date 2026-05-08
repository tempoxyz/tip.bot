import { Handler } from 'accounts/server'
import { http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { createDb } from '#/lib/db.ts'
import { getTempoChain, pathUsd } from '#/lib/tempo.ts'

export type RelayEnv = Env & {
  FEE_PAYER_PRIVATE_KEY?: `0x${string}`
}

export function createRelayTransport(env: Env, chainId: number) {
  return http(`https://tip.bot.internal/api/relay/${chainId}`, {
    fetchFn: async (input, init) => handleRelay(new Request(input, init), env as RelayEnv),
  })
}

export function handleRelay(request: Request, env: RelayEnv) {
  if (!env.FEE_PAYER_PRIVATE_KEY)
    return new Response('Fee payer is not configured.', { status: 500 })

  return Handler.relay({
    chains: [getTempoChain(env.TEMPO_CHAIN)],
    feePayer: {
      account: privateKeyToAccount(env.FEE_PAYER_PRIVATE_KEY) as never,
      name: 'Tip',
      validate: async (transaction: Record<string, unknown>) =>
        await shouldSponsor(env, transaction),
    },
    path: '/api/relay',
  } as never).fetch(request)
}

type Call = {
  data?: string
  to?: string
}

async function shouldSponsor(env: RelayEnv, transaction: Record<string, unknown>) {
  const call = Array.isArray(transaction.calls)
    ? (transaction.calls[0] as Call | undefined)
    : undefined
  const parsed = parseTransferCall(call)
  const sender = typeof transaction.from === 'string' ? transaction.from.toLowerCase() : null
  if (!sender || !parsed) return false

  const attempt = await createDb(env.DB)
    .selectFrom('tip_attempt')
    .selectAll()
    .where('sender_address', '=', sender)
    .where('recipient_address', '=', parsed.to)
    .where('amount', '=', parsed.amount)
    .where('token_address', '=', pathUsd)
    .where('expires_at', '>', new Date().toISOString())
    .executeTakeFirst()

  return Boolean(attempt)
}

function parseTransferCall(call: Call | undefined) {
  if (!call?.data || call.to?.toLowerCase() !== pathUsd.toLowerCase()) return null
  if (!call.data.startsWith('0xa9059cbb')) return null

  const to = `0x${call.data.slice(34, 74)}`.toLowerCase()
  const amount = BigInt(`0x${call.data.slice(74, 138)}`).toString()
  return { amount, to }
}
