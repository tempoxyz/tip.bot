import { createQueryId, type Insertable, type Kysely, type Selectable } from 'kysely'
import type { DB } from '#db/types.gen.ts'
import { mockTokenAddress } from '#/lib/mockTips.ts'
import * as Nanoid from '#/lib/nanoid.ts'

export function create(db: Kysely<DB>): FactoryInstance {
  function factory(table: keyof DB) {
    return {
      attrs(...args: Record<string, unknown>[]) {
        const attrs = args.map((overrides) => ({
          id: Nanoid.generate(),
          ...defaultConfig[table]?.(),
          ...overrides,
        }))
        return attrs.length === 1 ? attrs[0] : attrs
      },
      async insert(...args: Record<string, unknown>[]) {
        const values = this.attrs(...args)
        const rows = Array.isArray(values) ? values : [values]
        const ids = rows.map((row) => row.id as string)

        await (
          db.insertInto(table) as never as {
            values: (rows: unknown[]) => { execute: () => Promise<unknown> }
          }
        )
          .values(rows)
          .execute()

        await checkpoint(db)

        const result = await (
          db.selectFrom(table) as never as {
            selectAll: () => {
              where: (
                key: 'id',
                operator: 'in',
                ids: string[],
              ) => { execute: () => Promise<unknown[]> }
            }
          }
        )
          .selectAll()
          .where('id', 'in', ids)
          .execute()

        return rows.length === 1 ? result[0] : result
      },
    }
  }
  return new Proxy({} as FactoryInstance, {
    get(_target, table) {
      return factory(table as keyof DB)
    },
  })
}

async function checkpoint(db: Kysely<DB>) {
  try {
    // Force WAL checkpoint so miniflare/D1 can see the changes
    await db.executeQuery({
      parameters: [],
      query: { kind: 'RawNode' } as never,
      queryId: createQueryId(),
      sql: 'PRAGMA wal_checkpoint(FULL)',
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('SQLITE_AUTH')) return
    throw error
  }
}

const defaultConfig: Partial<{
  [K in keyof DB]: () => Partial<Insertable<DB[K]>>
}> = {
  account() {
    const now = new Date().toISOString()
    return {
      access_key_address: null,
      access_key_authorization: null,
      access_key_ciphertext: null,
      access_key_expires_at: null,
      created_at: now,
      display_name: null,
      platform: 'slack',
      platform_account_id: `U${Nanoid.generate()}`,
      tempo_address: null,
      updated_at: now,
    }
  },
  connect_token() {
    return {
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
      platform: 'slack',
      platform_account_id: `U${Nanoid.generate()}`,
      token_hash: Nanoid.generate(),
      used_at: null,
    }
  },
  tip() {
    const now = new Date().toISOString()
    return {
      amount: '0.001',
      created_at: now,
      error: null,
      idempotency_key: Nanoid.generate(),
      reason: null,
      source_type: 'command',
      status: 'submitting',
      token_address: mockTokenAddress,
      tx_hash: null,
      updated_at: now,
    }
  },
  tip_attempt() {
    return {
      amount: '1000',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60 * 1000).toISOString(), // 1 minute
      recipient_address: 'mock-recipient',
      sender_address: 'mock-sender',
      token_address: mockTokenAddress,
    }
  },
  workspace() {
    const now = new Date().toISOString()
    return {
      created_at: now,
      daily_cap: '1',
      name: null,
      platform: 'slack',
      platform_team_id: `T${Nanoid.generate()}`,
      tip_amount: '0.001',
      tip_emoji: 'money_with_wings',
      updated_at: now,
    }
  },
}

type FactoryInstance = {
  [K in keyof DB]: {
    attrs: <const V extends readonly Record<string, unknown>[]>(
      ...args: V & AttrsValidation<K, V>
    ) => V['length'] extends 1 ? Selectable<DB[K]> : Selectable<DB[K]>[]
    insert: <const V extends readonly Record<string, unknown>[]>(
      ...args: V & AttrsValidation<K, V>
    ) => Promise<V['length'] extends 1 ? Selectable<DB[K]> : Selectable<DB[K]>[]>
  }
}

type AttrsValidation<K extends keyof DB, V extends readonly Record<string, unknown>[]> = {
  [I in keyof V]: Partial<Insertable<DB[K]>> & RequiredForeignKeys<DB[K]>
}

type RequiredForeignKeys<T> = {
  [K in keyof T as K extends `${string}_id`
    ? null extends T[K]
      ? never
      : K extends 'id' | 'credential_id'
        ? never
        : K
    : never]-?: T[K]
}
