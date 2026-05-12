import { createEmulator } from 'emulate'
import { Server } from 'prool'
import * as TestContainers from 'prool/testcontainers'
import type { TestProject } from 'vitest/node'
import * as Constants from './constants.ts'
import { Env } from './env.ts'
import { getAvailablePort } from './utils.ts'

export default async function (project: TestProject) {
  const rpcPort = await getAvailablePort()
  const slack = await createEmulator({
    port: await getAvailablePort(),
    seed: Constants.seed,
    service: 'slack',
  })
  const tempo = Server.create({
    instance: TestContainers.Instance.tempo({
      blockTime: '2ms',
      image: `ghcr.io/tempoxyz/tempo:${process.env.VITE_NODE_TAG || 'latest'}`,
      port: rpcPort,
    } satisfies Pick<TestContainers.Instance.tempo.Parameters, 'blockTime' | 'image' | 'port'>),
    port: rpcPort,
  })
  await tempo.start()
  const env = Env.get({
    RPC_URL_TESTNET: `http://127.0.0.1:${rpcPort}/1`,
    SLACK_API_URL: `${slack.url}/api`,
  })
  process.env.FEE_PAYER_PRIVATE_KEY_MAINNET = env.FEE_PAYER_PRIVATE_KEY_MAINNET
  process.env.FEE_PAYER_PRIVATE_KEY_TESTNET = env.FEE_PAYER_PRIVATE_KEY_TESTNET
  process.env.VITE_RPC_PORT = String(rpcPort)

  project.provide('env', JSON.stringify(env))

  return async () => {
    await tempo.stop()
    await slack.close()
  }
}
