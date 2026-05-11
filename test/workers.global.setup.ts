import { createEmulator } from 'emulate'
import type { TestProject } from 'vitest/node'
import { Env } from './env.ts'
import { getAvailablePort } from './utils.ts'

export default async function (project: TestProject) {
  const slack = await createEmulator({
    port: await getAvailablePort(),
    seed: {
      slack: {
        users: [{ email: 'member@example.com', name: 'member' }],
      },
    },
    service: 'slack',
  })

  project.provide('env', JSON.stringify(Env.get({ SLACK_API_URL: `${slack.url}/api` })))

  return async () => {
    await slack.close()
  }
}
