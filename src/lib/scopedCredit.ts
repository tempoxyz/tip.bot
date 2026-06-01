import * as DB from '#db/client.ts'
import type { DB as Database } from '#db/types.gen.ts'
import { formatAmount, formatCurrencyAmount } from '#/lib/format.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Tip from '#/lib/tip.ts'

export const maxScopedCreditAmount = 10_000_000 // $10
export const scopedCreditExpiryMs = 7 * 24 * 60 * 60 * 1000 // 7 days

export type ScopedCreditCreateResult =
  | {
      credit: Database.Selectable.scoped_credit
      merchant: ScopedCreditMerchant
      ok: true
      recipientProviderUserId: string
      senderProviderUserId: string
    }
  | {
      code:
        | 'invalid_amount'
        | 'invalid_merchant'
        | 'invalid_usage'
        | 'self_credit'
        | 'too_large'
        | 'workspace_missing'
      message: string
      ok: false
    }

export type ScopedCreditMerchant = {
  id: string
  merchantAddress: string
  mppBaseUrl: string
  name: string
  tokenAddress: string
}

export const scopedCreditMerchants: Record<string, ScopedCreditMerchant> = {
  prospectbutcher: {
    id: 'prospectbutcher',
    merchantAddress: '0x0000000000000000000000000000000000001015',
    mppBaseUrl: 'https://prospect-butcher.example/mpp',
    name: 'Prospect Butcher Co.',
    tokenAddress: Tempo.addressLookup.pathUsd,
  },
} as const

export function parseScopedCreditText(value: string) {
  const text = value.trim()
  const match = text.match(
    /^<@([A-Z0-9_]+)(?:\|([^>]+))?>\s+(\$?(?:0|[1-9]\d*)(?:\.\d+)?)\s+([a-z0-9_-]+)$/i,
  )
  if (!match) return null

  const amount = Tip.parseAmount(match[3]!)
  return {
    amount,
    merchantId: normalizeMerchantId(match[4]!),
    recipientProviderLabel: match[2]?.trim(),
    recipientProviderUserId: match[1]!,
  }
}

export function formatScopedCreditAmount(amount: number) {
  return formatCurrencyAmount(formatAmount(amount), 'USD')
}

export function buildScopedCreditReceiptMemo(input: {
  merchantName: string
  recipientProviderUserId: string
  senderProviderUserId: string
}) {
  const merchantName = input.merchantName.replace(/\.+$/, '')
  return `Scoped credit for <@${input.recipientProviderUserId}> from <@${input.senderProviderUserId}>; spendable only at ${merchantName}.`
}

export async function createPendingScopedCredit(
  db: DB.Type,
  input: {
    idempotencyKey: string
    provider: Database.Selectable.workspace['provider']
    providerChannelId: string
    providerId: string
    providerThreadId?: string
    senderProviderUserId: string
    text: string
  },
): Promise<ScopedCreditCreateResult> {
  const parsed = parseScopedCreditText(input.text)
  if (!parsed || parsed.amount === null)
    return {
      code: parsed ? 'invalid_amount' : 'invalid_usage',
      message: 'Use `credit @account 2 prospectbutcher` to send a Prospect Butcher-only credit.',
      ok: false,
    }
  const merchant = scopedCreditMerchants[parsed.merchantId]
  if (!merchant)
    return {
      code: 'invalid_merchant',
      message: 'Merchant not available. For this MVP, use `prospectbutcher`.',
      ok: false,
    }
  if (parsed.amount > maxScopedCreditAmount)
    return {
      code: 'too_large',
      message: `Scoped credits are capped at ${formatScopedCreditAmount(maxScopedCreditAmount)} for this MVP.`,
      ok: false,
    }
  if (input.senderProviderUserId === parsed.recipientProviderUserId)
    return {
      code: 'self_credit',
      message: 'Payment not sent. Cannot send a credit to yourself.',
      ok: false,
    }

  const workspace = await getOrCreateWorkspace(db, input.provider, input.providerId)
  const sender = await getOrCreateMember(db, workspace, input.senderProviderUserId)
  const recipient = await getOrCreateMember(db, workspace, parsed.recipientProviderUserId, {
    login: parsed.recipientProviderLabel,
  })
  const existing = await db
    .selectFrom('scoped_credit')
    .selectAll()
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()
  if (existing)
    return {
      credit: existing,
      merchant,
      ok: true,
      recipientProviderUserId: existing.recipient_provider_user_id,
      senderProviderUserId: existing.sender_provider_user_id,
    }

  const id = Nanoid.generate()
  const now = new Date().toISOString()
  await db
    .insertInto('scoped_credit')
    .values({
      amount: parsed.amount,
      created_at: now,
      expires_at: new Date(Date.now() + scopedCreditExpiryMs).toISOString(),
      failed_at: null,
      failure_reason: null,
      id,
      idempotency_key: input.idempotencyKey,
      merchant_address: merchant.merchantAddress,
      merchant_id: merchant.id,
      merchant_name: merchant.name,
      mpp_receipt_id: null,
      provider_channel_id: input.providerChannelId,
      provider_thread_id: input.providerThreadId ?? null,
      recipient_member_id: recipient.id,
      recipient_provider_user_id: recipient.provider_user_id,
      receipt_memo: buildScopedCreditReceiptMemo({
        merchantName: merchant.name,
        recipientProviderUserId: recipient.provider_user_id,
        senderProviderUserId: sender.provider_user_id,
      }),
      sender_member_id: sender.id,
      sender_provider_user_id: sender.provider_user_id,
      status: 'pending',
      tempo_transaction_hash: null,
      token_address: merchant.tokenAddress,
      updated_at: now,
      workspace_id: workspace.id,
    })
    .execute()
  await insertScopedCreditEvent(db, id, 'created', {
    amount: parsed.amount,
    merchantId: merchant.id,
    recipientProviderUserId: recipient.provider_user_id,
    senderProviderUserId: sender.provider_user_id,
  })

  return {
    credit: await db
      .selectFrom('scoped_credit')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
    merchant,
    ok: true,
    recipientProviderUserId: recipient.provider_user_id,
    senderProviderUserId: sender.provider_user_id,
  }
}

