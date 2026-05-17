import crypto from 'node:crypto'
import fs from 'node:fs'
import JSONC from 'tiny-jsonc'

const command = process.argv[2]

if (command !== 'preview-workspace') usage()

const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID')
const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN')
const previewDbId = requiredEnv('PREVIEW_D1_ID')
const seedTeamId = requiredEnv('PREVIEW_SEED_SLACK_TEAM_ID')
const stateSeededAt = process.env.STATE_SEEDED_AT
const productionDbId = getProductionDbId()

const sourceWorkspace = await query(
  productionDbId,
  'SELECT * FROM "workspace" WHERE "provider" = ? AND "provider_id" = ? LIMIT 1',
  ['slack', seedTeamId],
).then((rows) => rows[0])
if (!sourceWorkspace) throw new Error(`No production Slack workspace found for ${seedTeamId}.`)

const previewWorkspace = await query(
  previewDbId,
  'SELECT "id" FROM "workspace" WHERE "provider" = ? AND "provider_id" = ? LIMIT 1',
  ['slack', seedTeamId],
).then((rows) => rows[0])
if (stateSeededAt && previewWorkspace) {
  const linkedCount = await query(
    previewDbId,
    'SELECT count(*) AS "count" FROM "member" WHERE "workspace_id" = ? AND "account_id" IS NOT NULL',
    [previewWorkspace.id],
  ).then((rows) => Number(rows[0]?.count ?? 0))
  if (linkedCount > 0) {
    output('seeded_at', stateSeededAt)
    console.log(`Preview workspace already seeded with ${linkedCount} linked members.`)
    process.exit(0)
  }
}

await execute(
  previewDbId,
  `INSERT INTO "workspace" (
    "id", "provider", "provider_id", "name", "default_amount", "default_token_address", "chain_id", "reaction_tip_emoji", "created_at", "updated_at"
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT("provider", "provider_id") DO UPDATE SET
    "name" = excluded."name",
    "default_amount" = excluded."default_amount",
    "default_token_address" = excluded."default_token_address",
    "chain_id" = excluded."chain_id",
    "reaction_tip_emoji" = excluded."reaction_tip_emoji",
    "updated_at" = excluded."updated_at"`,
  [
    previewWorkspace?.id ?? id(),
    sourceWorkspace.provider,
    sourceWorkspace.provider_id,
    sourceWorkspace.name,
    sourceWorkspace.default_amount,
    sourceWorkspace.default_token_address,
    sourceWorkspace.chain_id,
    sourceWorkspace.reaction_tip_emoji,
    sourceWorkspace.created_at,
    new Date().toISOString(),
  ],
)

const workspaceId = await query(
  previewDbId,
  'SELECT "id" FROM "workspace" WHERE "provider" = ? AND "provider_id" = ? LIMIT 1',
  ['slack', seedTeamId],
).then((rows) => rows[0]?.id)
if (!workspaceId) throw new Error('Preview workspace upsert did not return a workspace id.')

const members = await query(
  productionDbId,
  `SELECT
    "member"."provider_user_id",
    "member"."login",
    "member"."name",
    "member"."created_at" AS "member_created_at",
    "member"."updated_at" AS "member_updated_at",
    "account"."id" AS "account_id",
    "account"."address",
    "account"."created_at" AS "account_created_at",
    "account"."updated_at" AS "account_updated_at"
  FROM "member"
  INNER JOIN "account" ON "account"."id" = "member"."account_id"
  WHERE "member"."workspace_id" = ? AND "member"."account_id" IS NOT NULL
  ORDER BY "member"."created_at", "member"."id"`,
  [sourceWorkspace.id],
)

for (const member of members) {
  let account = await query(
    previewDbId,
    'SELECT "id" FROM "account" WHERE lower("address") = lower(?) LIMIT 1',
    [member.address],
  ).then((rows) => rows[0])
  if (!account) {
    let accountId = member.account_id
    const conflictingAccount = await query(
      previewDbId,
      'SELECT "id" FROM "account" WHERE "id" = ? LIMIT 1',
      [accountId],
    ).then((rows) => rows[0])
    if (conflictingAccount) accountId = id()
    await execute(
      previewDbId,
      'INSERT INTO "account" ("id", "address", "created_at", "updated_at") VALUES (?, ?, ?, ?)',
      [accountId, member.address, member.account_created_at, member.account_updated_at],
    )
    account = { id: accountId }
  }
  await execute(
    previewDbId,
    `INSERT INTO "member" ("id", "workspace_id", "account_id", "provider_user_id", "login", "name", "created_at", "updated_at")
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT("workspace_id", "provider_user_id") DO UPDATE SET
      "account_id" = excluded."account_id",
      "login" = excluded."login",
      "name" = excluded."name",
      "updated_at" = excluded."updated_at"`,
    [
      id(),
      workspaceId,
      account.id,
      member.provider_user_id,
      member.login,
      member.name,
      member.member_created_at,
      member.member_updated_at,
    ],
  )
}

const seededAt = new Date().toISOString()
output('seeded_at', seededAt)
console.log(`Seeded preview workspace ${seedTeamId} with ${members.length} linked members.`)

async function query(databaseId: string, sql: string, params: unknown[] = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      body: JSON.stringify({ params, sql }),
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
      | { results?: Record<string, string | number | null>[] }[]
      | { results?: Record<string, string | number | null>[] }
    success?: boolean
  }
  if (!response.ok || !json.success)
    throw new Error(
      JSON.stringify({ errors: json.errors, messages: json.messages, status: response.status }),
    )

  const result = Array.isArray(json.result) ? json.result[0] : json.result
  return result?.results ?? []
}

async function execute(databaseId: string, sql: string, params: unknown[] = []) {
  await query(databaseId, sql, params)
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

function id() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  return Array.from({ length: 12 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('')
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
