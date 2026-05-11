import { createQueryId, type Insertable, type Kysely, type Selectable } from 'kysely'
import type { DB } from '#db/types.gen.ts'
import { mockTokenAddress } from '#/lib/tips.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { Address, Secp256k1 } from 'ox'

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
      address: generateAddress(),
      created_at: now,
      updated_at: now,
    }
  },
  access_key() {
    const now = new Date().toISOString()
    return {
      address: generateAddress(),
      authorization: Nanoid.generate(),
      ciphertext: Nanoid.generate(),
      created_at: now,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
      revoked_at: null,
      updated_at: now,
    }
  },
  account_link_token() {
    return {
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
      member_id: null,
      token_hash: Nanoid.generate(),
      used_at: null,
    }
  },
  member() {
    const now = new Date().toISOString()
    return {
      account_id: null,
      created_at: now,
      login: null,
      name: null,
      provider_user_id: `U${Nanoid.generate()}`,
      updated_at: now,
    }
  },
  tip() {
    const now = new Date().toISOString()
    return {
      amount: 1000,
      confirmed_at: null,
      created_at: now,
      failed_at: null,
      failure_reason: null,
      idempotency_key: Nanoid.generate(),
      memo: null,
      token_address: mockTokenAddress,
      transaction_hash: null,
      updated_at: now,
    }
  },
  workspace() {
    const now = new Date().toISOString()
    return {
      created_at: now,
      default_amount: 1000,
      name: null,
      provider: 'slack',
      provider_id: `T${Nanoid.generate()}`,
      updated_at: now,
    }
  },
}

function generateAddress() {
  const privateKey = Secp256k1.randomPrivateKey()
  const publicKey = Secp256k1.getPublicKey({ privateKey })
  return Address.fromPublicKey(publicKey)
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
