import { env } from 'cloudflare:workers'
import { applyD1Migrations, reset } from 'cloudflare:test'
import { http } from 'msw'
import { afterEach, beforeAll, beforeEach } from 'vitest'
import { api } from '#/api.ts'
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
  server.use(
    http.all(`https://${env.HOST}/api/relay/:chainId`, async ({ request }) =>
      api.fetch(request as Request, env, {
        passThroughOnException() {},
        props: {},
        waitUntil() {},
      }),
    ),
  )
  await reset()
  await applyD1Migrations(env.DB, migrations)
})

afterEach(() => {
  server.resetHandlers()
})
