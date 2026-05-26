import fs from 'node:fs'
import * as DB from '#db/client.ts'
import { getPreviewReactionTipEmojis } from '#/lib/app.ts'
import * as Constants from '#/lib/constants.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { sql } from 'kysely'
import JSONC from 'tiny-jsonc'
import { z } from 'zod'

const env = z.parse(
  z.object({
    CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
    CLOUDFLARE_API_TOKEN: z.string().min(1),
    PREVIEW_D1_ID: z.string().min(1),
    PREVIEW_HOST: z.string().min(1),
    PREVIEW_SEED_SLACK_TEAM_ID: z.string().min(1),
    STATE_SEEDED_AT: z.string().optional(),
  }),
  process.env,
)
const previewReactionTipEmojis = (() => {
  const emojis = getPreviewReactionTipEmojis(env.PREVIEW_HOST)
  if (!emojis) throw new Error(`Expected preview host, got ${env.PREVIEW_HOST}.`)
  return emojis
})()

const config = z.parse(
  z.looseObject({
    env: z
      .looseObject({
        production: z
          .looseObject({
            d1_databases: z.array(
              z.looseObject({
                binding: z.string().optional(),
                database_id: z.string().optional(),
              }),
            ),
          })
          .optional(),
      })
      .optional(),
  }),
  JSONC.parse(fs.readFileSync('wrangler.jsonc', 'utf8')),
)
const productionDbId = config.env?.production?.d1_databases?.find(
  (database) => database.binding === 'DB',
)?.database_id
if (!productionDbId) throw new Error('Could not find production DB id in wrangler.jsonc.')

const productionDb = createRemoteDb(productionDbId)
const previewDb = createRemoteDb(env.PREVIEW_D1_ID)

