import * as DB from '#db/client.ts'
import * as Nanoid from '#/lib/nanoid.ts'

export const mockTokenAddress = 'mock:stablecoin'

export type Platform = 'slack'

export type TipInput = {
  idempotencyKey: string
  platform: Platform
  platformTeamId: string
  reason: string | null
  recipientAccountId: string
  senderAccountId: string
  sourceType: 'command' | 'mention' | 'reaction'
}

export type TipResult =
  | {
      amount: string
      ok: true
      reason: string | null
      recipientAccountId: string
      senderAccountId: string
      status: 'already_sent' | 'sent'
      txHash: string
    }
  | {
      accountId?: string
      code: 'daily_cap' | 'failed' | 'self_tip'
      message?: string
      ok: false
    }

export async function ensureWorkspace(env: Env, platform: Platform, platformTeamId: string) {
  const existing = await DB.create(env.DB)
    .selectFrom('workspace')
    .selectAll()
    .where('platform', '=', platform)
    .where('platform_team_id', '=', platformTeamId)
    .executeTakeFirst()
  if (existing) return existing

  const id = Nanoid.generate()
  const now = new Date().toISOString()
  await DB.create(env.DB)
    .insertInto('workspace')
    .values({
      created_at: now,
      daily_cap: '1',
      id,
      platform,
      platform_team_id: platformTeamId,
      tip_amount: '0.001',
      tip_emoji: 'money_with_wings',
      updated_at: now,
    })
    .execute()
  return await DB.create(env.DB)
    .selectFrom('workspace')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

export async function handleTipRequest(env: Env, input: TipInput): Promise<TipResult> {
  const workspace = await ensureWorkspace(env, input.platform, input.platformTeamId)
  const sender = await ensureAccount(env, workspace.id, input.senderAccountId)
  const recipient = await ensureAccount(env, workspace.id, input.recipientAccountId)
  if (sender.id === recipient.id) return { code: 'self_tip', ok: false }

  const existing = await DB.create(env.DB)
    .selectFrom('tip')
    .selectAll()
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()
  if (existing?.tx_hash)
    return {
      amount: existing.amount,
      ok: true,
      reason: existing.reason,
      recipientAccountId: input.recipientAccountId,
      senderAccountId: input.senderAccountId,
      status: 'already_sent',
      txHash: existing.tx_hash,
    }
  if (existing)
    return {
      code: 'failed',
      message: `Tip already recorded with status ${existing.status}.`,
      ok: false,
    }

  if (await isDailyCapExceeded(env, sender.id, workspace.daily_cap, workspace.tip_amount))
    return { accountId: input.senderAccountId, code: 'daily_cap', ok: false }

  const id = Nanoid.generate()
  const txHash = `mock-${id}`
  const now = new Date().toISOString()
  await DB.create(env.DB)
    .insertInto('tip')
    .values({
      amount: workspace.tip_amount,
      created_at: now,
      id,
      idempotency_key: input.idempotencyKey,
      reason: input.reason,
      recipient_account_id: recipient.id,
      sender_account_id: sender.id,
      source_type: input.sourceType,
      status: 'confirmed',
      token_address: mockTokenAddress,
      tx_hash: txHash,
      updated_at: now,
      workspace_id: workspace.id,
    })
    .execute()

  return {
    amount: workspace.tip_amount,
    ok: true,
    reason: input.reason,
    recipientAccountId: input.recipientAccountId,
    senderAccountId: input.senderAccountId,
    status: 'sent',
    txHash,
  }
}

export function formatTxLink(_env: Env, txHash: string) {
  return `(mock receipt ${txHash})`
}

async function ensureAccount(env: Env, workspaceId: string, platformAccountId: string) {
  const existing = await DB.create(env.DB)
    .selectFrom('account')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('platform', '=', 'slack')
    .where('platform_account_id', '=', platformAccountId)
    .executeTakeFirst()
  if (existing) return existing

  const id = Nanoid.generate()
  const now = new Date().toISOString()
  await DB.create(env.DB)
    .insertInto('account')
    .values({
      created_at: now,
      display_name: null,
      id,
      platform: 'slack',
      platform_account_id: platformAccountId,
      updated_at: now,
      workspace_id: workspaceId,
    })
    .execute()
  return await DB.create(env.DB)
    .selectFrom('account')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

async function isDailyCapExceeded(
  env: Env,
  senderAccountId: string,
  dailyCap: string,
  amount: string,
) {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  const tips = await DB.create(env.DB)
    .selectFrom('tip')
    .select('amount')
    .where('sender_account_id', '=', senderAccountId)
    .where('status', 'in', ['confirmed', 'submitting'])
    .where('created_at', '>=', start.toISOString())
    .execute()
  const spent = tips.reduce((total, tip) => total + Number(tip.amount), 0)
  return spent + Number(amount) > Number(dailyCap)
}
