import * as DB from '#db/client.ts'
import * as Chat from '#/chat.ts'
import { WebClient } from '@slack/web-api'
import { env } from 'cloudflare:workers'
import { testClient } from 'hono/testing'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '#/api.ts'
import * as Constants from '#test/constants.ts'
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
const slack = new WebClient(Constants.slack.botToken, { slackApiUrl: env.SLACK_API_URL })

beforeEach(async () => {
  waitUntil = []
  executionCtx.passThroughOnException.mockClear()
  executionCtx.waitUntil.mockClear()
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })
  await Promise.all(
    (history.messages ?? [])
      .filter((message): message is { ts: string } => typeof message.ts === 'string')
      .map((message) => slack.chat.delete({ channel: Constants.slack.channelId, ts: message.ts })),
  )
  await Chat.getChat().initialize()
  await Chat.getSlack().setInstallation(Constants.slack.teamId, {
    botToken: Constants.slack.botToken,
    botUserId: Constants.slack.botUserId,
    teamName: Constants.slack.teamName,
  })
  await factory.workspace.insert({ provider_id: Constants.slack.teamId })
})

describe('/tip @account', () => {
  test('sends tip', async () => {
    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
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
    await expectSlackMessage(
      `Mock tip sent: <@${Constants.slack.adminUserId}> → <@${Constants.slack.memberUserId}> 0.001 mock stablecoins`,
    )
    expect(tip).toMatchObject({
      amount: 1000,
      recipient_provider_user_id: Constants.slack.memberUserId,
      sender_provider_user_id: Constants.slack.adminUserId,
    })
    expect(tip.confirmed_at).toEqual(expect.any(String))
    expect(tip.transaction_hash).toEqual(expect.any(String))
  })

  test('is idempotent for the same trigger', async () => {
    const triggerId = 'trigger-idempotent-tip'

    const firstResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`, {
      triggerId,
    })
    const secondResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`, {
      triggerId,
    })
    const tips = await db.selectFrom('tip').selectAll().execute()

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    await expectSlackMessage(
      `Already sent: <@${Constants.slack.adminUserId}> → <@${Constants.slack.memberUserId}> 0.001 mock stablecoins`,
    )
    expect(tips).toHaveLength(1)
  })

  test('sends tip with memo', async () => {
    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> for great work`)
    const tip = await db.selectFrom('tip').select(['memo']).executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage('for great work')
    expect(tip.memo).toBe('great work')
  })

  test('supports Slack mention label syntax', async () => {
    const response = await postSlashCommand(
      `<@${Constants.slack.memberUserId}|member> for great work`,
    )
    const tip = await db
      .selectFrom('tip')
      .select(['memo', 'recipient_member_id'])
      .executeTakeFirstOrThrow()
    const recipient = await db
      .selectFrom('member')
      .selectAll()
      .where('id', '=', tip.recipient_member_id)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage('for great work')
    expect(recipient.provider_user_id).toBe(Constants.slack.memberUserId)
    expect(tip.memo).toBe('great work')
  })

  test('supports memo without for prefix', async () => {
    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> coffee`)
    const tip = await db.selectFrom('tip').select(['memo']).executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage('for coffee')
    expect(tip.memo).toBe('coffee')
  })

  test('denies self-tip', async () => {
    const response = await postSlashCommand(`<@${Constants.slack.adminUserId}>`)

    expect(response.status).toBe(200)
    await expectSlackMessage('You cannot tip yourself.')
  })
})

describe('/tip config', () => {
  test('shows current config', async () => {
    const response = await client.api.chat.slack.$post(
      {},
      await createSlashCommandRequestInit('config'),
    )
    await Promise.all(waitUntil)

    expect(response.status).toBe(200)
    await expect(
      slack.conversations.history({ channel: Constants.slack.channelId }),
    ).resolves.toMatchObject({
      messages: [
        expect.objectContaining({
          subtype: 'ephemeral',
          text: 'Current config: amount 0.001',
        }),
      ],
      ok: true,
    })
  })

  test('handles missing workspace', async () => {
    await db.deleteFrom('workspace').where('provider_id', '=', Constants.slack.teamId).execute()

    const response = await postSlashCommand('config')
    const workspaces = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', Constants.slack.teamId)
      .execute()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Tipbot is not configured for this Slack workspace. Reinstall Tipbot and try again.',
    )
    expect(workspaces).toEqual([])
  })

  test('handles missing Slack installation', async () => {
    await Chat.getSlack().deleteInstallation(Constants.slack.teamId)

    const response = await postSlashCommand('config amount 0.002')
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', Constants.slack.teamId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectNoSlackMessages()
    expect(workspace.default_amount).toBe(1000)
  })

  test('handles Slack users.info failure', async () => {
    const response = await postSlashCommand('config amount 0.002', {
      userId: Constants.slack.missingUserId,
    })
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', Constants.slack.teamId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectNoSlackMessages()
    expect(workspace.default_amount).toBe(1000)
  })

  test('updates amount', async () => {
    const response = await postSlashCommand('config amount 0.002')
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', Constants.slack.teamId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage('Updated amount.')
    expect(workspace.default_amount).toBe(2000)
  })

  test('updates amount with extra whitespace', async () => {
    const response = await postSlashCommand('  config   amount 0.002  ')
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', Constants.slack.teamId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage('Updated amount.')
    expect(workspace.default_amount).toBe(2000)
  })

  test('rejects unknown key', async () => {
    const response = await postSlashCommand('config unknown value')

    expect(response.status).toBe(200)
    await expectSlackMessage('Config keys: amount.')
  })

  test('rejects zero amount', async () => {
    const response = await postSlashCommand('config amount 0')

    expect(response.status).toBe(200)
    await expectSlackMessage('Amount must be a positive decimal with at most 6 decimal places.')
  })

  test('rejects non-numeric amount', async () => {
    const response = await postSlashCommand('config amount abc')

    expect(response.status).toBe(200)
    await expectSlackMessage('Amount must be a positive decimal with at most 6 decimal places.')
  })

  test('rejects amount with too many decimals', async () => {
    const response = await postSlashCommand('config amount 0.0000001')

    expect(response.status).toBe(200)
    await expectSlackMessage('Amount must be a positive decimal with at most 6 decimal places.')
  })

  test('denies non-admin amount update', async () => {
    const userList = await slack.users.list({})
    const member = userList.members?.find((member) => member.id && !member.is_admin)
    if (!member?.id) throw new Error('Expected Slack emulator to seed a non-admin member.')

    const response = await postSlashCommand('config amount 0.002', {
      userId: member.id,
    })
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', Constants.slack.teamId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage('Only Slack admins can change tip config.')
    expect(workspace.default_amount).toBe(1000)
  })
})

