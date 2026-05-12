import * as AccessKey from '#/lib/accessKey.ts'
import * as DB from '#db/client.ts'
import { formatAmount } from '#/lib/format.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Tempo from '#/lib/tempo.ts'
import type { DB as Database } from '#db/types.gen.ts'
import { local, Provider as AccountsProvider, Storage } from 'accounts'
import { Address, Hex } from 'ox'
import { KeyAuthorization } from 'ox/tempo'
import { custom } from 'viem'
import { Actions } from 'viem/tempo'

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
          chain_id: Tempo.mainnetChainId,
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

  const tokenAddress = Address.checksum(workspace.default_token_address ?? Tempo.pathUsdAddress)
  if (!Tempo.isAllowedToken(workspace.chain_id, tokenAddress))
    return {
      code: 'failed',
      message: 'Workspace token is not supported on this network.',
      ok: false,
    }

  const existing = await DB.create(env.DB)
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

  const sender = await getConnectedMember(env, workspace.id, input.senderProviderUserId)
  if (!sender) return { code: 'sender_unconnected', ok: false }
  const recipient = await getConnectedMember(env, workspace.id, input.recipientProviderUserId)
  if (!recipient)
    return {
      code: 'recipient_unconnected',
      ok: false,
      recipientProviderUserId: input.recipientProviderUserId,
      senderProviderUserId: input.senderProviderUserId,
    }

  const accessKey = await DB.create(env.DB)
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
  await DB.create(env.DB)
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
    const keyAuthorization = KeyAuthorization.fromRpc(JSON.parse(accessKey.authorization) as never)
    const provider = AccountsProvider.create({
      adapter: local({
        loadAccounts: async () => ({
          accounts: [{ address: sender.account.address as `0x${string}` }],
        }),
      }),
      chains: [Tempo.getChain(workspace.chain_id)],
      storage: Storage.memory({ key: `tipbot-${id}` }),
      transports: {
        [workspace.chain_id]: custom({
          async request(request) {
            const response = await fetch(`https://${env.HOST}/api/relay/${workspace.chain_id}`, {
              body: JSON.stringify({
                id: 1,
                jsonrpc: '2.0',
                method: request.method,
                params: request.params,
              }),
              headers: { 'content-type': 'application/json' },
              method: 'POST',
            })
            const json = (await response.json()) as {
              error?: { message?: string }
              result?: unknown
            }
            if (json.error) throw new Error(json.error.message ?? 'Tempo relay request failed.')
            return json.result
          },
        }),
      },
    }) as never as {
      request: (request: {
        method: 'eth_sendTransactionSync'
        params: readonly [unknown]
      }) => Promise<unknown>
      store: { setState: (state: unknown) => void }
    }
    provider.store.setState({
      accessKeys: [
        {
          access: sender.account.address as never,
          address: keyAuthorization.address as never,
          expiry: keyAuthorization.expiry ?? undefined,
          keyAuthorization: accessKey.authorization_used_at ? undefined : keyAuthorization,
          keyType: keyAuthorization.type,
          limits: keyAuthorization.limits as never,
          privateKey: await AccessKey.decrypt(env, accessKey.ciphertext),
          scopes: keyAuthorization.scopes as never,
        },
      ],
      accounts: [{ address: sender.account.address as never }],
      activeAccount: 0,
      chainId: workspace.chain_id,
      requestQueue: [],
    })
    const receipt = (await provider.request({
      method: 'eth_sendTransactionSync',
      params: [
        {
          calls: [
            Actions.token.transfer.call({
              amount: BigInt(workspace.default_amount),
              memo: sponsorshipMemo as Hex.Hex,
              to: recipient.account.address as never,
              token: tokenAddress,
            }),
          ],
          feePayer: true,
        },
      ],
    })) as { transactionHash?: string }
    if (!receipt.transactionHash) throw new Error('Tempo transaction did not return a hash.')
    await DB.create(env.DB)
      .updateTable('tip')
      .set({
        confirmed_at: new Date().toISOString(),
        transaction_hash: receipt.transactionHash,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .execute()
    if (!accessKey.authorization_used_at)
      await DB.create(env.DB)
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
      transactionHash: receipt.transactionHash,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tip submission failed.'
    await DB.create(env.DB)
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

async function getConnectedMember(env: Env, workspaceId: string, providerUserId: string) {
  return await DB.create(env.DB)
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
