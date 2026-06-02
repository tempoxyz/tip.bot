import { createEmulator } from 'emulate'
import { Server } from 'prool'
import * as TestContainers from 'prool/testcontainers'
import type { TestProject } from 'vitest/node'
import { createClient, http, parseUnits } from 'viem'
import { Account, Actions } from 'viem/tempo'
import * as Tempo from '#/lib/tempo.ts'
import * as Constants from './constants.ts'
import { Env } from './env.ts'
import { getAvailablePort } from './utils.ts'

export default async function (project: TestProject) {
  console.log('workers: starting slack emulator')
  const slack = await createEmulator({
    port: await getAvailablePort(),
    seed: Constants.seed,
    service: 'slack',
  })
  console.log('workers: started slack emulator')

  const rpcPort = await getAvailablePort()
  const tempo = Server.create({
    instance: TestContainers.Instance.tempo({
      blockTime: '2ms',
      image: getTempoImage(),
      port: rpcPort,
    } satisfies Pick<TestContainers.Instance.tempo.Parameters, 'blockTime' | 'image' | 'port'>),
    port: rpcPort,
  })
  console.log('workers: starting tempo')
  await tempo.start()
  console.log('workers: started tempo')

  const env = Env.get({
    RPC_URL_TESTNET: `http://127.0.0.1:${rpcPort}/1`,
    SLACK_API_URL: `${slack.url}/api`,
  })
  const client = createClient({
    chain: Tempo.getChain(Tempo.chainLookup.localnet),
    transport: http(env.RPC_URL_TESTNET),
  })

  console.log('workers: minting fee payer')
  await retryTempoSetup(
    () =>
      Actions.token.mintSync(client, {
        account: Account.fromSecp256k1(env.FEE_PAYER_PRIVATE_KEY_TESTNET),
        amount: parseUnits('1000', 6),
        to: Account.fromSecp256k1(Constants.tip.senderRootPrivateKey).address,
        token: Tempo.addressLookup.pathUsd,
      }),
    'mint fee payer',
  )
  console.log('workers: minted fee payer')

  process.env.FEE_PAYER_PRIVATE_KEY_MAINNET = env.FEE_PAYER_PRIVATE_KEY_MAINNET
  process.env.FEE_PAYER_PRIVATE_KEY_TESTNET = env.FEE_PAYER_PRIVATE_KEY_TESTNET
  process.env.SECRET_KEY = env.SECRET_KEY
  process.env.SLACK_CLIENT_ID = env.SLACK_CLIENT_ID
  process.env.SLACK_CLIENT_SECRET = env.SLACK_CLIENT_SECRET
  process.env.SLACK_SIGNING_SECRET = env.SLACK_SIGNING_SECRET
  process.env.TWITTER_ACCESS_TOKEN = env.TWITTER_ACCESS_TOKEN
  process.env.TWITTER_ACCESS_TOKEN_SECRET = env.TWITTER_ACCESS_TOKEN_SECRET
  process.env.TWITTER_BEARER_TOKEN = env.TWITTER_BEARER_TOKEN
  process.env.TWITTER_CONSUMER_KEY = env.TWITTER_CONSUMER_KEY
  process.env.TWITTER_CONSUMER_SECRET = env.TWITTER_CONSUMER_SECRET
  process.env.VITE_RPC_PORT = String(rpcPort)

  project.provide('env', JSON.stringify(env))

  return async () => {
    await tempo.stop()
    await slack.close()
  }
}

function getTempoImage() {
  if (process.env.VITE_TEMPO_IMAGE?.startsWith('sha256:'))
    return `ghcr.io/tempoxyz/tempo@${process.env.VITE_TEMPO_IMAGE}`
  return `ghcr.io/tempoxyz/tempo:${process.env.VITE_TEMPO_IMAGE || 'latest'}`
}

async function retryTempoSetup<T>(fn: () => Promise<T>, label: string) {
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
