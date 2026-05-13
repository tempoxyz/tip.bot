import Database from 'better-sqlite3'
import { createEmulator } from 'emulate'
import { hc } from 'hono/client'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import type { api } from '#/api.ts'
import * as Constants from './constants.ts'
import { startDevServer } from './devServer.ts'
import { Env } from './env.ts'
import { getAvailablePort } from './utils.ts'

export default async function globalSetup() {
  const port = await getAvailablePort()
  const host = `127.0.0.1:${port}`
  const statePath = join(process.cwd(), 'test-results', 'wrangler', 'global')

  await fs.rm(statePath, { force: true, recursive: true })

  console.log('e2e: starting slack emulator')
  const slack = await createEmulator({
    port: await getAvailablePort(),
    seed: Constants.seed,
    service: 'slack',
  })
  console.log('e2e: started slack emulator')

  const env = Env.get({
    HOST: host,
    SLACK_APP_ID: 'A000000001',
    SLACK_API_URL: `${slack.url}/api`,
  })

  console.log('e2e: starting dev server')
  const server = await startDevServer({
    CLOUDFLARE_PERSIST_STATE_PATH: statePath,
    PLAYWRIGHT_ACCOUNT_PRIVATE_KEY:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    ...env,
    PORT: String(port),
  })
  console.log('e2e: started dev server')

  console.log('e2e: running migrations')
  const dbPath = await applyD1Migrations({ baseUrl: server.baseUrl, statePath })
  console.log('e2e: ran migrations')

  Object.assign(process.env, env)
  process.env.PLAYWRIGHT_DB_PATH = dbPath

  return async () => {
    server.stop()
    await slack.close()
  }
}

async function applyD1Migrations(input: { baseUrl: string; statePath: string }) {
  const response = await hc<typeof api>(input.baseUrl).api.health.$get()
  if (!response.ok)
    throw new Error(`Health check failed: ${response.status} ${await response.text()}`)

  const dbPath = await getD1DatabasePath(input.statePath)
  const db = new Database(dbPath)
  try {
    for (const migration of (await fs.readdir(join(process.cwd(), 'db/migrations'))).sort()) {
      if (!migration.endsWith('.sql')) continue
      for (const query of (
        await fs.readFile(join(process.cwd(), 'db/migrations', migration), 'utf8')
      )
        .split(';')
        .map((query) => query.trim())
        .filter(Boolean))
        db.prepare(query).run()
    }
    return dbPath
  } finally {
    db.close()
  }
}

async function getD1DatabasePath(statePath: string) {
  const dir = join(statePath, 'v3/d1/miniflare-D1DatabaseObject')
  const deadline = Date.now() + 30_000 // 30 seconds
  while (Date.now() < deadline) {
    try {
      const file = (await fs.readdir(dir)).find(
        (file) => file.endsWith('.sqlite') && file !== 'metadata.sqlite',
      )
      if (file) return join(dir, file)
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100)) // 100 milliseconds
  }
  throw new Error('Could not find local D1 SQLite database.')
}
