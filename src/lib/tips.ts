import * as DB from '#db/client.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import type { DB as Database } from '#db/types.gen.ts'
import { Address, Secp256k1 } from 'ox'

export const mockTokenAddress = Address.checksum('0x0000000000000000000000000000000000000001')

export type Provider = Database.Selectable.workspace['provider']

export type TipInput = {
  idempotencyKey: string
  memo: string | null
  provider: Provider
  providerId: string
  recipientProviderUserId: string
  senderProviderUserId: string
}

export type TipResult =
  | {
      amount: string
      memo: string | null
      ok: true
      status: 'already_sent' | 'sent'
      recipientProviderUserId: string
      senderProviderUserId: string
      transactionHash: string
    }
  | {
      code: 'failed' | 'self_tip'
      message?: string
      ok: false
    }

export async function handleTipRequest(env: Env, input: TipInput): Promise<TipResult> {
  const workspace =
    (await DB.create(env.DB)
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', input.provider)
      .where('provider_id', '=', input.providerId)
      .executeTakeFirst()) ??
    (await (async () => {
      const id = Nanoid.generate()
      const now = new Date().toISOString()
      await DB.create(env.DB)
        .insertInto('workspace')
        .values({
          created_at: now,
          default_amount: 1000,
          id,
          provider: input.provider,
          provider_id: input.providerId,
          updated_at: now,
        })
        .execute()
      return await DB.create(env.DB)
        .selectFrom('workspace')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    })())
  if (input.senderProviderUserId === input.recipientProviderUserId)
    return { code: 'self_tip', ok: false }

  const sender = await ensureMemberAccount(env, workspace.id, input.senderProviderUserId)
  const recipient = await ensureMemberAccount(env, workspace.id, input.recipientProviderUserId)

  const existing = await DB.create(env.DB)
    .selectFrom('tip')
    .selectAll()
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()
  if (existing?.transaction_hash)
    return {
      amount: formatAmount(existing.amount),
      memo: existing.memo,
      ok: true,
      recipientProviderUserId: input.recipientProviderUserId,
      senderProviderUserId: input.senderProviderUserId,
      status: 'already_sent',
      transactionHash: existing.transaction_hash,
    }
  if (existing)
    return {
      code: 'failed',
      message: 'Tip already recorded without a transaction.',
      ok: false,
    }

  const id = Nanoid.generate()
  const transactionHash = `mock-${id}`
  const now = new Date().toISOString()
  await DB.create(env.DB)
    .insertInto('tip')
    .values({
      amount: workspace.default_amount,
      confirmed_at: now,
      created_at: now,
      id,
      idempotency_key: input.idempotencyKey,
      memo: input.memo,
      recipient_id: recipient.account.id,
      recipient_member_id: recipient.member.id,
      sender_id: sender.account.id,
      sender_member_id: sender.member.id,
      token_address: mockTokenAddress,
      transaction_hash: transactionHash,
      updated_at: now,
      workspace_id: workspace.id,
    })
    .execute()

  return {
    amount: formatAmount(workspace.default_amount),
    memo: input.memo,
    ok: true,
    recipientProviderUserId: input.recipientProviderUserId,
    senderProviderUserId: input.senderProviderUserId,
    status: 'sent',
    transactionHash,
  }
}

export function formatAmount(amount: number) {
  const whole = Math.floor(amount / 1_000_000)
  const fraction = String(amount % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

export function formatTxLink(_env: Env, transactionHash: string) {
  return `(mock receipt ${transactionHash})`
}

export function parseAmount(value: string) {
  const match = value.match(/^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/)
  if (!match) return null

  const amount = Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'))
  if (!Number.isSafeInteger(amount) || amount <= 0) return null
  return amount
}

async function ensureMemberAccount(env: Env, workspaceId: string, providerUserId: string) {
  const member = await ensureMember(env, workspaceId, providerUserId)
  if (member.account_id) {
    const account = await DB.create(env.DB)
      .selectFrom('account')
      .selectAll()
      .where('id', '=', member.account_id)
      .executeTakeFirstOrThrow()
    return { account, member }
  }

  const account = await ensureMockAccount(env)
  await DB.create(env.DB)
    .updateTable('member')
    .set({ account_id: account.id, updated_at: new Date().toISOString() })
    .where('id', '=', member.id)
    .execute()

  return {
    account,
    member: { ...member, account_id: account.id },
  }
}

async function ensureMember(env: Env, workspaceId: string, providerUserId: string) {
  const existing = await DB.create(env.DB)
    .selectFrom('member')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('provider_user_id', '=', providerUserId)
    .executeTakeFirst()
  if (existing) return existing

  const id = Nanoid.generate()
  const now = new Date().toISOString()
  await DB.create(env.DB)
    .insertInto('member')
    .values({
      account_id: null,
      created_at: now,
      id,
      login: null,
      name: null,
      provider_user_id: providerUserId,
      updated_at: now,
      workspace_id: workspaceId,
    })
    .execute()
  return await DB.create(env.DB)
    .selectFrom('member')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

async function ensureMockAccount(env: Env) {
  const id = Nanoid.generate()
  const now = new Date().toISOString()
  await DB.create(env.DB)
    .insertInto('account')
    .values({
      address: mockAccountAddress(),
      created_at: now,
      id,
      updated_at: now,
    })
    .execute()
  return await DB.create(env.DB)
    .selectFrom('account')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

function mockAccountAddress() {
  const privateKey = Secp256k1.randomPrivateKey()
  const publicKey = Secp256k1.getPublicKey({ privateKey })
  return Address.fromPublicKey(publicKey)
}
