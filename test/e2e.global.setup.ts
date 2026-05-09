import { createEmulator } from 'emulate'
import { startDevServer } from './devServer.ts'
import { Env } from './env.ts'
import { getAvailablePort } from './utils.ts'

export default async function globalSetup() {
  const appPort = await getAvailablePort()
  const host = `127.0.0.1:${appPort}`

  const slack = await createEmulator({
    port: await getAvailablePort(),
    service: 'slack',
  })

  const server = await startDevServer({
    ...Env.get({
      HOST: host,
      SLACK_API_URL: `${slack.url}/api`,
    }),
    PORT: String(appPort),
  })

  process.env.PLAYWRIGHT_BASE_URL = server.baseUrl
  process.env.PLAYWRIGHT_HOST = host
  process.env.PLAYWRIGHT_SLACK_URL = slack.url

  return async () => {
    server.stop()
    await slack.close()
  }
}
