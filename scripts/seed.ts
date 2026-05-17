import fs from 'node:fs'
import * as DB from '#db/client.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { sql } from 'kysely'
import JSONC from 'tiny-jsonc'

const command = process.argv[2]

if (command !== 'preview-workspace') usage()

const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID')
const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN')
const previewDbId = requiredEnv('PREVIEW_D1_ID')
const seedTeamId = requiredEnv('PREVIEW_SEED_SLACK_TEAM_ID')
const stateSeededAt = process.env.STATE_SEEDED_AT

const productionDb = createRemoteDb(getProductionDbId())
const previewDb = createRemoteDb(previewDbId)

try {
  const sourceWorkspace = await productionDb
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', 'slack')
    .where('provider_id', '=', seedTeamId)
    .executeTakeFirst()
  if (!sourceWorkspace) throw new Error(`No production Slack workspace found for ${seedTeamId}.`)

  const previewWorkspace = await previewDb
    .selectFrom('workspace')
    .select('id')
    .where('provider', '=', 'slack')
    .where('provider_id', '=', seedTeamId)
    .executeTakeFirst()
  if (stateSeededAt && previewWorkspace) {
    const linked = await previewDb
      .selectFrom('member')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('workspace_id', '=', previewWorkspace.id)
      .where('account_id', 'is not', null)
      .executeTakeFirstOrThrow()
    const linkedCount = Number(linked.count)
    if (linkedCount > 0) {
      output('seeded_at', stateSeededAt)
      console.log(`Preview workspace already seeded with ${linkedCount} linked members.`)
      process.exit(0)
    }
  }

  await previewDb
    .insertInto('workspace')
    .values({
      chain_id: sourceWorkspace.chain_id,
      created_at: sourceWorkspace.created_at,
      default_amount: sourceWorkspace.default_amount,
      default_token_address: sourceWorkspace.default_token_address,
      id: previewWorkspace?.id ?? Nanoid.generate(),
      name: sourceWorkspace.name,
      provider: sourceWorkspace.provider,
      provider_id: sourceWorkspace.provider_id,
      reaction_tip_emoji: sourceWorkspace.reaction_tip_emoji,
      updated_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.columns(['provider', 'provider_id']).doUpdateSet((eb) => ({
        chain_id: eb.ref('excluded.chain_id'),
        default_amount: eb.ref('excluded.default_amount'),
        default_token_address: eb.ref('excluded.default_token_address'),
        name: eb.ref('excluded.name'),
        reaction_tip_emoji: eb.ref('excluded.reaction_tip_emoji'),
        updated_at: eb.ref('excluded.updated_at'),
      })),
    )
    .execute()

  const workspace = await previewDb
    .selectFrom('workspace')
    .select('id')
    .where('provider', '=', 'slack')
    .where('provider_id', '=', seedTeamId)
    .executeTakeFirstOrThrow()

  const members = await productionDb
    .selectFrom('member')
    .innerJoin('account', 'account.id', 'member.account_id')
    .select([
      'account.address',
      'account.created_at as account_created_at',
      'account.id as account_id',
      'account.updated_at as account_updated_at',
      'member.created_at as member_created_at',
      'member.login',
      'member.name',
      'member.provider_user_id',
      'member.updated_at as member_updated_at',
    ])
    .where('member.workspace_id', '=', sourceWorkspace.id)
    .where('member.account_id', 'is not', null)
    .orderBy('member.created_at', 'asc')
    .orderBy('member.id', 'asc')
    .execute()

  for (const member of members) {
    let account = await previewDb
      .selectFrom('account')
      .select('id')
      .where(sql<string>`lower("address")`, '=', member.address.toLowerCase())
      .executeTakeFirst()
    if (!account) {
      let accountId = member.account_id
      const conflictingAccount = await previewDb
        .selectFrom('account')
        .select('id')
        .where('id', '=', accountId)
        .executeTakeFirst()
      if (conflictingAccount) accountId = Nanoid.generate()
      await previewDb
        .insertInto('account')
        .values({
          address: member.address,
          created_at: member.account_created_at,
          id: accountId,
          updated_at: member.account_updated_at,
        })
        .execute()
      account = { id: accountId }
    }

    await previewDb
      .insertInto('member')
      .values({
        account_id: account.id,
        created_at: member.member_created_at,
        id: Nanoid.generate(),
        login: member.login,
        name: member.name,
        provider_user_id: member.provider_user_id,
        updated_at: member.member_updated_at,
        workspace_id: workspace.id,
      })
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'provider_user_id']).doUpdateSet((eb) => ({
          account_id: eb.ref('excluded.account_id'),
          login: eb.ref('excluded.login'),
          name: eb.ref('excluded.name'),
          updated_at: eb.ref('excluded.updated_at'),
        })),
      )
      .execute()
  }

  const seededAt = new Date().toISOString()
  output('seeded_at', seededAt)
  console.log(`Seeded preview workspace ${seedTeamId} with ${members.length} linked members.`)
} finally {
  await productionDb.destroy()
  await previewDb.destroy()
}

function createRemoteDb(databaseId: string) {
  return DB.create({
    prepare: (statement) => ({
      bind: (...params) => ({
        all: async () => await queryD1(databaseId, statement, params),
      }),
    }),
  } as D1Database)
}

async function queryD1(databaseId: string, statement: string, params: unknown[]) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      body: JSON.stringify({ params, sql: statement }),
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    },
  )
  const json = (await response.json()) as {
    errors?: unknown
    messages?: unknown
    result?:
      | {
          error?: string
          meta?: { changes?: number; last_row_id?: number | null }
          results?: Record<string, string | number | null>[]
        }[]
      | {
          error?: string
          meta?: { changes?: number; last_row_id?: number | null }
          results?: Record<string, string | number | null>[]
        }
    success?: boolean
  }
  if (!response.ok || !json.success)
    throw new Error(
      JSON.stringify({ errors: json.errors, messages: json.messages, status: response.status }),
    )

  const result = Array.isArray(json.result) ? json.result[0] : json.result
  return {
    error: result?.error,
    meta: {
      changes: result?.meta?.changes ?? 0,
      last_row_id: result?.meta?.last_row_id,
    },
    results: result?.results ?? [],
    success: true,
  }
}

function getProductionDbId() {
  const config = JSONC.parse(fs.readFileSync('wrangler.jsonc', 'utf8')) as {
    env?: { production?: { d1_databases?: { binding?: string; database_id?: string }[] } }
  }
  const databaseId = config.env?.production?.d1_databases?.find(
    (database) => database.binding === 'DB',
  )?.database_id
  if (databaseId) return databaseId

  throw new Error('Could not find production DB id in wrangler.jsonc.')
}

function output(name: string, value: string) {
  if (!process.env.GITHUB_OUTPUT) return
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

function requiredEnv(name: string) {
  const value = process.env[name]
  if (value) return value

  throw new Error(`Missing ${name}`)
}

function usage(): never {
  console.error(`
Usage:
  node --experimental-strip-types scripts/seed.ts preview-workspace

Environment:
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN
  PREVIEW_D1_ID
  PREVIEW_SEED_SLACK_TEAM_ID
  STATE_SEEDED_AT Optional previous seed marker
`)
  process.exit(1)
}