export async function confirmScopedCredit(
  db: DB.Type,
  input: { actorProviderUserId: string; id: string },
) {
  const credit = await db
    .selectFrom('scoped_credit')
    .selectAll()
    .where('id', '=', input.id)
    .executeTakeFirst()
  if (!credit)
    return { code: 'not_found' as const, message: 'Credit not found.', ok: false as const }
  if (credit.sender_provider_user_id !== input.actorProviderUserId)
    return {
      code: 'wrong_actor' as const,
      message: 'Only the sender can confirm this credit.',
      ok: false as const,
    }
  if (credit.status !== 'pending')
    return {
      code: 'wrong_status' as const,
      message: `Credit is already ${credit.status}.`,
      ok: false as const,
    }

  const now = new Date().toISOString()
  const tempoTransactionHash = `fake_tempo_tx_${Nanoid.generate()}`
  await db
    .updateTable('scoped_credit')
    .set({
      status: 'issued',
      tempo_transaction_hash: tempoTransactionHash,
      updated_at: now,
    })
    .where('id', '=', credit.id)
    .execute()
  await insertScopedCreditEvent(db, credit.id, 'sender_confirmed')
  await insertScopedCreditEvent(db, credit.id, 'issued', {
    tempoPolicy: {
      recipient: credit.merchant_address,
      sender: 'credit_holder',
      tip: 'TIP-1015',
    },
    tempoTransactionHash,
  })
  await insertScopedCreditEvent(db, credit.id, 'recipient_notified')

  return {
    credit: await db
      .selectFrom('scoped_credit')
      .selectAll()
      .where('id', '=', credit.id)
      .executeTakeFirstOrThrow(),
    ok: true as const,
  }
}

export async function cancelScopedCredit(
  db: DB.Type,
  input: { actorProviderUserId: string; id: string },
) {
  const credit = await db
    .selectFrom('scoped_credit')
    .selectAll()
    .where('id', '=', input.id)
    .executeTakeFirst()
  if (!credit)
    return { code: 'not_found' as const, message: 'Credit not found.', ok: false as const }
  if (credit.sender_provider_user_id !== input.actorProviderUserId)
    return {
      code: 'wrong_actor' as const,
      message: 'Only the sender can cancel this credit.',
      ok: false as const,
    }
  if (credit.status !== 'pending')
    return {
      code: 'wrong_status' as const,
      message: `Credit is already ${credit.status}.`,
      ok: false as const,
    }

  await db
    .updateTable('scoped_credit')
    .set({ status: 'canceled', updated_at: new Date().toISOString() })
    .where('id', '=', credit.id)
    .execute()
  await insertScopedCreditEvent(db, credit.id, 'canceled')
  return { ok: true as const }
}

