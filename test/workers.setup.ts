import { env } from 'cloudflare:workers'
import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach } from 'vitest'

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

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, migrations)
})
