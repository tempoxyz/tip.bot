import { createEmulator } from 'emulate'
import * as Constants from './constants.ts'
import { startDevServer } from './devServer.ts'
import { Env } from './env.ts'
import { getAvailablePort } from './utils.ts'

export default async function globalSetup() {
  const appPort = await getAvailablePort()
  const host = `127.0.0.1:${appPort}`
  const slackAppId = 'A000000001'

  const slack = await createEmulator({
    port: await getAvailablePort(),
    seed: Constants.seed,
    service: 'slack',
  })
  const env = Env.get({
    HOST: host,
    SLACK_API_URL: `${slack.url}/api`,
  })

  const server = await startDevServer({
    ...env,
    PORT: String(appPort),
    SLACK_APP_ID: slackAppId,
  })

  process.env.PLAYWRIGHT_BASE_URL = server.baseUrl
  process.env.PLAYWRIGHT_HOST = host
  process.env.PLAYWRIGHT_SLACK_APP_ID = slackAppId
  process.env.PLAYWRIGHT_SLACK_URL = slack.url

  return async () => {
    server.stop()
    await slack.close()
  }
}
