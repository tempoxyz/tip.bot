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
  await factory.workspace.insert({ platform_team_id: 'T000000001' })
})

test('/tip config', async () => {
  const response = await client.api.chat.slack.$post(
    {},
    await createSlashCommandRequestInit('config'),
  )
  await Promise.all(waitUntil)

  expect(response.status).toBe(200)
  await expect(slack.conversations.history({ channel: 'C000000001' })).resolves.toMatchObject({
    messages: [
      expect.objectContaining({
        subtype: 'ephemeral',
        text: 'Current config: emoji money_with_wings, amount 0.001, cap 1',
      }),
    ],
    ok: true,
  })
})

test('/tip config emoji coin', async () => {
  const response = await client.api.chat.slack.$post(
    {},
    await createSlashCommandRequestInit('config emoji coin'),
  )
  await Promise.all(waitUntil)

  const workspace = await db
    .selectFrom('workspace')
    .select(['tip_emoji'])
    .where('platform_team_id', '=', 'T000000001')
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expect(slack.conversations.history({ channel: 'C000000001' })).resolves.toMatchObject({
    messages: [expect.objectContaining({ subtype: 'ephemeral', text: 'Updated emoji.' })],
    ok: true,
  })
  expect(workspace.tip_emoji).toBe('coin')
})

test('/tip connect', async () => {
  const response = await postSlashCommand('connect')

  expect(response.status).toBe(200)
  await expectSlackMessage('Mock tipping is enabled. No wallet connection is required right now.')
})

test('/tip', async () => {
  const response = await postSlashCommand('')

  expect(response.status).toBe(200)
  await expectSlackMessage('Usage: /tip @account or /tip config')
})

test('/tip hello', async () => {
  const response = await postSlashCommand('hello')

  expect(response.status).toBe(200)
  await expectSlackMessage('Usage: /tip @account or /tip config')
})

test('/tip <@U000000002>', async () => {
  const response = await postSlashCommand('<@U000000002>')
  const tip = await db
    .selectFrom('tip')
    .innerJoin('account as sender', 'sender.id', 'tip.sender_account_id')
    .innerJoin('account as recipient', 'recipient.id', 'tip.recipient_account_id')
    .select([
      'recipient.platform_account_id as recipient_platform_account_id',
      'sender.platform_account_id as sender_platform_account_id',
      'tip.amount',
      'tip.source_type',
      'tip.status',
      'tip.tx_hash',
    ])
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackMessage('Mock tip sent: <@U000000001> → <@U000000002> 0.001 mock stablecoins')
  expect(tip).toMatchObject({
    amount: '0.001',
    recipient_platform_account_id: 'U000000002',
    sender_platform_account_id: 'U000000001',
    source_type: 'command',
    status: 'confirmed',
  })
  expect(tip.tx_hash).toEqual(expect.any(String))
})

test('/tip <@U000000002> for great work', async () => {
  const response = await postSlashCommand('<@U000000002> for great work')
  const tip = await db.selectFrom('tip').select(['reason']).executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackMessage('for great work')
  expect(tip.reason).toBe('great work')
})

test('/tip <@U000000001>', async () => {
  const response = await postSlashCommand('<@U000000001>')

  expect(response.status).toBe(200)
  await expectSlackMessage('You cannot tip yourself.')
})

test('/tip config amount 0.002', async () => {
  const response = await postSlashCommand('config amount 0.002')
  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('platform_team_id', '=', 'T000000001')
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackMessage('Updated amount.')
  expect(workspace.tip_amount).toBe('0.002')
})

test('/tip config cap 2', async () => {
  const response = await postSlashCommand('config cap 2')
  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('platform_team_id', '=', 'T000000001')
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackMessage('Updated cap.')
  expect(workspace.daily_cap).toBe('2')
})

test('/tip config emoji :coin:', async () => {
  const response = await postSlashCommand('config emoji :coin:')
  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('platform_team_id', '=', 'T000000001')
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackMessage('Updated emoji.')
  expect(workspace.tip_emoji).toBe('coin')
})

test('/tip config unknown value', async () => {
  const response = await postSlashCommand('config unknown value')

  expect(response.status).toBe(200)
  await expectSlackMessage('Config keys: emoji, amount, cap.')
})

test('/tip config amount 0', async () => {
  const response = await postSlashCommand('config amount 0')

  expect(response.status).toBe(200)
  await expectSlackMessage('Amount must be a positive decimal.')
})

test('/tip config cap 0', async () => {
  const response = await postSlashCommand('config cap 0')

  expect(response.status).toBe(200)
  await expectSlackMessage('Cap must be a positive decimal.')
})

test('/tip config amount abc', async () => {
  const response = await postSlashCommand('config amount abc')

  expect(response.status).toBe(200)
  await expectSlackMessage('Amount must be a positive decimal.')
})

test('/tip config cap abc', async () => {
  const response = await postSlashCommand('config cap abc')

  expect(response.status).toBe(200)
  await expectSlackMessage('Cap must be a positive decimal.')
})

test('/tip config amount 2', async () => {
  const response = await postSlashCommand('config amount 2')

  expect(response.status).toBe(200)
  await expectSlackMessage('Cap must be greater than or equal to amount.')
})

test('/tip config emoji coin denied for non-admin', async () => {
  const userList = await slack.users.list({})
  const member = userList.members?.find((member) => member.id && !member.is_admin)
  if (!member?.id) throw new Error('Expected Slack emulator to seed a non-admin member.')

  const response = await postSlashCommand('config emoji coin', { userId: member.id })
  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('platform_team_id', '=', 'T000000001')
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackMessage('Only Slack admins can change tip config.')
  expect(workspace.tip_emoji).toBe('money_with_wings')
})

async function expectSlackMessage(text: string) {
  await expect(slack.conversations.history({ channel: 'C000000001' })).resolves.toMatchObject({
    messages: [expect.objectContaining({ text: expect.stringContaining(text) })],
    ok: true,
  })
}

async function postSlashCommand(
  text: string,
  options: { responseUrl?: string; triggerId?: string; userId?: string } = {},
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
  options: { responseUrl?: string; triggerId?: string; userId?: string } = {},
) {
  const body = new URLSearchParams({
    channel_id: 'C000000001',
    command: '/tip',
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
