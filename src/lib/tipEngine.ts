import { KeyAuthorization } from 'ox/tempo'
import { createClient, http, parseUnits, type Hex } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { Account as TempoAccount, Actions } from 'viem/tempo'

import { decryptSecret } from '#/lib/crypto.ts'
import { createDb } from '#/lib/db.ts'
import type { DB } from '#/lib/db.gen.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { createConnectUrl, ensureWorkspace } from '#/lib/slack.ts'
import { getTempoChain, pathUsd, pathUsdDecimals, tipAttemptTtlMs } from '#/lib/tempo.ts'

export async function handleTipRequest(env: Env, request: Request, input: TipInput) {
  const workspace = await ensureWorkspace(env, input.teamId)
  const sender = await getAccount(env, workspace.id, input.senderAccountId)
  if (!sender?.tempo_address || !sender.access_key_ciphertext || !sender.access_key_authorization)
    return {
      ok: false,
      text: `<@${input.senderAccountId}> connect your Tempo Wallet before sending tips: ${await createConnectUrl(request, env, { accountId: input.senderAccountId, teamId: input.teamId })}`,
    }

  if (
    sender.access_key_expires_at &&
    new Date(sender.access_key_expires_at).getTime() <= Date.now()
  )
    return {
      ok: false,
      text: `<@${input.senderAccountId}> reconnect your Tempo Wallet to refresh your tipping key: ${await createConnectUrl(request, env, { accountId: input.senderAccountId, teamId: input.teamId })}`,
    }

  const recipient = await getAccount(env, workspace.id, input.recipientAccountId)
  if (!recipient?.tempo_address)
    return {
      ok: false,
      text: `<@${input.recipientAccountId}> connect your Tempo Wallet to receive tips: ${await createConnectUrl(request, env, { accountId: input.recipientAccountId, teamId: input.teamId })}`,
    }

  if (sender.id === recipient.id) return { ok: false, text: 'You cannot tip yourself.' }

  const capped = await isDailyCapExceeded(env, sender.id, workspace.daily_cap, workspace.tip_amount)
  if (capped) return { ok: false, text: `Daily tip cap reached for <@${input.senderAccountId}>.` }

  const existing = await createDb(env.DB)
    .selectFrom('tip')
    .selectAll()
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()
  if (existing?.tx_hash)
    return {
      ok: true,
      text: `Already sent: <@${input.senderAccountId}> → <@${input.recipientAccountId}> ${existing.amount} stablecoins${existing.reason ? ` for ${existing.reason}` : ''}. ${formatTxLink(env, existing.tx_hash)}`,
    }
  if (existing) return { ok: false, text: `Tip already recorded with status ${existing.status}.` }

  const tipId = Nanoid.generate()
  const attemptId = Nanoid.generate()
  const amount = workspace.tip_amount
  const amountBaseUnits = parseUnits(amount, pathUsdDecimals).toString()
  const now = new Date()
  const nowIso = now.toISOString()
  const expiresAt = new Date(now.getTime() + tipAttemptTtlMs).toISOString()

  await createDb(env.DB)
    .insertInto('tip')
    .values({
      amount,
      created_at: nowIso,
      id: tipId,
      idempotency_key: input.idempotencyKey,
      reason: input.reason,
      recipient_account_id: recipient.id,
      sender_account_id: sender.id,
      source_type: input.sourceType,
      status: 'submitting',
      token_address: pathUsd,
      updated_at: nowIso,
      workspace_id: workspace.id,
    })
    .execute()
  await createDb(env.DB)
    .insertInto('tip_attempt')
    .values({
      amount: amountBaseUnits,
      created_at: nowIso,
      expires_at: expiresAt,
      id: attemptId,
      recipient_address: recipient.tempo_address,
      sender_address: sender.tempo_address,
      tip_id: tipId,
      token_address: pathUsd,
    })
    .execute()

  try {
    const txHash = await submitTipTransaction(env, request, {
      amount,
      recipientAddress: recipient.tempo_address as Hex,
      sender,
    })
    await createDb(env.DB)
      .updateTable('tip')
      .set({ status: 'confirmed', tx_hash: txHash, updated_at: new Date().toISOString() })
      .where('id', '=', tipId)
      .execute()
    return {
      ok: true,
      text: `Tip sent: <@${input.senderAccountId}> → <@${input.recipientAccountId}> ${amount} stablecoins${input.reason ? ` for ${input.reason}` : ''}. ${formatTxLink(env, txHash)}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tip submission failed.'
    await createDb(env.DB)
      .updateTable('tip')
      .set({ error: message, status: 'failed', updated_at: new Date().toISOString() })
      .where('id', '=', tipId)
      .execute()
    return { ok: false, text: `Could not send tip: ${message}` }
  }
}

export type TipInput = {
  idempotencyKey: string
  reason: string | null
  recipientAccountId: string
  senderAccountId: string
  sourceType: 'command' | 'mention' | 'reaction'
  teamId: string
}

async function getAccount(env: Env, workspaceId: string, platformAccountId: string) {
  return await createDb(env.DB)
    .selectFrom('account')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('platform', '=', 'slack')
    .where('platform_account_id', '=', platformAccountId)
    .executeTakeFirst()
}

async function isDailyCapExceeded(
  env: Env,
  senderAccountId: string,
  dailyCap: string,
  amount: string,
) {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  const tips = await createDb(env.DB)
    .selectFrom('tip')
    .select('amount')
    .where('sender_account_id', '=', senderAccountId)
    .where('status', 'in', ['confirmed', 'submitting'])
    .where('created_at', '>=', start.toISOString())
    .execute()
  const spent = tips.reduce((total, tip) => total + Number(tip.amount), 0)
  return spent + Number(amount) > Number(dailyCap)
}

async function submitTipTransaction(
  env: Env,
  request: Request,
  input: {
    amount: string
    recipientAddress: Hex
    sender: DB.Account
  },
) {
  if (!env.ACCESS_KEY_ENCRYPTION_SECRET)
    throw new Error('ACCESS_KEY_ENCRYPTION_SECRET is not configured.')

  const privateKey = (await decryptSecret(
    input.sender.access_key_ciphertext!,
    env.ACCESS_KEY_ENCRYPTION_SECRET,
  )) as Hex
  const account = TempoAccount.fromSecp256k1(privateKey, {
    access: input.sender.tempo_address as Hex,
  })
  const chain = getTempoChain(env.TEMPO_CHAIN)
  const keyAuthorization = KeyAuthorization.fromRpc(
    JSON.parse(input.sender.access_key_authorization!),
  )
  if (keyAuthorization.chainId !== BigInt(chain.id))
    throw new Error('Reconnect your Tempo Wallet so your tipping key matches this Tempo chain.')

  const client = createClient({
    account,
    chain,
    transport: http(`${new URL(request.url).origin}/api/relay/${chain.id}`),
  })
  const receipt = await sendTransactionSync(client, {
    account,
    calls: [
      Actions.token.transfer.call({
        amount: parseUnits(input.amount, pathUsdDecimals),
        to: input.recipientAddress,
        token: pathUsd,
      }),
    ],
    feePayer: true,
    keyAuthorization,
  } as never)

  return (receipt as { transactionHash?: string }).transactionHash ?? JSON.stringify(receipt)
}

function formatTxLink(env: Env, txHash: string) {
  return `<${getTempoChain(env.TEMPO_CHAIN).blockExplorers.default.url}/tx/${txHash}|Tx ${shortTxHash(txHash)}>`
}

function shortTxHash(txHash: string) {
  if (txHash.length <= 13) return txHash
  return `${txHash.slice(0, 6)}…${txHash.slice(-4)}`
}
