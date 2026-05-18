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
  const setupStartedAt = performance.now()
  server.listen({ onUnhandledRequest: 'bypass' })
  const migrationsStartedAt = performance.now()
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  console.log(`workers: applied D1 migrations in ${formatMs(migrationsStartedAt)}`)
  console.log(`workers: setup file completed in ${formatMs(setupStartedAt)}`)
  return () => {
    const teardownStartedAt = performance.now()
    server.close()
    console.log(`workers: setup file teardown completed in ${formatMs(teardownStartedAt)}`)
  }
})

afterEach(() => {
  server.resetHandlers()
})

function formatMs(startedAt: number) {
  return `${Math.round(performance.now() - startedAt)}ms`
}
