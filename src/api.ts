import { Hono } from 'hono'
import { Address, Base64, Hex } from 'ox'
import * as chat from 'chat'
import { z } from 'zod'
import * as Chat from '#/chat.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import { getSlackBotDisplayName, getSlackCommand } from '#/lib/app.ts'
import { formatAmount, formatCurrencyAmount, formatTipAmount } from '#/lib/format.ts'
import * as hono from '#/lib/hono.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as ProviderIdentity from '#/lib/providerIdentity.ts'
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
          'account_link_token.used_at',
          'member.provider_identity_id as member_provider_identity_id',
          'member.provider_user_id as member_provider_user_id',
          'workspace.chain_id',
          'workspace.default_token_address',
          'workspace.id as workspace_id',
          'workspace.provider as workspace_provider',
          'workspace.provider_id',
          'workspace.reaction_tip_emoji',
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
          .leftJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
          .select(['member.id', 'member.provider_identity_id'])
          .where('member.workspace_id', '=', link.workspace_id)
          .where('member.id', '!=', link.member_id)
          .where((eb) =>
            eb.or([
              eb('member.account_id', '=', account.id),
              eb('provider_identity.account_id', '=', account.id),
            ]),
          )
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
            .leftJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
            .select('member.provider_identity_id')
            .where('member.workspace_id', '=', link.workspace_id)
            .where('member.id', '!=', link.member_id)
            .where((eb) =>
              eb.or([
                eb('member.account_id', '=', account.id),
                eb('provider_identity.account_id', '=', account.id),
              ]),
            )
            .execute()
          const duplicateIdentityIds = duplicateIdentities
            .map((row) => row.provider_identity_id)
            .filter((id) => id !== null)
          await c.var.db
            .updateTable('member')
            .set({ account_id: null, updated_at: now })
            .where('workspace_id', '=', link.workspace_id)
            .where('account_id', '=', account.id)
            .where('id', '!=', link.member_id)
            .execute()
          if (duplicateIdentityIds.length)
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
        const identity = await ProviderIdentity.ensureForMember(c.var.db, {
          accountId: account.id,
          displayName: null,
          memberId: link.member_id,
          provider: link.workspace_provider,
          providerUserId: link.member_provider_user_id,
          providerWorkspaceId: link.provider_id,
          realName: null,
        })
        await c.var.db
          .updateTable('member')
          .set({ account_id: account.id, provider_identity_id: identity.id, updated_at: now })
          .where('id', '=', link.member_id)
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

        if (link.provider_channel_id)
          c.executionCtx.waitUntil(
            (async () => {
              await Chat.getChat().initialize()
              const installation = await Chat.getSlack().getInstallation(link.provider_id)
              if (!installation) return

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
                          `Mention \`@${getSlackBotDisplayName(c.env.HOST)} @user\` or use \`${getSlackCommand(c.env.HOST)} @user\` to send a payment. React with :${link.reaction_tip_emoji}: to tip a message.`,
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
                .where('workspace.provider_id', '=', data.payload.providerId)
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
                reaction: reactionTip.reaction,
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
                  ? `<@${result.senderProviderUserId}> ${result.memo ? 'sent' : 'tipped'} ${result.recipients.length} accounts ${amount} each${result.memo ? ` for ${result.memo}` : ''}.\n${result.recipients.map((recipient) => `• <@${recipient.recipientProviderUserId}>`).join('\n')}`
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
                  }),
                  await response.json(),
                )
                if (!json.ok) throw new Error(json.error ?? 'Slack API chat.postMessage failed.')
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
    c.executionCtx.waitUntil(
      logSlackConnectDebug(c.env, body, params).catch((error) => {
        console.error('Failed to log Slack Connect debug fields:', error)
      }),
    )
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

    if (params?.has('command') && !params.has('payload')) {
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
        'groups:history',
        'groups:read',
        'reactions:read',
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
        if (workspace)
          await c.var.db
            .updateTable('workspace')
            .set({ name: result.installation.teamName ?? null, updated_at: now })
            .where('id', '=', workspace.id)
            .execute()
        else
          await c.var.db
            .insertInto('workspace')
            .values({
              created_at: now,
              default_amount: 1000,
              id: Nanoid.generate(),
              name: result.installation.teamName ?? null,
              provider: 'slack',
              provider_id: result.teamId,
              updated_at: now,
            })
            .execute()

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

async function logSlackConnectDebug(env: Env, body: string, params: URLSearchParams | null) {
  if (env.SLACK_CONNECT_DEBUG !== '1') return

  if (params?.has('command') && !params.has('payload')) {
    await logSlackConnectCommandDebug(env, params)
    return
  }
  if (params) return

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return
  }
  const parsed = z
    .object({
      authorizations: z
        .array(
          z
            .object({
              enterprise_id: z.string().nullable().optional(),
              is_bot: z.boolean().optional(),
              is_enterprise_install: z.boolean().optional(),
              team_id: z.string().nullable().optional(),
              user_id: z.string().nullable().optional(),
            })
            .passthrough(),
        )
        .optional(),
      context_enterprise_id: z.string().nullable().optional(),
      context_team_id: z.string().nullable().optional(),
      event: z
        .object({
          channel: z.string().optional(),
          item: z.object({ channel: z.string().optional() }).passthrough().optional(),
          team: z.string().optional(),
          team_id: z.string().optional(),
          text: z.string().optional(),
          type: z.string().optional(),
          user: z.string().optional(),
        })
        .passthrough()
        .optional(),
      event_context: z.string().optional(),
      event_id: z.string().optional(),
      is_ext_shared_channel: z.boolean().optional(),
      team_id: z.string().optional(),
      type: z.string().optional(),
    })
    .passthrough()
    .safeParse(payload)
  if (!parsed.success || parsed.data.type !== 'event_callback') return
  if (!parsed.data.is_ext_shared_channel) return

  const mentionedUserIds = extractSlackMentionedUserIds(parsed.data.event?.text ?? '')
  const channelId = parsed.data.event?.channel ?? parsed.data.event?.item?.channel
  const eventTeamId = parsed.data.event?.team_id ?? parsed.data.event?.team
  const teamId = parsed.data.team_id ?? parsed.data.context_team_id ?? parsed.data.event?.team_id
  console.info(
    JSON.stringify({
      authorizations: parsed.data.authorizations?.map((authorization) => ({
        enterprise_id: authorization.enterprise_id ?? null,
        is_bot: authorization.is_bot ?? null,
        is_enterprise_install: authorization.is_enterprise_install ?? null,
        team_id: authorization.team_id ?? null,
        user_id: authorization.user_id ?? null,
      })),
      channel_info_by_token: await getSlackConnectDebugChannelInfoByTokenTeam(
        env,
        [teamId, eventTeamId],
        channelId,
      ),
      context_enterprise_id: parsed.data.context_enterprise_id ?? null,
      context_team_id: parsed.data.context_team_id ?? null,
      event_channel_id: parsed.data.event?.channel ?? parsed.data.event?.item?.channel ?? null,
      event_context: parsed.data.event_context ?? null,
      event_id: parsed.data.event_id ?? null,
      event_team_id: parsed.data.event?.team_id ?? parsed.data.event?.team ?? null,
      event_type: parsed.data.event?.type ?? null,
      is_ext_shared_channel: parsed.data.is_ext_shared_channel ?? null,
      mentioned_user_ids: mentionedUserIds,
      source: 'tipbot.slack_connect_debug',
      team_id: parsed.data.team_id ?? null,
      user_id: parsed.data.event?.user ?? null,
      users_info: await getSlackConnectDebugUsersInfo(env, teamId, mentionedUserIds),
      users_info_by_token: await getSlackConnectDebugUsersInfoByTokenTeam(
        env,
        [teamId, eventTeamId],
        mentionedUserIds,
      ),
    }),
  )
}

