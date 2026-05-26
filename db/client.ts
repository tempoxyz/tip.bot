import { Kysely } from 'kysely'
import { D1Dialect } from '#/vendor/kyselyD1.ts'
import type { DB as DB_gen } from './types.gen.ts'

export function create(database: D1Database | D1DatabaseSession) {
  return new Kysely<DB_gen>({
    dialect: new D1Dialect({ database }),
  })
}

export type Type = Kysely<DB_gen>
