import * as AccessKey from '#/lib/accessKey.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as Confirmation from '#/lib/confirmation.ts'
import * as DB from '#db/client.ts'
import { replaceEmojiShortcodes } from '#/lib/emoji.ts'
import { formatAmount } from '#/lib/format.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Tempo from '#/lib/tempo.ts'
import type { DB as Database } from '#db/types.gen.ts'
import { AbiFunction, Address, Hex } from 'ox'
import { TxEnvelopeTempo } from 'ox/tempo'
import { KeyAuthorization } from 'ox/tempo'
import { BaseError, InsufficientFundsError, createClient, http } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { privateKeyToAccount } from 'viem/accounts'
import { Account as TempoAccount, Actions } from 'viem/tempo'
import { getNodeError } from 'viem/utils'

export type TipResult =
  | {
      amount: string
      chainId: number
      feePayer: 'sender' | 'sponsor'
      isDefaultToken: boolean
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
        | 'confirmation_required'
        | 'insufficient_funds'
        | 'missing_sender_access_key'
        | 'pending'
        | 'recipient_unconnected'
        | 'self_tip'
        | 'sender_unconnected'
      message?: string
      ok: false
      confirmUrl?: string
      recipientProviderUserId?: string
      senderProviderUserId?: string
      transactionHash?: string | undefined
      chainId?: number | undefined
    }

export type TipBatchResult =
  | {
      amount: string
      chainId: number
      feePayer: 'sender' | 'sponsor'
      isDefaultToken: boolean
      memo: string | null
      ok: true
      recipients: Array<{ recipientProviderLabel?: string; recipientProviderUserId: string }>
      senderProviderUserId: string
      skippedRecipients?: TipSkippedRecipient[]
      status: 'duplicate' | 'sent'
      tokenCurrency: string
      tokenSymbol: string
      transactionHash: string
    }
  | Extract<TipResult, { ok: false }>

export type TipRecipientInput = {
  recipientProviderLabel?: string
  recipientProviderUserId: string
  recipientProviderWorkspaceId?: string
}

export type TipSkippedRecipient = {
  reason: 'not_connected' | 'you'
  recipientProviderLabel?: string
  recipientProviderUserId: string
}

export type TipUsergroupInput = {
  providerUsergroupId: string
  providerUsergroupLabel?: string
}

export const maxTipBatchRecipients = 100

export async function handleTipRequest(
  env: Env,
  input: {
    amount?: number
    idempotencyKey: string
    memo: string | null
    provider: Database.Selectable.workspace['provider']
    providerChannelId: string
    providerId: string
    providerThreadId?: string
    recipientProviderLabel?: string
    recipientProviderUserId: string
    recipientProviderWorkspaceId?: string
    senderProviderUserId: string
    tokenAddress?: string
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
          chain_id: Tempo.chainLookup.mainnet,
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
  if (
    input.senderProviderUserId === input.recipientProviderUserId &&
    (!input.recipientProviderWorkspaceId || input.recipientProviderWorkspaceId === input.providerId)
  )
    return { code: 'self_tip', ok: false }

  const amount = input.amount ?? workspace.default_amount
  const tokenAddress = Address.checksum(
    input.tokenAddress ?? workspace.default_token_address ?? Tempo.addressLookup.pathUsd,
  )
  if (!Tempo.isAllowedToken(workspace.chain_id, tokenAddress))
    return {
      code: 'failed',
      message: 'Workspace token is not supported on this network.',
      ok: false,
    }

  const existing = await getExistingTipResult(env, db, input, tokenAddress)
  if (existing) return existing

  const sender = await getConnectedMember(db, workspace.id, input.senderProviderUserId)
  if (!sender) return { code: 'sender_unconnected', ok: false }
  const recipient = await getConnectedRecipient(db, workspace, input.provider, {
    recipientProviderUserId: input.recipientProviderUserId,
    recipientProviderWorkspaceId: input.recipientProviderWorkspaceId,
  })
  if (recipient?.account.id === sender.account.id) return { code: 'self_tip', ok: false }
  if (!recipient)
    return {
      code: 'recipient_unconnected',
      ok: false,
      recipientProviderUserId: input.recipientProviderUserId,
      senderProviderUserId: input.senderProviderUserId,
    }

  const accessKeys = await db
    .selectFrom('access_key')
    .selectAll()
    .where('account_id', '=', sender.account.id)
    .where('chain_id', '=', workspace.chain_id)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date().toISOString())
    .orderBy('created_at', 'desc')
    .execute()
  let trackedAccessKeyLimitExceeded = false
  let accessKey: Database.Selectable.access_key | undefined
  for (const row of accessKeys) {
    const authorization = KeyAuthorization.fromRpc(JSON.parse(row.authorization) as never)
    if (!supportsTip(authorization, { amount, memo: input.memo, tokenAddress })) continue
    if (
      !(await hasTrackedAccessKeyLimitRemaining(db, {
        accessKeyId: row.id,
        accountId: sender.account.id,
        amount,
        authorization,
        authorizationUsedAt: row.authorization_used_at,
        chainId: workspace.chain_id,
        tokenAddress,
      }))
    ) {
      trackedAccessKeyLimitExceeded = true
      continue
    }
    accessKey = row
    break
  }
  if (!accessKey)
    return await createConfirmationRequired(env, input, workspace, amount, tokenAddress, {
      kind: trackedAccessKeyLimitExceeded ? 'onetime_payment' : undefined,
    })

  return await submitTip(env, db, {
    accessKeyId: accessKey.id,
    accessKeyPrivateKey: await AccessKey.decrypt(env, accessKey.ciphertext),
    amount,
    authorizationUsedAt: accessKey.authorization_used_at,
    idempotencyKey: input.idempotencyKey,
    keyAuthorization: KeyAuthorization.fromRpc(JSON.parse(accessKey.authorization) as never),
    memo: input.memo,
    recipient,
    recipientProviderUserId: input.recipientProviderUserId,
    sender,
    senderProviderUserId: input.senderProviderUserId,
    tokenAddress,
    workspace,
  })
}

