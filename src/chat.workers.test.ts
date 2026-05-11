import * as DB from '#db/client.ts'
import * as Chat from '#/chat.ts'
import { WebClient } from '@slack/web-api'
import { env } from 'cloudflare:workers'
import { testClient } from 'hono/testing'
import { beforeEach, expect, test, vi } from 'vitest'
import { api } from '#/api.ts'
import * as Factory from '#test/factory.ts'
import { createSlackHeaders } from '#test/slack.ts'

let waitUntil: Promise<unknown>[] = []
const db = DB.create(env.DB)
const executionCtx = {
  passThroughOnException: vi.fn(),
  props: {},
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    waitUntil.push(promise)
  }),
}
const client = testClient(api, env, executionCtx)
const factory = Factory.create(db)
const slack = new WebClient('xoxb-test', { slackApiUrl: env.SLACK_API_URL })

beforeEach(async () => {
  waitUntil = []
  executionCtx.passThroughOnException.mockClear()
  executionCtx.waitUntil.mockClear()
  const history = await slack.conversations.history({ channel: 'C000000001' })
  await Promise.all(
    (history.messages ?? [])
      .filter((message): message is { ts: string } => typeof message.ts === 'string')
      .map((message) => slack.chat.delete({ channel: 'C000000001', ts: message.ts })),
  )
  await Chat.bot.initialize()
  await Chat.slack.setInstallation('T000000001', {
    botToken: 'xoxb-test',
    botUserId: 'B000000001',
    teamName: 'Tip Test',
  })
  await factory.workspace.insert({ provider_id: 'T000000001' })
})

test('/tip-config', async () => {
  const response = await client.api.chat.slack.$post(
    {},
    await createSlashCommandRequestInit('', { command: '/tip-config' }),
  )
  await Promise.all(waitUntil)

  expect(response.status).toBe(200)
  await expect(slack.conversations.history({ channel: 'C000000001' })).resolves.toMatchObject({
    messages: [
      expect.objectContaining({
        subtype: 'ephemeral',
        text: 'Current config: amount 0.001',
      }),
    ],
    ok: true,
  })
})

test('/tip-config missing workspace', async () => {
  await db.deleteFrom('workspace').where('provider_id', '=', 'T000000001').execute()

  const response = await postSlashCommand('', { command: '/tip-config' })
  const workspaces = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider_id', '=', 'T000000001')
    .execute()

  expect(response.status).toBe(200)
  await expectSlackMessage(
    'Tipbot is not configured for this Slack workspace. Reinstall Tipbot and try again.',
  )
  expect(workspaces).toEqual([])
})

test('/tip-connect', async () => {
  const response = await postSlashCommand('', { command: '/tip-connect' })

  expect(response.status).toBe(200)
  await expectSlackMessage('Mock tipping is enabled. No wallet connection is required right now.')
})

test('/tip-disconnect', async () => {
  const account = await factory.account.insert({})
  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider_id', '=', 'T000000001')
    .executeTakeFirstOrThrow()
  const member = await factory.member.insert({
    account_id: account.id,
    provider_user_id: 'U000000001',
    workspace_id: workspace.id,
  })

  const response = await postSlashCommand('', { command: '/tip-disconnect' })
  const updatedMember = await db
    .selectFrom('member')
    .selectAll()
    .where('id', '=', member.id)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackMessage('Disconnected account.')
  expect(updatedMember.account_id).toBe(null)
})

test('/tip-disconnect with no connected account', async () => {
  const response = await postSlashCommand('', { command: '/tip-disconnect' })

  expect(response.status).toBe(200)
  await expectSlackMessage('No account is connected.')
})

test('/tip-help', async () => {
  const response = await postSlashCommand('', { command: '/tip-help' })

  expect(response.status).toBe(200)
  await expectSlackMessage('I’m Tipbot: sometime tipper, sometime messenger, always bot.')
  await expectSlackMessage('Try `/tip <@account> for coffee`.')
})

test('/tip', async () => {
  const response = await postSlashCommand('')

  expect(response.status).toBe(200)
  await expectSlackMessage('Usage: /tip @account')
})

test('/tip hello', async () => {
  const response = await postSlashCommand('hello')

  expect(response.status).toBe(200)
  await expectSlackMessage('Usage: /tip @account')
})

