import type { Kysely } from 'kysely'
import type { DB } from '#db/types.gen.ts'
import type * as Factory from '../factory.ts'

/** Inserts a member with a provider identity, connected to `account_id` when it names one. */
export async function insertMember(
  db: Kysely<DB>,
  factory: ReturnType<typeof Factory.create>,
  attrs: Partial<DB.Insertable.member> &
    Pick<DB.Insertable.member, 'workspace_id'> & { account_id?: string | null },
) {
  const member = factory.member.attrs(attrs as never)
  const { account_id: accountId, ...memberValues } = member as typeof member & {
    account_id?: string | null
  }
  if (member.provider_identity_id) return await factory.member.insert(memberValues)

  const workspace = await db
    .selectFrom('workspace')
    .select(['provider', 'provider_id'])
    .where('id', '=', member.workspace_id)
    .executeTakeFirstOrThrow()
  const identity = await factory.provider_identity.insert({
    account_id: accountId ?? null,
    created_at: member.created_at,
    display_name: member.login,
    provider: workspace.provider,
    provider_user_id: member.provider_user_id,
    provider_workspace_id: workspace.provider_id,
    real_name: member.name,
    updated_at: member.updated_at,
  })
  return await factory.member.insert({ ...memberValues, provider_identity_id: identity.id })
}
