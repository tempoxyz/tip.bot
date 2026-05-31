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
  const setupStartedAt = Date.now()
  const slack = await time('workers: start slack emulator', async () =>
    createEmulator({
      port: await getAvailablePort(),
      seed: Constants.seed,
      service: 'slack',
    }),
  )

  const rpcPort = await getAvailablePort()
  const tempo = Server.create({
    instance: TestContainers.Instance.tempo({
      blockTime: '2ms',
      image: getTempoImage(),
      port: rpcPort,
    } satisfies Pick<TestContainers.Instance.tempo.Parameters, 'blockTime' | 'image' | 'port'>),
    port: rpcPort,
  })
  await time('workers: start tempo', () => tempo.start())

  const env = Env.get({
    RPC_URL_TESTNET: `http://127.0.0.1:${rpcPort}/1`,
    SLACK_API_URL: `${slack.url}/api`,
  })

  await time('workers: mint fee payer', () =>
    Actions.token.mintSync(
      createClient({
        chain: Tempo.getChain(Tempo.chainLookup.localnet),
        transport: http(env.RPC_URL_TESTNET),
      }),
      {
        account: Account.fromSecp256k1(env.FEE_PAYER_PRIVATE_KEY_TESTNET),
        amount: parseUnits('1000', 6),
        to: Account.fromSecp256k1(Constants.tip.senderRootPrivateKey).address,
        token: Tempo.addressLookup.pathUsd,
      },
    ),
  )

  process.env.FEE_PAYER_PRIVATE_KEY_MAINNET = env.FEE_PAYER_PRIVATE_KEY_MAINNET
  process.env.FEE_PAYER_PRIVATE_KEY_TESTNET = env.FEE_PAYER_PRIVATE_KEY_TESTNET
  process.env.VITE_RPC_PORT = String(rpcPort)

  project.provide('env', JSON.stringify(env))
  console.log(`workers: global setup completed in ${Date.now() - setupStartedAt}ms`)

  return async () => {
    await time('workers: stop tempo', () => tempo.stop())
    await time('workers: close slack emulator', () => slack.close())
  }
}

function getTempoImage() {
  if (process.env.VITE_TEMPO_IMAGE?.startsWith('sha256:'))
    return `ghcr.io/tempoxyz/tempo@${process.env.VITE_TEMPO_IMAGE}`
  return `ghcr.io/tempoxyz/tempo:${process.env.VITE_TEMPO_IMAGE || 'latest'}`
}

async function time<T>(label: string, task: () => Promise<T>) {
  console.log(`${label}: starting`)
  const startedAt = Date.now()
  try {
    return await task()
  } finally {
    console.log(`${label}: completed in ${Date.now() - startedAt}ms`)
  }
}
