import { env } from 'cloudflare:workers'
import { applyD1Migrations, reset } from 'cloudflare:test'
import { afterEach, beforeAll } from 'vitest'
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

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'bypass' })
  await reset()
  await applyD1Migrations(env.DB, migrations)
  return () => {
    server.close()
  }
})

afterEach(() => {
  server.resetHandlers()
})