try {
  const sourceWorkspace = await productionDb
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', 'slack')
    .where('provider_id', '=', env.PREVIEW_SEED_SLACK_TEAM_ID)
    .executeTakeFirst()
  if (!sourceWorkspace)
    throw new Error(`No production Slack workspace found for ${env.PREVIEW_SEED_SLACK_TEAM_ID}.`)

  const previewWorkspace = await previewDb
    .selectFrom('workspace')
    .select('id')
    .where('provider', '=', 'slack')
    .where('provider_id', '=', env.PREVIEW_SEED_SLACK_TEAM_ID)
    .executeTakeFirst()
  if (env.STATE_SEEDED_AT && previewWorkspace) {
    const linked = await previewDb
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('workspace_id', '=', previewWorkspace.id)
      .where('provider_identity.account_id', 'is not', null)
      .executeTakeFirstOrThrow()
    const linkedCount = Number(linked.count)
    if (linkedCount > 0) {
      const now = new Date().toISOString()
      await previewDb
        .deleteFrom('reaction_tip_config')
        .where('workspace_id', '=', previewWorkspace.id)
        .execute()
      await previewDb
        .insertInto('reaction_tip_config')
        .values(
          Constants.defaultReactionTipConfigs.map((config, index) => ({
            amount: config.amount,
            created_at: now,
            emoji: previewReactionTipEmojis[index]!,
            id: Nanoid.generate(),
            updated_at: now,
            workspace_id: previewWorkspace.id,
          })),
        )
        .execute()
      output('reaction_tip_emoji', previewReactionTipEmojis[0])
      output('seeded_at', env.STATE_SEEDED_AT)
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
      updated_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.columns(['provider', 'provider_id']).doUpdateSet((eb) => ({
        chain_id: eb.ref('excluded.chain_id'),
        default_amount: eb.ref('excluded.default_amount'),
        default_token_address: eb.ref('excluded.default_token_address'),
        name: eb.ref('excluded.name'),
        updated_at: eb.ref('excluded.updated_at'),
      })),
    )
    .execute()

  const workspace = await previewDb
    .selectFrom('workspace')
    .select('id')
    .where('provider', '=', 'slack')
    .where('provider_id', '=', env.PREVIEW_SEED_SLACK_TEAM_ID)
    .executeTakeFirstOrThrow()
  const now = new Date().toISOString()
  await previewDb
    .deleteFrom('reaction_tip_config')
    .where('workspace_id', '=', workspace.id)
    .execute()
  await previewDb
    .insertInto('reaction_tip_config')
    .values(
      Constants.defaultReactionTipConfigs.map((config, index) => ({
        amount: config.amount,
        created_at: now,
        emoji: previewReactionTipEmojis[index]!,
        id: Nanoid.generate(),
        updated_at: now,
        workspace_id: workspace.id,
      })),
    )
    .execute()

  const members = await productionDb
    .selectFrom('member')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .innerJoin('account', 'account.id', 'provider_identity.account_id')
    .select([
      'account.address',
      'account.created_at as account_created_at',
      'account.id as account_id',
      'account.updated_at as account_updated_at',
      'member.created_at as member_created_at',
      'member.login',
      'member.name',
      'provider_identity.display_name',
      'provider_identity.metadata',
      'provider_identity.provider_global_user_id',
      'provider_identity.real_name',
      'member.provider_user_id',
      'member.updated_at as member_updated_at',
    ])
    .where('member.workspace_id', '=', sourceWorkspace.id)
    .where('provider_identity.account_id', 'is not', null)
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

    let identity = await previewDb
      .selectFrom('provider_identity')
      .select('id')
      .where('provider', '=', 'slack')
      .where('provider_workspace_id', '=', env.PREVIEW_SEED_SLACK_TEAM_ID)
      .where('provider_user_id', '=', member.provider_user_id)
      .executeTakeFirst()
    if (identity)
      await previewDb
        .updateTable('provider_identity')
        .set({
          account_id: account.id,
          display_name: member.display_name,
          metadata: member.metadata,
          provider_global_user_id: member.provider_global_user_id,
          real_name: member.real_name,
          updated_at: member.member_updated_at,
        })
        .where('id', '=', identity.id)
        .execute()
    else {
      identity = { id: Nanoid.generate() }
      await previewDb
        .insertInto('provider_identity')
        .values({
          account_id: account.id,
          created_at: member.member_created_at,
          display_name: member.display_name,
          id: identity.id,
          metadata: member.metadata,
          provider: 'slack',
          provider_global_user_id: member.provider_global_user_id,
          provider_user_id: member.provider_user_id,
          provider_workspace_id: env.PREVIEW_SEED_SLACK_TEAM_ID,
          real_name: member.real_name,
          updated_at: member.member_updated_at,
        })
        .execute()
    }

    await previewDb
      .insertInto('member')
      .values({
        created_at: member.member_created_at,
        id: Nanoid.generate(),
        login: member.login,
        name: member.name,
        provider_identity_id: identity.id,
        provider_user_id: member.provider_user_id,
        updated_at: member.member_updated_at,
        workspace_id: workspace.id,
      })
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'provider_user_id']).doUpdateSet((eb) => ({
          login: eb.ref('excluded.login'),
          name: eb.ref('excluded.name'),
          provider_identity_id: eb.ref('excluded.provider_identity_id'),
          updated_at: eb.ref('excluded.updated_at'),
        })),
      )
      .execute()
  }

  const seededAt = new Date().toISOString()
  output('reaction_tip_emoji', previewReactionTipEmojis[0])
  output('seeded_at', seededAt)
  console.log(
    `Seeded preview workspace ${env.PREVIEW_SEED_SLACK_TEAM_ID} with ${members.length} linked members.`,
  )
} finally {
  await productionDb.destroy()
  await previewDb.destroy()
}

function createRemoteDb(databaseId: string) {
  return DB.create({
    prepare: (statement) => ({
      bind: (...params) => ({
        async all() {
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`,
            {
              body: JSON.stringify({ params, sql: statement }),
              headers: {
                Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
                'Content-Type': 'application/json',
              },
              method: 'POST',
            },
          )
          const d1ResultSchema = z.looseObject({
            error: z.string().optional(),
            meta: z
              .looseObject({
                changes: z.number().optional(),
                last_row_id: z.number().nullable().optional(),
              })
              .optional(),
            results: z
              .array(z.record(z.string(), z.union([z.boolean(), z.null(), z.number(), z.string()])))
              .optional(),
          })
          const json = z.parse(
            z.looseObject({
              errors: z.unknown().optional(),
              messages: z.unknown().optional(),
              result: z.union([d1ResultSchema, z.array(d1ResultSchema)]).optional(),
              success: z.boolean().optional(),
            }),
            await response.json(),
          )
          if (!response.ok || !json.success)
            throw new Error(
              JSON.stringify({
                errors: json.errors,
                messages: json.messages,
                status: response.status,
              }),
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
        },
      }),
    }),
  } as D1Database)
}

function output(name: string, value: string) {
  if (!process.env.GITHUB_OUTPUT) return
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}
