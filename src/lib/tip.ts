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

export { defaultReactionTipConfigs } from '#/lib/constants.ts'

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
      amount: string
      chainId: number
      isDefaultToken: boolean
      memo: string | null
      ok: true
      pendingTipId: string
      recipientProviderUserId: string
      senderProviderUserId: string
      source: 'command' | 'mention' | 'reaction'
      status: 'queued'
      tokenCurrency: string
      tokenSymbol: string
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
      queuedRecipients?: Array<{
        pendingTipId: string
        recipientProviderLabel?: string
        recipientProviderUserId: string
      }>
    }
  | {
      amount: string
      chainId: number
      isDefaultToken: boolean
      memo: string | null
      ok: true
      queuedRecipients: Array<{
        pendingTipId: string
        recipientProviderLabel?: string
        recipientProviderUserId: string
      }>
      senderProviderUserId: string
      skippedRecipients?: TipSkippedRecipient[]
      status: 'queued'
      tokenCurrency: string
      tokenSymbol: string
    }
  | Extract<TipResult, { ok: false }>

export type PendingTipClaimResult =
  | {
      amount: string
      chainId: number
      isDefaultToken: boolean
      memo: string | null
      ok: true
      pendingTip: Database.Selectable.pending_tip
      recipientProviderUserId: string
      senderProviderUserId: string
      status: 'sent'
      tokenCurrency: string
      tokenSymbol: string
      transactionHash: string
    }
  | {
      code: 'expired' | 'failed'
      message: string
      ok: false
      pendingTip: Database.Selectable.pending_tip
      status: 'expired' | 'failed'
    }

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
    settingsProviderId?: string
    source?: 'command' | 'mention' | 'reaction'
    tokenAddress?: string
    workspaceProviderId?: string
  },
): Promise<TipResult> {
  const db = DB.create(env.DB)
  const workspace =
    (await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', input.provider)
      .where('provider_id', '=', input.workspaceProviderId ?? input.providerId)
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
          installed_at: now,
          provider: input.provider,
          provider_id: input.workspaceProviderId ?? input.providerId,
          uninstalled_at: null,
          updated_at: now,
        })
        .execute()
      return await db
        .selectFrom('workspace')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    })())
  const settingsWorkspace = input.settingsProviderId
    ? await db
        .selectFrom('workspace')
        .selectAll()
        .where('provider', '=', input.provider)
        .where('provider_id', '=', input.settingsProviderId)
        .executeTakeFirstOrThrow()
    : workspace
  const executionWorkspace = {
    ...workspace,
    chain_id: settingsWorkspace.chain_id,
    default_amount: settingsWorkspace.default_amount,
    default_token_address: settingsWorkspace.default_token_address,
  }
  if (
    input.senderProviderUserId === input.recipientProviderUserId &&
    (!input.recipientProviderWorkspaceId ||
      input.recipientProviderWorkspaceId === (input.workspaceProviderId ?? input.providerId))
  )
    return { code: 'self_tip', ok: false }

  const amount = input.amount ?? executionWorkspace.default_amount
  const tokenAddress = Address.checksum(
    input.tokenAddress ?? executionWorkspace.default_token_address ?? Tempo.addressLookup.pathUsd,
  )
  if (!Tempo.isAllowedToken(executionWorkspace.chain_id, tokenAddress))
    return {
      code: 'failed',
      message: 'Workspace token is not supported on this network.',
      ok: false,
    }

  const existing = await getExistingTipResult(env, db, input, tokenAddress)
  if (existing) return existing
  const existingPending = await getExistingPendingTipResult(env, db, input, tokenAddress)
  if (existingPending) return existingPending

  const sender = await getConnectedMember(db, workspace.id, input.senderProviderUserId)
  if (!sender) return { code: 'sender_unconnected', ok: false }
  const recipient = await getConnectedRecipient(db, workspace, input.provider, {
    recipientProviderUserId: input.recipientProviderUserId,
    recipientProviderWorkspaceId: input.recipientProviderWorkspaceId,
  })
  if (recipient?.account.id === sender.account.id) return { code: 'self_tip', ok: false }
  const { accessKey, trackedAccessKeyLimitExceeded } = await (async () => {
    // Pick the newest reusable access key that can cover this tip.
    const accessKeys = await db
      .selectFrom('access_key')
      .selectAll()
      .where('account_id', '=', sender.account.id)
      .where('chain_id', '=', executionWorkspace.chain_id)
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
          chainId: executionWorkspace.chain_id,
          tokenAddress,
        }))
      ) {
        trackedAccessKeyLimitExceeded = true
        continue
      }
      accessKey = row
      break
    }
    return { accessKey, trackedAccessKeyLimitExceeded }
  })()
  if (!accessKey)
    return await createConfirmationRequired(env, input, executionWorkspace, amount, tokenAddress, {
      kind: trackedAccessKeyLimitExceeded ? 'onetime_payment' : undefined,
    })

  if (!recipient)
    return await createPendingTip(env, db, {
      accessKey,
      amount,
      idempotencyKey: input.idempotencyKey,
      memo: input.memo,
      provider: input.provider,
      providerChannelId: input.providerChannelId,
      providerId: input.providerId,
      providerThreadId: input.providerThreadId,
      recipientProviderUserId: input.recipientProviderUserId,
      recipientProviderWorkspaceId: input.recipientProviderWorkspaceId,
      sender,
      senderProviderUserId: input.senderProviderUserId,
      source: input.source ?? 'command',
      tokenAddress,
      workspace: executionWorkspace,
    })

  return await submitTip(env, db, {
    accessKeyId: accessKey.id,
    accessKeyPrivateKey: await AccessKey.decrypt(env, accessKey.ciphertext),
    amount,
    authorizationUsedAt: accessKey.authorization_used_at,
    idempotencyKey: input.idempotencyKey,
    keyAuthorization: KeyAuthorization.fromRpc(JSON.parse(accessKey.authorization) as never),
    memo: input.memo,
    providerChannelId: input.providerChannelId,
    providerId: input.providerId,
    providerThreadId: input.providerThreadId,
    recipient,
    recipientProviderUserId: input.recipientProviderUserId,
    sender,
    senderProviderUserId: input.senderProviderUserId,
    source: input.source ?? 'command',
    tokenAddress,
    workspace: executionWorkspace,
  })
}

