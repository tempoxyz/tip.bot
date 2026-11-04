import { Server } from 'prool'
import * as TestContainers from 'prool/testcontainers'
import { createClient, http, parseUnits } from 'viem'
import { Account, Actions } from 'viem/tempo'
import * as Tempo from '#/lib/tempo.ts'
import { getAvailablePort } from './utils.ts'

/** Starts a local Tempo node through prool. Returns its RPC URL and `stop`. */
export async function start() {
  const port = await getAvailablePort()
  const server = Server.create({
    instance: TestContainers.Instance.tempo({
      blockTime: '2ms',
      image: getImage(),
      port,
    } satisfies Pick<TestContainers.Instance.tempo.Parameters, 'blockTime' | 'image' | 'port'>),
    port,
  })
  await server.start()
  return { port, rpcUrl: `http://127.0.0.1:${port}/1`, stop: () => server.stop() }
}

/** Mints PathUSD to `to` with the fee payer's account, which the dev genesis lets mint. */
export async function mint(input: {
  amount: string
  feePayer: `0x${string}`
  rpcUrl: string
  to: string
}) {
  const client = createClient({
    chain: Tempo.getChain(Tempo.chainLookup.localnet),
    transport: http(input.rpcUrl),
  })
  return await retry(
    () =>
      Actions.token.mintSync(client, {
        account: Account.fromSecp256k1(input.feePayer),
        amount: parseUnits(input.amount, 6),
        to: input.to as `0x${string}`,
        token: Tempo.addressLookup.pathUsd,
      }),
    'mint PathUSD',
  )
}

function getImage() {
  if (process.env.VITE_TEMPO_IMAGE?.startsWith('sha256:'))
    return `ghcr.io/tempoxyz/tempo@${process.env.VITE_TEMPO_IMAGE}`
  return `ghcr.io/tempoxyz/tempo:${process.env.VITE_TEMPO_IMAGE || 'latest'}`
}

// The node accepts transactions a moment after its container starts.
async function retry<T>(fn: () => Promise<T>, label: string) {
  const retryTimeoutMs = 30_000 // 30 seconds
  const retryDelayMs = 500 // 500 milliseconds
  const deadline = Date.now() + retryTimeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }
  throw new Error(`Timed out trying to ${label}.`, { cause: lastError })
}
