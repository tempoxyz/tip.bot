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
  server.listen({ onUnhandledRequest: 'bypass' })
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  return () => {
    server.close()
  }
})

afterEach(() => {
  server.resetHandlers()
})
