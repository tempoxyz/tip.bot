import * as AccessKey from '#/lib/accessKey.ts'
import * as DB from '#db/client.ts'
import { formatAmount } from '#/lib/format.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Tempo from '#/lib/tempo.ts'
import type { DB as Database } from '#db/types.gen.ts'
import { AbiFunction, Address, Hex } from 'ox'
import { KeyAuthorization } from 'ox/tempo'
import { createClient, http } from 'viem'
import { Account as TempoAccount, Actions, withRelay } from 'viem/tempo'

export type TipResult =
  | {
      amount: string
      chainId: number
      memo: string | null
      ok: true
      recipientProviderUserId: string
      senderProviderUserId: string
      status: 'duplicate' | 'sent'
      tokenCurrency: string
      tokenSymbol: string
      transactionHash: string
    }
  | {
      code:
        | 'failed'
        | 'missing_sender_access_key'
        | 'pending'
        | 'recipient_unconnected'
        | 'self_tip'
        | 'sender_unconnected'
      message?: string
      ok: false
      recipientProviderUserId?: string
      senderProviderUserId?: string
      transactionHash?: string | undefined
      chainId?: number | undefined
    }

export async function handleTipRequest(
  env: Env,
  input: {
    idempotencyKey: string
    memo: string | null
    provider: Database.Selectable.workspace['provider']
    providerId: string
    recipientProviderUserId: string
    senderProviderUserId: string
  },
): Promise<TipResult> {
  const db = DB.create(env.DB)
  const workspace =
    (await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', input.provider)
      .where('provider_id', '=', input.providerId)
      .executeTakeFirst()) ??
    (await (async () => {
      const id = Nanoid.generate()
      const now = new Date().toISOString()
      await db
        .insertInto('workspace')
        .values({
          chain_id: Tempo.mainnetChainId,
          created_at: now,
          default_amount: 1000,
          id,
          provider: input.provider,
          provider_id: input.providerId,
          updated_at: now,
        })
        .execute()
      return await db
        .selectFrom('workspace')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    })())
  if (input.senderProviderUserId === input.recipientProviderUserId)
    return { code: 'self_tip', ok: false }

  const tokenAddress = Address.checksum(workspace.default_token_address ?? Tempo.pathUsdAddress)
  if (!Tempo.isAllowedToken(workspace.chain_id, tokenAddress))
    return {
      code: 'failed',
      message: 'Workspace token is not supported on this network.',
      ok: false,
    }

  const existing = await db
    .selectFrom('tip')
    .selectAll()
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()
  if (existing?.confirmed_at && existing.transaction_hash) {
    const tokenMetadata = await Tempo.getTokenMetadata(
      env,
      existing.chain_id,
      existing.token_address,
    )
    return {
      amount: formatAmount(existing.amount),
      chainId: existing.chain_id,
      memo: existing.memo,
      ok: true,
      recipientProviderUserId: input.recipientProviderUserId,
      senderProviderUserId: input.senderProviderUserId,
      status: 'duplicate',
      tokenCurrency: tokenMetadata.currency,
      tokenSymbol: tokenMetadata.symbol,
      transactionHash: existing.transaction_hash,
    }
  }
  if (existing?.failed_at)
    return {
      chainId: existing.chain_id,
      code: 'failed',
      message: existing.failure_reason ?? 'Tip failed. Try again.',
      ok: false,
      transactionHash: existing.transaction_hash ?? undefined,
    }
  if (existing)
    return {
      chainId: existing.chain_id,
      code: 'pending',
      message: 'Tip is still sending.',
      ok: false,
      transactionHash: existing.transaction_hash ?? undefined,
    }

  const sender = await getConnectedMember(db, workspace.id, input.senderProviderUserId)
  if (!sender) return { code: 'sender_unconnected', ok: false }
  const recipient = await getConnectedMember(db, workspace.id, input.recipientProviderUserId)
  if (!recipient)
    return {
      code: 'recipient_unconnected',
      ok: false,
      recipientProviderUserId: input.recipientProviderUserId,
      senderProviderUserId: input.senderProviderUserId,
    }

  const accessKey = await db
    .selectFrom('access_key')
    .selectAll()
    .where('account_id', '=', sender.account.id)
    .where('chain_id', '=', workspace.chain_id)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date().toISOString())
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
  if (!accessKey)
    return { chainId: workspace.chain_id, code: 'missing_sender_access_key', ok: false }
  const keyAuthorization = KeyAuthorization.fromRpc(JSON.parse(accessKey.authorization) as never)
  if (input.memo && !supportsTransferMemo(keyAuthorization, tokenAddress))
    return { chainId: workspace.chain_id, code: 'missing_sender_access_key', ok: false }

  const id = Nanoid.generate()
  const sponsorshipMemo = await createSponsorshipMemo(env, {
    amount: workspace.default_amount,
    chainId: workspace.chain_id,
    id,
    idempotencyKey: input.idempotencyKey,
    recipient: recipient.account.address,
    sender: sender.account.address,
    token: tokenAddress,
  })
  const now = new Date().toISOString()
  await db
    .insertInto('tip')
    .values({
      amount: workspace.default_amount,
      chain_id: workspace.chain_id,
      confirmed_at: null,
      created_at: now,
      failed_at: null,
      failure_reason: null,
      id,
      idempotency_key: input.idempotencyKey,
      memo: input.memo,
      recipient_id: recipient.account.id,
      recipient_member_id: recipient.member.id,
      sender_id: sender.account.id,
      sender_member_id: sender.member.id,
      sponsorship_memo: sponsorshipMemo,
      token_address: tokenAddress,
      transaction_hash: null,
      updated_at: now,
      workspace_id: workspace.id,
    })
    .execute()

  try {
    const account = TempoAccount.fromSecp256k1(await AccessKey.decrypt(env, accessKey.ciphertext), {
      access: sender.account.address as `0x${string}`,
    })
    const client = createClient({
      chain: Tempo.getChain(workspace.chain_id),
      transport: withRelay(
        http(Tempo.getRpcUrl(env, workspace.chain_id)),
        http(`https://${env.HOST}/api/relay/${workspace.chain_id}`),
      ),
    })
    const transfer = await Actions.token.transferSync(client, {
      account,
      amount: BigInt(workspace.default_amount),
      feePayer: true,
      keyAuthorization: accessKey.authorization_used_at ? undefined : keyAuthorization,
      ...(input.memo ? { memo: encodeTransferMemo(input.memo) } : {}),
      to: recipient.account.address as never,
      token: tokenAddress,
    })
    if (!transfer.receipt.transactionHash)
      throw new Error('Tempo transaction did not return a hash.')
    await db
      .updateTable('tip')
      .set({
        confirmed_at: new Date().toISOString(),
        transaction_hash: transfer.receipt.transactionHash,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .execute()
    if (!accessKey.authorization_used_at)
      await db
        .updateTable('access_key')
        .set({
          authorization_used_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', accessKey.id)
        .execute()
    const tokenMetadata = await Tempo.getTokenMetadata(env, workspace.chain_id, tokenAddress)
    return {
      amount: formatAmount(workspace.default_amount),
      chainId: workspace.chain_id,
      memo: input.memo,
      ok: true,
      recipientProviderUserId: input.recipientProviderUserId,
      senderProviderUserId: input.senderProviderUserId,
      status: 'sent',
      tokenCurrency: tokenMetadata.currency,
      tokenSymbol: tokenMetadata.symbol,
      transactionHash: transfer.receipt.transactionHash,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tip submission failed.'
    await db
      .updateTable('tip')
      .set({
        failed_at: new Date().toISOString(),
        failure_reason: message,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .execute()
    return { chainId: workspace.chain_id, code: 'failed', message, ok: false }
  }
}

export function parseAmount(value: string) {
  const match = value.match(/^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/)
  if (!match) return null

  const amount = Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'))
  if (!Number.isSafeInteger(amount) || amount <= 0) return null
  return amount
}

export function parseTipText(value: string) {
  const text = value.trim()
  const mention = text.match(/<@([A-Z0-9_]+)(?:\|[^>]+)?>/)
  if (!mention) return null
  const afterMention = text.slice((mention.index ?? 0) + mention[0].length).trim()
  return {
    memo: afterMention.replace(/^for\s+/i, '').trim() || null,
    recipientProviderUserId: mention[1]!,
  }
}

export function encodeTransferMemo(memo: string | null) {
  if (!memo) return Hex.padRight('0x', 32)
  const hex = Hex.fromString(memo)
  if (Hex.size(hex) > 32) throw new Error('Memo must be at most 32 bytes.')
  return Hex.padRight(hex, 32)
}

export async function verifySponsorshipMemo(
  env: Env,
  tip: Pick<
    Database.Selectable.tip,
    'amount' | 'chain_id' | 'id' | 'idempotency_key' | 'sponsorship_memo' | 'token_address'
  > & {
    recipient_address: string
    sender_address: string
  },
) {
  if (!tip.sponsorship_memo) return false
  const memo = await createSponsorshipMemo(env, {
    amount: tip.amount,
    chainId: tip.chain_id,
    id: tip.id,
    idempotencyKey: tip.idempotency_key,
    recipient: tip.recipient_address,
    sender: tip.sender_address,
    token: tip.token_address,
  })
  return memo.toLowerCase() === tip.sponsorship_memo.toLowerCase()
}

async function getConnectedMember(db: DB.Type, workspaceId: string, providerUserId: string) {
  return await db
    .selectFrom('member')
    .innerJoin('account', 'account.id', 'member.account_id')
    .select([
      'account.address as account_address',
      'account.created_at as account_created_at',
      'account.id as account_id',
      'account.updated_at as account_updated_at',
      'member.account_id as member_account_id',
      'member.created_at as member_created_at',
      'member.id as member_id',
      'member.login',
      'member.name',
      'member.provider_user_id',
      'member.updated_at as member_updated_at',
      'member.workspace_id',
    ])
    .where('member.workspace_id', '=', workspaceId)
    .where('member.provider_user_id', '=', providerUserId)
    .executeTakeFirst()
    .then((row) =>
      row
        ? {
            account: {
              address: row.account_address,
              created_at: row.account_created_at,
              id: row.account_id,
              updated_at: row.account_updated_at,
            },
            member: {
              account_id: row.member_account_id,
              created_at: row.member_created_at,
              id: row.member_id,
              login: row.login,
              name: row.name,
              provider_user_id: row.provider_user_id,
              updated_at: row.member_updated_at,
              workspace_id: row.workspace_id,
            },
          }
        : null,
    )
}

function supportsTransferMemo(
  authorization: KeyAuthorization.KeyAuthorization,
  tokenAddress: string,
) {
  if (!authorization.scopes) return true
  return authorization.scopes.some((scope) => {
    if (!Address.isEqual(scope.address, tokenAddress as Address.Address)) return false
    if (!scope.selector) return true
    return (
      scope.selector.toLowerCase() ===
      AbiFunction.getSelector('transferWithMemo(address,uint256,bytes32)').toLowerCase()
    )
  })
}

async function createSponsorshipMemo(
  env: Pick<Env, 'SECRET_KEY'>,
  input: {
    amount: number
    chainId: number
    id: string
    idempotencyKey: string
    recipient: string
    sender: string
    token: string
  },
) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SECRET_KEY),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(
      JSON.stringify({
        amount: input.amount,
        chainId: input.chainId,
        id: input.id,
        idempotencyKey: input.idempotencyKey,
        recipient: Address.checksum(input.recipient),
        sender: Address.checksum(input.sender),
        token: Address.checksum(input.token),
      }),
    ),
  )
  return `0x74697001${Hex.fromBytes(new Uint8Array(digest)).slice(10, 66)}`
}
