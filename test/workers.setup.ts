import { env } from 'cloudflare:workers'
import { applyD1Migrations, reset } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach } from 'vitest'
import { server } from './workers.server.ts'

const migrations = Object.entries(
  import.meta.glob<string>('../db/migrations/*.sql', {
    eager: true,
    import: 'default',
    query: '?raw',
  }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, migration]) => ({
    name: path.split('/').at(-1) ?? path,
    queries: migration
      .split(';')
      .map((query) => query.trim())
      .filter(Boolean),
  }))

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' })
  return () => {
    server.close()
  }
})

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, migrations)
})

afterEach(() => {
  server.resetHandlers()
})
