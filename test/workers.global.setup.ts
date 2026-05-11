import { createEmulator } from 'emulate'
import type { TestProject } from 'vitest/node'
import * as Constants from './constants.ts'
import { Env } from './env.ts'
import { getAvailablePort } from './utils.ts'

export default async function (project: TestProject) {
  const slack = await createEmulator({
    port: await getAvailablePort(),
    seed: Constants.seed,
    service: 'slack',
  })

  project.provide('env', JSON.stringify(Env.get({ SLACK_API_URL: `${slack.url}/api` })))

  return async () => {
    await slack.close()
  }
}
