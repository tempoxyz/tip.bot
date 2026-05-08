import { createClient } from 'viem'

import { api } from '#/lib/api.ts'
import { createDb } from '#/lib/db.ts'
import { createRelayTransport } from '#/lib/relay.ts'
import { getTempoChain, pathUsd } from '#/lib/tempo.ts'
import { createFactory } from './factory.ts'

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname === '/__test/serverRelayTransport')
      return await handleServerRelayTransportTest(env)
    if (url.pathname === '/__test/relayFillAddsFeeCaps')
      return await handleRelayFillAddsFeeCapsTest(env)
    if (url.pathname.startsWith('/api/')) return await api.fetch(request, env)
    return new Response('Not found.', { status: 404 })
  },
}

async function handleRelayFillAddsFeeCapsTest(env: Env) {
  await insertRelayFillTipAttempt(env)

  const fetchBefore = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string }
    if (body.method === 'eth_fillTransaction')
      return Response.json({
        id: body.id,
        jsonrpc: '2.0',
        result: {
          capabilities: { sponsored: false },
          tx: {
            accessList: [],
            calls: [transferCall()],
            chainId: '0xa5bf',
            from: '0x1111111111111111111111111111111111111111',
            gas: '0x5208',
            nonce: '0x0',
            type: '0x76',
          },
        },
      })
    if (body.method === 'eth_getBlockByNumber')
      return Response.json({
        id: body.id,
        jsonrpc: '2.0',
        result: { baseFeePerGas: '0x64' },
      })
    if (body.method === 'eth_maxPriorityFeePerGas')
      return Response.json({ id: body.id, jsonrpc: '2.0', result: '0x3' })
    return Response.json({
      error: { code: -32601, message: body.method },
      id: body.id,
      jsonrpc: '2.0',
    })
  }

  try {
    const response = await api.fetch(
      new Request('https://tip.test/api/relay/42431', {
        body: JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'eth_fillTransaction',
          params: [
            {
              calls: [transferCall()],
              chainId: '0xa5bf',
              feePayer: true,
              from: '0x1111111111111111111111111111111111111111',
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      env,
    )
    const json = (await response.json()) as {
      result?: { tx?: { gas?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string } }
    }
    return Response.json({
      gas: json.result?.tx?.gas,
      maxFeePerGas: json.result?.tx?.maxFeePerGas,
      maxPriorityFeePerGas: json.result?.tx?.maxPriorityFeePerGas,
    })
  } finally {
    globalThis.fetch = fetchBefore
  }
}

async function handleServerRelayTransportTest(env: Env) {
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async (input) =>
    new Response(`Unexpected external fetch: ${String(input)}`, { status: 599 })

  try {
    const chain = getTempoChain(env.TEMPO_CHAIN)
    const client = createClient({
      chain,
      transport: createRelayTransport({ ...env, FEE_PAYER_PRIVATE_KEY: '' }, chain.id),
    })

    await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })
    return Response.json(
      { ok: false, reason: 'Relay request unexpectedly succeeded.' },
      { status: 500 },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('Fee payer is not configured.')) return Response.json({ ok: true })
    return Response.json({ ok: false, reason: message }, { status: 500 })
  } finally {
    globalThis.fetch = fetchBefore
  }
}

function transferCall() {
  return {
    data: `0xa9059cbb${'2'.repeat(64)}${'3'.repeat(64)}`,
    to: pathUsd,
  }
}

async function insertRelayFillTipAttempt(env: Env) {
  const factory = createFactory(createDb(env.DB))
  const workspace = await factory.workspace.insert({ platform_team_id: 'TRELAYER' })
  const [sender, recipient] = await factory.account.insert(
    {
      platform_account_id: 'URELAYSENDER',
      tempo_address: '0x1111111111111111111111111111111111111111',
      workspace_id: workspace.id,
    },
    {
      platform_account_id: 'URELAYRECIPIENT',
      tempo_address: '0x2222222222222222222222222222222222222222',
      workspace_id: workspace.id,
    },
  )
  const tip = await factory.tip.insert({
    idempotency_key: 'relay-fill',
    recipient_account_id: recipient.id,
    sender_account_id: sender.id,
    workspace_id: workspace.id,
  })
  await factory.tip_attempt.insert({
    amount: BigInt(`0x${'3'.repeat(64)}`).toString(),
    recipient_address: recipient.tempo_address!,
    sender_address: sender.tempo_address!,
    tip_id: tip.id,
  })
}
