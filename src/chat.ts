import * as DB from '#db/client.ts'
import type { DB as DB_gen } from '#db/types.gen.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as AccessKey from '#/lib/accessKey.ts'
import { formatAmount, formatTipAmount } from '#/lib/format.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Tip from '#/lib/tip.ts'
import { createCloudflareState } from '#/vendor/chatStateCloudflareDO.ts'
import { createSlackAdapter } from '@chat-adapter/slack'
import * as chat from 'chat'
import { env } from 'cloudflare:workers'
import { z } from 'zod'

let bot: chat.Chat | null = null
export function getChat() {
  if (bot) return bot
  bot = new chat.Chat({
    adapters: { slack: getSlack() },
    state: createCloudflareState({
      name: 'tipbot',
      namespace: env.CHAT_STATE,
      shardKey(threadId) {
        return threadId.split(':', 1)[0] || 'default'
      },
    }),
    userName: 'tipbot',
  })
  bot.onSlashCommand('/tip', async (event) => {
    const context = {
      db: DB.create(env.DB),
      provider: getProvider(event),
      text: event.text.trim(),
    } satisfies HandlerContext

    const match = context.text.match(commandPattern)
    if (match) {
      const name = z.parse(z.enum(commandNames), match[1])
      await handlers[name](event, { ...context, text: match[2]?.trim() ?? '' })
      return
    }
    await handlers.default(event, context)
  })
  bot.onAction(async (event) => {
    const action = z.safeParse(z.enum(actionNames), event.actionId)
    if (!action.success) return
    await actions[action.data](event)
  })
  bot.onModalSubmit(async (event) => {
    const modalSubmit = z.enum(modalSubmitNames).safeParse(event.callbackId)
    if (!modalSubmit.success) return

    return await modalSubmits[modalSubmit.data](event)
  })
  return bot
}

let slack: ReturnType<typeof createSlackAdapter> | null = null
export function getSlack() {
  if (slack) return slack
  slack = createSlackAdapter({
    apiUrl: `${env.SLACK_API_URL}/`,
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    encryptionKey: env.SECRET_KEY,
    signingSecret: env.SLACK_SIGNING_SECRET,
  })
  return slack
}

const actions = {
  async config_edit(event) {
    if (event.adapter !== getSlack()) throw new Error('Provider not implemented yet.')
    const raw = z.parse(
      z.object({
        channel: z.object({ id: z.string().min(1) }).optional(),
        container: z.object({ channel_id: z.string().min(1).optional() }).optional(),
        team: z.object({ id: z.string().min(1) }),
      }),
      event.raw,
    )
    const workspace = await DB.create(env.DB)
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', 'slack')
      .where('provider_id', '=', raw.team.id)
      .executeTakeFirst()
    if (!workspace) return

    if (!(await isSlackAdmin(raw.team.id, event.user.userId))) {
      const channelId = raw.channel?.id ?? raw.container?.channel_id
      if (channelId)
        await getChat()
          .channel(`slack:${channelId}`)
          .postEphemeral(
            event.user,
            {
              card: chat.Card({
                children: [chat.CardText('Only Slack admins can change Tipbot settings.')],
                title: 'Admin permission required',
              }),
              fallbackText:
                'Admin permission required\nOnly Slack admins can change Tipbot settings.',
            },
            { fallbackToDM: false },
          )
      else if (event.thread)
        await event.thread.postEphemeral(
          event.user,
          {
            card: chat.Card({
              children: [chat.CardText('Only Slack admins can change Tipbot settings.')],
              title: 'Admin permission required',
            }),
            fallbackText:
              'Admin permission required\nOnly Slack admins can change Tipbot settings.',
          },
          { fallbackToDM: false },
        )
      return
    }

    const tokenAddress = workspace.default_token_address ?? Tempo.pathUsdAddress
    const tokenValue = (() => {
      if (tokenAddress.toLowerCase() === Tempo.alphaUsdAddress.toLowerCase()) return 'AlphaUSD'
      if (tokenAddress.toLowerCase() === Tempo.betaUsdAddress.toLowerCase()) return 'BetaUSD'
      if (tokenAddress.toLowerCase() === Tempo.thetaUsdAddress.toLowerCase()) return 'ThetaUSD'
      return 'pathUSD'
    })()
    await event.openModal(
      chat.Modal({
        callbackId: 'config_edit',
        children: [
          chat.Select({
            id: 'network',
            initialOption: workspace.chain_id === Tempo.mainnetChainId ? 'mainnet' : 'testnet',
            label: 'Network',
            options: [
              chat.SelectOption({ label: 'Mainnet', value: 'mainnet' }),
              chat.SelectOption({ label: 'Testnet', value: 'testnet' }),
            ],
          }),
          chat.Select({
            id: 'default_token',
            initialOption: tokenValue,
            label: 'Default token',
            options: [
              chat.SelectOption({ label: 'pathUSD', value: 'pathUSD' }),
              chat.SelectOption({ label: 'AlphaUSD', value: 'AlphaUSD' }),
              chat.SelectOption({ label: 'BetaUSD', value: 'BetaUSD' }),
              chat.SelectOption({ label: 'ThetaUSD', value: 'ThetaUSD' }),
            ],
          }),
          chat.TextInput({
            id: 'default_amount',
            initialValue: formatAmount(workspace.default_amount),
            label: 'Default amount',
          }),
        ],
        privateMetadata: JSON.stringify({ providerId: raw.team.id }),
        submitLabel: 'Save',
        title: 'Edit workspace settings',
      }),
    )
  },
  async connect_cancel(event) {
    await event.adapter.deleteMessage(event.threadId, event.messageId)
  },
} as const satisfies Record<
  (typeof actionNames)[number],
  (event: chat.ActionEvent) => Promise<void>