export async function handleTipBatchRequest(
  env: Env,
  input: {
    amount?: number
    idempotencyKey: string
    memo: string | null
    provider: Database.Selectable.workspace['provider']
    providerChannelId: string
    providerId: string
    providerThreadId?: string
    recipients: TipRecipientInput[]
    senderProviderUserId: string
    skippedRecipients?: TipSkippedRecipient[]
    source: 'command' | 'mention' | 'reaction'
    tokenAddress?: string
    usergroupId?: string
    usergroupLabel?: string
  },
): Promise<TipBatchResult> {
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
          chain_id: Tempo.chainLookup.mainnet,
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
  const recipients = input.recipients.slice(0, maxTipBatchRecipients)
  if (input.recipients.length === 0)
    return { code: 'failed', message: 'Payment must have at least one recipient.', ok: false }
  if (input.recipients.length > maxTipBatchRecipients)
    return {
      code: 'failed',
      message: `Multi-tip supports up to ${maxTipBatchRecipients} recipients.`,
      ok: false,
    }
  if (
    recipients.some(
      (recipient) =>
        recipient.recipientProviderUserId === input.senderProviderUserId &&
        (!recipient.recipientProviderWorkspaceId ||
          recipient.recipientProviderWorkspaceId === input.providerId),
    )
  )
    return { code: 'self_tip', ok: false }

  const amount = input.amount ?? workspace.default_amount
  const totalAmount = amount * recipients.length
  if (!Number.isSafeInteger(totalAmount) || totalAmount <= 0)
    return { code: 'failed', message: 'Payment amount is too large.', ok: false }
  const tokenAddress = Address.checksum(
    input.tokenAddress ?? workspace.default_token_address ?? Tempo.addressLookup.pathUsd,
  )
  if (!Tempo.isAllowedToken(workspace.chain_id, tokenAddress))
    return {
      code: 'failed',
      message: 'Workspace token is not supported on this network.',
      ok: false,
    }

  const existing = await getExistingTipBatchResult(env, db, input, tokenAddress)
  if (existing) return existing

  const sender = await getConnectedMember(db, workspace.id, input.senderProviderUserId)
  if (!sender) return { code: 'sender_unconnected', ok: false }
  const connectedRecipients = [] as ConnectedMember[]
  for (const recipient of recipients) {
    const connected = await getConnectedRecipient(db, workspace, input.provider, recipient)
    if (connected?.account.id === sender.account.id) return { code: 'self_tip', ok: false }
    if (!connected)
      return {
        code: 'recipient_unconnected',
        ok: false,
        recipientProviderUserId: recipient.recipientProviderUserId,
        senderProviderUserId: input.senderProviderUserId,
      }
    connectedRecipients.push(connected)
  }

  const accessKeys = await db
    .selectFrom('access_key')
    .selectAll()
    .where('account_id', '=', sender.account.id)
    .where('chain_id', '=', workspace.chain_id)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date().toISOString())
    .orderBy('created_at', 'desc')
    .execute()
  let accessKey: Database.Selectable.access_key | undefined
  for (const row of accessKeys) {
    const authorization = KeyAuthorization.fromRpc(JSON.parse(row.authorization) as never)
    if (!supportsTip(authorization, { amount: totalAmount, memo: input.memo, tokenAddress }))
      continue
    if (
      !(await hasTrackedAccessKeyLimitRemaining(db, {
        accessKeyId: row.id,
        accountId: sender.account.id,
        amount: totalAmount,
        authorization,
        authorizationUsedAt: row.authorization_used_at,
        chainId: workspace.chain_id,
        tokenAddress,
      }))
    )
      continue
    accessKey = row
    break
  }
  if (!accessKey)
    return (await createConfirmationRequired(
      env,
      {
        amount,
        idempotencyKey: input.idempotencyKey,
        memo: input.memo,
        provider: input.provider,
        providerChannelId: input.providerChannelId,
        providerId: input.providerId,
        providerThreadId: input.providerThreadId,
        recipientProviderLabel: recipients[0]?.recipientProviderLabel,
        recipientProviderUserId: recipients[0]!.recipientProviderUserId,
        recipientProviderWorkspaceId: recipients[0]?.recipientProviderWorkspaceId,
        recipients,
        senderProviderUserId: input.senderProviderUserId,
        skippedRecipients: input.skippedRecipients,
        usergroupId: input.usergroupId,
        usergroupLabel: input.usergroupLabel,
      },
      workspace,
      amount,
      tokenAddress,
      {
        accessKeyLimit: BigInt(Math.max(AccountLink.reusableAccessKeyLimit, totalAmount)),
        kind: 'onetime_payment',
      },
    )) as Extract<TipBatchResult, { ok: false }>

  return await submitTipBatch(env, db, {
    accessKeyId: accessKey.id,
    accessKeyPrivateKey: await AccessKey.decrypt(env, accessKey.ciphertext),
    amount,
    authorizationUsedAt: accessKey.authorization_used_at,
    connectedRecipients,
    idempotencyKey: input.idempotencyKey,
    keyAuthorization: KeyAuthorization.fromRpc(JSON.parse(accessKey.authorization) as never),
    memo: input.memo,
    provider: input.provider,
    providerChannelId: input.providerChannelId,
    providerId: input.providerId,
    providerThreadId: input.providerThreadId,
    recipients,
    sender,
    senderProviderUserId: input.senderProviderUserId,
    skippedRecipients: input.skippedRecipients,
    source: input.source,
    tokenAddress,
    usergroupId: input.usergroupId,
    usergroupLabel: input.usergroupLabel,
    workspace,
  })
}

export function parseAmount(value: string) {
  const match = value.match(/^\$?(0|[1-9]\d*)(?:\.(\d+))?$/)
  if (!match) return null

  const decimals = (match[2] ?? '').slice(0, 6).padEnd(6, '0')
  const amount = Number(match[1]) * 1_000_000 + Number(decimals)
  if (!Number.isSafeInteger(amount) || amount <= 0) return null
  return amount
}

function isTokenLike(value: string) {
  if (/[._\d]/.test(value)) return true // e.g. USDC.e, usdt0
  return /^[A-Z]{2,10}$/.test(value) // e.g. USDC, USDT, PATH
}

export function parseTipText(value: string, options: { chainId?: number } = {}) {
  const text = value.trim()
  const mention = text.match(/<@([A-Z0-9_]+)(?:\|([^>]+))?>/)
  if (!mention) return null
  const afterMention = text.slice((mention.index ?? 0) + mention[0].length).trim()
  const [first = '', ...rest] = afterMention.split(/\s+/)
  const amount = parseAmount(first)
  if (amount === null && /^\$\d/.test(first)) return null
  if (amount !== null) {
    const remaining = rest.join(' ').trim()
    const memoOnly = remaining.match(/^for\s+([\s\S]+)$/i)
    if (!remaining || memoOnly)
      return {
        amount,
        memo: memoOnly?.[1]?.trim() || null,
        ...(mention[2]?.trim() ? { recipientProviderLabel: mention[2].trim() } : {}),
        recipientProviderUserId: mention[1]!,
        token: null,
      }

    const [token = '', ...tokenRest] = remaining.split(/\s+/)
    const chainId = options.chainId ?? Tempo.chainLookup.mainnet
    const isKnownToken = Object.values(Tempo.chainLookup).some((knownChainId) =>
      Tempo.getTokenAddress(knownChainId, token),
    )
    const afterToken = tokenRest.join(' ').trim()
    const memo = afterToken.match(/^for\s+([\s\S]+)$/i)
    if (Tempo.getTokenAddress(chainId, token) || isKnownToken) {
      if (afterToken && !memo) return null
      return {
        amount,
        memo: memo?.[1]?.trim() || null,
        ...(mention[2]?.trim() ? { recipientProviderLabel: mention[2].trim() } : {}),
        recipientProviderUserId: mention[1]!,
        token,
      }
    }
    // TODO: Replace this unsupported-token heuristic if token symbols become dynamic or user-defined.
    // It intentionally keeps single token-like words like FAKE on the unsupported-token path,
    // while allowing phrases like "v2 launch" to fall through as memos.
    if (isTokenLike(token) && (!afterToken || memo)) {
      return {
        amount,
        memo: memo?.[1]?.trim() || null,
        ...(mention[2]?.trim() ? { recipientProviderLabel: mention[2].trim() } : {}),
        recipientProviderUserId: mention[1]!,
        token,
      }
    }

    return {
      amount,
      memo: remaining.replace(/^for\s+/i, '').trim() || null,
      ...(mention[2]?.trim() ? { recipientProviderLabel: mention[2].trim() } : {}),
      recipientProviderUserId: mention[1]!,
      token: null,
    }
  }
  return {
    amount: undefined,
    memo: afterMention.replace(/^for\s+/i, '').trim() || null,
    ...(mention[2]?.trim() ? { recipientProviderLabel: mention[2].trim() } : {}),
    recipientProviderUserId: mention[1]!,
    token: null,
  }
}

