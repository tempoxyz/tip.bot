import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'
import { Handler } from 'accounts/server'
import { privateKeyToAccount } from 'viem/accounts'

import { createDb } from '#/lib/db.ts'
import { pathUsd } from '#/lib/tempo.ts'

type RelayEnv = Env & {
  FEE_PAYER_PRIVATE_KEY?: `0x${string}`
}

export const Route = createFileRoute('/relay')({
  server: {
    handlers: {
      GET: (ctx) => handleRelay(ctx.request),
      POST: (ctx) => handleRelay(ctx.request),
    },
  },
})

function handleRelay(request: Request) {
  const relayEnv = env as RelayEnv
  if (!relayEnv.FEE_PAYER_PRIVATE_KEY)
    return new Response('Fee payer is not configured.', { status: 500 })

  return Handler.relay({
    feePayer: {
      account: privateKeyToAccount(relayEnv.FEE_PAYER_PRIVATE_KEY) as never,
      name: 'Tip',
      validate: async (transaction: Record<string, unknown>) =>
        await shouldSponsor(relayEnv, transaction),
    },
    path: '/relay',
  } as never).fetch(request)
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

type Call = {
  data?: string
  to?: string
}

function parseTransferCall(call: Call | undefined) {
  if (!call?.data || call.to?.toLowerCase() !== pathUsd.toLowerCase()) return null
  if (!call.data.startsWith('0xa9059cbb')) return null

  const to = `0x${call.data.slice(34, 74)}`.toLowerCase()
  const amount = BigInt(`0x${call.data.slice(74, 138)}`).toString()
  return { amount, to }
}