>

const modalSubmits = {
  async config_edit(event) {
    const metadata = z.parse(
      z.object({
        providerId: z.string().min(1),
      }),
      JSON.parse(event.privateMetadata ?? '{}'),
    )
    if (!(await isSlackAdmin(metadata.providerId, event.user.userId))) return

    const chainId = (() => {
      if (event.values.network === 'mainnet') return Tempo.mainnetChainId
      if (event.values.network === 'testnet') return Tempo.moderatoChainId
      return null
    })()
    const tokenAddress = (() => {
      if (event.values.default_token === 'pathUSD') return Tempo.pathUsdAddress
      if (event.values.default_token === 'AlphaUSD') return Tempo.alphaUsdAddress
      if (event.values.default_token === 'BetaUSD') return Tempo.betaUsdAddress
      if (event.values.default_token === 'ThetaUSD') return Tempo.thetaUsdAddress
      return null
    })()
    const amount = Tip.parseAmount(event.values.default_amount ?? '')
    const errors: Record<string, string> = {}
    if (chainId === null) errors.network = 'Choose Mainnet or Testnet.'
    if (tokenAddress === null) errors.default_token = 'Choose a default token.'
    if (amount === null)
      errors.default_amount = 'Enter a positive amount with up to 6 decimal places. Example: 0.005'
    if (chainId !== null && tokenAddress !== null && !Tempo.isAllowedToken(chainId, tokenAddress))
      errors.default_token = 'This token isn’t available on the selected network.'
    if (Object.keys(errors).length > 0) return { action: 'errors' as const, errors }
    if (amount === null || chainId === null || tokenAddress === null) return

    const now = new Date().toISOString()
    await DB.create(env.DB)
      .updateTable('workspace')
      .set({
        chain_id: chainId,
        default_amount: amount,
        default_token_address: tokenAddress,
        updated_at: now,
      })
      .where('provider', '=', 'slack')
      .where('provider_id', '=', metadata.providerId)
      .execute()

    const workspace = await DB.create(env.DB)
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', 'slack')
      .where('provider_id', '=', metadata.providerId)
      .executeTakeFirstOrThrow()
    if (event.relatedMessage)
      await event.relatedMessage.edit(configCard(workspace, { canEdit: true, updated: true }))
  },
} as const satisfies Record<
  (typeof modalSubmitNames)[number],
  (event: chat.ModalSubmitEvent) => Promise<chat.ModalResponse | void | undefined>
>