async function logSlackConnectCommandDebug(env: Env, params: URLSearchParams) {
  const teamId = params.get('team_id')
  const channelId = params.get('channel_id')
  if (!teamId || !channelId) return

  await Chat.getChat().initialize()
  const installation = await Chat.getSlack().getInstallation(teamId)
  if (!installation) return

  const conversation = await getSlackConnectDebugConversation(env, installation.botToken, channelId)
  if (!conversation?.is_ext_shared) return
  const mentionedUserIds = extractSlackMentionedUserIds(params.get('text') ?? '')
  console.info(
    JSON.stringify({
      channel_id: channelId,
      channel_info: sanitizeSlackConnectDebugConversation(conversation),
      command: params.get('command'),
      is_ext_shared_channel: true,
      mentioned_user_ids: mentionedUserIds,
      source: 'tipbot.slack_connect_debug',
      team_id: teamId,
      user_id: params.get('user_id'),
      users_info: await getSlackConnectDebugUsersInfo(env, teamId, mentionedUserIds),
    }),
  )
}

async function getSlackConnectDebugConversation(env: Env, botToken: string, channelId: string) {
  const body = new URLSearchParams()
  body.set('channel', channelId)
  const response = await Chat.getSlack().withBotToken(botToken, () =>
    fetch(`${env.SLACK_API_URL}/conversations.info`, {
      body,
      headers: { authorization: `Bearer ${botToken}` },
      method: 'POST',
    }),
  )
  const json = z.parse(
    z.object({
      channel: z
        .object({
          context_team_id: z.string().optional(),
          conversation_host_id: z.string().optional(),
          id: z.string().optional(),
          is_ext_shared: z.boolean().optional(),
          is_org_shared: z.boolean().optional(),
          is_pending_ext_shared: z.boolean().optional(),
          is_shared: z.boolean().optional(),
          pending_connected_team_ids: z.array(z.string()).optional(),
          pending_shared: z.array(z.string()).optional(),
          shared_team_ids: z.array(z.string()).optional(),
        })
        .passthrough()
        .optional(),
      ok: z.boolean().optional(),
    }),
    await response.json(),
  )
  if (!json.ok) return null
  return json.channel ?? null
}