export async function handleTipBatchRequest(
  env: Env,
  input: {
    amount?: number
    chainId?: number
    idempotencyKey: string
    memo: string | null
    provider: Database.Selectable.workspace['provider']
    providerChannelId: string
    providerId: string
    providerThreadId?: string
    pendingRecipients?: TipRecipientInput[]
    recipients: TipRecipientInput[]
    senderProviderUserId: string
    settingsProviderId?: string
    skippedRecipients?: TipSkippedRecipient[]
    source: 'command' | 'mention' | 'reaction'
    tokenAddress?: string
    usergroupId?: string
    usergroupLabel?: string
    workspaceProviderId?: string
  },
): Promise<TipBatchResult> {
  const db = DB.create(env.DB)
  const workspace =
    (await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', input.provider)
      .where('provider_id', '=', input.workspaceProviderId ?? input.providerId)
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
          installed_at: now,
          provider: input.provider,
          provider_id: input.workspaceProviderId ?? input.providerId,
          uninstalled_at: null,
          updated_at: now,
        })
        .execute()
      return await db
        .selectFrom('workspace')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    })())
  const settingsWorkspace = input.settingsProviderId
    ? await db
        .selectFrom('workspace')
        .selectAll()
        .where('provider', '=', input.provider)
        .where('provider_id', '=', input.settingsProviderId)
        .executeTakeFirstOrThrow()
    : workspace
  const executionWorkspace = {
    ...workspace,
    chain_id: input.chainId ?? settingsWorkspace.chain_id,
    default_amount: settingsWorkspace.default_amount,
    default_token_address: settingsWorkspace.default_token_address,
  }
  const recipientCount = input.recipients.length + (input.pendingRecipients?.length ?? 0)
  const recipients = input.recipients.slice(0, maxTipBatchRecipients)
  const pendingRecipients = (input.pendingRecipients ?? []).slice(0, maxTipBatchRecipients)
  const allRecipients = [...recipients, ...pendingRecipients]
  if (recipientCount === 0)
    return { code: 'failed', message: 'Payment must have at least one recipient.', ok: false }
  if (recipientCount > maxTipBatchRecipients)
    return {
      code: 'failed',
      message: `Multi-tip supports up to ${maxTipBatchRecipients} recipients.`,
      ok: false,
    }
  if (
    allRecipients.some(
      (recipient) =>
        recipient.recipientProviderUserId === input.senderProviderUserId &&
        (!recipient.recipientProviderWorkspaceId ||
          recipient.recipientProviderWorkspaceId ===
            (input.workspaceProviderId ?? input.providerId)),
    )
  )
    return { code: 'self_tip', ok: false }

  const amount = input.amount ?? executionWorkspace.default_amount
  const totalAmount = amount * allRecipients.length
  if (!Number.isSafeInteger(totalAmount) || totalAmount <= 0)
    return { code: 'failed', message: 'Payment amount is too large.', ok: false }
  const tokenAddress = Address.checksum(
    input.tokenAddress ?? executionWorkspace.default_token_address ?? Tempo.addressLookup.pathUsd,
  )
  if (!Tempo.isAllowedToken(executionWorkspace.chain_id, tokenAddress))
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
  const connectedRecipientInputs = [] as TipRecipientInput[]
  const actuallyPendingRecipients = [] as TipRecipientInput[]
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
    connectedRecipientInputs.push(recipient)
  }
  for (const recipient of pendingRecipients) {
    const connected = await getConnectedRecipient(db, workspace, input.provider, recipient)
    if (connected?.account.id === sender.account.id) return { code: 'self_tip', ok: false }
    if (connected) {
      connectedRecipients.push(connected)
      connectedRecipientInputs.push(recipient)
    } else actuallyPendingRecipients.push(recipient)
  }

  const accessKeys = await db
    .selectFrom('access_key')
    .selectAll()
    .where('account_id', '=', sender.account.id)
    .where('chain_id', '=', executionWorkspace.chain_id)
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
        chainId: executionWorkspace.chain_id,
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
        source: input.source,
        usergroupId: input.usergroupId,
        usergroupLabel: input.usergroupLabel,
      },
      executionWorkspace,
      amount,
      tokenAddress,
      {
        accessKeyLimit: BigInt(Math.max(AccountLink.reusableAccessKeyLimit, totalAmount)),
        kind: 'onetime_payment',
      },
    )) as Extract<TipBatchResult, { ok: false }>

  const sentResult = connectedRecipients.length
    ? await submitTipBatch(env, db, {
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
        recipients: connectedRecipientInputs,
        sender,
        senderProviderUserId: input.senderProviderUserId,
        skippedRecipients: input.skippedRecipients,
        source: input.source,
        tokenAddress,
        usergroupId: input.usergroupId,
        usergroupLabel: input.usergroupLabel,
        workspace: executionWorkspace,
      })
    : null
  if (sentResult && !sentResult.ok) return sentResult

  const queuedRecipients = [] as Array<{
    pendingTipId: string
    recipientProviderLabel?: string
    recipientProviderUserId: string
  }>
  for (const recipient of actuallyPendingRecipients) {
    const result = await createPendingTip(env, db, {
      accessKey,
      amount,
      idempotencyKey: `${input.idempotencyKey}:${recipient.recipientProviderUserId}`,
      memo: input.memo,
      provider: input.provider,
      providerChannelId: input.providerChannelId,
      providerId: input.providerId,
      providerThreadId: input.providerThreadId,
      recipientProviderUserId: recipient.recipientProviderUserId,
      recipientProviderWorkspaceId: recipient.recipientProviderWorkspaceId,
      sender,
      senderProviderUserId: input.senderProviderUserId,
      source: input.source,
      tokenAddress,
      workspace: executionWorkspace,
    })
    if (!result.ok) return result
    if (result.status !== 'queued') continue
    queuedRecipients.push({
      pendingTipId: result.pendingTipId,
      recipientProviderLabel: recipient.recipientProviderLabel,
      recipientProviderUserId: recipient.recipientProviderUserId,
    })
  }
  if (sentResult?.ok) return { ...sentResult, queuedRecipients }

  const tokenMetadata = await Tempo.getTokenMetadata(env, executionWorkspace.chain_id, tokenAddress)
  return {
    amount: formatAmount(amount),
    chainId: executionWorkspace.chain_id,
    isDefaultToken: Address.isEqual(
      Address.checksum(tokenAddress),
      Address.checksum(executionWorkspace.default_token_address ?? Tempo.addressLookup.pathUsd),
    ),
    memo: input.memo,
    ok: true,
    queuedRecipients,
    senderProviderUserId: input.senderProviderUserId,
    skippedRecipients: input.skippedRecipients,
    status: 'queued',
    tokenCurrency: tokenMetadata.currency,
    tokenSymbol: tokenMetadata.symbol,
  }
}

