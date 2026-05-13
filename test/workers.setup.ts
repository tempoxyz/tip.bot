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

beforeAll(async () => {
  const startedAt = performance.now()
  await measure('msw server startup', async () => server.listen({ onUnhandledRequest: 'bypass' }))
  await measure('d1 reset', async () => reset())
  await measure('d1 migrations', async () => applyD1Migrations(env.DB, migrations))
  console.log(`workers: setup file beforeAll took ${formatDuration(performance.now() - startedAt)}`)
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
})

afterEach(() => {
  server.resetHandlers()
})

async function measure<Value>(label: string, fn: () => Promise<Value> | Value) {
  const startedAt = performance.now()
  try {
    return await fn()
  } finally {
    console.log(`workers: ${label} took ${formatDuration(performance.now() - startedAt)}`)
  }
}

function formatDuration(milliseconds: number) {
  return `${Math.round(milliseconds)}ms`
}
