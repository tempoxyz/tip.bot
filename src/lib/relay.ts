import { Handler } from 'accounts/server'
import { createClient, http, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { createClient as createDb } from '#db/client.ts'
import { getTempoChain, pathUsd } from '#/lib/tempo.ts'

const sponsoredTempoGasFloor = 5_000_000n

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

  return handleRelayResponse(
    request,
    Promise.resolve(
      Handler.relay({
        chains: [getTempoChain(env.TEMPO_CHAIN)],
        feePayer: {
          account: privateKeyToAccount(env.FEE_PAYER_PRIVATE_KEY) as never,
          name: 'Tipbot',
          validate: async (transaction: Record<string, unknown>) =>
            await shouldSponsor(env, transaction),
        },
        path: '/api/relay',
      } as never).fetch(request.clone() as Request),
    ),
    env,
  )
}

type Call = {
  data?: string
  to?: string
}

async function handleRelayResponse(request: Request, responsePromise: Promise<Response>, env: Env) {
  const response = await responsePromise
  if (request.method !== 'POST') return response

  const body = (await request.json().catch(() => null as unknown)) as
    | RelayRpcRequest
    | RelayRpcRequest[]
    | null
  if (!hasFillTransactionRequest(body)) return response

  const json = (await response
    .clone()
    .json()
    .catch(() => null as unknown)) as RelayRpcResponse | RelayRpcResponse[] | null
  const responses = Array.isArray(json) ? json : json ? [json] : []
  const needsFinalization = responses.some((item) => needsTempoFillFinalization(item.result?.tx))
  if (!needsFinalization) return response

  const fees = responses.some((item) => needsTempoFeeCaps(item.result?.tx))
    ? await getTempoFeeCaps(env)
    : undefined
  for (const item of responses) {
    finalizeTempoFill(item.result?.tx, fees)
  }

  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return Response.json(Array.isArray(json) ? responses : responses[0], {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

async function getTempoFeeCaps(env: Env) {
  const chain = getTempoChain(env.TEMPO_CHAIN)
  const client = createClient({
    chain,
    transport: http(),
  })
  const [block, maxPriorityFeePerGasHex] = await Promise.all([
    client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }),
    client.request({ method: 'eth_maxPriorityFeePerGas' }).catch(() => '0x0'),
  ])
  const baseFeePerGas = getHexQuantity(block, 'baseFeePerGas')
  const maxPriorityFeePerGas = BigInt(maxPriorityFeePerGasHex as `0x${string}`)
  const maxFeePerGas = baseFeePerGas * 2n + maxPriorityFeePerGas
  return { maxFeePerGas, maxPriorityFeePerGas }
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

type RelayRpcRequest = {
  method?: string
}

type RelayRpcResponse = {
  result?: {
    tx?: Record<string, unknown>
  }
}

function finalizeTempoFill(
  tx: Record<string, unknown> | undefined,
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined,
) {
  if (!tx || !needsTempoFillFinalization(tx)) return
  const target = tx
  if (getHexQuantityOrZero(target.gas) < sponsoredTempoGasFloor)
    target.gas = toHex(sponsoredTempoGasFloor)
  if (!fees || !needsTempoFeeCaps(target)) return
  target.maxFeePerGas = toHex(fees.maxFeePerGas)
  target.maxPriorityFeePerGas = toHex(fees.maxPriorityFeePerGas)
}

function getHexQuantity(value: unknown, key: string) {
  if (!value || typeof value !== 'object') throw new Error(`Missing ${key}.`)
  const quantity = (value as Record<string, unknown>)[key]
  if (typeof quantity !== 'string' || !quantity.startsWith('0x')) throw new Error(`Missing ${key}.`)
  return BigInt(quantity as `0x${string}`)
}

function getHexQuantityOrZero(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('0x')) return 0n
  return BigInt(value as `0x${string}`)
}

function hasFillTransactionRequest(body: RelayRpcRequest | RelayRpcRequest[] | null) {
  const requests = Array.isArray(body) ? body : body ? [body] : []
  return requests.some((item) => item.method === 'eth_fillTransaction')
}

function needsTempoFeeCaps(tx: Record<string, unknown> | undefined) {
  return Boolean(
    tx &&
    isEmptyFee(tx.gasPrice) &&
    isEmptyFee(tx.maxFeePerGas) &&
    isEmptyFee(tx.maxPriorityFeePerGas),
  )
}

function needsTempoFillFinalization(tx: Record<string, unknown> | undefined) {
  return Boolean(
    tx && (needsTempoFeeCaps(tx) || getHexQuantityOrZero(tx.gas) < sponsoredTempoGasFloor),
  )
}

function isEmptyFee(value: unknown) {
  return typeof value === 'undefined' || value === '0x' || value === '0x0'
}

function parseTransferCall(call: Call | undefined) {
  if (!call?.data || call.to?.toLowerCase() !== pathUsd.toLowerCase()) return null
  if (!call.data.startsWith('0xa9059cbb')) return null

  const to = `0x${call.data.slice(34, 74)}`.toLowerCase()
  const amount = BigInt(`0x${call.data.slice(74, 138)}`).toString()
  return { amount, to }
}
