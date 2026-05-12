import { expect, test as base } from '@playwright/test'
import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import type { DB } from '#db/types.gen.ts'
import type { FileRouteTypes } from '#/routeTree.gen.ts'
import { Env } from '../env.ts'
import * as Factory from '../factory.ts'

export const test = base.extend<
  {
    db: Kysely<DB>
    factory: ReturnType<typeof Factory.create>
  },
  {
    app: {
      baseUrl: string
      dbPath: string
      env: ReturnType<typeof Env.get>
      slackAppId: string
      slackUrl: string
      url: {
        (options: RouteUrlOptionsUnion): string
        (path: `/api/${string}`): string
      }
    }
  }
>({
  app: [
    async ({ browserName }, use) => {
      void browserName
      const env = Env.parse(process.env)
      const baseUrl = `http://${env.HOST}`
      await use({
        baseUrl,
        dbPath: process.env.PLAYWRIGHT_DB_PATH ?? '',
        env,
        slackAppId: env.SLACK_APP_ID,
        slackUrl: new URL(env.SLACK_API_URL).origin,
        url: (input: `/api/${string}` | RouteUrlOptionsUnion) => {
          if (typeof input === 'string') return new URL(input, baseUrl).toString()
          return new URL(formatRouteUrl(input), baseUrl).toString()
        },
      })
    },
    { scope: 'worker' },
  ],
  db: async ({ app }, use) => {
    const sqlite = new Database(app.dbPath)
    const db = new Kysely<DB>({
      dialect: new SqliteDialect({ database: sqlite }),
    })
    try {
      await use(db)
    } finally {
      await db.destroy()
      sqlite.close()
    }
  },
  factory: async ({ db }, use) => {
    await use(Factory.create(db))
  },
})

export { expect }

function formatRouteUrl(options: RouteUrlOptionsUnion) {
  const pathname = options.to.replace(/\$([^/]+)/g, (_match, key: string) => {
    const value = (options.params as Record<string, string> | undefined)?.[key]
    if (value === undefined) throw new Error(`Missing route param: ${key}`)
    return encodeURIComponent(String(value))
  })
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(
    (options.search ?? {}) as Record<string, boolean | number | string | undefined>,
  )) {
    if (value === undefined) continue
    search.set(key, String(value))
  }
  const query = search.toString()
  if (!query) return pathname
  return `${pathname}?${query}`
}

type RouteUrlOptionsUnion = {
  [path in FileRouteTypes['to']]: RouteUrlOptions<path>
}[FileRouteTypes['to']]

type RouteUrlOptions<path extends FileRouteTypes['to']> = {
  // TODO: Type this from TanStack's generated fullSearchSchemaInput once it is concrete here.
  search?: Record<string, boolean | number | string | undefined>
  to: path
} & (keyof RouteParams<path> extends never ? { params?: never } : { params: RouteParams<path> })

type RouteParams<path extends string> = path extends `${string}$${infer param}/${infer rest}`
  ? { [key in param | keyof RouteParams<`/${rest}`>]: string }
  : path extends `${string}$${infer param}`
    ? { [key in param]: string }
    : Record<never, never>
