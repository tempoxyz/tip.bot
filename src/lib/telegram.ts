import * as DB from '#db/client.ts'
import type { DB as DB_gen } from '#db/types.gen.ts'
import { formatAmount } from '#/lib/format.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Tempo from '#/lib/tempo.ts'
import { createTelegramAdapter } from '@chat-adapter/telegram'
import { env } from 'cloudflare:workers'
import { z } from 'zod'

let adapter: ReturnType<typeof createTelegramAdapter> | null = null
export function getAdapter() {
  if (adapter) return adapter
  adapter = createTelegramAdapter({
    apiUrl: env.TELEGRAM_API_URL,
    botToken: env.TELEGRAM_BOT_TOKEN,
    mode: 'webhook',
    secretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
    userName: env.TELEGRAM_BOT_USERNAME,
  })
  return adapter
}

export const messageSchema = z.object({
  chat: z.object({
    id: z.number(),
    title: z.string().optional(),
    type: z.enum(['private', 'group', 'supergroup', 'channel']),
    username: z.string().optional(),
  }),
  entities: z
    .array(
      z.object({
        length: z.number().int().nonnegative(),
        offset: z.number().int().nonnegative(),
        type: z.string(),
        user: z
          .object({
            first_name: z.string(),
            id: z.number(),
            is_bot: z.boolean(),
            last_name: z.string().optional(),
            username: z.string().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  from: z
    .object({
      first_name: z.string(),
      id: z.number(),
      is_bot: z.boolean(),
      last_name: z.string().optional(),
      username: z.string().optional(),
    })
    .optional(),
  message_id: z.number().int().positive(),
  message_thread_id: z.number().int().positive().optional(),
  reply_to_message: z
    .object({
      from: z
        .object({
          first_name: z.string(),
          id: z.number(),
          is_bot: z.boolean(),
          last_name: z.string().optional(),
          username: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  text: z.string().default(''),
})

export type Message = z.infer<typeof messageSchema>

export type ParsedMention =
  | {
      command: string
      text: string
      unresolvedMention?: undefined
    }
  | { command?: undefined; text: string; unresolvedMention: string }

export function channelId(message: Message) {
  return `telegram:${message.chat.id}`
}

export function configText(workspace: DB_gen.Selectable.workspace) {
  return [
    'Workspace settings',
    `Network ${Tempo.getChainName(workspace.chain_id)}`,
    `Default amount ${formatAmount(workspace.default_amount)}`,
    `Default token ${Tempo.getTokenMetadataFallback(workspace.default_token_address ?? Tempo.addressLookup.pathUsd).symbol}`,
    'Telegram settings editing coming soon.',
  ].join('\n')
}

export function isGroupMessage(message: Message) {
  return ['group', 'supergroup'].includes(message.chat.type)
}

export function openInstruction() {
  return `Open @${env.TELEGRAM_BOT_USERNAME.replace(/^@+/, '')}, press Start, then try again.`
}

export async function ensureMessageMembers(
  db: DB.Type,
  workspace: DB_gen.Selectable.workspace,
  message: Message,
) {
  if (message.from) await ensureMember(db, workspace, message.from)
  if (message.reply_to_message?.from && !message.reply_to_message.from.is_bot)
    await ensureMember(db, workspace, message.reply_to_message.from)
  for (const entity of message.entities ?? [])
    if (entity.type === 'text_mention' && entity.user && !entity.user.is_bot)
      await ensureMember(db, workspace, entity.user)
}

export async function ensureWorkspace(db: DB.Type, message: Message) {
  const now = new Date().toISOString()
  await db
    .insertInto('workspace')
    .values({
      created_at: now,
      default_amount: 1000,
      id: Nanoid.generate(),
      installed_at: now,
      name: message.chat.title ?? message.chat.username ?? String(message.chat.id),
      provider: 'telegram',
      provider_id: String(message.chat.id),
      uninstalled_at: null,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['provider', 'provider_id']).doUpdateSet({
        name: message.chat.title ?? message.chat.username ?? String(message.chat.id),
        updated_at: now,
      }),
    )
    .execute()
  return await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', 'telegram')
    .where('provider_id', '=', String(message.chat.id))
    .executeTakeFirstOrThrow()
}

export async function parseMention(
  db: DB.Type,
  workspace: DB_gen.Selectable.workspace,
  message: Message,
  options: { botUsername: string; commandPattern: RegExp },
): Promise<ParsedMention> {
  const replacements: { end: number; start: number; value: string }[] = []
  const botName = options.botUsername.replace(/^@+/, '').toLowerCase()
  for (const entity of message.entities ?? []) {
    const value = message.text.slice(entity.offset, entity.offset + entity.length)
    if (entity.type === 'bot_command') {
      const command = value.replace(/^\//, '').split('@')
      if (command[1] && command[1].toLowerCase() !== botName) continue
      replacements.push({
        end: entity.offset + entity.length,
        start: entity.offset,
        value: command[0]!,
      })
      continue
    }
    if (entity.type === 'text_mention' && entity.user && !entity.user.is_bot) {
      replacements.push({
        end: entity.offset + entity.length,
        start: entity.offset,
        value: `<@${entity.user.id}|${userLabel(entity.user)}>`,
      })
      continue
    }
    if (entity.type !== 'mention') continue
    if (value.replace(/^@+/, '').toLowerCase() === botName) {
      replacements.push({ end: entity.offset + entity.length, start: entity.offset, value: ' ' })
      continue
    }
    const resolved = await resolveUsername(db, workspace.id, value)
    if (!resolved) return { text: '', unresolvedMention: value }
    replacements.push({
      end: entity.offset + entity.length,
      start: entity.offset,
      value: `<@${resolved.provider_user_id}|${resolved.display_name ?? value}>`,
    })
  }
  let text = message.text
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    text = `${text.slice(0, replacement.start)}${replacement.value}${text.slice(replacement.end)}`
  text = text.replace(new RegExp(`(^|\\s)@${escapeRegex(botName)}\\b`, 'i'), ' ').trim()
  const match = text.match(options.commandPattern)
  if (match) return { command: match[1]!, text: match[2]?.trim() ?? '' }
  if (
    !/^<@\d+(?:\|[^>]+)?>/.test(text) &&
    message.reply_to_message?.from &&
    !message.reply_to_message.from.is_bot
  )
    text =
      `<@${message.reply_to_message.from.id}|${userLabel(message.reply_to_message.from)}> ${text}`.trim()
  return { command: 'default', text }
}

export function parseUpdate(update: unknown) {
  return z.parse(z.object({ message: messageSchema }).passthrough(), update).message
}

export function threadTs(message: Message) {
  return message.message_thread_id ? String(message.message_thread_id) : undefined
}

export function userLabel(user: { first_name: string; last_name?: string; username?: string }) {
  return user.username
    ? `@${user.username}`
    : [user.first_name, user.last_name].filter(Boolean).join(' ')
}

async function ensureMember(
  db: DB.Type,
  workspace: DB_gen.Selectable.workspace,
  user: NonNullable<Message['from']>,
) {
  const now = new Date().toISOString()
  const label = userLabel(user)
  await db
    .insertInto('provider_identity')
    .values({
      account_id: null,
      created_at: now,
      display_name: label,
      id: Nanoid.generate(),
      metadata: JSON.stringify({ username: user.username ?? null }),
      provider: 'telegram',
      provider_global_user_id: String(user.id),
      provider_user_id: String(user.id),
      provider_workspace_id: workspace.provider_id,
      real_name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
      updated_at: now,
    })
    .execute()
    .catch((error) => {
      if (!isUniqueConstraintError(error)) throw error
    })
  await db
    .updateTable('provider_identity')
    .set({
      display_name: label,
      metadata: JSON.stringify({ username: user.username ?? null }),
      real_name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
      updated_at: now,
    })
    .where('provider', '=', 'telegram')
    .where('provider_workspace_id', '=', workspace.provider_id)
    .where('provider_user_id', '=', String(user.id))
    .execute()
  const identity = await db
    .selectFrom('provider_identity')
    .select('id')
    .where('provider', '=', 'telegram')
    .where('provider_workspace_id', '=', workspace.provider_id)
    .where('provider_user_id', '=', String(user.id))
    .executeTakeFirstOrThrow()
  await db
    .insertInto('member')
    .values({
      created_at: now,
      id: Nanoid.generate(),
      login: user.username ? `@${user.username}` : null,
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
      provider_identity_id: identity.id,
      provider_user_id: String(user.id),
      updated_at: now,
      workspace_id: workspace.id,
    })
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'provider_user_id']).doUpdateSet({
        login: user.username ? `@${user.username}` : null,
        name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
        provider_identity_id: identity.id,
        updated_at: now,
      }),
    )
    .execute()
}

async function resolveUsername(db: DB.Type, workspaceId: string, username: string) {
  const rows = await db
    .selectFrom('member')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .select(['provider_identity.display_name', 'member.provider_user_id'])
    .where('member.workspace_id', '=', workspaceId)
    .where((eb) => eb.fn('lower', ['provider_identity.display_name']), '=', username.toLowerCase())
    .execute()
  return rows.length === 1 ? rows[0] : null
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/.test(error.message)
  )
}
