import * as DB from '#db/client.ts'
import type { DB as DB_gen } from '#db/types.gen.ts'
import * as Nanoid from '#/lib/nanoid.ts'

export async function ensureForMember(
  db: DB.Type,
  options: {
    accountId?: string | null
    displayName?: string | null
    memberId: string
    provider: DB_gen.Selectable.workspace['provider']
    providerUserId: string
    providerWorkspaceId: string | null
    realName?: string | null
  },
) {
  const now = new Date().toISOString()
  const existing = await db
    .selectFrom('provider_identity')
    .selectAll()
    .where('provider', '=', options.provider)
    .where((eb) =>
      options.providerWorkspaceId === null
        ? eb('provider_workspace_id', 'is', null)
        : eb('provider_workspace_id', '=', options.providerWorkspaceId),
    )
    .where('provider_user_id', '=', options.providerUserId)
    .executeTakeFirst()

  const identity = existing ?? (await insertProviderIdentity(db, options, now))
  const nextAccountId = options.accountId === undefined ? identity.account_id : options.accountId
  const nextDisplayName =
    options.displayName === undefined ? identity.display_name : options.displayName
  const nextRealName = options.realName === undefined ? identity.real_name : options.realName
  if (
    nextAccountId !== identity.account_id ||
    nextDisplayName !== identity.display_name ||
    nextRealName !== identity.real_name
  )
    await db
      .updateTable('provider_identity')
      .set({
        account_id: nextAccountId,
        display_name: nextDisplayName,
        real_name: nextRealName,
        updated_at: now,
      })
      .where('id', '=', identity.id)
      .execute()

  await db
    .updateTable('member')
    .set({ provider_identity_id: identity.id, updated_at: now })
    .where('id', '=', options.memberId)
    .where((eb) =>
      eb.or([
        eb('provider_identity_id', 'is', null),
        eb('provider_identity_id', '!=', identity.id),
      ]),
    )
    .execute()

  return await db
    .selectFrom('provider_identity')
    .selectAll()
    .where('id', '=', identity.id)
    .executeTakeFirstOrThrow()
}

async function insertProviderIdentity(
  db: DB.Type,
  options: Parameters<typeof ensureForMember>[1],
  now: string,
) {
  const id = Nanoid.generate()
  try {
    await db
      .insertInto('provider_identity')
      .values({
        account_id: options.accountId ?? null,
        created_at: now,
        display_name: options.displayName ?? null,
        id,
        metadata: null,
        provider: options.provider,
        provider_global_user_id: null,
        provider_user_id: options.providerUserId,
        provider_workspace_id: options.providerWorkspaceId,
        real_name: options.realName ?? null,
        updated_at: now,
      })
      .execute()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
  }
  return await db
    .selectFrom('provider_identity')
    .selectAll()
    .where('provider', '=', options.provider)
    .where((eb) =>
      options.providerWorkspaceId === null
        ? eb('provider_workspace_id', 'is', null)
        : eb('provider_workspace_id', '=', options.providerWorkspaceId),
    )
    .where('provider_user_id', '=', options.providerUserId)
    .executeTakeFirstOrThrow()
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /unique constraint/i.test(error.message)
}
