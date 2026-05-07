import { env } from 'cloudflare:workers'
import { applyD1Migrations, reset } from 'cloudflare:test'
import initialMigration from '../migrations/0001_initial.sql?raw'
import slackInstallationMigration from '../migrations/0002_slack_installation.sql?raw'
import { beforeEach } from 'vitest'

const migrations = [
  {
    name: '0001_initial.sql',
    queries: initialMigration
      .split(';')
      .map((query) => query.trim())
      .filter(Boolean),
  },
  {
    name: '0002_slack_installation.sql',
    queries: slackInstallationMigration
      .split(';')
      .map((query) => query.trim())
      .filter(Boolean),
  },
]

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, migrations)
})