export function parseTipBatchText(value: string, options: { chainId?: number } = {}) {
  const text = value.trim()
  const recipients: TipRecipientInput[] = []
  const usergroups: TipUsergroupInput[] = []
  let remaining = text
  for (;;) {
    const mention = remaining.match(/^<@([A-Z0-9_]+)(?:\|([^>]+))?>\s*/)
    if (mention) {
      if (!recipients.some((recipient) => recipient.recipientProviderUserId === mention[1]))
        recipients.push({
          ...(mention[2]?.trim() ? { recipientProviderLabel: mention[2].trim() } : {}),
          recipientProviderUserId: mention[1]!,
        })
      remaining = remaining.slice(mention[0].length)
      continue
    }

    const usergroup = remaining.match(/^<!subteam\^([A-Z0-9_]+)(?:\|([^>]+))?>\s*/)
    if (!usergroup) break
    if (!usergroups.some((item) => item.providerUsergroupId === usergroup[1]))
      usergroups.push({
        ...(usergroup[2]?.trim()
          ? { providerUsergroupLabel: usergroup[2].trim().replace(/^@+/, '') }
          : {}),
        providerUsergroupId: usergroup[1]!,
      })
    remaining = remaining.slice(usergroup[0].length)
  }
  if (recipients.length === 0 && usergroups.length === 0) return null
  if (/<@[A-Z0-9_]+(?:\|[^>]+)?>|<!subteam\^[A-Z0-9_]+(?:\|[^>]+)?>/.test(remaining)) return null

  const parsed = parseTipText(
    `<@${recipients[0]?.recipientProviderUserId ?? 'U000000000'}${recipients[0]?.recipientProviderLabel ? `|${recipients[0].recipientProviderLabel}` : ''}> ${remaining}`,
    options,
  )
  if (!parsed) return null
  return {
    amount: parsed.amount,
    memo: parsed.memo,
    recipients,
    token: parsed.token,
    ...(usergroups.length ? { usergroups } : {}),
  }
}

export function encodeTransferMemo(memo: string | null) {
  if (!memo) return Hex.padRight('0x', 32)
  const hex = Hex.fromString(replaceEmojiShortcodes(memo))
  if (isTransferMemoTooLong(memo)) throw new Error('Memo must be at most 32 bytes.')
  return Hex.padRight(hex, 32)
}

