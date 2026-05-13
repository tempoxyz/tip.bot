import { createEmulator } from 'emulate'
import { Server } from 'prool'
import * as TestContainers from 'prool/testcontainers'
import { PullPolicy } from 'testcontainers'
import type { TestProject } from 'vitest/node'
import { createClient, http, parseUnits } from 'viem'
import { Account, Actions } from 'viem/tempo'
import * as Tempo from '#/lib/tempo.ts'
import * as Constants from './constants.ts'
import { Env } from './env.ts'
import { getAvailablePort } from './utils.ts'

export default async function (project: TestProject) {
  const startedAt = performance.now()

  const slack = await measure('slack emulator startup', async () => {
    console.log('workers: starting slack emulator')
    const emulator = await createEmulator({
      port: await getAvailablePort(),
      seed: Constants.seed,
      service: 'slack',
    })
    console.log('workers: started slack emulator')
    return emulator
  })

  console.log('workers: starting tempo')
  const rpcPort = await getAvailablePort()
  const tempo = Server.create({
    instance: TestContainers.Instance.tempo({
      blockTime: '2ms',
      image: getTempoImage(),
      port: rpcPort,
    } satisfies Pick<TestContainers.Instance.tempo.Parameters, 'blockTime' | 'image' | 'port'>),
    port: rpcPort,
  })
  const restorePullPolicy = useDefaultPullPolicy()
  await measure('tempo startup', async () => {
    try {
      await tempo.start()
    } finally {
      restorePullPolicy()
    }
    console.log('workers: started tempo')
  })

  const env = Env.get({
    RPC_URL_TESTNET: `http://127.0.0.1:${rpcPort}/1`,
    SLACK_API_URL: `${slack.url}/api`,
  })

  console.log('workers: minting fee payer')
  await measure('fee payer mint', async () => {
    await Actions.token.mintSync(
      createClient({
        chain: Tempo.getChain(Tempo.localnetChainId),
        transport: http(env.RPC_URL_TESTNET),
      }),
      {
        account: Account.fromSecp256k1(env.FEE_PAYER_PRIVATE_KEY_TESTNET),
        amount: parseUnits('10', 6),
        to: Account.fromSecp256k1(Constants.tip.senderRootPrivateKey).address,
        token: Tempo.pathUsdAddress,
      },
    )
    console.log('workers: minted fee payer')
  })

  process.env.FEE_PAYER_PRIVATE_KEY_MAINNET = env.FEE_PAYER_PRIVATE_KEY_MAINNET
  process.env.FEE_PAYER_PRIVATE_KEY_TESTNET = env.FEE_PAYER_PRIVATE_KEY_TESTNET
  process.env.VITE_RPC_PORT = String(rpcPort)

  project.provide('env', JSON.stringify(env))
  console.log(`workers: global setup took ${formatDuration(performance.now() - startedAt)}`)

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

function useDefaultPullPolicy() {
  const alwaysPull = () => ({ shouldPull: () => true })
  PullPolicy.alwaysPull = () => PullPolicy.defaultPolicy()
  return () => {
    PullPolicy.alwaysPull = alwaysPull
  }
}

async function measure<Value>(label: string, fn: () => Promise<Value>) {
  const startedAt = performance.now()
  try {
    return await fn()
  } finally {
    console.log(`workers: ${label} took ${formatDuration(performance.now() - startedAt)}`)
  }
}

function formatDuration(milliseconds: number) {
  return `${Math.round(milliseconds)}ms`
}