describe('/tip connect', () => {
  test('shows connect status', async () => {
    const response = await postSlashCommand('connect')

    expect(response.status).toBe(200)
    await expectSlackMessage('Mock tipping is enabled. No wallet connection is required right now.')
  })
})

describe('/tip disconnect', () => {
  test('disconnects a connected account', async () => {
    const account = await factory.account.insert({})
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', Constants.slack.teamId)
      .executeTakeFirstOrThrow()
    const member = await factory.member.insert({
      account_id: account.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })

    const response = await postSlashCommand('disconnect')
    const updatedMember = await db
      .selectFrom('member')
      .selectAll()
      .where('id', '=', member.id)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage('Disconnected account.')
    expect(updatedMember.account_id).toBe(null)
  })

  test('handles no connected account', async () => {
    const response = await postSlashCommand('disconnect')

    expect(response.status).toBe(200)
    await expectSlackMessage('No account is connected.')
  })

  test('handles missing workspace', async () => {
    await db.deleteFrom('workspace').where('provider_id', '=', Constants.slack.teamId).execute()

    const response = await postSlashCommand('disconnect')
    const workspaces = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', Constants.slack.teamId)
      .execute()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Tipbot is not configured for this Slack workspace. Reinstall Tipbot and try again.',
    )
    expect(workspaces).toEqual([])
  })
})

describe('/tip help', () => {
  test('shows help', async () => {
    const response = await postSlashCommand('help')

    expect(response.status).toBe(200)
    await expectSlackMessage('I’m Tipbot: sometime tipper, sometime messenger, always bot.')
    await expectSlackMessage('Try `/tip <@account> for coffee`.')
    await expectSlackMessage(
      'Subcommands: `/tip connect`, `/tip disconnect`, `/tip config`, `/tip help`.',
    )
  })
})

describe('/tip usage', () => {
  test('shows usage for empty text', async () => {
    const response = await postSlashCommand('')

    expect(response.status).toBe(200)
    await expectSlackMessage('Usage: /tip @account')
  })

  test('shows usage for unknown text', async () => {
    const response = await postSlashCommand('hello')

    expect(response.status).toBe(200)
    await expectSlackMessage('Usage: /tip @account')
  })

  test('handles Slack chat.postEphemeral failure', async () => {
    const response = await postSlashCommand('', { channelId: Constants.slack.missingChannelId })

    expect(response.status).toBe(200)
    await expectNoSlackMessages()
  })
})

async function expectSlackMessage(text: string) {
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })

  expect(history.ok).toBe(true)
  expect(history.messages?.some((message) => message.text?.includes(text))).toBe(true)
}

async function expectNoSlackMessages() {
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })

  expect(history).toMatchObject({ messages: [], ok: true })
}

async function postSlashCommand(
  text: string,
  options: {
    channelId?: string
    command?: string
    responseUrl?: string
    triggerId?: string
    userId?: string
  } = {},
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
  options: {
    channelId?: string
    command?: string
    responseUrl?: string
    triggerId?: string
    userId?: string
  } = {},
) {
  const body = new URLSearchParams({
    channel_id: options.channelId ?? Constants.slack.channelId,
    command: options.command ?? '/tip',
    ...(options.responseUrl ? { response_url: options.responseUrl } : {}),
    team_id: Constants.slack.teamId,
    text,
    trigger_id: options.triggerId ?? `trigger-${text.replaceAll(/\W+/g, '-')}`,
    user_id: options.userId ?? Constants.slack.adminUserId,
  }).toString()

  return {
    headers: {
      ...(await createSlackHeaders(body)),
      'content-type': 'application/x-www-form-urlencoded',
    },
    init: { body },
  }
}