const handlers = {
  async config(event, ctx) {
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()
    if (!workspace) {
      await event.channel.postEphemeral(
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
        { fallbackToDM: false },
      )
      return
    }

    await event.channel.postEphemeral(
      event.user,
      configCard(workspace, { canEdit: await isSlackAdmin(ctx.provider.id, event.user.userId) }),
      { fallbackToDM: false },
    )
  },
  async connect(event, ctx) {
    await postConnectLink(event, ctx)
  },
  async disconnect(event, ctx) {
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()
    if (!workspace) {
      await event.channel.postEphemeral(
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
        { fallbackToDM: false },
      )
      return
    }

    const member = await ctx.db
      .selectFrom('member')
      .selectAll()
      .where('workspace_id', '=', workspace.id)
      .where('provider_user_id', '=', event.user.userId)
      .executeTakeFirst()
    if (!member?.account_id) {
      await event.channel.postEphemeral(event.user, 'No account connected.', {
        fallbackToDM: false,
      })
      return
    }

    await ctx.db.deleteFrom('access_key').where('account_id', '=', member.account_id).execute()
    await ctx.db
      .updateTable('member')
      .set({ account_id: null, updated_at: new Date().toISOString() })
      .where('id', '=', member.id)
      .execute()
    await event.channel.postEphemeral(event.user, 'Disconnected from Tipbot', {
      fallbackToDM: false,
    })
  },
  async help(event, ctx) {
    if (ctx.provider.type !== 'slack') throw new Error('Provider not implemented yet.')

    const installation = await getSlack().getInstallation(ctx.provider.id)
    if (!installation) return

    const rows = [
      ['/tip @account for coffee', 'Send payment in chat'],
      ['/tip config', 'Manage workspace configuration'],
      ['/tip connect', 'Connect to Tipbot'],
      ['/tip disconnect', 'Disconnect from Tipbot'],
      ['/tip help', 'Show help message'],
      ['/tip status', 'Check connection status'],
    ]
    const body = new URLSearchParams()
    body.set('channel', event.channel.id.replace(/^slack:/, ''))
    body.set('text', rows.map((row) => `${row[0]} ${row[1]}`).join('\n'))
    body.set(
      'blocks',
      JSON.stringify([
        {
          rows: [
            [slackTableCell('Command'), slackTableCell('Description')],
            ...rows.map((row) => [slackTableCell(row[0], { code: true }), slackTableCell(row[1])]),
          ],
          type: 'table',
        },
      ]),
    )
    body.set('user', event.user.userId)
    const response = await getSlack().withBotToken(installation.botToken, () =>
      fetch(`${env.SLACK_API_URL}/chat.postEphemeral`, {
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
    if (!json.ok) throw new Error(json.error ?? 'Slack API chat.postEphemeral failed.')
  },
  async status(event, ctx) {
    const workspace = await ctx.db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', ctx.provider.type)
      .where('provider_id', '=', ctx.provider.id)
      .executeTakeFirst()
    if (!workspace) {
      await event.channel.postEphemeral(
        event.user,
        'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
        { fallbackToDM: false },
      )
      return
    }

    const member = await ctx.db
      .selectFrom('member')
      .innerJoin('account', 'account.id', 'member.account_id')
      .select([
        'account.address as account_address',
        'account.id as account_id',
        'member.provider_user_id',
      ])
      .where('member.workspace_id', '=', workspace.id)
      .where('member.provider_user_id', '=', event.user.userId)
      .executeTakeFirst()
    if (!member) {
      await event.channel.postEphemeral(event.user, 'No account connected.', {
        fallbackToDM: false,
      })
      return
    }

    await event.channel.postEphemeral(
      event.user,
      {
        card: chat.Card({
          children: [
            chat.Table({
              headers: ['Field', 'Value'],
              rows: [
                ['Account ID', member.account_id],
                ['Address', member.account_address],
                ['Provider user ID', member.provider_user_id],
              ],
            }),
          ],
        }),
        fallbackText: `Account ID ${member.account_id}\nAddress ${member.account_address}\nProvider user ID ${member.provider_user_id}`,
      },
      { fallbackToDM: false },
    )
  },
  async default(event, ctx) {
    const parsed = Tip.parseTipText(ctx.text)
    if (!parsed) {
      if (ctx.provider.type !== 'slack') throw new Error('Provider not implemented yet.')

      const installation = await getSlack().getInstallation(ctx.provider.id)
      if (!installation) throw new Error('Tibot app not installed for this workspace.')

      const body = new URLSearchParams()
      body.set('channel', event.channel.id.replace(/^slack:/, ''))
      body.set('text', 'Invalid `/tip` usage. Try `/tip @account` or `/tip help` for more info.')
      body.set('user', event.user.userId)
      const response = await getSlack().withBotToken(installation.botToken, () =>
        fetch(`${env.SLACK_API_URL}/chat.postEphemeral`, {
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
      if (!json.ok) throw new Error(json.error ?? 'Slack API chat.postEphemeral failed.')
      return
    }

    if (!event.triggerId) {
      await event.channel.postEphemeral(event.user, 'Payment not sent. Try again.', {
        fallbackToDM: false,
      })
      return
    }

    const result = await Tip.handleTipRequest(env, {
      idempotencyKey: `command:${ctx.provider.id}:${event.triggerId}`,
      memo: parsed.memo,
      provider: ctx.provider.type,
      providerId: ctx.provider.id,
      recipientProviderUserId: parsed.recipientProviderUserId,
      senderProviderUserId: event.user.userId,
    }).catch(
      (error) =>
        ({
          code: 'failed',
          message: error instanceof Error ? error.message : 'Command failed.',
          ok: false,
        }) satisfies Tip.TipResult,
    )

    if (result.ok && result.status === 'sent')
      await event.channel.post(
        `${event.channel.mentionUser(result.senderProviderUserId)} sent ${event.channel.mentionUser(result.recipientProviderUserId)} ${formatTipAmount(result.amount, result.tokenCurrency, result.tokenSymbol)}${result.memo ? ` for ${result.memo}` : ''}. ${formatReceiptLink(result.chainId, result.transactionHash)}`,
      )
    else if (result.ok)
      await event.channel.postEphemeral(
        event.user,
        `Payment sent. ${formatReceiptLink(result.chainId, result.transactionHash)}`,
        { fallbackToDM: false },
      )
    else {
      if (result.code === 'sender_unconnected' || result.code === 'missing_sender_access_key') {
        await postConnectLink(event, ctx)
        return
      }
      await event.channel.postEphemeral(
        event.user,
        (() => {
          const receipt =
            'chainId' in result &&
            result.chainId &&
            'transactionHash' in result &&
            result.transactionHash
              ? ` ${formatReceiptLink(result.chainId, result.transactionHash)}`
              : ''
          if (result.code === 'self_tip')
            return 'Payment not sent. Cannot send a payment to yourself.'
          if (result.code === 'recipient_unconnected')
            return `Payment not sent. ${event.channel.mentionUser(result.recipientProviderUserId ?? parsed.recipientProviderUserId)} needs to connect Tipbot before receiving payments.`
          if (result.code === 'pending') return `Payment still sending.${receipt}`
          return `Payment failed.${receipt}`
        })(),
        { fallbackToDM: false },
      )
    }
  },
} as const satisfies Record<
  (typeof commandNames)[number] | 'default',
  (event: chat.SlashCommandEvent, ctx: HandlerContext) => Promise<void>
>

const commandNames = ['config', 'connect', 'disconnect', 'help', 'status'] as const
const commandPattern = new RegExp(`^(${commandNames.join('|')})(?:\\s+([\\s\\S]*))?$`)
const actionNames = ['config_edit', 'connect_cancel'] as const
const modalSubmitNames = ['config_edit'] as const

type HandlerContext = {
  db: DB.Type
  provider: ReturnType<typeof getProvider>
  text: string
}

function getProvider(event: chat.SlashCommandEvent): {
  id: string
  type: DB_gen.Selectable.workspace['provider']
} {
  if (event.adapter === getSlack()) {
    const slackSlashCommandRaw = z.object({
      team_id: z.string().min(1),
    })
    const raw = z.parse(slackSlashCommandRaw, event.raw)
    return {
      id: raw.team_id,
      type: 'slack',
    }
  }
  throw new Error('Provider not implemented yet.')
}

//////////////////////////////////////////////////////////////////////////////////////

async function postConnectLink(event: chat.SlashCommandEvent, ctx: HandlerContext) {
  const workspace = await ctx.db
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', ctx.provider.type)
    .where('provider_id', '=', ctx.provider.id)
    .executeTakeFirst()
  if (!workspace) {
    await event.channel.postEphemeral(
      event.user,
      'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
      { fallbackToDM: false },
    )
    return
  }

  let member = await ctx.db
    .selectFrom('member')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .where('provider_user_id', '=', event.user.userId)
    .executeTakeFirst()
  if (!member) {
    const id = Nanoid.generate()
    const createdAt = new Date().toISOString()
    await ctx.db
      .insertInto('member')
      .values({
        account_id: null,
        created_at: createdAt,
        id,
        login: null,
        name: null,
        provider_user_id: event.user.userId,
        updated_at: createdAt,
        workspace_id: workspace.id,
      })
      .execute()
    member = await ctx.db
      .selectFrom('member')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  if (member.account_id) {
    const accessKey = await ctx.db
      .selectFrom('access_key')
      .select(['id'])
      .where('account_id', '=', member.account_id)
      .where('chain_id', '=', workspace.chain_id)
      .where('expires_at', '>', new Date().toISOString())
      .where('revoked_at', 'is', null)
      .executeTakeFirst()
    if (accessKey) {
      await event.channel.postEphemeral(event.user, 'Already connected', { fallbackToDM: false })
      return
    }
  }

  const now = new Date()
  const token = Nanoid.generate()
  const accessKey = AccessKey.generate()
  const linkButtonLabel = member.account_id ? 'Refresh connection' : 'Connect to Tipbot'
  const linkDescription = 'Link expires in 10 minutes.'
  const linkUrl = `https://${env.HOST}/connect/${token}`
  const linkText = `${member.account_id ? 'Refresh Tipbot connection' : 'Connect to Tipbot'}: ${linkUrl}\n${linkDescription}`
  const linkExpiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString() // 10 minutes
  const accessKeyExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
  await ctx.db
    .deleteFrom('account_link_token')
    .where('member_id', '=', member.id)
    .where('used_at', 'is', null)
    .execute()
  await ctx.db
    .insertInto('account_link_token')
    .values({
      access_key_address: accessKey.address,
      access_key_authorization: null,
      access_key_ciphertext: await AccessKey.encrypt(env, accessKey.privateKey),
      access_key_expires_at: accessKeyExpiresAt,
      access_key_public_key: accessKey.publicKey,
      account_id: null,
      created_at: now.toISOString(),
      expires_at: linkExpiresAt,
      id: Nanoid.generate(),
      member_id: member.id,
      provider_channel_id: event.channel.id,
      token_hash: await AccountLink.hashToken(env, token),
      used_at: null,
    })
    .execute()

  await event.channel.postEphemeral(
    event.user,
    {
      card: chat.Card({
        children: [
          chat.Actions([
            chat.LinkButton({ label: linkButtonLabel, style: 'primary', url: linkUrl }),
            chat.Button({ id: 'connect_cancel', label: 'Cancel' }),
          ]),
          chat.CardText(linkDescription, { style: 'muted' }),
          chat.CardLink({ label: '\u200B', url: linkUrl }),
        ],
      }),
      fallbackText: linkText,
    },
    { fallbackToDM: false },
  )
}

function formatReceiptLink(chainId: number, transactionHash: string) {
  return `<${Tempo.formatTxLink(chainId, transactionHash)}|Receipt>`
}

async function isSlackAdmin(providerId: string, providerUserId: string) {
  const installation = await getSlack().getInstallation(providerId)
  if (!installation) return false

  const body = new URLSearchParams()
  body.set('user', providerUserId)
  const response = await getSlack().withBotToken(installation.botToken, () =>
    fetch(`${env.SLACK_API_URL}/users.info`, {
      body,
      headers: { authorization: `Bearer ${installation.botToken}` },
      method: 'POST',
    }),
  )
  const info = z.parse(
    z.object({
      ok: z.boolean().optional(),
      user: z
        .object({
          is_admin: z.boolean().optional(),
          is_owner: z.boolean().optional(),
        })
        .optional(),
    }),
    await response.json(),
  )
  return Boolean(info.ok && (info.user?.is_admin || info.user?.is_owner))
}

function configCard(
  workspace: DB_gen.Selectable.workspace,
  options?: { canEdit?: boolean; updated?: boolean },
) {
  const tokenAddress = workspace.default_token_address ?? Tempo.pathUsdAddress
  const token = Tempo.getTokenMetadataFallback(tokenAddress)
  const networkLabel = workspace.chain_id === Tempo.mainnetChainId ? 'Mainnet' : 'Testnet'
  return {
    card: chat.Card({
      children: [
        chat.Table({
          headers: ['Setting', 'Value'],
          rows: [
            ['Network', networkLabel],
            ['Default token', token.symbol],
            ['Default amount', formatAmount(workspace.default_amount)],
          ],
        }),
        ...(options?.canEdit
          ? [
              chat.Actions([
                chat.Button({
                  actionType: 'modal',
                  id: 'config_edit',
                  label: 'Edit settings',
                  style: 'primary',
                }),
              ]),
            ]
          : []),
        ...(options?.updated ? [chat.CardText('Workspace settings updated')] : []),
      ],
    }),
    fallbackText: `Network ${networkLabel}\nDefault token ${token.symbol} ${Tempo.formatTokenLink(workspace.chain_id, tokenAddress)}\nDefault amount ${formatAmount(workspace.default_amount)}${options?.updated ? '\nWorkspace settings updated' : ''}`,
  }
}

function slackTableCell(text: string, style?: { code?: boolean }) {
  return {
    elements: [
      {
        elements: [style ? { style, text, type: 'text' } : { text, type: 'text' }],
        type: 'rich_text_section',
      },
    ],
    type: 'rich_text',
  }
}
