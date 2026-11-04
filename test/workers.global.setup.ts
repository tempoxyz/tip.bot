import { createEmulator } from 'emulate'
import type { TestProject } from 'vitest/node'
import { Account } from 'viem/tempo'
import * as Constants from './constants.ts'
import { Env } from './env.ts'
import * as TempoNode from './tempo.ts'
import { getAvailablePort } from './utils.ts'

export default async function (project: TestProject) {
  console.log('workers: starting slack emulator')
  const slack = await createEmulator({
    port: await getAvailablePort(),
    seed: Constants.seed,
    service: 'slack',
  })
  console.log('workers: started slack emulator')

  console.log('workers: starting tempo')
  const tempo = await TempoNode.start()
  const rpcPort = tempo.port
  console.log('workers: started tempo')

  const env = Env.get({
    RPC_URL_TESTNET: tempo.rpcUrl,
    SLACK_API_URL: `${slack.url}/api`,
  })

  console.log('workers: minting fee payer')
  await TempoNode.mint({
    amount: '1000',
    feePayer: env.FEE_PAYER_PRIVATE_KEY_TESTNET,
    rpcUrl: tempo.rpcUrl,
    to: Account.fromSecp256k1(Constants.tip.senderRootPrivateKey).address,
  })
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