export function parseAmount(value: string) {
  const match = value.match(/^\$?(?:(0|[1-9]\d*)(?:\.(\d+))?|\.(\d+))$/)
  if (!match) return null

  const decimals = (match[2] ?? match[3] ?? '').slice(0, 6).padEnd(6, '0')
  const amount = Number(match[1] ?? 0) * 1_000_000 + Number(decimals)
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
  if (amount === null && /^\$(?:\d|\.)/.test(first)) return null
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
    const specialMention = usergroup ? null : remaining.match(/^<!(channel|here)(?:\|([^>]+))?>\s*/)
    if (!usergroup && !specialMention) break
    const providerUsergroupId = (usergroup?.[1] ?? specialMention?.[1])!
    const providerUsergroupLabel =
      usergroup?.[2]?.trim().replace(/^@+/, '') ?? specialMention?.[2]?.trim().replace(/^@+/, '')
    if (!usergroups.some((item) => item.providerUsergroupId === providerUsergroupId))
      usergroups.push({
        ...(providerUsergroupLabel ? { providerUsergroupLabel } : {}),
        providerUsergroupId,
      })
    remaining = remaining.slice((usergroup ?? specialMention)![0].length)
  }
  if (recipients.length === 0 && usergroups.length === 0) return null
  if (
    /<@[A-Z0-9_]+(?:\|[^>]+)?>|<!subteam\^[A-Z0-9_]+(?:\|[^>]+)?>|<!(?:channel|here)(?:\|[^>]+)?>/.test(
      remaining,
    )
  )
    return null

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
      source: payload.source ?? 'command',
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
    providerChannelId: payload.providerChannelId,
    providerId: payload.providerId,
    providerThreadId: payload.providerThreadId,
    recipient,
    recipientProviderUserId: payload.recipientProviderUserId,
    sender,
    senderProviderUserId: payload.senderProviderUserId,
    source: payload.source,
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

