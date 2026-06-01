import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import { sql } from 'kysely'
import { Address } from 'ox'
import * as z from 'zod/mini'
import * as Chat from '#/chat.ts'
import { formatAmount, formatCurrencyAmount } from '#/lib/format.ts'
import { auth } from '#/lib/auth.ts'
import * as Slack from '#/lib/slack.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Twitter from '#/lib/twitter.ts'
import * as DB from '#db/client.ts'

export const getDashboardData = createServerFn({ method: 'GET' }).handler(async () => {
  return await loadDashboardData(getRequest())
})

export const disconnectDashboardAccount = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ identityId: z.string().check(z.minLength(1)) }))
  .handler(async ({ data }) => {
    const session = await auth.getSession(getRequest())
    if (!session) throw new Error('Connect your wallet to manage connected accounts.')

    const db = DB.create(env.DB)
    const account = await db
      .selectFrom('account')
      .selectAll()
      .where('address', '=', Address.checksum(session.address))
      .executeTakeFirst()
    if (!account) throw new Error('Wallet is not connected.')

    const identity = await db
      .selectFrom('provider_identity')
      .select(['account_id', 'id'])
      .where('id', '=', data.identityId)
      .where('account_id', '=', account.id)
      .executeTakeFirst()
    if (!identity) throw new Error('Connected account not found.')

    const now = new Date().toISOString()
    await db
      .updateTable('provider_identity')
      .set({ account_id: null, updated_at: now })
      .where('id', '=', identity.id)
      .execute()
    const remaining = await db
      .selectFrom('provider_identity')
      .select('id')
      .where('account_id', '=', account.id)
      .executeTakeFirst()
    if (!remaining) await db.deleteFrom('access_key').where('account_id', '=', account.id).execute()

    return { ok: true as const }
  })

async function loadDashboardData(request: Request) {
  const session = await auth.getSession(request)
  if (!session) return { ok: false as const }

  const address = Address.checksum(session.address)
  const db = DB.create(env.DB)
  const account = await db
    .selectFrom('account')
    .selectAll()
    .where('address', '=', address)
    .executeTakeFirst()
  if (!account)
    return {
      accounts: { slack: [], x: [] },
      ok: true as const,
      stats: {
        received: { amount: formatCurrencyAmount('0', 'USD'), tips: 0 },
        sent: { amount: formatCurrencyAmount('0', 'USD'), tips: 0 },
      },
      walletAddress: address,
      walletExplorerUrl: Tempo.explorerLink(Tempo.chainLookup.mainnet, address),
    }

  const [receivedStats, sentStats, accessKey, rows] = await Promise.all([
    db
      .selectFrom('tip')
      .select([
        sql<number>`coalesce(sum("tip"."amount"), 0)`.as('amount'),
        sql<number>`count("tip"."id")`.as('tips'),
      ])
      .where('recipient_id', '=', account.id)
      .where('confirmed_at', 'is not', null)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('tip')
      .select([
        sql<number>`coalesce(sum("tip"."amount"), 0)`.as('amount'),
        sql<number>`count("tip"."id")`.as('tips'),
      ])
      .where('sender_id', '=', account.id)
      .where('confirmed_at', 'is not', null)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('access_key')
      .select('chain_id')
      .where('account_id', '=', account.id)
      .orderBy('updated_at', 'desc')
      .executeTakeFirst(),
    db
      .selectFrom('provider_identity')
      .leftJoin('member', 'member.provider_identity_id', 'provider_identity.id')
      .leftJoin('workspace', 'workspace.id', 'member.workspace_id')
      .select([
        'member.login',
        'member.name',
        'provider_identity.display_name',
        'provider_identity.id',
        'provider_identity.provider',
        'provider_identity.provider_user_id',
        'provider_identity.provider_workspace_id',
        'provider_identity.real_name',
        'provider_identity.updated_at',
        'workspace.name as workspace_name',
        'workspace.provider_id as workspace_provider_id',
      ])
      .where('provider_identity.account_id', '=', account.id)
      .orderBy('workspace.name', 'asc')
      .orderBy('provider_identity.display_name', 'asc')
      .execute(),
  ])
  const accounts = await Promise.all(
    rows.map(async (row) => {
      const provider =
        String(row.provider) === 'twitter' ||
        row.provider_workspace_id === Twitter.twitterProviderId
          ? ('x' as const)
          : ('slack' as const)
      const label =
        row.display_name?.trim() ||
        row.real_name?.trim() ||
        row.name?.trim() ||
        row.login?.trim() ||
        row.provider_user_id
      const username = provider === 'x' ? label.replace(/^@+/, '') : row.login?.trim() || label
      const avatarUrl = await (async () => {
        if (provider === 'x') {
          if (!username) return undefined
          try {
            return (
              (await Twitter.getUserByUsername(env, username))?.profile_image_url?.trim() ||
              undefined
            )
          } catch {
            return undefined
          }
        }

        if (!row.workspace_provider_id) return undefined
        try {
          await Chat.getChat().initialize()
          const installation = await Chat.getSlack().getInstallation(row.workspace_provider_id)
          if (!installation) return undefined
          const user = await Slack.getUserInfo({
            apiUrl: env.SLACK_API_URL,
            botToken: installation.botToken,
            providerUserId: row.provider_user_id,
            withBotToken: (botToken, fn) => Chat.getSlack().withBotToken(botToken, fn),
          })
          return (
            user?.profile?.image_192?.trim() ||
            user?.profile?.image_72?.trim() ||
            user?.profile?.image_48?.trim() ||
            undefined
          )
        } catch {
          return undefined
        }
      })()

      return {
        avatarUrl,
        connectedAt: row.updated_at,
        id: row.id,
        label,
        provider,
        providerUserId: row.provider_user_id,
        username,
        workspace:
          provider === 'slack'
            ? {
                id: row.workspace_provider_id ?? row.provider_workspace_id,
                logoUrl: null,
                name: row.workspace_name ?? row.provider_workspace_id ?? 'Slack',
              }
            : null,
      }
    }),
  )

  return {
    accounts: {
      slack: accounts.filter((item) => item.provider === 'slack'),
      x: accounts.filter((item) => item.provider === 'x'),
    },
    ok: true as const,
    stats: {
      received: {
        amount: formatCurrencyAmount(formatAmount(Number(receivedStats.amount)), 'USD'),
        tips: Number(receivedStats.tips),
      },
      sent: {
        amount: formatCurrencyAmount(formatAmount(Number(sentStats.amount)), 'USD'),
        tips: Number(sentStats.tips),
      },
    },
    walletAddress: account.address,
    walletExplorerUrl: Tempo.explorerLink(
      accessKey?.chain_id ?? Tempo.chainLookup.mainnet,
      account.address,
    ),
  }
}

export type Dashboard = Extract<Awaited<ReturnType<typeof loadDashboardData>>, { ok: true }>

export type DashboardAccount = Dashboard['accounts']['slack'][number]