test('/tip <@U000000002>', async () => {
  const response = await postSlashCommand('<@U000000002>')
  const tip = await db
    .selectFrom('tip')
    .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
    .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
    .select([
      'recipient.provider_user_id as recipient_provider_user_id',
      'sender.provider_user_id as sender_provider_user_id',
      'tip.amount',
      'tip.confirmed_at',
      'tip.transaction_hash',
    ])
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackMessage('Mock tip sent: <@U000000001> → <@U000000002> 0.001 mock stablecoins')
  expect(tip).toMatchObject({
    amount: 1000,
    recipient_provider_user_id: 'U000000002',
    sender_provider_user_id: 'U000000001',
  })
  expect(tip.confirmed_at).toEqual(expect.any(String))
  expect(tip.transaction_hash).toEqual(expect.any(String))
})

test('/tip <@U000000002> for great work', async () => {
  const response = await postSlashCommand('<@U000000002> for great work')
  const tip = await db.selectFrom('tip').select(['memo']).executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackMessage('for great work')
  expect(tip.memo).toBe('great work')
})

test('/tip <@U000000001>', async () => {
  const response = await postSlashCommand('<@U000000001>')

  expect(response.status).toBe(200)
  await expectSlackMessage('You cannot tip yourself.')
})

test('/tip-config amount 0.002', async () => {
  const response = await postSlashCommand('amount 0.002', { command: '/tip-config' })
  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider_id', '=', 'T000000001')
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackMessage('Updated amount.')
  expect(workspace.default_amount).toBe(2000)
})

test('/tip-config unknown value', async () => {
  const response = await postSlashCommand('unknown value', { command: '/tip-config' })

  expect(response.status).toBe(200)
  await expectSlackMessage('Config keys: amount.')
})

test('/tip-config amount 0', async () => {
  const response = await postSlashCommand('amount 0', { command: '/tip-config' })

  expect(response.status).toBe(200)
  await expectSlackMessage('Amount must be a positive decimal with at most 6 decimal places.')
})

test('/tip-config amount abc', async () => {
  const response = await postSlashCommand('amount abc', { command: '/tip-config' })

  expect(response.status).toBe(200)
  await expectSlackMessage('Amount must be a positive decimal with at most 6 decimal places.')
})

test('/tip-config amount 0.0000001', async () => {
  const response = await postSlashCommand('amount 0.0000001', { command: '/tip-config' })

  expect(response.status).toBe(200)
  await expectSlackMessage('Amount must be a positive decimal with at most 6 decimal places.')
})

test('/tip-config amount denied for non-admin', async () => {
  const userList = await slack.users.list({})
  const member = userList.members?.find((member) => member.id && !member.is_admin)
  if (!member?.id) throw new Error('Expected Slack emulator to seed a non-admin member.')

  const response = await postSlashCommand('amount 0.002', {
    command: '/tip-config',
    userId: member.id,
  })
  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider_id', '=', 'T000000001')
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackMessage('Only Slack admins can change tip config.')
  expect(workspace.default_amount).toBe(1000)
})

async function expectSlackMessage(text: string) {
  await expect(slack.conversations.history({ channel: 'C000000001' })).resolves.toMatchObject({
    messages: [expect.objectContaining({ text: expect.stringContaining(text) })],
    ok: true,
  })
}

async function postSlashCommand(
  text: string,
  options: { command?: string; responseUrl?: string; triggerId?: string; userId?: string } = {},
) {
  const response = await client.api.chat.slack.$post(
    {},
    await createSlashCommandRequestInit(text, options),
  )
  await Promise.all(waitUntil)
  return response
}

async function createSlashCommandRequestInit(
  text: string,
  options: { command?: string; responseUrl?: string; triggerId?: string; userId?: string } = {},
) {
  const body = new URLSearchParams({
    channel_id: 'C000000001',
    command: options.command ?? '/tip',
    ...(options.responseUrl ? { response_url: options.responseUrl } : {}),
    team_id: 'T000000001',
    text,
    trigger_id: options.triggerId ?? `trigger-${text.replaceAll(/\W+/g, '-')}`,
    user_id: options.userId ?? 'U000000001',
  }).toString()

  return {
    headers: {
      ...(await createSlackHeaders(body)),
      'content-type': 'application/x-www-form-urlencoded',
    },
    init: { body },
  }
}