export async function recordPendingTipMessage(
  env: Env,
  input: { pendingTipId: string; providerMessageTs: string },
) {
  await DB.create(env.DB)
    .updateTable('pending_tip')
    .set({ provider_message_ts: input.providerMessageTs, updated_at: new Date().toISOString() })
    .where('id', '=', input.pendingTipId)
    .execute()
}

export async function claimPendingTip(
  env: Env,
  input: { pendingTipId: string },
): Promise<PendingTipClaimResult | null> {
  const db = DB.create(env.DB)
  const pending = await db
    .selectFrom('pending_tip')
    .selectAll()
    .where('id', '=', input.pendingTipId)
    .executeTakeFirst()
  if (!pending) return null
  if (pending.status === 'sent') return await getSentPendingTipResult(env, db, pending)
  if (!['pending', 'sending'].includes(pending.status)) return null

  const now = new Date().toISOString()
  if (pending.expires_at <= now)
    return await updatePendingTipFailed(db, pending, {
      message: 'Pending tip expired before recipient connected.',
      status: 'expired',
    })

  await db
    .updateTable('pending_tip')
    .set({ status: 'sending', updated_at: now })
    .where('id', '=', pending.id)
    .where('status', '=', 'pending')
    .execute()

  const sender = await getConnectedMemberById(db, pending.sender_member_id)
  const recipient = await getConnectedMemberById(db, pending.recipient_member_id)
  const accessKey = pending.access_key_id
    ? await db
        .selectFrom('access_key')
        .selectAll()
        .where('id', '=', pending.access_key_id)
        .executeTakeFirst()
    : null
  if (!sender || !recipient || !accessKey)
    return await updatePendingTipFailed(db, pending, {
      message: 'Pending tip could not be sent.',
      status: 'failed',
    })
  if (accessKey.revoked_at || accessKey.expires_at <= new Date().toISOString())
    return await updatePendingTipFailed(db, pending, {
      message: 'Pending tip expired before recipient connected.',
      status: 'expired',
    })

  const authorization = KeyAuthorization.fromRpc(JSON.parse(accessKey.authorization) as never)
  if (
    accessKey.chain_id !== pending.chain_id ||
    !supportsTip(authorization, {
      amount: pending.amount,
      memo: pending.memo,
      tokenAddress: pending.token_address,
    }) ||
    !(await hasTrackedAccessKeyLimitRemaining(db, {
      accessKeyId: accessKey.id,
      accountId: sender.account.id,
      amount: pending.amount,
      authorization,
      authorizationUsedAt: accessKey.authorization_used_at,
      chainId: pending.chain_id,
      excludePendingTipId: pending.id,
      tokenAddress: pending.token_address,
    }))
  )
    return await updatePendingTipFailed(db, pending, {
      message: 'Pending tip could not be sent.',
      status: 'failed',
    })

  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('id', '=', pending.workspace_id)
    .executeTakeFirstOrThrow()
  const result = await submitTip(env, db, {
    accessKeyId: accessKey.id,
    accessKeyPrivateKey: await AccessKey.decrypt(env, accessKey.ciphertext),
    amount: pending.amount,
    authorizationUsedAt: accessKey.authorization_used_at,
    idempotencyKey: `pending:${pending.id}`,
    keyAuthorization: authorization,
    memo: pending.memo,
    providerChannelId: pending.provider_channel_id,
    providerId: pending.provider_id,
    providerThreadId: pending.provider_thread_id ?? undefined,
    recipient,
    recipientProviderUserId: pending.recipient_provider_user_id,
    sender,
    senderProviderUserId: sender.member.provider_user_id,
    source: pending.source,
    tokenAddress: pending.token_address,
    workspace: { ...workspace, chain_id: pending.chain_id },
  })
  if (!result.ok)
    return await updatePendingTipFailed(db, pending, {
      message: result.message ?? 'Pending tip could not be sent.',
      status: 'failed',
    })
  if (result.status === 'queued')
    return await updatePendingTipFailed(db, pending, {
      message: 'Pending tip could not be sent.',
      status: 'failed',
    })

  const tip = await db
    .selectFrom('tip')
    .select('id')
    .where('idempotency_key', '=', `pending:${pending.id}`)
    .executeTakeFirst()
  await db
    .updateTable('pending_tip')
    .set({
      status: 'sent',
      tip_id: tip?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', pending.id)
    .execute()

  return {
    amount: result.amount,
    chainId: result.chainId,
    isDefaultToken: result.isDefaultToken,
    memo: result.memo,
    ok: true,
    pendingTip: { ...pending, status: 'sent', tip_id: tip?.id ?? null },
    recipientProviderUserId: result.recipientProviderUserId,
    senderProviderUserId: result.senderProviderUserId,
    status: 'sent',
    tokenCurrency: result.tokenCurrency,
    tokenSymbol: result.tokenSymbol,
    transactionHash: result.transactionHash,
  }
}

async function getExistingPendingTipResult(
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
    .selectFrom('pending_tip')
    .selectAll()
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()
  if (!existing || existing.status !== 'pending') return null
  const tokenMetadata = await Tempo.getTokenMetadata(env, existing.chain_id, existing.token_address)
  return {
    amount: formatAmount(existing.amount),
    chainId: existing.chain_id,
    isDefaultToken: Address.isEqual(
      Address.checksum(existing.token_address),
      defaultTokenAddress as Address.Address,
    ),
    memo: existing.memo,
    ok: true,
    pendingTipId: existing.id,
    recipientProviderUserId: input.recipientProviderUserId,
    senderProviderUserId: input.senderProviderUserId,
    source: existing.source,
    status: 'queued',
    tokenCurrency: tokenMetadata.currency,
    tokenSymbol: tokenMetadata.symbol,
  }
}

async function createPendingTip(
  env: Env,
  db: DB.Type,
  input: {
    accessKey: Database.Selectable.access_key
    amount: number
    idempotencyKey: string
    memo: string | null
    provider: 'slack'
    providerChannelId: string
    providerId: string
    providerThreadId?: string
    recipientProviderUserId: string
    recipientProviderWorkspaceId?: string
    sender: ConnectedMember
    senderProviderUserId: string
    source: 'command' | 'mention' | 'reaction'
    tokenAddress: string
    workspace: Database.Selectable.workspace
  },
): Promise<TipResult> {
  const recipient = await getOrCreatePendingRecipientMember(db, input.workspace, input.provider, {
    recipientProviderUserId: input.recipientProviderUserId,
    recipientProviderWorkspaceId: input.recipientProviderWorkspaceId,
  })
  const id = Nanoid.generate()
  const now = new Date().toISOString()
  await db
    .insertInto('pending_tip')
    .values({
      access_key_id: input.accessKey.id,
      amount: input.amount,
      chain_id: input.workspace.chain_id,
      created_at: now,
      expires_at: input.accessKey.expires_at,
      failure_reason: null,
      id,
      idempotency_key: input.idempotencyKey,
      memo: input.memo,
      provider: input.provider,
      provider_channel_id: input.providerChannelId,
      provider_id: input.providerId,
      provider_message_ts: null,
      provider_thread_id: input.providerThreadId ?? null,
      recipient_member_id: recipient.id,
      recipient_provider_user_id: input.recipientProviderUserId,
      sender_id: input.sender.account.id,
      sender_member_id: input.sender.member.id,
      sender_provider_user_id: input.senderProviderUserId,
      source: input.source,
      status: 'pending',
      tip_id: null,
      token_address: input.tokenAddress,
      updated_at: now,
      workspace_id: input.workspace.id,
    })
    .execute()
  const tokenMetadata = await Tempo.getTokenMetadata(
    env,
    input.workspace.chain_id,
    input.tokenAddress,
  )
  return {
    amount: formatAmount(input.amount),
    chainId: input.workspace.chain_id,
    isDefaultToken: Address.isEqual(
      Address.checksum(input.tokenAddress),
      Address.checksum(input.workspace.default_token_address ?? Tempo.addressLookup.pathUsd),
    ),
    memo: input.memo,
    ok: true,
    pendingTipId: id,
    recipientProviderUserId: input.recipientProviderUserId,
    senderProviderUserId: input.senderProviderUserId,
    source: input.source,
    status: 'queued',
    tokenCurrency: tokenMetadata.currency,
    tokenSymbol: tokenMetadata.symbol,
  }
}

async function getOrCreatePendingRecipientMember(
  db: DB.Type,
  workspace: Database.Selectable.workspace,
  provider: Database.Selectable.workspace['provider'],
  recipient: TipRecipientInput,
) {
  const recipientWorkspace = await (async () => {
    if (!recipient.recipientProviderWorkspaceId) return workspace
    const existing = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_id', '=', recipient.recipientProviderWorkspaceId)
      .executeTakeFirst()
    if (existing) return existing

    const now = new Date().toISOString()
    const id = Nanoid.generate()
    await db
      .insertInto('workspace')
      .values({
        chain_id: workspace.chain_id,
        created_at: now,
        default_amount: workspace.default_amount,
        default_token_address: workspace.default_token_address,
        id,
        installed_at: null,
        provider,
        provider_id: recipient.recipientProviderWorkspaceId,
        uninstalled_at: null,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(['provider', 'provider_id']).doNothing())
      .execute()
    return await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_id', '=', recipient.recipientProviderWorkspaceId!)
      .executeTakeFirstOrThrow()
  })()

  const existing = await db
    .selectFrom('member')
    .selectAll()
    .where('workspace_id', '=', recipientWorkspace.id)
    .where('provider_user_id', '=', recipient.recipientProviderUserId)
    .executeTakeFirst()
  if (existing) return existing

  const now = new Date().toISOString()
  const providerIdentityId = Nanoid.generate()
  await db
    .insertInto('provider_identity')
    .values({
      account_id: null,
      created_at: now,
      display_name: recipient.recipientProviderLabel ?? null,
      id: providerIdentityId,
      metadata: null,
      provider,
      provider_global_user_id: null,
      provider_user_id: recipient.recipientProviderUserId,
      provider_workspace_id: recipientWorkspace.provider_id,
      real_name: null,
      updated_at: now,
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
  const identity = await db
    .selectFrom('provider_identity')
    .select('id')
    .where('provider', '=', provider)
    .where('provider_workspace_id', '=', recipientWorkspace.provider_id)
    .where('provider_user_id', '=', recipient.recipientProviderUserId)
    .executeTakeFirstOrThrow()
  const id = Nanoid.generate()
  await db
    .insertInto('member')
    .values({
      created_at: now,
      id,
      login: recipient.recipientProviderLabel ?? null,
      name: null,
      provider_identity_id: identity.id,
      provider_user_id: recipient.recipientProviderUserId,
      updated_at: now,
      workspace_id: recipientWorkspace.id,
    })
    .onConflict((oc) => oc.columns(['workspace_id', 'provider_user_id']).doNothing())
    .execute()
  return await db
    .selectFrom('member')
    .selectAll()
    .where('workspace_id', '=', recipientWorkspace.id)
    .where('provider_user_id', '=', recipient.recipientProviderUserId)
    .executeTakeFirstOrThrow()
}

async function updatePendingTipFailed(
  db: DB.Type,
  pendingTip: Database.Selectable.pending_tip,
  input: { message: string; status: 'expired' | 'failed' },
): Promise<Extract<PendingTipClaimResult, { ok: false }>> {
  await db
    .updateTable('pending_tip')
    .set({
      failure_reason: input.message,
      status: input.status,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', pendingTip.id)
    .execute()
  return {
    code: input.status,
    message: input.message,
    ok: false,
    pendingTip: { ...pendingTip, failure_reason: input.message, status: input.status },
    status: input.status,
  }
}

async function getSentPendingTipResult(
  env: Env,
  db: DB.Type,
  pendingTip: Database.Selectable.pending_tip,
): Promise<Extract<PendingTipClaimResult, { ok: true }> | null> {
  const tip = await db
    .selectFrom('tip')
    .innerJoin('tip_batch', 'tip_batch.id', 'tip.batch_id')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .select(['tip.id', 'tip_batch.transaction_hash', 'workspace.default_token_address'])
    .where('tip.idempotency_key', '=', `pending:${pendingTip.id}`)
    .executeTakeFirst()
  if (!tip?.transaction_hash) return null
  const tokenMetadata = await Tempo.getTokenMetadata(
    env,
    pendingTip.chain_id,
    pendingTip.token_address,
  )
  return {
    amount: formatAmount(pendingTip.amount),
    chainId: pendingTip.chain_id,
    isDefaultToken: Address.isEqual(
      Address.checksum(pendingTip.token_address),
      Address.checksum(tip.default_token_address ?? Tempo.addressLookup.pathUsd),
    ),
    memo: pendingTip.memo,
    ok: true,
    pendingTip,
    recipientProviderUserId: pendingTip.recipient_provider_user_id,
    senderProviderUserId: pendingTip.sender_provider_user_id,
    status: 'sent',
    tokenCurrency: tokenMetadata.currency,
    tokenSymbol: tokenMetadata.symbol,
    transactionHash: tip.transaction_hash,
  }
}

async function getConnectedMemberById(db: DB.Type, memberId: string) {
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
    .where('member.id', '=', memberId)
    .executeTakeFirst()
  return member ? connectedMemberFromRow(member) : null
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
    source?: 'command' | 'mention' | 'reaction'
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
    source: input.source,
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
    providerChannelId: string
    providerId: string
    providerThreadId?: string
    recipient: ConnectedMember
    recipientProviderUserId: string
    sender: ConnectedMember
    senderProviderUserId: string
    source?: 'command' | 'mention' | 'reaction'
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
    providerChannelId: input.providerChannelId,
    providerId: input.providerId,
    providerThreadId: input.providerThreadId,
    recipients: [
      {
        recipientProviderUserId: input.recipientProviderUserId,
      },
    ],
    sender: input.sender,
    senderProviderUserId: input.senderProviderUserId,
    source: input.source ?? 'command',
    tokenAddress: input.tokenAddress,
    workspace: input.workspace,
  })
  if (!result.ok) return result
  if (result.status === 'queued')
    return { code: 'failed', message: 'Payment could not be sent.', ok: false }
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
      source: input.payload.source ?? 'command',
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
      source: input.payload.source ?? 'command',
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
    excludePendingTipId?: string
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
    const pendingTips = await db
      .selectFrom('pending_tip')
      .select('amount')
      .where('access_key_id', '=', input.accessKeyId)
      .where('sender_id', '=', input.accountId)
      .where('chain_id', '=', input.chainId)
      .where('token_address', '=', Address.checksum(input.tokenAddress))
      .where('status', 'in', ['pending', 'sending'])
      .where('expires_at', '>', new Date().toISOString())
      .$if(Boolean(input.excludePendingTipId), (qb) =>
        qb.where('id', '!=', input.excludePendingTipId!),
      )
      .execute()
    const used = [...tips, ...pendingTips].reduce((total, tip) => total + BigInt(tip.amount), 0n)
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
