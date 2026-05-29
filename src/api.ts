import { Hono } from 'hono'
import { Address, Base64, Hex } from 'ox'
import * as chat from 'chat'
import { z } from 'zod'
import * as Chat from '#/chat.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import { getPreviewReactionTipEmojis, getSlackBotDisplayName, getSlackCommand } from '#/lib/app.ts'
import { formatAmount, formatCurrencyAmount, formatTipAmount } from '#/lib/format.ts'
import * as hono from '#/lib/hono.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Slack from '#/lib/slack.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Tip from '#/lib/tip.ts'
import * as DB from '#db/client.ts'

export const api = new Hono<{
  Bindings: Env
  Variables: {
    db: DB.Type
  }
}>()
  .use(async (c, next) => {
    c.set('db', DB.create(c.env.DB))
    await next()
  })
  .get('/api/account/link/:token', async (c) => {
    const link = await c.var.db
      .selectFrom('account_link_token')
      .innerJoin('member', 'member.id', 'account_link_token.member_id')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .select([
        'account_link_token.access_key_address',
        'account_link_token.access_key_ciphertext',
        'account_link_token.access_key_expires_at',
        'account_link_token.access_key_public_key',
        'account_link_token.expires_at',
        'account_link_token.id',
        'account_link_token.member_id',
        'account_link_token.used_at',
        'workspace.chain_id',
        'workspace.default_token_address',
        'workspace.id as workspace_id',
      ])
      .where(
        'account_link_token.token_hash',
        '=',
        await AccountLink.hashToken(c.env, c.req.param('token')),
      )
      .executeTakeFirst()
    if (!link || link.used_at || Date.now() > new Date(link.expires_at).getTime())
      return c.json(
        {
          code: 'invalid_account_link' as const,
          message: 'This connection link is invalid or expired.',
          ok: false as const,
        },
        404,
      )

    return c.json({
      accessKeyAddress: link.access_key_address,
      accessKeyExpiry: link.access_key_expires_at,
      accessKeyLimit: AccountLink.reusableAccessKeyLimitText,
      accessKeyLimitPeriodSeconds: AccountLink.reusableAccessKeyPeriodSeconds,
      accessKeyPublicKey: link.access_key_public_key as `0x${string}`,
      chainId: link.chain_id,
      chainName: Tempo.getChainName(link.chain_id),
      expiresAt: link.expires_at,
      ok: true as const,
      tokenAddress: Address.checksum(link.default_token_address ?? Tempo.addressLookup.pathUsd),
    })
  })
  .post(
    '/api/account/link/:token',
    hono.validator(
      'json',
      z.object({
        address: z.string().min(1),
        disconnectExistingAccount: z.boolean().optional(),
        keyAuthorization: z.unknown(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json')
      const link = await c.var.db
        .selectFrom('account_link_token')
        .innerJoin('member', 'member.id', 'account_link_token.member_id')
        .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
        .select([
          'account_link_token.access_key_address',
          'account_link_token.access_key_ciphertext',
          'account_link_token.access_key_expires_at',
          'account_link_token.access_key_public_key',
          'account_link_token.expires_at',
          'account_link_token.id',
          'account_link_token.member_id',
          'account_link_token.provider_channel_id',
          'account_link_token.channel_provider_id',
          'account_link_token.used_at',
          'member.provider_identity_id as member_provider_identity_id',
          'member.provider_user_id as member_provider_user_id',
          'workspace.chain_id',
          'workspace.default_token_address',
          'workspace.id as workspace_id',
          'workspace.provider_id',
        ])
        .where(
          'account_link_token.token_hash',
          '=',
          await AccountLink.hashToken(c.env, c.req.param('token')),
        )
        .executeTakeFirst()
      if (!link || link.used_at || Date.now() > new Date(link.expires_at).getTime())
        return c.json(
          {
            code: 'invalid_account_link' as const,
            message: 'This connection link is invalid or expired.',
            ok: false as const,
          },
          404,
        )

      try {
        const verified = await AccountLink.verifyKeyAuthorization({
          accessKeyAddress: link.access_key_address,
          chainId: link.chain_id,
          env: c.env,
          expiresAt: link.access_key_expires_at,
          keyAuthorization: body.keyAuthorization,
          rootAddress: body.address,
          tokenAddress: Address.checksum(link.default_token_address ?? Tempo.addressLookup.pathUsd),
        })
        const now = new Date().toISOString()
        const existingAccount = await c.var.db
          .selectFrom('account')
          .selectAll()
          .where('address', '=', verified.rootAddress)
          .executeTakeFirst()
        const account = await (async () => {
          if (existingAccount) {
            await c.var.db
              .updateTable('account')
              .set({ updated_at: now })
              .where('id', '=', existingAccount.id)
              .execute()
            return existingAccount
          }

          const id = Nanoid.generate()
          await c.var.db
            .insertInto('account')
            .values({
              address: verified.rootAddress,
              created_at: now,
              id,
              updated_at: now,
            })
            .execute()
          return await c.var.db
            .selectFrom('account')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        })()

        const duplicate = await c.var.db
          .selectFrom('member')
          .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
          .select(['member.id', 'member.provider_identity_id'])
          .where('member.workspace_id', '=', link.workspace_id)
          .where('member.id', '!=', link.member_id)
          .where('provider_identity.account_id', '=', account.id)
          .executeTakeFirst()
        if (duplicate && !body.disconnectExistingAccount)
          return c.json(
            {
              code: 'account_already_connected' as const,
              message:
                'This wallet is already connected to another Slack account in this workspace.',
            },
            409,
          )
        if (duplicate && body.disconnectExistingAccount) {
          const duplicateIdentities = await c.var.db
            .selectFrom('member')
            .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
            .select('member.provider_identity_id')
            .where('member.workspace_id', '=', link.workspace_id)
            .where('member.id', '!=', link.member_id)
            .where('provider_identity.account_id', '=', account.id)
            .execute()
          const duplicateIdentityIds = duplicateIdentities.map((row) => row.provider_identity_id)
          await c.var.db
            .updateTable('provider_identity')
            .set({ account_id: null, updated_at: now })
            .where('id', 'in', duplicateIdentityIds)
            .execute()
        }

        await c.var.db
          .deleteFrom('access_key')
          .where('account_id', '=', account.id)
          .where('chain_id', '=', link.chain_id)
          .where(
            'token_address',
            '=',
            Address.checksum(link.default_token_address ?? Tempo.addressLookup.pathUsd),
          )
          .execute()
        await c.var.db
          .deleteFrom('access_key')
          .where('account_id', '=', account.id)
          .where('chain_id', '=', link.chain_id)
          .where('token_address', 'is', null)
          .execute()
        await c.var.db
          .insertInto('access_key')
          .values({
            account_id: account.id,
            address: link.access_key_address,
            authorization: verified.serialized,
            chain_id: link.chain_id,
            ciphertext: link.access_key_ciphertext,
            created_at: now,
            expires_at: verified.expiresAt,
            id: Nanoid.generate(),
            revoked_at: null,
            token_address: Address.checksum(
              link.default_token_address ?? Tempo.addressLookup.pathUsd,
            ),
            updated_at: now,
          })
          .execute()
        if (link.member_provider_identity_id)
          await c.var.db
            .updateTable('provider_identity')
            .set({ account_id: account.id, updated_at: now })
            .where('id', '=', link.member_provider_identity_id)
            .execute()
        await c.var.db
          .updateTable('account_link_token')
          .set({
            access_key_authorization: verified.serialized,
            account_id: account.id,
            used_at: now,
          })
          .where('id', '=', link.id)
          .execute()
        c.executionCtx.waitUntil(
          (async () => {
            const pendingTips = await c.var.db
              .selectFrom('pending_tip')
              .select('id')
              .where('recipient_member_id', '=', link.member_id)
              .where('status', '=', 'pending')
              .execute()
            for (const pendingTip of pendingTips)
              await c.env.PENDING_TIP_QUEUE.send({ pendingTipId: pendingTip.id })
          })().catch((error) => {
            console.error('Failed to enqueue pending tips after wallet connection:', error)
          }),
        )

        if (link.provider_channel_id)
          c.executionCtx.waitUntil(
            (async () => {
              await Chat.getChat().initialize()
              const installation = await Chat.getSlack().getInstallation(
                link.channel_provider_id ?? link.provider_id,
              )
              if (!installation) return

              const reactionTipConfigs = await c.var.db
                .selectFrom('reaction_tip_config')
                .select(['amount', 'emoji'])
                .where('workspace_id', '=', link.workspace_id)
                .orderBy('amount', 'asc')
                .orderBy('emoji', 'asc')
                .execute()
              const reactionTipConfigsText = (
                reactionTipConfigs.length ? reactionTipConfigs : Tip.defaultReactionTipConfigs
              )
                .map(
                  (config) =>
                    `:${config.emoji}: \`:${config.emoji}:\` (${formatAmount(config.amount)})`,
                )
                .join(', ')

              const channelRef = Chat.getChat().channel(
                link.provider_channel_id!.startsWith('slack:')
                  ? link.provider_channel_id!
                  : `slack:${link.provider_channel_id!}`,
              )
              const truncatedAddress = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`
              const explorerUrl = Tempo.explorerLink(link.chain_id, account.address)

              await Chat.getSlack().withBotToken(installation.botToken, () =>
                channelRef.postEphemeral(
                  link.member_provider_user_id,
                  {
                    card: chat.Card({
                      children: [
                        chat.CardText(`Connected \`${truncatedAddress}\` <${explorerUrl}|View>`),
                        chat.CardText(
                          `Mention \`@${getSlackBotDisplayName(c.env.HOST)} @user\` or use \`${getSlackCommand(c.env.HOST)} @user\` to send a payment. React with ${reactionTipConfigsText} to tip a message.`,
                          { style: 'muted' },
                        ),
                      ],
                    }),
                    fallbackText: `Connected\nWallet: ${account.address}\nUse ${getSlackCommand(c.env.HOST)} @user to send your first tip.`,
                  },
                  { fallbackToDM: false },
                ),
              )
            })().catch((error) => {
              console.error('Failed to notify Slack member after wallet connection:', error)
            }),
          )

        return c.json({ ok: true as const })
      } catch (error) {
        return c.json(
          {
            code: 'invalid_key_authorization' as const,
            message: error instanceof Error ? error.message : 'Invalid key authorization.',
          },
          400,
        )
      }
    },
  )
  .get('/api/confirm/:token', async (c) => {
    try {
      const data = await Tip.getConfirmationData(c.env, c.req.param('token'))
      const metadata = Tempo.getTokenMetadataFallback(data.payload.tokenAddress)
      const recipientProviderLabel =
        data.payload.recipientProviderLabel ??
        (await c.var.db
          .selectFrom('member')
          .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
          .select(['member.login', 'member.name'])
          .where('workspace.id', '=', data.payload.workspaceId)
          .where('member.provider_user_id', '=', data.payload.recipientProviderUserId)
          .executeTakeFirst()
          .then((member) => member?.name?.trim() || member?.login?.trim() || undefined)) ??
        (await (async () => {
          await Chat.getChat().initialize()
          const installation = await Chat.getSlack().getInstallation(data.payload.providerId)
          if (!installation) return undefined
          const slackUserSchema = z.object({
            id: z.string().optional(),
            name: z.string().optional(),
            profile: z
              .object({
                display_name: z.string().optional(),
                real_name: z.string().optional(),
              })
              .nullable()
              .optional(),
          })

          const body = new URLSearchParams()
          body.set('user', data.payload.recipientProviderUserId)
          const response = await Chat.getSlack().withBotToken(installation.botToken, () =>
            fetch(`${c.env.SLACK_API_URL}/users.info`, {
              body,
              headers: { authorization: `Bearer ${installation.botToken}` },
              method: 'POST',
            }),
          )
          const info = z.parse(
            z.object({
              ok: z.boolean().optional(),
              user: slackUserSchema.optional(),
            }),
            await response.json(),
          )
          const user = info.ok
            ? info.user
            : await (async () => {
                const listResponse = await Chat.getSlack().withBotToken(installation.botToken, () =>
                  fetch(`${c.env.SLACK_API_URL}/users.list`, {
                    headers: { authorization: `Bearer ${installation.botToken}` },
                    method: 'GET',
                  }),
                )
                const list = z.parse(
                  z.object({
                    members: z.array(slackUserSchema).optional(),
                    ok: z.boolean().optional(),
                  }),
                  await listResponse.json(),
                )
                if (!list.ok) return undefined
                return list.members?.find(
                  (member) => member.id === data.payload.recipientProviderUserId,
                )
              })()
          return (
            user?.profile?.display_name?.trim() ||
            user?.profile?.real_name?.trim() ||
            user?.name?.trim() ||
            undefined
          )
        })().catch(() => undefined))
      return c.json({
        accessKeyAddress: data.accessKey.address,
        accessKeyExpiry:
          data.payload.kind === 'reusable_access_key'
            ? (data.payload.accessKeyExpiresAt ?? data.payload.expiresAt)
            : data.payload.expiresAt,
        accessKeyLimit:
          data.payload.kind === 'reusable_access_key'
            ? formatAmount(
                Number(data.payload.accessKeyLimit ?? AccountLink.reusableAccessKeyLimit),
              )
            : formatAmount(data.payload.amount),
        accessKeyLimitPeriodSeconds:
          data.payload.kind === 'reusable_access_key'
            ? AccountLink.reusableAccessKeyPeriodSeconds
            : AccountLink.confirmationLinkTtlMs / 1000,
        accessKeyPublicKey: data.accessKey.publicKey as `0x${string}`,
        amount: formatAmount(data.payload.amount),
        chainId: data.payload.chainId,
        groupId: data.payload.groupId,
        groupLabel: data.payload.groupLabel,
        kind: data.payload.kind,
        memo: data.payload.memo,
        ok: true as const,
        recipientProviderLabel,
        recipientProviderUserId: data.payload.recipientProviderUserId,
        recipients: data.payload.recipients ?? [
          {
            recipientProviderLabel,
            recipientProviderUserId: data.payload.recipientProviderUserId,
          },
        ],
        skippedRecipients: data.payload.skippedRecipients ?? [],
        tokenAddress: Address.checksum(data.payload.tokenAddress),
        tokenCurrency: metadata.currency,
        tokenSymbol: metadata.symbol,
        transactionRequest:
          data.payload.kind === 'onetime_payment'
            ? await Tip.getConfirmationTransactionRequest(c.env, c.req.param('token'))
            : undefined,
      })
    } catch (error) {
      return c.json(
        {
          code: 'invalid_confirmation' as const,
          message: error instanceof Error ? error.message : 'Confirmation link expired',
          ok: false as const,
        },
        404,
      )
    }
  })
  .post(
    '/api/confirm/:token',
    hono.validator(
      'json',
      z.object({
        address: z.string().min(1),
        keyAuthorization: z.unknown().optional(),
        signedTransaction: z.string().min(1).optional(),
      }),
    ),
    async (c) => {
      try {
        const body = c.req.valid('json')
        const data = await Tip.getConfirmationData(c.env, c.req.param('token'))
        const result = await Tip.confirmTipRequest(c.env, {
          address: body.address,
          keyAuthorization: body.keyAuthorization,
          signedTransaction: body.signedTransaction as `0x${string}` | undefined,
          token: c.req.param('token'),
        })
        if (!result.ok)
          return c.json(
            {
              code: result.code,
              message: result.code === 'failed' ? 'Payment failed. Try again.' : result.message,
              ok: false as const,
            },
            400,
          )

        if (
          result.status === 'sent' &&
          Chat.isReactionTipIdempotencyKey(data.payload.idempotencyKey)
        )
          c.executionCtx.waitUntil(
            (async () => {
              const db = DB.create(c.env.DB)
              const reactionTip = await db
                .selectFrom('reaction_tip')
                .innerJoin('workspace', 'workspace.id', 'reaction_tip.workspace_id')
                .innerJoin('tip', 'tip.idempotency_key', 'reaction_tip.idempotency_key')
                .select([
                  'reaction_tip.channel_id',
                  'reaction_tip.id',
                  'reaction_tip.reaction',
                  'reaction_tip.thread_ts',
                  'reaction_tip.workspace_id',
                  'tip.id as tip_id',
                ])
                .where('reaction_tip.workspace_id', '=', data.payload.workspaceId)
                .where('reaction_tip.idempotency_key', '=', data.payload.idempotencyKey)
                .where('tip.confirmed_at', 'is not', null)
                .executeTakeFirst()
              if (!reactionTip) return

              await db
                .updateTable('reaction_tip')
                .set({ tip_id: reactionTip.tip_id, updated_at: new Date().toISOString() })
                .where('id', '=', reactionTip.id)
                .where('tip_id', 'is', null)
                .execute()
              await Chat.updateReactionTipAggregate(data.payload.providerId, {
                channelId: reactionTip.channel_id,
                threadTs: reactionTip.thread_ts,
                workspaceId: reactionTip.workspace_id,
              })
            })().catch((error) => {
              console.error(
                'Failed to update Slack reaction tip aggregate after confirmation:',
                error,
              )
            }),
          )
        else if (
          result.status === 'sent' &&
          Chat.isReceiptBoostIdempotencyKey(data.payload.idempotencyKey)
        )
          c.executionCtx.waitUntil(
            (async () => {
              await Chat.getChat().initialize()
              const installation = await Chat.getSlack().getInstallation(data.payload.providerId)
              if (!installation) return

              const [, workspaceId, channelId, messageTs] = data.payload.idempotencyKey.split(':')
              if (!workspaceId || !channelId || !messageTs) return
              const receipt = await c.var.db
                .selectFrom('tip_receipt_message')
                .select(['message_ts', 'thread_ts'])
                .where('workspace_id', '=', workspaceId)
                .where('channel_id', '=', channelId)
                .where('message_ts', '=', messageTs)
                .executeTakeFirst()
              if (!receipt) return

              if (receipt.thread_ts !== receipt.message_ts) {
                await Chat.updateReceiptBoostAggregate(data.payload.providerId, {
                  channelId,
                  threadTs: receipt.thread_ts,
                  workspaceId,
                })
                if (data.payload.skippedRecipients?.length) {
                  const skippedBody = new URLSearchParams()
                  const recipientCount = data.payload.recipients?.length ?? 1
                  const skippedCount = data.payload.skippedRecipients.length
                  skippedBody.set('channel', channelId)
                  skippedBody.set(
                    'text',
                    `Boost sent to ${recipientCount} ${recipientCount === 1 ? 'account' : 'accounts'}. Skipped ${skippedCount} ${skippedCount === 1 ? 'account' : 'accounts'} that can no longer receive payments.`,
                  )
                  skippedBody.set('thread_ts', receipt.thread_ts)
                  skippedBody.set('user', data.payload.senderProviderUserId)
                  await Chat.getSlack().withBotToken(installation.botToken, () =>
                    fetch(`${c.env.SLACK_API_URL}/chat.postEphemeral`, {
                      body: skippedBody,
                      headers: { authorization: `Bearer ${installation.botToken}` },
                      method: 'POST',
                    }),
                  )
                }
                return
              }

              const originalReceiptLink = (() => {
                if (receipt.thread_ts === receipt.message_ts) return ''
                const url = new URL('slack://channel')
                url.searchParams.set('team', data.payload.providerId)
                url.searchParams.set('id', channelId)
                url.searchParams.set('message', receipt.message_ts)
                return ` <${url}|this message>`
              })()
              const receiptLink = `<${Tempo.formatTxLink(result.chainId, result.transactionHash)}|Receipt>`
              const text = `<@${result.senderProviderUserId}> boosted${originalReceiptLink} · ${receiptLink}`
              const body = new URLSearchParams()
              body.set(
                'blocks',
                JSON.stringify([
                  {
                    text: { text, type: 'mrkdwn' },
                    type: 'section',
                  },
                ]),
              )
              body.set('channel', channelId)
              body.set('text', text.replace(receiptLink, 'Receipt'))
              body.set('thread_ts', receipt.thread_ts)
              body.set('unfurl_links', 'false')
              body.set('unfurl_media', 'false')
              const response = await Chat.getSlack().withBotToken(installation.botToken, () =>
                fetch(`${c.env.SLACK_API_URL}/chat.postMessage`, {
                  body,
                  headers: { authorization: `Bearer ${installation.botToken}` },
                  method: 'POST',
                }),
              )
              const json = z.parse(
                z.object({
                  error: z.string().optional(),
                  ok: z.boolean().optional(),
                  ts: z.string().optional(),
                }),
                await response.json(),
              )
              if (!json.ok || !json.ts)
                throw new Error(json.error ?? 'Slack API chat.postMessage failed.')
              await Chat.recordSlackReceiptMessageForTransaction(c.var.db, {
                channelId,
                messageTs: json.ts,
                threadTs: receipt.thread_ts,
                transactionHash: result.transactionHash,
              })
              if (data.payload.skippedRecipients?.length) {
                const skippedBody = new URLSearchParams()
                const recipientCount = data.payload.recipients?.length ?? 1
                const skippedCount = data.payload.skippedRecipients.length
                skippedBody.set('channel', channelId)
                skippedBody.set(
                  'text',
                  `Boost sent to ${recipientCount} ${recipientCount === 1 ? 'account' : 'accounts'}. Skipped ${skippedCount} ${skippedCount === 1 ? 'account' : 'accounts'} that can no longer receive payments.`,
                )
                skippedBody.set('thread_ts', receipt.thread_ts)
                skippedBody.set('user', data.payload.senderProviderUserId)
                await Chat.getSlack().withBotToken(installation.botToken, () =>
                  fetch(`${c.env.SLACK_API_URL}/chat.postEphemeral`, {
                    body: skippedBody,
                    headers: { authorization: `Bearer ${installation.botToken}` },
                    method: 'POST',
                  }),
                )
              }
            })().catch((error) => {
              console.error('Failed to post Slack boost receipt after confirmation:', error)
            }),
          )
        else if (result.status === 'sent')
          c.executionCtx.waitUntil(
            (async () => {
              await Chat.getChat().initialize()
              const installation = await Chat.getSlack().getInstallation(data.payload.providerId)
              if (!installation) return

              const amount = result.isDefaultToken
                ? formatCurrencyAmount(result.amount, result.tokenCurrency)
                : formatTipAmount(result.amount, result.tokenCurrency, result.tokenSymbol)
              const text =
                'recipients' in result
                  ? `<@${result.senderProviderUserId}> ${result.memo ? 'sent' : 'tipped'} ${data.payload.groupId ? `<!subteam^${data.payload.groupId}${data.payload.groupLabel ? `|@${data.payload.groupLabel}` : ''}> ` : ''}${Chat.formatProviderUserMentionSummary(result.recipients.map((recipient) => recipient.recipientProviderUserId))} ${amount} each${result.memo ? ` for ${result.memo}` : ''}.\n${[
                      ...result.recipients.map(
                        (recipient) => `• <@${recipient.recipientProviderUserId}>`,
                      ),
                      ...(data.payload.skippedRecipients ?? [])
                        .slice(0, 10)
                        .map(
                          (recipient) =>
                            `• <@${recipient.recipientProviderUserId}> (${recipient.reason === 'you' ? 'you' : 'not connected yet'})`,
                        ),
                      ...((data.payload.skippedRecipients?.length ?? 0) > 10
                        ? [
                            `…and ${(data.payload.skippedRecipients?.length ?? 0) - 10} more not connected yet`,
                          ]
                        : []),
                    ].join('\n')}`
                  : `<@${result.senderProviderUserId}> ${result.memo ? 'sent' : 'tipped'} <@${result.recipientProviderUserId}> ${amount}${result.memo ? ` for ${result.memo}` : ''}.`
              const receiptText = text.replace(/\.$/, '')
              const receiptLink = `<${Tempo.formatTxLink(result.chainId, result.transactionHash)}|Receipt>`
              const receiptMessage = (() => {
                const lineBreakIndex = receiptText.indexOf('\n')
                if (lineBreakIndex === -1) return `${receiptText} · ${receiptLink}`
                return `${receiptText.slice(0, lineBreakIndex).replace(/\.$/, '')} · ${receiptLink}${receiptText.slice(lineBreakIndex)}`
              })()
              const threadId = data.payload.providerThreadId
              const body = new URLSearchParams()
              body.set(
                'blocks',
                JSON.stringify([
                  {
                    text: {
                      text: receiptMessage,
                      type: 'mrkdwn',
                    },
                    type: 'section',
                  },
                ]),
              )
              body.set('channel', data.payload.providerChannelId.replace(/^slack:/, ''))
              body.set('text', receiptMessage.replace(receiptLink, 'Receipt'))
              if (threadId) body.set('thread_ts', threadId)
              body.set('unfurl_links', 'false')
              body.set('unfurl_media', 'false')
              try {
                const response = await Chat.getSlack().withBotToken(installation.botToken, () =>
                  fetch(`${c.env.SLACK_API_URL}/chat.postMessage`, {
                    body,
                    headers: { authorization: `Bearer ${installation.botToken}` },
                    method: 'POST',
                  }),
                )
                const json = z.parse(
                  z.object({
                    error: z.string().optional(),
                    ok: z.boolean().optional(),
                    ts: z.string().optional(),
                  }),
                  await response.json(),
                )
                if (!json.ok) throw new Error(json.error ?? 'Slack API chat.postMessage failed.')
                if (json.ts)
                  await Chat.recordSlackReceiptMessageForTransaction(c.var.db, {
                    channelId: data.payload.providerChannelId.replace(/^slack:/, ''),
                    messageTs: json.ts,
                    threadTs: threadId ?? json.ts,
                    transactionHash: result.transactionHash,
                  })
              } finally {
                if (threadId) {
                  const statusBody = new URLSearchParams()
                  statusBody.set(
                    'channel_id',
                    data.payload.providerChannelId.replace(/^slack:/, ''),
                  )
                  statusBody.set('thread_ts', threadId)
                  statusBody.set('status', '')
                  await fetch(`${c.env.SLACK_API_URL}/assistant.threads.setStatus`, {
                    body: statusBody,
                    headers: { authorization: `Bearer ${installation.botToken}` },
                    method: 'POST',
                  }).catch(() => {
                    // Best effort only. Confirmed payment flow must not depend on Slack assistant UI cleanup.
                  })
                }
              }
            })().catch((error) => {
              console.error('Failed to post Slack receipt after confirmation:', error)
            }),
          )
        if (!('transactionHash' in result)) throw new Error('Payment failed.')
        return c.json({ ok: true as const, transactionHash: result.transactionHash })
      } catch (error) {
        return c.json(
          {
            code: 'confirmation_failed' as const,
            message: error instanceof Error ? error.message : 'Payment failed.',
            ok: false as const,
          },
          400,
        )
      }
    },
  )
  .post('/api/chat/slack', async (c) => {
    const request = c.req.raw
    const body = await request.text()
    if (
      !(await Slack.verifySlackSignature({
        body,
        signature: request.headers.get('x-slack-signature'),
        signingSecret: c.env.SLACK_SIGNING_SECRET,
        timestamp: request.headers.get('x-slack-request-timestamp'),
      }))
    )
      return new Response('Invalid signature', { status: 401 })

    const params = request.headers
      .get('content-type')
      ?.includes('application/x-www-form-urlencoded')
      ? new URLSearchParams(body)
      : null
    const duplicateKey = (() => {
      // Dedupe Slack block action retries before they can repeat side effects like
      // opening modals, deleting messages, or posting admin-denied notices.
      const interaction = (() => {
        const raw = params?.get('payload')
        if (!raw) return null
        let payload: unknown
        try {
          payload = JSON.parse(raw)
        } catch {
          return null
        }
        const parsed = z
          .looseObject({
            actions: z
              .array(
                z.object({
                  action_id: z.string().min(1).optional(),
                  value: z.string().optional(),
                }),
              )
              .optional(),
            container: z
              .looseObject({
                message_ts: z.string().optional(),
                view_id: z.string().optional(),
              })
              .optional(),
            team: z.object({ id: z.string().min(1) }).optional(),
            trigger_id: z.string().min(1).optional(),
            type: z.string().min(1),
            user: z.object({ id: z.string().min(1) }).optional(),
          })
          .safeParse(payload)
        if (!parsed.success) return null
        if (parsed.data.type !== 'block_actions') return null
        const actions = parsed.data.actions
          ?.map((action) => `${action.action_id ?? ''}:${action.value ?? ''}`)
          .join(',')
        return [
          'slack:interaction',
          parsed.data.team?.id ?? '',
          parsed.data.user?.id ?? '',
          parsed.data.trigger_id ?? '',
          parsed.data.container?.message_ts ?? parsed.data.container?.view_id ?? '',
          actions ?? '',
        ].join(':')
      })()
      if (interaction) return interaction
      if (params) return null

      // Dedupe reaction Events API retries by Slack event_id. Chat SDK already
      // dedupes message events, so keep this scoped to reactions only.
      let payload: unknown
      try {
        payload = JSON.parse(body)
      } catch {
        return null
      }
      const parsed = z
        .object({
          event: z.looseObject({ type: z.string().min(1) }).optional(),
          event_id: z.string().min(1).optional(),
          type: z.string().min(1).optional(),
        })
        .safeParse(payload)
      if (!parsed.success) return null
      if (parsed.data.type !== 'event_callback') return null
      if (!parsed.data.event_id) return null
      if (!['reaction_added', 'reaction_removed'].includes(parsed.data.event?.type ?? ''))
        return null
      return `slack:webhook:${parsed.data.event_id}`
    })()
    if (duplicateKey) {
      await Chat.getChat().initialize()
      const inserted = await Chat.getChat()
        .getState()
        .setIfNotExists(duplicateKey, true, 65 * 60 * 1000) // 65 minutes
      if (!inserted) return params ? new Response('', { status: 200 }) : c.json({ ok: true })
    }

    // Republish the Home tab when a user opens it. We intercept here because the
    // chat-adapter/slack AppHomeOpenedEvent does not expose team_id, so we can't
    // reliably resolve the workspace from inside bot.onAppHomeOpened.
    if (!params) {
      const payload = (() => {
        try {
          return JSON.parse(body)
        } catch {
          return null
        }
      })()
      const homeOpened = (() => {
        const parsed = z.safeParse(
          z.object({
            event: z
              .object({
                channel: z.string().min(1).optional(),
                tab: z.string().optional(),
                type: z.string().min(1),
                user: z.string().min(1),
              })
              .optional(),
            team_id: z.string().min(1).optional(),
            type: z.string().min(1).optional(),
          }),
          payload,
        )
        if (!parsed.success) return null
        if (parsed.data.type !== 'event_callback') return null
        if (parsed.data.event?.type !== 'app_home_opened') return null
        if (parsed.data.event.tab && parsed.data.event.tab !== 'home') return null
        if (!parsed.data.team_id) return null
        return { slackUserId: parsed.data.event.user, teamId: parsed.data.team_id }
      })()
      if (homeOpened) {
        c.executionCtx.waitUntil(
          Slack.publishHome({
            env: c.env,
            getInstallation: (teamId) => Chat.getSlack().getInstallation(teamId),
            initializeChat: () => Chat.getChat().initialize(),
            publishHomeView: (slackUserId, view) =>
              Chat.getSlack().publishHomeView(slackUserId, view),
            slackUserId: homeOpened.slackUserId,
            teamId: homeOpened.teamId,
            withBotToken: (botToken, fn) => Chat.getSlack().withBotToken(botToken, fn),
          }).catch((error) => {
            console.error('publishHome failed', error)
          }),
        )
        return new Response('', { status: 200 })
      }
    }

    if (params?.has('command') && !params.has('payload')) {
      const botMissingFromChannel = await (async () => {
        // Slash-command HTTP responses can render even when bot API posting cannot.
        // Detect that case before handing off to async chat handling.
        const channelId = params.get('channel_id')
        const teamId = params.get('team_id')
        if (!channelId || !teamId) return false
        if (channelId.startsWith('D')) return false

        await Chat.getChat().initialize()
        const installation = await Chat.getSlack().getInstallation(teamId)
        if (!installation) return false

        const infoBody = new URLSearchParams()
        infoBody.set('channel', channelId)
        const response = await Chat.getSlack().withBotToken(installation.botToken, () =>
          fetch(`${c.env.SLACK_API_URL}/conversations.info`, {
            body: infoBody,
            headers: { authorization: `Bearer ${installation.botToken}` },
            method: 'POST',
          }),
        )
        const json = z.parse(
          z.object({
            channel: z
              .object({
                is_ext_shared: z.boolean().optional(),
                is_member: z.boolean().optional(),
                is_org_shared: z.boolean().optional(),
                is_shared: z.boolean().optional(),
              })
              .optional(),
            error: z.string().optional(),
            ok: z.boolean().optional(),
          }),
          await response.json(),
        )
        if (!json.ok) return false
        if (json.channel?.is_ext_shared || json.channel?.is_org_shared || json.channel?.is_shared)
          return false
        return json.channel?.is_member === false
      })()
      if (botMissingFromChannel)
        return c.json({
          response_type: 'ephemeral' as const,
          text: (() => {
            // Echo the attempted command so the member can retry after inviting Tipbot.
            const commandText = [
              params.get('command') || getSlackCommand(c.env.HOST),
              params.get('text'),
            ]
              .filter(Boolean)
              .join(' ')
            return [
              'Tipbot isn’t in this channel, so it can’t send tips here yet.',
              '',
              `Run \`/invite @${getSlackBotDisplayName(c.env.HOST)}\`, then try this again:`,
              `\`${commandText}\``,
            ].join('\n')
          })(),
        })

      const tasks: Promise<unknown>[] = []
      const task = (async () => {
        await Chat.getChat().webhooks.slack(
          new Request(request.url, {
            body,
            headers: request.headers,
            method: request.method,
          }),
          {
            waitUntil(promise) {
              tasks.push(promise)
              try {
                c.executionCtx.waitUntil(promise)
              } catch {}
            },
          },
        )
        await Promise.all(tasks)
      })()
      c.executionCtx.waitUntil(task)
      return new Response('', { status: 200 })
    }

    return await Chat.getChat().webhooks.slack(
      new Request(request.url, {
        body,
        headers: request.headers,
        method: request.method,
      }),
      {
        waitUntil(promise) {
          try {
            c.executionCtx.waitUntil(promise)
          } catch {}
        },
      },
    )
  })
  .get('/api/chat/slack/install', async (c) => {
    const redirectUri = `https://${c.env.HOST}/api/chat/slack/oauth/callback`
    const payload = Base64.fromString(
      JSON.stringify({ expiresAt: Date.now() + 10 * 60 * 1000, redirectUri }), // 10 minutes
      { pad: false, url: true },
    )

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(c.env.SECRET_KEY),
      { hash: 'SHA-256', name: 'HMAC' },
      false,
      ['sign'],
    )
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
    const url = new URL('/oauth/v2/authorize', c.env.SLACK_API_URL)
    url.searchParams.set('client_id', c.env.SLACK_CLIENT_ID)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set(
      'scope',
      [
        'app_mentions:read',
        'assistant:write',
        'channels:history',
        'channels:read',
        'chat:write',
        'commands',
        'emoji:read',
        'groups:history',
        'groups:read',
        'reactions:read',
        'usergroups:read',
        'users:read',
      ].join(','),
    )
    url.searchParams.set('state', `${payload}.${Hex.fromBytes(new Uint8Array(digest))}`)
    return Response.redirect(url.toString(), 302)
  })
  .get(
    '/api/chat/slack/oauth/callback',
    hono.validator(
      'query',
      z.union([
        z.object({ error: z.string().min(1) }).catchall(z.unknown()),
        z.object({ code: z.string().min(1), state: z.string().min(1) }).catchall(z.unknown()),
      ]),
    ),
    async (c) => {
      try {
        const query = c.req.valid('query')
        if ('error' in query)
          return c.json(
            {
              code: 'slack_install_failed' as const,
              message: `Slack install failed: ${String(query.error)}`,
            },
            400,
          )

        const [payload, signature] = query.state.split('.')
        if (!payload || !signature)
          return c.json(
            {
              code: 'invalid_slack_install_state' as const,
              message: 'Slack install state is invalid.',
            },
            400,
          )

        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(c.env.SECRET_KEY),
          { hash: 'SHA-256', name: 'HMAC' },
          false,
          ['sign'],
        )
        const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
        const expectedSignature = Hex.fromBytes(new Uint8Array(digest))
        if (signature.length !== expectedSignature.length)
          return c.json(
            {
              code: 'invalid_slack_install_state' as const,
              message: 'Slack install state signature is invalid.',
            },
            400,
          )

        let signatureDifference = 0
        for (let i = 0; i < signature.length; i += 1)
          signatureDifference |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i)
        if (signatureDifference !== 0)
          return c.json(
            {
              code: 'invalid_slack_install_state' as const,
              message: 'Slack install state signature is invalid.',
            },
            400,
          )

        const stateData = z.parse(
          z.object({ expiresAt: z.number(), redirectUri: z.string() }),
          JSON.parse(Base64.toString(payload)),
        )
        if (Date.now() > stateData.expiresAt)
          return c.json(
            {
              code: 'expired_slack_install_state' as const,
              message: 'Slack install state expired.',
            },
            400,
          )

        const redirectUri = `https://${c.env.HOST}/api/chat/slack/oauth/callback`
        if (stateData.redirectUri !== redirectUri)
          return c.json(
            {
              code: 'invalid_slack_install_state' as const,
              message: 'Slack install callback redirect URI does not match state.',
            },
            400,
          )

        await Chat.getChat().initialize()
        const result = await Chat.getSlack().handleOAuthCallback(c.req.raw, { redirectUri })
        const workspace = await c.var.db
          .selectFrom('workspace')
          .selectAll()
          .where('provider', '=', 'slack')
          .where('provider_id', '=', result.teamId)
          .executeTakeFirst()
        const now = new Date().toISOString()
        const previewReactionTipEmojis = getPreviewReactionTipEmojis(c.env.HOST)
        const workspaceId = workspace?.id ?? Nanoid.generate()
        if (workspace)
          await c.var.db
            .updateTable('workspace')
            .set({
              installed_at: now,
              name: result.installation.teamName ?? null,
              uninstalled_at: null,
              updated_at: now,
            })
            .where('id', '=', workspace.id)
            .execute()
        else {
          await c.var.db
            .insertInto('workspace')
            .values({
              created_at: now,
              default_amount: 1000,
              id: workspaceId,
              installed_at: now,
              name: result.installation.teamName ?? null,
              provider: 'slack',
              provider_id: result.teamId,
              uninstalled_at: null,
              updated_at: now,
            })
            .execute()
        }
        if (previewReactionTipEmojis) {
          // Preview Slack apps use PR-specific reaction emojis, so replace default fallback
          // behavior with preview-specific reaction tip configs.
          await c.var.db
            .deleteFrom('reaction_tip_config')
            .where('workspace_id', '=', workspaceId)
            .execute()
          await c.var.db
            .insertInto('reaction_tip_config')
            .values(
              Tip.defaultReactionTipConfigs.map((config, index) => ({
                amount: config.amount,
                created_at: now,
                emoji: previewReactionTipEmojis[index]!,
                id: Nanoid.generate(),
                updated_at: now,
                workspace_id: workspaceId,
              })),
            )
            .execute()
        }

        const url = new URL(c.req.url)
        return Response.redirect(
          `${url.origin}/?slack=installed&team=${encodeURIComponent(result.installation.teamName ?? result.teamId)}`,
          302,
        )
      } catch (error) {
        return c.json(
          {
            code: 'slack_oauth_failed' as const,
            message: error instanceof Error ? error.message : 'Request failed.',
          },
          400,
        )
      }
    },
  )
  .get('/api/health', async (c) => {
    await c.env.DB.prepare('SELECT 1').first()
    return c.json({ ok: true })
  })