export function isTransferMemoTooLong(memo: string | null) {
  return Boolean(memo && new TextEncoder().encode(replaceEmojiShortcodes(memo)).length > 32)
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

export async function getConfirmationData(env: Env, token: string) {
  const payload = await Confirmation.decrypt(env, token)
  if (Date.now() > new Date(payload.expiresAt).getTime())
    throw new Error('Confirmation link expired')
  const accessKey = await Confirmation.deriveAccessKey(env, payload.nonce)
  return { accessKey, payload }
}

export async function getConfirmationTransactionRequest(env: Env, token: string) {
  const db = DB.create(env.DB)
  const { payload } = await getConfirmationData(env, token)
  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('id', '=', payload.workspaceId)
    .executeTakeFirstOrThrow()
  const sender = await getConnectedMember(db, workspace.id, payload.senderProviderUserId)
  if (!sender) throw new Error('Reconnect Tipbot and try again.')
  const recipients = payload.recipients ?? [
    {
      recipientProviderLabel: payload.recipientProviderLabel,
      recipientProviderUserId: payload.recipientProviderUserId,
      recipientProviderWorkspaceId: payload.recipientProviderWorkspaceId,
    },
  ]
  const connectedRecipients = [] as ConnectedMember[]
  for (const recipient of recipients) {
    const connected = await getConnectedRecipient(db, workspace, payload.provider, recipient)
    if (!connected) throw new Error('Recipient needs to connect Tipbot before receiving payments.')
    connectedRecipients.push(connected)
  }

  return createSignedTransactionRequest(payload, sender, connectedRecipients)
}

export async function confirmTipRequest(
  env: Env,
  input: {
    address: string
    keyAuthorization?: unknown
    signedTransaction?: `0x${string}` | undefined
    token: string
  },
) {
  const db = DB.create(env.DB)
  const { accessKey, payload } = await getConfirmationData(env, input.token)
  if (!Tempo.isAllowedToken(payload.chainId, payload.tokenAddress))
    throw new Error('This token is not supported on this network.')

  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('id', '=', payload.workspaceId)
    .executeTakeFirstOrThrow()
  const sender = await getConnectedMember(db, workspace.id, payload.senderProviderUserId)
  if (!sender) throw new Error('Reconnect Tipbot and try again.')
  const recipients = payload.recipients ?? [
    {
      recipientProviderLabel: payload.recipientProviderLabel,
      recipientProviderUserId: payload.recipientProviderUserId,
      recipientProviderWorkspaceId: payload.recipientProviderWorkspaceId,
    },
  ]
  const connectedRecipients = [] as ConnectedMember[]
  for (const recipient of recipients) {
    const connected = await getConnectedRecipient(db, workspace, payload.provider, recipient)
    if (!connected) throw new Error('Recipient needs to connect Tipbot before receiving payments.')
    connectedRecipients.push(connected)
  }
  if (payload.kind === 'onetime_payment') {
    if (!input.signedTransaction) throw new Error('Tempo Wallet did not approve this payment.')
    if (recipients.length > 1)
      return await submitSignedTipBatch(env, db, {
        address: input.address,
        connectedRecipients,
        idempotencyKey: payload.idempotencyKey,
        memo: payload.memo,
        payload,
        recipients,
        sender,
        signedTransaction: input.signedTransaction,
        tokenAddress: Address.checksum(payload.tokenAddress),
        workspace,
      })
    const recipient = connectedRecipients[0]
    if (!recipient) throw new Error('Tempo Wallet did not approve this payment.')
    return await submitSignedTip(env, db, {
      address: input.address,
      idempotencyKey: payload.idempotencyKey,
      memo: payload.memo,
      payload,
      recipient,
      sender,
      signedTransaction: input.signedTransaction,
      tokenAddress: Address.checksum(payload.tokenAddress),
      workspace,
    })
  }
  if (!input.keyAuthorization) throw new Error('Tempo Wallet did not approve this payment.')
  const accessKeyExpiresAt =
    payload.kind === 'reusable_access_key'
      ? (payload.accessKeyExpiresAt ?? payload.expiresAt)
      : payload.expiresAt
  const accessKeyLimit =
    payload.kind === 'reusable_access_key'
      ? BigInt(payload.accessKeyLimit ?? AccountLink.reusableAccessKeyLimit)
      : BigInt(payload.amount)
  const accessKeyPeriodSeconds =
    payload.kind === 'reusable_access_key'
      ? AccountLink.reusableAccessKeyPeriodSeconds
      : AccountLink.confirmationLinkTtlMs / 1000 // 10 minutes

  const verified = await AccountLink.verifyKeyAuthorization({
    accessKeyAddress: accessKey.address,
    chainId: payload.chainId,
    env,
    expiresAt: accessKeyExpiresAt,
    keyAuthorization: input.keyAuthorization,
    limit: accessKeyLimit,
    periodSeconds: accessKeyPeriodSeconds,
    rootAddress: input.address,
    tokenAddress: payload.tokenAddress,
  })
  if (!Address.isEqual(verified.rootAddress, sender.account.address as Address.Address))
    throw new Error('Reconnect Tipbot and try again.')

  let accessKeyId: string | undefined
  if (payload.kind === 'reusable_access_key') {
    const now = new Date().toISOString()
    await db
      .deleteFrom('access_key')
      .where('account_id', '=', sender.account.id)
      .where('chain_id', '=', payload.chainId)
      .where('token_address', '=', Address.checksum(payload.tokenAddress))
      .execute()
    accessKeyId = Nanoid.generate()
    await db
      .insertInto('access_key')
      .values({
        account_id: sender.account.id,
        address: accessKey.address,
        authorization: verified.serialized,
        authorization_used_at: null,
        chain_id: payload.chainId,
        ciphertext: await AccessKey.encrypt(env, accessKey.privateKey),
        created_at: now,
        expires_at: accessKeyExpiresAt,
        id: accessKeyId,
        revoked_at: null,
        token_address: Address.checksum(payload.tokenAddress),
        updated_at: now,
      })
      .execute()
  }

  if (recipients.length > 1)
    return await submitTipBatch(env, db, {
      accessKeyId,
      accessKeyPrivateKey: accessKey.privateKey,
      amount: payload.amount,
      authorizationUsedAt: null,
      connectedRecipients,
      idempotencyKey: payload.idempotencyKey,
      keyAuthorization: verified.authorization,
      memo: payload.memo,
      provider: payload.provider,
      providerChannelId: payload.providerChannelId,
      providerId: payload.providerId,
      providerThreadId: payload.providerThreadId,
      recipients,
      sender,
      senderProviderUserId: payload.senderProviderUserId,
      skippedRecipients: payload.skippedRecipients,
      source: 'command',
      tokenAddress: Address.checksum(payload.tokenAddress),
      usergroupId: payload.groupId,
      usergroupLabel: payload.groupLabel,
      workspace,
    })

  const recipient = connectedRecipients[0]!
  return await submitTip(env, db, {
    accessKeyId,
    accessKeyPrivateKey: accessKey.privateKey,
    amount: payload.amount,
    authorizationUsedAt: null,
    idempotencyKey: payload.idempotencyKey,
    keyAuthorization: verified.authorization,
    memo: payload.memo,
    recipient,
    recipientProviderUserId: payload.recipientProviderUserId,
    sender,
    senderProviderUserId: payload.senderProviderUserId,
    tokenAddress: Address.checksum(payload.tokenAddress),
    workspace,
  })
}

async function getConnectedMember(db: DB.Type, workspaceId: string, providerUserId: string) {
  const member = await db
    .selectFrom('member')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .innerJoin('account', 'account.id', 'provider_identity.account_id')
    .select([
      'account.address as account_address',
      'account.created_at as account_created_at',
      'account.id as account_id',
      'account.updated_at as account_updated_at',
      'member.created_at as member_created_at',
      'member.id as member_id',
      'member.login',
      'member.name',
      'member.provider_identity_id',
      'member.provider_user_id',
      'member.updated_at as member_updated_at',
      'member.workspace_id',
    ])
    .where('member.workspace_id', '=', workspaceId)
    .where('member.provider_user_id', '=', providerUserId)
    .executeTakeFirst()
  return member ? connectedMemberFromRow(member) : null
}

async function getConnectedRecipient(
  db: DB.Type,
  workspace: Database.Selectable.workspace,
  provider: Database.Selectable.workspace['provider'],
  recipient: TipRecipientInput,
) {
  if (!recipient.recipientProviderWorkspaceId)
    return await getConnectedMember(db, workspace.id, recipient.recipientProviderUserId)

  const recipientWorkspace = await db
    .selectFrom('workspace')
    .select(['id'])
    .where('provider', '=', provider)
    .where('provider_id', '=', recipient.recipientProviderWorkspaceId)
    .executeTakeFirst()
  if (!recipientWorkspace) return null
  return await getConnectedMember(db, recipientWorkspace.id, recipient.recipientProviderUserId)
}

type ConnectedMember = NonNullable<Awaited<ReturnType<typeof getConnectedMember>>>

function connectedMemberFromRow(row: {
  account_address: string
  account_created_at: string
  account_id: string
  account_updated_at: string
  member_created_at: string
  member_id: string
  login: string | null
  name: string | null
  provider_identity_id: string | null
  provider_user_id: string
  member_updated_at: string
  workspace_id: string
}) {
  return {
    account: {
      address: row.account_address,
      created_at: row.account_created_at,
      id: row.account_id,
      updated_at: row.account_updated_at,
    },
    member: {
      created_at: row.member_created_at,
      id: row.member_id,
      login: row.login,
      name: row.name,
      provider_identity_id: row.provider_identity_id,
      provider_user_id: row.provider_user_id,
      updated_at: row.member_updated_at,
      workspace_id: row.workspace_id,
    },
  }
}

async function getExistingTipResult(
  env: Env,
  db: DB.Type,
  input: {
    idempotencyKey: string
    recipientProviderUserId: string
    senderProviderUserId: string
  },
  defaultTokenAddress: string,
): Promise<TipResult | null> {
  const existing = await db
    .selectFrom('tip')
    .leftJoin('tip_batch', 'tip_batch.id', 'tip.batch_id')
    .selectAll('tip')
    .select('tip_batch.transaction_hash as batch_transaction_hash')
    .where('tip.idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()
  if (existing?.confirmed_at && existing.batch_transaction_hash) {
    const tokenMetadata = await Tempo.getTokenMetadata(
      env,
      existing.chain_id,
      existing.token_address,
    )
    return {
      amount: formatAmount(existing.amount),
      chainId: existing.chain_id,
      feePayer: 'sponsor',
      isDefaultToken: Address.isEqual(
        Address.checksum(existing.token_address),
        defaultTokenAddress as Address.Address,
      ),
      memo: existing.memo,
      ok: true,
      recipientProviderUserId: input.recipientProviderUserId,
      senderProviderUserId: input.senderProviderUserId,
      status: 'duplicate',
      tokenCurrency: tokenMetadata.currency,
      tokenSymbol: tokenMetadata.symbol,
      transactionHash: existing.batch_transaction_hash,
    }
  }
  if (existing?.failed_at)
    return {
      chainId: existing.chain_id,
      code: existing.failure_reason ? getFailureCodeFromReason(existing.failure_reason) : 'failed',
      message: existing.failure_reason ?? 'Tip failed. Try again.',
      ok: false,
      transactionHash: existing.batch_transaction_hash ?? undefined,
    }
  if (existing)
    return {
      chainId: existing.chain_id,
      code: 'pending',
      message: 'Tip is still sending.',
      ok: false,
      transactionHash: existing.batch_transaction_hash ?? undefined,
    }
  return null
}

async function getExistingTipBatchResult(
  env: Env,
  db: DB.Type,
  input: {
    idempotencyKey: string
    senderProviderUserId: string
  },
  defaultTokenAddress: string,
): Promise<TipBatchResult | null> {
  const existing = await db
    .selectFrom('tip_batch')
    .selectAll()
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()
  if (existing?.status === 'confirmed' && existing.transaction_hash) {
    const workspace = await db
      .selectFrom('workspace')
      .select('chain_id')
      .where('id', '=', existing.workspace_id)
      .executeTakeFirstOrThrow()
    const tokenMetadata = await Tempo.getTokenMetadata(
      env,
      workspace.chain_id,
      existing.token_address,
    )
    const recipients = await db
      .selectFrom('tip')
      .innerJoin('member', 'member.id', 'tip.recipient_member_id')
      .select('member.provider_user_id')
      .where('tip.batch_id', '=', existing.id)
      .orderBy('tip.created_at', 'asc')
      .execute()
    return {
      amount: formatAmount(existing.amount_each),
      chainId: workspace.chain_id,
      feePayer: 'sponsor',
      isDefaultToken: Address.isEqual(
        Address.checksum(existing.token_address),
        defaultTokenAddress as Address.Address,
      ),
      memo: existing.memo,
      ok: true,
      recipients: recipients.map((recipient) => ({
        recipientProviderUserId: recipient.provider_user_id,
      })),
      senderProviderUserId: input.senderProviderUserId,
      status: 'duplicate',
      tokenCurrency: tokenMetadata.currency,
      tokenSymbol: tokenMetadata.symbol,
      transactionHash: existing.transaction_hash,
    }
  }
  if (existing?.status === 'failed')
    return {
      code: existing.failure_reason ? getFailureCodeFromReason(existing.failure_reason) : 'failed',
      message: existing.failure_reason ?? 'Tip failed. Try again.',
      ok: false,
      transactionHash: existing.transaction_hash ?? undefined,
    }
  if (existing)
    return {
      code: 'pending',
      message: 'Tip is still sending.',
      ok: false,
      transactionHash: existing.transaction_hash ?? undefined,
    }
  return null
}

async function createConfirmationRequired(
  env: Env,
  input: {
    amount?: number
    idempotencyKey: string
    memo: string | null
    provider: 'slack'
    providerChannelId: string
    providerId: string
    providerThreadId?: string
    recipientProviderLabel?: string
    recipientProviderUserId: string
    recipientProviderWorkspaceId?: string
    recipients?: TipRecipientInput[]
    senderProviderUserId: string
    skippedRecipients?: TipSkippedRecipient[]
    usergroupId?: string
    usergroupLabel?: string
  },
  workspace: Database.Selectable.workspace,
  amount: number,
  tokenAddress: string,
  options: { accessKeyLimit?: bigint; kind?: Confirmation.Payload['kind'] } = {},
): Promise<TipResult> {
  const nonce = Nanoid.generate()
  const expiresAt = new Date(Date.now() + AccountLink.confirmationLinkTtlMs).toISOString()
  const isReusable = options.kind
    ? options.kind === 'reusable_access_key'
    : amount <= AccountLink.reusableAccessKeyLimit
  const token = await Confirmation.encrypt(env, {
    ...(isReusable
      ? {
          accessKeyExpiresAt: new Date(
            Date.now() + AccountLink.reusableAccessKeyTtlMs,
          ).toISOString(),
        }
      : {}),
    ...(input.recipients ? { recipients: input.recipients } : {}),
    ...(input.skippedRecipients?.length ? { skippedRecipients: input.skippedRecipients } : {}),
    ...(input.usergroupId ? { groupId: input.usergroupId } : {}),
    ...(input.usergroupLabel ? { groupLabel: input.usergroupLabel } : {}),
    amount,
    chainId: workspace.chain_id,
    expiresAt,
    idempotencyKey: input.idempotencyKey,
    kind: isReusable ? 'reusable_access_key' : 'onetime_payment',
    memo: input.memo,
    nonce,
    provider: input.provider,
    providerChannelId: input.providerChannelId,
    providerId: input.providerId,
    providerThreadId: input.providerThreadId,
    recipientProviderLabel: input.recipientProviderLabel,
    recipientProviderUserId: input.recipientProviderUserId,
    recipientProviderWorkspaceId: input.recipientProviderWorkspaceId,
    senderProviderUserId: input.senderProviderUserId,
    tokenAddress,
    ...(options.accessKeyLimit ? { accessKeyLimit: options.accessKeyLimit.toString() } : {}),
    workspaceId: workspace.id,
  } as Confirmation.Payload & { accessKeyLimit?: string })
  return {
    chainId: workspace.chain_id,
    code: 'confirmation_required',
    confirmUrl: `https://${env.HOST}/confirm/${token}`,
    ok: false,
  }
}

async function submitTipBatch(
  env: Env,
  db: DB.Type,
  input: {
    accessKeyId?: string
    accessKeyPrivateKey: `0x${string}`
    amount: number
    authorizationUsedAt: string | null
    connectedRecipients: ConnectedMember[]
    idempotencyKey: string
    keyAuthorization: KeyAuthorization.Signed
    memo: string | null
    provider: 'slack'
    providerChannelId: string
    providerId: string
    providerThreadId?: string
    recipients: TipRecipientInput[]
    sender: ConnectedMember
    senderProviderUserId: string
    skippedRecipients?: TipSkippedRecipient[]
    source: 'command' | 'mention' | 'reaction'
    tokenAddress: string
    usergroupId?: string
    usergroupLabel?: string
    workspace: Database.Selectable.workspace
  },
): Promise<TipBatchResult> {
  const existing = await getExistingTipBatchResult(env, db, input, input.tokenAddress)
  if (existing) return existing

  const batchId = Nanoid.generate()
  const now = new Date().toISOString()
  const tipRows = await Promise.all(
    input.connectedRecipients.map(async (recipient, index) => {
      const id = Nanoid.generate()
      const idempotencyKey =
        input.connectedRecipients.length === 1
          ? input.idempotencyKey
          : `${input.idempotencyKey}:${input.recipients[index]!.recipientProviderUserId}`
      return {
        access_key_id: input.accessKeyId ?? null,
        amount: input.amount,
        batch_id: batchId,
        chain_id: input.workspace.chain_id,
        confirmed_at: null,
        created_at: now,
        failed_at: null,
        failure_reason: null,
        id,
        idempotency_key: idempotencyKey,
        memo: input.memo,
        recipient_id: recipient.account.id,
        recipient_member_id: recipient.member.id,
        sender_id: input.sender.account.id,
        sender_member_id: input.sender.member.id,
        sponsorship_memo: await createSponsorshipMemo(env, {
          amount: input.amount,
          chainId: input.workspace.chain_id,
          id,
          idempotencyKey,
          recipient: recipient.account.address,
          sender: input.sender.account.address,
          token: input.tokenAddress,
        }),
        token_address: input.tokenAddress,
        transfer_log_index: null,
        updated_at: now,
        workspace_id: input.workspace.id,
      } satisfies Database.Insertable.tip
    }),
  )
  try {
    await db
      .insertInto('tip_batch')
      .values({
        amount_each: input.amount,
        created_at: now,
        failure_reason: null,
        id: batchId,
        idempotency_key: input.idempotencyKey,
        memo: input.memo,
        provider: input.provider,
        provider_channel_id: input.providerChannelId,
        provider_id: input.providerId,
        provider_thread_id: input.providerThreadId ?? null,
        recipient_count: input.connectedRecipients.length,
        sender_member_id: input.sender.member.id,
        source: input.source,
        status: 'pending',
        token_address: input.tokenAddress,
        total_amount: input.amount * input.connectedRecipients.length,
        updated_at: now,
        workspace_id: input.workspace.id,
      })
      .execute()
    for (let index = 0; index < tipRows.length; index += 4) {
      // D1 has a low SQL variable limit; each tip row has many columns, so keep multi-row inserts
      // small even when a group tip has up to 100 paid recipients.
      await db
        .insertInto('tip')
        .values(tipRows.slice(index, index + 4))
        .execute()
    }
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const existing = await getExistingTipBatchResult(env, db, input, input.tokenAddress)
    if (existing) return existing
    throw error
  }

  try {
    await db
      .updateTable('tip_batch')
      .set({ status: 'submitting', updated_at: new Date().toISOString() })
      .where('id', '=', batchId)
      .execute()
    const feePayerPrivateKey = Tempo.getFeePayerPrivateKey(env, input.workspace.chain_id)
    const account = TempoAccount.fromSecp256k1(input.accessKeyPrivateKey, {
      access: input.sender.account.address as `0x${string}`,
    })
    const client = createClient({
      chain: Tempo.getChain(input.workspace.chain_id),
      transport: http(Tempo.getRpcUrl(env, input.workspace.chain_id)),
    })
    const totalAmount = input.amount * input.connectedRecipients.length
    const balance = await Actions.token.getBalance(client, {
      account: input.sender.account.address as Address.Address,
      token: input.tokenAddress as Address.Address,
    })
    if (balance < BigInt(totalAmount)) throw new InsufficientFundsError()

    const calls = input.connectedRecipients.map((recipient) =>
      Actions.token.transfer.call({
        amount: BigInt(input.amount),
        ...(input.memo ? { memo: encodeTransferMemo(input.memo) } : {}),
        to: recipient.account.address as Address.Address,
        token: input.tokenAddress as Address.Address,
      }),
    )
    const [receipt, feePayer] = await (async () => {
      const parameters = {
        account,
        calls,
        chain: Tempo.getChain(input.workspace.chain_id),
        keyAuthorization: input.authorizationUsedAt ? undefined : input.keyAuthorization,
      }
      if (!feePayerPrivateKey)
        return [
          await sendTransactionSync(client, {
            ...parameters,
            feeToken: input.tokenAddress as Address.Address,
          } as never),
          'sender' as const,
        ] as const

      try {
        return [
          await sendTransactionSync(client, {
            ...parameters,
            feePayer: privateKeyToAccount(feePayerPrivateKey),
          } as never),
          'sponsor' as const,
        ] as const
      } catch (error) {
        if (!isInsufficientFundsError(error)) throw error
        return [
          await sendTransactionSync(client, {
            ...parameters,
            feeToken: input.tokenAddress as Address.Address,
          } as never),
          'sender' as const,
        ] as const
      }
    })()
    if (!receipt.transactionHash) throw new Error('Tempo transaction did not return a hash.')
    await db
      .updateTable('tip_batch')
      .set({
        status: 'confirmed',
        transaction_hash: receipt.transactionHash,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', batchId)
      .execute()
    await db
      .updateTable('tip')
      .set({
        confirmed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where('batch_id', '=', batchId)
      .execute()
    if (input.accessKeyId && !input.authorizationUsedAt)
      await db
        .updateTable('access_key')
        .set({
          authorization_used_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', input.accessKeyId)
        .execute()
    const tokenMetadata = await Tempo.getTokenMetadata(
      env,
      input.workspace.chain_id,
      input.tokenAddress,
    )
    return {
      amount: formatAmount(input.amount),
      chainId: input.workspace.chain_id,
      feePayer,
      isDefaultToken: Address.isEqual(
        Address.checksum(input.tokenAddress),
        Address.checksum(input.workspace.default_token_address ?? Tempo.addressLookup.pathUsd),
      ),
      memo: input.memo,
      ok: true,
      recipients: input.recipients,
      senderProviderUserId: input.senderProviderUserId,
      skippedRecipients: input.skippedRecipients,
      status: 'sent',
      tokenCurrency: tokenMetadata.currency,
      tokenSymbol: tokenMetadata.symbol,
      transactionHash: receipt.transactionHash,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tip submission failed.'
    const code = isInsufficientFundsError(error) ? 'insufficient_funds' : 'failed'
    await db
      .updateTable('tip_batch')
      .set({ failure_reason: message, status: 'failed', updated_at: new Date().toISOString() })
      .where('id', '=', batchId)
      .execute()
    await db
      .updateTable('tip')
      .set({
        failed_at: new Date().toISOString(),
        failure_reason: message,
        updated_at: new Date().toISOString(),
      })
      .where('batch_id', '=', batchId)
      .execute()
    return { chainId: input.workspace.chain_id, code, message, ok: false }
  }
}

async function submitTip(
  env: Env,
  db: DB.Type,
  input: {
    accessKeyId?: string
    accessKeyPrivateKey: `0x${string}`
    amount: number
    authorizationUsedAt: string | null
    idempotencyKey: string
    keyAuthorization: KeyAuthorization.Signed
    memo: string | null
    recipient: ConnectedMember
    recipientProviderUserId: string
    sender: ConnectedMember
    senderProviderUserId: string
    tokenAddress: string
    workspace: Database.Selectable.workspace
  },
): Promise<TipResult> {
  const result = await submitTipBatch(env, db, {
    accessKeyId: input.accessKeyId,
    accessKeyPrivateKey: input.accessKeyPrivateKey,
    amount: input.amount,
    authorizationUsedAt: input.authorizationUsedAt,
    connectedRecipients: [input.recipient],
    idempotencyKey: input.idempotencyKey,
    keyAuthorization: input.keyAuthorization,
    memo: input.memo,
    provider: input.workspace.provider,
    providerChannelId: '',
    providerId: input.workspace.provider_id,
    recipients: [
      {
        recipientProviderUserId: input.recipientProviderUserId,
      },
    ],
    sender: input.sender,
    senderProviderUserId: input.senderProviderUserId,
    source: 'command',
    tokenAddress: input.tokenAddress,
    workspace: input.workspace,
  })
  if (!result.ok) return result
  return {
    amount: result.amount,
    chainId: result.chainId,
    feePayer: result.feePayer,
    isDefaultToken: result.isDefaultToken,
    memo: result.memo,
    ok: true,
    recipientProviderUserId: input.recipientProviderUserId,
    senderProviderUserId: result.senderProviderUserId,
    status: result.status,
    tokenCurrency: result.tokenCurrency,
    tokenSymbol: result.tokenSymbol,
    transactionHash: result.transactionHash,
  }
}

async function submitSignedTipBatch(
  env: Env,
  db: DB.Type,
  input: {
    address: string
    connectedRecipients: ConnectedMember[]
    idempotencyKey: string
    memo: string | null
    payload: Confirmation.Payload
    recipients: TipRecipientInput[]
    sender: ConnectedMember
    signedTransaction: `0x${string}`
    tokenAddress: string
    workspace: Database.Selectable.workspace
  },
): Promise<TipBatchResult> {
  const existing = await getExistingTipBatchResult(
    env,
    db,
    {
      idempotencyKey: input.idempotencyKey,
      senderProviderUserId: input.payload.senderProviderUserId,
    },
    Address.checksum(input.workspace.default_token_address ?? Tempo.addressLookup.pathUsd),
  )
  if (existing) return existing

  const firstRecipient = input.connectedRecipients[0]
  if (!firstRecipient) throw new Error('Tempo Wallet did not approve this payment.')
  validateSignedTransaction({
    address: input.address,
    connectedRecipients: input.connectedRecipients,
    payload: input.payload,
    recipient: firstRecipient,
    sender: input.sender,
    signedTransaction: input.signedTransaction,
    tokenAddress: input.tokenAddress,
  })

  const batchId = Nanoid.generate()
  const now = new Date().toISOString()
  const tipRows = await Promise.all(
    input.connectedRecipients.map(async (recipient, index) => {
      const id = Nanoid.generate()
      const idempotencyKey = `${input.idempotencyKey}:${input.recipients[index]!.recipientProviderUserId}`
      return {
        access_key_id: null,
        amount: input.payload.amount,
        batch_id: batchId,
        chain_id: input.workspace.chain_id,
        confirmed_at: null,
        created_at: now,
        failed_at: null,
        failure_reason: null,
        id,
        idempotency_key: idempotencyKey,
        memo: input.memo,
        recipient_id: recipient.account.id,
        recipient_member_id: recipient.member.id,
        sender_id: input.sender.account.id,
        sender_member_id: input.sender.member.id,
        sponsorship_memo: await createSponsorshipMemo(env, {
          amount: input.payload.amount,
          chainId: input.workspace.chain_id,
          id,
          idempotencyKey,
          recipient: recipient.account.address,
          sender: input.sender.account.address,
          token: input.tokenAddress,
        }),
        token_address: input.tokenAddress,
        transfer_log_index: null,
        updated_at: now,
        workspace_id: input.workspace.id,
      } satisfies Database.Insertable.tip
    }),
  )
  await db
    .insertInto('tip_batch')
    .values({
      amount_each: input.payload.amount,
      created_at: now,
      failure_reason: null,
      id: batchId,
      idempotency_key: input.idempotencyKey,
      memo: input.memo,
      provider: input.payload.provider,
      provider_channel_id: input.payload.providerChannelId,
      provider_id: input.payload.providerId,
      provider_thread_id: input.payload.providerThreadId ?? null,
      recipient_count: input.connectedRecipients.length,
      sender_member_id: input.sender.member.id,
      source: 'command',
      status: 'pending',
      token_address: input.tokenAddress,
      total_amount: input.payload.amount * input.connectedRecipients.length,
      updated_at: now,
      workspace_id: input.workspace.id,
    })
    .execute()
  await db.insertInto('tip').values(tipRows).execute()

  try {
    await db
      .updateTable('tip_batch')
      .set({ status: 'submitting', updated_at: new Date().toISOString() })
      .where('id', '=', batchId)
      .execute()
    const client = createClient({
      chain: Tempo.getChain(input.workspace.chain_id),
      transport: http(Tempo.getRpcUrl(env, input.workspace.chain_id)),
    })
    const balance = await Actions.token.getBalance(client, {
      account: input.sender.account.address as Address.Address,
      token: input.tokenAddress as Address.Address,
    })
    if (balance < BigInt(input.payload.amount * input.connectedRecipients.length))
      throw new InsufficientFundsError()

    const receipt = (await client.request({
      method: 'eth_sendRawTransactionSync' as never,
      params: [input.signedTransaction] as never,
    })) as { status: `0x${string}`; transactionHash?: `0x${string}` }
    if (receipt.status !== '0x1' || !receipt.transactionHash)
      throw new Error('Tempo transaction failed.')
    await db
      .updateTable('tip_batch')
      .set({
        status: 'confirmed',
        transaction_hash: receipt.transactionHash,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', batchId)
      .execute()
    await db
      .updateTable('tip')
      .set({ confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .where('batch_id', '=', batchId)
      .execute()

    const tokenMetadata = await Tempo.getTokenMetadata(
      env,
      input.workspace.chain_id,
      input.tokenAddress,
    )
    return {
      amount: formatAmount(input.payload.amount),
      chainId: input.workspace.chain_id,
      feePayer: 'sender',
      isDefaultToken: Address.isEqual(
        Address.checksum(input.tokenAddress),
        Address.checksum(input.workspace.default_token_address ?? Tempo.addressLookup.pathUsd),
      ),
      memo: input.memo,
      ok: true,
      recipients: input.recipients,
      senderProviderUserId: input.payload.senderProviderUserId,
      skippedRecipients: input.payload.skippedRecipients,
      status: 'sent',
      tokenCurrency: tokenMetadata.currency,
      tokenSymbol: tokenMetadata.symbol,
      transactionHash: receipt.transactionHash,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tip submission failed.'
    const code = isInsufficientFundsError(error) ? 'insufficient_funds' : 'failed'
    await db
      .updateTable('tip_batch')
      .set({ failure_reason: message, status: 'failed', updated_at: new Date().toISOString() })
      .where('id', '=', batchId)
      .execute()
    await db
      .updateTable('tip')
      .set({
        failed_at: new Date().toISOString(),
        failure_reason: message,
        updated_at: new Date().toISOString(),
      })
      .where('batch_id', '=', batchId)
      .execute()
    return { chainId: input.workspace.chain_id, code, message, ok: false }
  }
}

async function submitSignedTip(
  env: Env,
  db: DB.Type,
  input: {
    address: string
    idempotencyKey: string
    memo: string | null
    payload: Confirmation.Payload
    recipient: ConnectedMember
    sender: ConnectedMember
    signedTransaction: `0x${string}`
    tokenAddress: string
    workspace: Database.Selectable.workspace
  },
): Promise<TipResult> {
  const existing = await getExistingTipResult(
    env,
    db,
    {
      idempotencyKey: input.idempotencyKey,
      recipientProviderUserId: input.payload.recipientProviderUserId,
      senderProviderUserId: input.payload.senderProviderUserId,
    },
    input.tokenAddress,
  )
  if (existing) return existing

  validateSignedTransaction(input)
  const id = Nanoid.generate()
  const batchId = Nanoid.generate()
  const sponsorshipMemo = await createSponsorshipMemo(env, {
    amount: input.payload.amount,
    chainId: input.workspace.chain_id,
    id,
    idempotencyKey: input.idempotencyKey,
    recipient: input.recipient.account.address,
    sender: input.sender.account.address,
    token: input.tokenAddress,
  })
  const now = new Date().toISOString()
  await db
    .insertInto('tip_batch')
    .values({
      amount_each: input.payload.amount,
      created_at: now,
      failure_reason: null,
      id: batchId,
      idempotency_key: input.idempotencyKey,
      memo: input.memo,
      provider: input.payload.provider,
      provider_channel_id: input.payload.providerChannelId,
      provider_id: input.payload.providerId,
      provider_thread_id: input.payload.providerThreadId ?? null,
      recipient_count: 1,
      sender_member_id: input.sender.member.id,
      source: 'command',
      status: 'pending',
      token_address: input.tokenAddress,
      total_amount: input.payload.amount,
      updated_at: now,
      workspace_id: input.workspace.id,
    })
    .execute()
  await db
    .insertInto('tip')
    .values({
      access_key_id: null,
      amount: input.payload.amount,
      batch_id: batchId,
      chain_id: input.workspace.chain_id,
      confirmed_at: null,
      created_at: now,
      failed_at: null,
      failure_reason: null,
      id,
      idempotency_key: input.idempotencyKey,
      memo: input.memo,
      recipient_id: input.recipient.account.id,
      recipient_member_id: input.recipient.member.id,
      sender_id: input.sender.account.id,
      sender_member_id: input.sender.member.id,
      sponsorship_memo: sponsorshipMemo,
      token_address: input.tokenAddress,
      transfer_log_index: null,
      updated_at: now,
      workspace_id: input.workspace.id,
    })
    .execute()

  try {
    await db
      .updateTable('tip_batch')
      .set({ status: 'submitting', updated_at: new Date().toISOString() })
      .where('id', '=', batchId)
      .execute()
    const client = createClient({
      chain: Tempo.getChain(input.workspace.chain_id),
      transport: http(Tempo.getRpcUrl(env, input.workspace.chain_id)),
    })
    const balance = await Actions.token.getBalance(client, {
      account: input.sender.account.address as Address.Address,
      token: input.tokenAddress as Address.Address,
    })
    if (balance < BigInt(input.payload.amount)) throw new InsufficientFundsError()

    const receipt = (await client.request({
      method: 'eth_sendRawTransactionSync' as never,
      params: [input.signedTransaction] as never,
    })) as { status: `0x${string}`; transactionHash?: `0x${string}` }
    if (receipt.status !== '0x1' || !receipt.transactionHash)
      throw new Error('Tempo transaction failed.')
    await db
      .updateTable('tip_batch')
      .set({
        status: 'confirmed',
        transaction_hash: receipt.transactionHash,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', batchId)
      .execute()
    await db
      .updateTable('tip')
      .set({
        confirmed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .execute()

    const tokenMetadata = await Tempo.getTokenMetadata(
      env,
      input.workspace.chain_id,
      input.tokenAddress,
    )
    return {
      amount: formatAmount(input.payload.amount),
      chainId: input.workspace.chain_id,
      feePayer: 'sender',
      isDefaultToken: Address.isEqual(
        Address.checksum(input.tokenAddress),
        Address.checksum(input.workspace.default_token_address ?? Tempo.addressLookup.pathUsd),
      ),
      memo: input.memo,
      ok: true,
      recipientProviderUserId: input.payload.recipientProviderUserId,
      senderProviderUserId: input.payload.senderProviderUserId,
      status: 'sent',
      tokenCurrency: tokenMetadata.currency,
      tokenSymbol: tokenMetadata.symbol,
      transactionHash: receipt.transactionHash,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tip submission failed.'
    const code = isInsufficientFundsError(error) ? 'insufficient_funds' : 'failed'
    await db
      .updateTable('tip_batch')
      .set({ failure_reason: message, status: 'failed', updated_at: new Date().toISOString() })
      .where('id', '=', batchId)
      .execute()
    await db
      .updateTable('tip')
      .set({
        failed_at: new Date().toISOString(),
        failure_reason: message,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .execute()
    return { chainId: input.workspace.chain_id, code, message, ok: false }
  }
}

function createSignedTransactionRequest(
  payload: Confirmation.Payload,
  sender: ConnectedMember,
  recipients: ConnectedMember[],
) {
  const calls = recipients.map((recipient) => {
    const call = Actions.token.transfer.call({
      amount: BigInt(payload.amount),
      ...(payload.memo ? { memo: encodeTransferMemo(payload.memo) } : {}),
      to: recipient.account.address as Address.Address,
      token: Address.checksum(payload.tokenAddress),
    })
    return { data: call.data, to: call.to }
  })
  return {
    calls,
    chainId: payload.chainId,
    feeToken: Address.checksum(payload.tokenAddress),
    from: sender.account.address,
  }
}

function validateSignedTransaction(input: {
  address: string
  connectedRecipients?: ConnectedMember[]
  payload: Confirmation.Payload
  recipient: ConnectedMember
  sender: ConnectedMember
  signedTransaction: `0x${string}`
  tokenAddress: string
}) {
  const transaction = TxEnvelopeTempo.deserialize(input.signedTransaction as `0x76${string}`)
  const expected = createSignedTransactionRequest(
    input.payload,
    input.sender,
    input.connectedRecipients ?? [input.recipient],
  )
  if (
    !Address.isEqual(
      input.address as Address.Address,
      input.sender.account.address as Address.Address,
    )
  )
    throw new Error('Reconnect Tipbot and try again.')
  if (!transaction.from) throw new Error('Payment approval is invalid.')
  if (!Address.isEqual(transaction.from, input.sender.account.address as Address.Address))
    throw new Error('Reconnect Tipbot and try again.')
  if (transaction.chainId !== input.payload.chainId) throw new Error('Payment approval is invalid.')
  if (transaction.calls.length !== expected.calls.length)
    throw new Error('Payment approval is invalid.')
  for (const [index, expectedCall] of expected.calls.entries()) {
    const call = transaction.calls[index]
    if (!call || !call.to || !Address.isEqual(call.to, expectedCall.to as Address.Address))
      throw new Error('Payment approval is invalid.')
    if ((call.data ?? '0x').toLowerCase() !== expectedCall.data.toLowerCase())
      throw new Error('Payment approval is invalid.')
    if (call.value && call.value !== 0n) throw new Error('Payment approval is invalid.')
  }
  if (transaction.keyAuthorization) throw new Error('Payment approval is invalid.')
  if (transaction.feePayerSignature) throw new Error('Payment approval is invalid.')
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

function supportsTip(
  authorization: KeyAuthorization.KeyAuthorization,
  input: { amount: number; memo: string | null; tokenAddress: string },
) {
  if (
    authorization.scopes &&
    !authorization.scopes.some((scope) => {
      if (!Address.isEqual(scope.address, input.tokenAddress as Address.Address)) return false
      if (!scope.selector) return true
      return scope.selector.toLowerCase() === AbiFunction.getSelector('transfer(address,uint256)')
    })
  )
    return false
  if (input.memo && !supportsTransferMemo(authorization, input.tokenAddress)) return false
  if (!authorization.limits) return true
  return authorization.limits.some(
    (limit) =>
      Address.isEqual(limit.token as Address.Address, input.tokenAddress as Address.Address) &&
      limit.limit >= BigInt(input.amount),
  )
}

async function hasTrackedAccessKeyLimitRemaining(
  db: DB.Type,
  input: {
    accessKeyId: string
    accountId: string
    amount: number
    authorization: KeyAuthorization.KeyAuthorization
    authorizationUsedAt: string | null
    chainId: number
    tokenAddress: string
  },
) {
  const limits = input.authorization.limits?.filter((limit) =>
    Address.isEqual(limit.token as Address.Address, input.tokenAddress as Address.Address),
  )
  if (!limits?.length) return true

  for (const limit of limits) {
    if (limit.limit < BigInt(input.amount)) continue

    const periodStart = new Date(Date.now() - Number(limit.period) * 1000).toISOString()
    const usedSince =
      input.authorizationUsedAt && input.authorizationUsedAt > periodStart
        ? input.authorizationUsedAt
        : periodStart
    const tips = await db
      .selectFrom('tip')
      .select('amount')
      .where('access_key_id', '=', input.accessKeyId)
      .where('sender_id', '=', input.accountId)
      .where('chain_id', '=', input.chainId)
      .where('token_address', '=', Address.checksum(input.tokenAddress))
      .where('confirmed_at', 'is not', null)
      .where('confirmed_at', '>=', usedSince)
      .execute()
    const used = tips.reduce((total, tip) => total + BigInt(tip.amount), 0n)
    if (used + BigInt(input.amount) <= limit.limit) return true
  }
  return false
}

function isInsufficientFundsError(error: unknown) {
  if (error instanceof InsufficientFundsError) return true
  if (error instanceof BaseError)
    return (
      Boolean(error.walk((cause) => cause instanceof InsufficientFundsError)) ||
      getNodeError(error, {}) instanceof InsufficientFundsError
    )
  if (error instanceof Error)
    return (
      getNodeError(new BaseError('Transaction failed.', { details: error.message }), {}) instanceof
        InsufficientFundsError || isInsufficientFundsMessage(error.message)
    )
  return false
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /unique constraint|constraint failed/i.test(error.message)
}

function isInsufficientFundsMessage(message: string) {
  return /insufficient (?:funds|balance)|exceeds .* balance/i.test(message)
}

function getFailureCodeFromReason(reason: string): 'failed' | 'insufficient_funds' {
  if (isInsufficientFundsMessage(reason)) return 'insufficient_funds'
  return 'failed'
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
