import type {
  CompiledQuery,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  Driver,
  QueryCompiler,
  QueryResult,
} from 'kysely'
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely'
import type { DB } from './db.gen'

export function createDb(database: D1Database | D1DatabaseSession) {
  return new Kysely<DB>({
    dialect: new D1Dialect({ database }),
  })
}

export function createReadDb(database: D1Database) {
  return createDb(database.withSession('first-unconstrained'))
}

interface D1DialectConfig {
  database: D1Database | D1DatabaseSession
}

class D1Dialect implements Dialect {
  #config: D1DialectConfig

  constructor(config: D1DialectConfig) {
    this.#config = config
  }

  createAdapter() {
    return new SqliteAdapter()
  }

  createDriver(): Driver {
    return new D1Driver(this.#config)
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler()
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db)
  }
}

class D1Driver implements Driver {
  #config: D1DialectConfig

  constructor(config: D1DialectConfig) {
    this.#config = config
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new D1Connection(this.#config)
  }

  async beginTransaction(): Promise<void> {
    throw new Error('D1 does not support Kysely transactions yet.')
  }

  async commitTransaction(): Promise<void> {
    throw new Error('D1 does not support Kysely transactions yet.')
  }

  async rollbackTransaction(): Promise<void> {
    throw new Error('D1 does not support Kysely transactions yet.')
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

class D1Connection implements DatabaseConnection {
  #config: D1DialectConfig

  constructor(config: D1DialectConfig) {
    this.#config = config
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const results = await this.#config.database
      .prepare(compiledQuery.sql)
      .bind(...compiledQuery.parameters)
      .all()

    if (results.error) throw new Error(results.error)

    const numAffectedRows = results.meta.changes > 0 ? BigInt(results.meta.changes) : undefined

    return {
      insertId:
        results.meta.last_row_id === undefined || results.meta.last_row_id === null
          ? undefined
          : BigInt(results.meta.last_row_id),
      rows: (results.results as O[]) || [],
      numAffectedRows,
    }
  }

  // Required by Kysely's connection interface. D1 does not support streaming.
  async *streamQuery<O>(): AsyncIterableIterator<QueryResult<O>> {
    yield* [] as QueryResult<O>[]
    throw new Error('D1 does not support Kysely streaming queries.')
  }
}
