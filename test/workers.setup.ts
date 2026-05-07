import { env } from 'cloudflare:workers'
import { applyD1Migrations, reset } from 'cloudflare:test'
import migration from '../migrations/0001_initial.sql?raw'
import { beforeEach } from 'vitest'

const migrations = [
  {
    name: '0001_initial.sql',
    queries: migration
      .split(';')
      .map((query) => query.trim())
      .filter(Boolean),
  },
]

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, migrations)
})