async function getSlackConnectDebugChannelInfoByTokenTeam(
  env: Env,
  teamIds: Array<string | undefined>,
  channelId: string | undefined,
) {
  if (!channelId) return []
  return await Promise.all(
    [...new Set(teamIds.filter((teamId) => teamId !== undefined))].map(async (teamId) => {
      await Chat.getChat().initialize()
      const installation = await Chat.getSlack().getInstallation(teamId)
      return {
        channel_info: installation
          ? sanitizeSlackConnectDebugConversation(
              await getSlackConnectDebugConversation(env, installation.botToken, channelId),
            )
          : null,
        token_team_id: teamId,
      }
    }),
  )
}

function sanitizeSlackConnectDebugConversation(
  conversation: Awaited<ReturnType<typeof getSlackConnectDebugConversation>>,
) {
  if (!conversation) return null
  return {
    context_team_id: conversation.context_team_id ?? null,
    conversation_host_id: conversation.conversation_host_id ?? null,
    id: conversation.id ?? null,
    is_ext_shared: conversation.is_ext_shared ?? null,
    is_org_shared: conversation.is_org_shared ?? null,
    is_pending_ext_shared: conversation.is_pending_ext_shared ?? null,
    is_shared: conversation.is_shared ?? null,
    pending_connected_team_ids: conversation.pending_connected_team_ids ?? [],
    pending_shared: conversation.pending_shared ?? [],
    shared_team_ids: conversation.shared_team_ids ?? [],
  }
}

async function getSlackConnectDebugUsersInfo(
  env: Env,
  teamId: string | undefined,
  userIds: string[],
) {
  if (!teamId || userIds.length === 0) return []
  await Chat.getChat().initialize()
  const installation = await Chat.getSlack().getInstallation(teamId)
  if (!installation) return []
  return await Promise.all(
    userIds.map(async (userId) => {
      const body = new URLSearchParams()
      body.set('user', userId)
      const response = await Chat.getSlack().withBotToken(installation.botToken, () =>
        fetch(`${env.SLACK_API_URL}/users.info`, {
          body,
          headers: { authorization: `Bearer ${installation.botToken}` },
          method: 'POST',
        }),
      )
      const json = z.parse(
        z.object({
          error: z.string().optional(),
          ok: z.boolean().optional(),
          user: z
            .object({
              enterprise_user: z
                .object({
                  enterprise_id: z.string().optional(),
                  id: z.string().optional(),
                  is_admin: z.boolean().optional(),
                  is_owner: z.boolean().optional(),
                  team_id: z.string().optional(),
                })
                .passthrough()
                .nullable()
                .optional(),
              is_bot: z.boolean().optional(),
              is_restricted: z.boolean().optional(),
              id: z.string().optional(),
              is_stranger: z.boolean().optional(),
              team_id: z.string().optional(),
              is_ultra_restricted: z.boolean().optional(),
            })
            .passthrough()
            .optional(),
        }),
        await response.json(),
      )
      return {
        error: json.ok ? null : (json.error ?? null),
        id: json.user?.id ?? userId,
        is_bot: json.user?.is_bot ?? null,
        is_restricted: json.user?.is_restricted ?? null,
        is_stranger: json.user?.is_stranger ?? null,
        is_ultra_restricted: json.user?.is_ultra_restricted ?? null,
        ok: Boolean(json.ok),
        team_id: json.user?.team_id ?? null,
        enterprise_user: json.user?.enterprise_user
          ? {
              enterprise_id: json.user.enterprise_user.enterprise_id ?? null,
              id: json.user.enterprise_user.id ?? null,
              is_admin: json.user.enterprise_user.is_admin ?? null,
              is_owner: json.user.enterprise_user.is_owner ?? null,
              team_id: json.user.enterprise_user.team_id ?? null,
            }
          : null,
      }
    }),
  )
}

async function getSlackConnectDebugUsersInfoByTokenTeam(
  env: Env,
  teamIds: Array<string | undefined>,
  userIds: string[],
) {
  return await Promise.all(
    [...new Set(teamIds.filter((teamId) => teamId !== undefined))].map(async (teamId) => ({
      token_team_id: teamId,
      users_info: await getSlackConnectDebugUsersInfo(env, teamId, userIds),
    })),
  )
}

function extractSlackMentionedUserIds(text: string) {
  return [...new Set([...text.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]+)?>/g)].map((match) => match[1]!))]
}
