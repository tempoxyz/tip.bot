import { env } from 'cloudflare:workers'
import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { afterEach, beforeAll } from 'vitest'
import { server } from './workers.server.ts'

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}

beforeAll(async () => {
  const startedAt = Date.now()
  console.log(`workers: apply d1 migrations: starting (${env.TEST_MIGRATIONS.length} migrations)`)
  server.listen({ onUnhandledRequest: 'bypass' })
  try {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  } finally {
    console.log(`workers: apply d1 migrations: completed in ${Date.now() - startedAt}ms`)
  }
  return () => {
    server.close()
  }
})

afterEach(() => {
  server.resetHandlers()
})