export async function spendScopedCredit(
  db: DB.Type,
  input: { actorProviderUserId: string; id: string },
) {
  const credit = await db
    .selectFrom('scoped_credit')
    .selectAll()
    .where('id', '=', input.id)
    .executeTakeFirst()
  if (!credit)
    return { code: 'not_found' as const, message: 'Credit not found.', ok: false as const }
  if (credit.recipient_provider_user_id !== input.actorProviderUserId)
    return {
      code: 'wrong_actor' as const,
      message: 'Only the recipient can spend this credit.',
      ok: false as const,
    }
  if (credit.status !== 'issued')
    return {
      code: 'wrong_status' as const,
      message: `Credit is ${credit.status}, not available.`,
      ok: false as const,
    }

  const mppReceiptId = `fake_mpp_receipt_${Nanoid.generate()}`
  await insertScopedCreditEvent(db, credit.id, 'spend_started', {
    mppBaseUrl: scopedCreditMerchants[credit.merchant_id]?.mppBaseUrl,
  })
  await db
    .updateTable('scoped_credit')
    .set({
      mpp_receipt_id: mppReceiptId,
      status: 'spent',
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', credit.id)
    .execute()
  await insertScopedCreditEvent(db, credit.id, 'paid', {
    mppReceiptId,
    receiptMemo: credit.receipt_memo,
  })
  return {
    credit: await db
      .selectFrom('scoped_credit')
      .selectAll()
      .where('id', '=', credit.id)
      .executeTakeFirstOrThrow(),
    ok: true as const,
  }
}

async function getOrCreateWorkspace(
  db: DB.Type,
  provider: Database.Selectable.workspace['provider'],
  providerId: string,
) {
  const existing = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', provider)
    .where('provider_id', '=', providerId)
    .executeTakeFirst()
  if (existing) return existing

  const id = Nanoid.generate()
  const now = new Date().toISOString()
  await db
    .insertInto('workspace')
    .values({
      chain_id: Tempo.chainLookup.mainnet,
      created_at: now,
      default_amount: 1000,
      id,
      provider,
      provider_id: providerId,
      reaction_tip_emoji: 'money_with_wings',
      updated_at: now,
    })
    .execute()
  return await db.selectFrom('workspace').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

async function getOrCreateMember(
  db: DB.Type,
  workspace: Database.Selectable.workspace,
  providerUserId: string,
  options: { login?: string } = {},
) {
  const existing = await db
    .selectFrom('member')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .where('provider_user_id', '=', providerUserId)
    .executeTakeFirst()
  if (existing) return existing

  const now = new Date().toISOString()
  const providerIdentity =
    (await db
      .selectFrom('provider_identity')
      .selectAll()
      .where('provider', '=', workspace.provider)
      .where('provider_workspace_id', '=', workspace.provider_id)
      .where('provider_user_id', '=', providerUserId)
      .executeTakeFirst()) ??
    (await (async () => {
      const id = Nanoid.generate()
      await db
        .insertInto('provider_identity')
        .values({
          account_id: null,
          created_at: now,
          display_name: options.login ?? null,
          id,
          metadata: null,
          provider: workspace.provider,
          provider_global_user_id: null,
          provider_user_id: providerUserId,
          provider_workspace_id: workspace.provider_id,
          real_name: null,
          updated_at: now,
        })
        .execute()
      return await db
        .selectFrom('provider_identity')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    })())
  const id = Nanoid.generate()
  await db
    .insertInto('member')
    .values({
      created_at: now,
      id,
      login: options.login ?? null,
      name: null,
      provider_identity_id: providerIdentity.id,
      provider_user_id: providerUserId,
      updated_at: now,
      workspace_id: workspace.id,
    })
    .execute()
  return await db.selectFrom('member').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

async function insertScopedCreditEvent(
  db: DB.Type,
  scopedCreditId: string,
  eventType: Database.Insertable.scoped_credit_event['event_type'],
  details?: Record<string, unknown>,
) {
  await db
    .insertInto('scoped_credit_event')
    .values({
      created_at: new Date().toISOString(),
      details_json: details ? JSON.stringify(details) : null,
      event_type: eventType,
      id: Nanoid.generate(),
      scoped_credit_id: scopedCreditId,
    })
    .execute()
}

function normalizeMerchantId(value: string) {
  return value.toLowerCase().replace(/[-_\s]+/g, '')
}
