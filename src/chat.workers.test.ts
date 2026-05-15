import * as DB from '#db/client.ts'
import * as AccessKey from '#/lib/accessKey.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as Chat from '#/chat.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Tip from '#/lib/tip.ts'
import { WebClient } from '@slack/web-api'
import { env } from 'cloudflare:workers'
import { testClient } from 'hono/testing'
import { AbiFunction } from 'ox'
import { KeyAuthorization } from 'ox/tempo'
import { createClient, http, parseUnits } from 'viem'
import { Account, Actions } from 'viem/tempo'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '#/api.ts'
import * as Schema from '#db/schemas.gen.ts'
import * as Constants from '#test/constants.ts'
import * as Factory from '#test/factory.ts'
import { createSlackHeaders } from '#/lib/slack.ts'

let waitUntil: Promise<unknown>[] = []
let aiRunMock: ReturnType<typeof vi.spyOn>
let providerId = ''
let unconnectedProviderUserId = ''
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
const memberSlack = new WebClient('member', { slackApiUrl: env.SLACK_API_URL })
const slack = new WebClient(Constants.slack.botToken, { slackApiUrl: env.SLACK_API_URL })

beforeAll(async () => {
  const user = await slack.users.lookupByEmail({ email: Constants.slack.unconnectedUserEmail })
  unconnectedProviderUserId = user.user?.id ?? ''
  if (!unconnectedProviderUserId) throw new Error('Expected Slack unconnected test user.')
})

beforeEach(async () => {
  waitUntil = []
  providerId = `T${Nanoid.generate()}`
  executionCtx.passThroughOnException.mockClear()
  executionCtx.waitUntil.mockClear()
  vi.restoreAllMocks()
  aiRunMock = vi.spyOn(env.AI, 'run').mockResolvedValue({ response: 'Ack.' } as never)
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })
  await Promise.all(
    (history.messages ?? [])
      .filter((message): message is { ts: string } => typeof message.ts === 'string')
      .map((message) => slack.chat.delete({ channel: Constants.slack.channelId, ts: message.ts })),
  )
  await Chat.getChat().initialize()
  await Chat.getSlack().setInstallation(providerId, {
    botToken: Constants.slack.botToken,
    botUserId: Constants.slack.botUserId,
    teamName: Constants.slack.teamName,
  })
  await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    provider_id: providerId,
  })
})

describe('/tip @account', () => {
  test('sends tip', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
    const tip = await db
      .selectFrom('tip')
      .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
      .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
      .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
      .select([
        'recipient.provider_user_id as recipient_provider_user_id',
        'sender.provider_user_id as sender_provider_user_id',
        'tip.amount',
        'tip.confirmed_at',
        'tip.transaction_hash',
      ])
      .where('workspace.provider_id', '=', providerId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
    )
    await expectSlackMessageNotContaining(
      `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001. Receipt`,
    )
    expect(tip).toMatchObject({
      amount: 1000,
      recipient_provider_user_id: Constants.slack.memberUserId,
      sender_provider_user_id: Constants.slack.adminUserId,
    })
    expect(tip.confirmed_at).toEqual(expect.any(String))
    expect(tip.transaction_hash).toEqual(expect.any(String))
  }, 20_000) // 20 seconds

  test('sends tip with memo', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> for coffee`)
    const tip = await db
      .selectFrom('tip')
      .select(['confirmed_at', 'memo', 'transaction_hash'])
      .where('memo', '=', 'coffee')
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `<@${Constants.slack.adminUserId}> sent <@${Constants.slack.memberUserId}> $0.001 for coffee · Receipt`,
    )
    await expectSlackMessageNotContaining(
      `<@${Constants.slack.adminUserId}> sent <@${Constants.slack.memberUserId}> $0.001 for coffee. Receipt`,
    )
    expect(tip.confirmed_at).toEqual(expect.any(String))
    expect(tip.transaction_hash).toEqual(expect.any(String))
  }, 20_000) // 20 seconds

  test('sends tip with custom amount', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> $0.002`)
    const tip = await db
      .selectFrom('tip')
      .select(['amount', 'confirmed_at', 'transaction_hash'])
      .where('amount', '=', 2000)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.002 · Receipt`,
    )
    await expectSlackMessageNotContaining(
      `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.002. Receipt`,
    )
    expect(tip.confirmed_at).toEqual(expect.any(String))
    expect(tip.transaction_hash).toEqual(expect.any(String))
  }, 20_000) // 20 seconds

  test('shows confirmation action for token without access key', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> 0.002 BetaUSD`)

    expect(response.status).toBe(200)
    await expectSlackMessage('Tipbot needs your approval to send this payment.')
    await expectSlackMessage('/confirm/')
    await expectSlackMessage('|https://tip.bot/confirm/0x')
    await expectSlackMessage('Link expires in 10 minutes.')
    await expectSlackMessageNotContaining('Receipt')
  })

  test('shows confirmation action for amount above access key limit', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> 11`)

    expect(response.status).toBe(200)
    await expectSlackMessage('Tipbot needs your approval to send this payment.')
    await expectSlackMessage('/confirm/')
    await expectSlackMessage('Link expires in 10 minutes.')
    await expectSlackMessageNotContaining('Receipt')
  })

  test('shows confirmation action when prior tips would exceed access key limit', async () => {
    const connected = await connectTipAccounts({ tokenAddress: Tempo.addressLookup.thetaUsd })
    if (!connected.recipientMember) throw new Error('Expected connected recipient.')
    await db
      .updateTable('access_key')
      .set({ authorization_used_at: new Date().toISOString() })
      .where('id', '=', connected.accessKey.id)
      .execute()
    await factory.tip.insert({
      access_key_id: connected.accessKey.id,
      amount: 1_000_000,
      chain_id: connected.workspace.chain_id,
      confirmed_at: new Date().toISOString(),
      idempotency_key: `existing-${Nanoid.generate()}`,
      recipient_id: connected.recipientAccount.id,
      recipient_member_id: connected.recipientMember.id,
      sender_id: connected.senderAccount.id,
      sender_member_id: connected.senderMember.id,
      token_address: Tempo.addressLookup.thetaUsd,
      transaction_hash: `0x${'1'.repeat(64)}`,
      workspace_id: connected.workspace.id,
    })

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> 9.50 ThetaUSD`)

    expect(response.status).toBe(200)
    await expectSlackMessage('Tipbot needs your approval to send this payment.')
    await expectSlackMessage('/confirm/')
    await expectSlackMessage('Link expires in 10 minutes.')
    await expectSlackMessageNotContaining('Payment failed.')
  })

  test('shows confirmation action when memo needs approval', async () => {
    await connectTipAccounts({ memoScope: false })

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> for lunch`)

    expect(response.status).toBe(200)
    await expectSlackMessage('Tipbot needs your approval to send this payment.')
    await expectSlackMessage('/confirm/')
    await expectSlackMessage('Link expires in 10 minutes.')
    await expectSlackMessageNotContaining('Receipt')
  })

  test('is idempotent for the same trigger', async () => {
    const triggerId = 'trigger-idempotent-tip'
    await connectTipAccounts()

    const firstResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`, {
      triggerId,
    })
    const secondResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`, {
      triggerId,
    })
    const tips = await db
      .selectFrom('tip')
      .selectAll()
      .where('idempotency_key', '=', `command:${providerId}:${triggerId}`)
      .execute()

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    await expectSlackMessage('Payment sent · Receipt')
    expect(tips).toHaveLength(1)
  }, 20_000) // 20 seconds

  test('denies self-tip', async () => {
    const response = await postSlashCommand(`<@${Constants.slack.adminUserId}>`)

    expect(response.status).toBe(200)
    await expectSlackMessage('Payment not sent. Cannot send a payment to yourself.')
  })

  test('shows connect action when sender is not connected', async () => {
    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
    const link = await db
      .selectFrom('account_link_token')
      .selectAll('account_link_token')
      .innerJoin('member', 'member.id', 'account_link_token.member_id')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .where('member.provider_user_id', '=', Constants.slack.adminUserId)
      .where('workspace.provider_id', '=', providerId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage('Link expires in 10 minutes.')
    expect(link).toEqual(expect.schemaMatching(Schema.account_link_token))
  })

  test('handles recipient not connected', async () => {
    await connectTipAccounts({ recipient: false })

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `Payment not sent. <@${Constants.slack.memberUserId}> needs to connect Tipbot before receiving payments.`,
    )
    await expectSlackMessageNotContaining('tried to tip you')
  })

  test('handles insufficient funds', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handleTipRequest = vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
      code: 'insufficient_funds',
      ok: false,
    })

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)

    expect(response.status).toBe(200)
    await expectSlackMessage('Payment not sent. Your wallet has insufficient funds.')
    const postEphemeralCall = fetchSpy.mock.calls.find((call) => {
      const input = call[0]
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return (
        url.endsWith('/chat.postEphemeral') &&
        call[1]?.body instanceof URLSearchParams &&
        call[1].body.get('text')?.includes('Payment not sent. Your wallet has insufficient funds.')
      )
    })
    const blocks = JSON.parse(
      postEphemeralCall?.[1]?.body instanceof URLSearchParams
        ? (postEphemeralCall[1].body.get('blocks') ?? '[]')
        : '[]',
    )
    expect(
      postEphemeralCall?.[1]?.body instanceof URLSearchParams
        ? postEphemeralCall[1].body.has('thread_ts')
        : true,
    ).toBe(false)
    expect(blocks).toEqual([
      {
        text: {
          text: 'Payment not sent. Your wallet has insufficient funds.',
          type: 'mrkdwn',
        },
        type: 'section',
      },
      {
        elements: [
          {
            action_id: 'add_funds',
            style: 'primary',
            text: { text: 'Add funds', type: 'plain_text' },
            type: 'button',
            url: 'https://wallet.tempo.xyz',
          },
          {
            action_id: 'connect_cancel',
            text: { text: 'Cancel', type: 'plain_text' },
            type: 'button',
          },
        ],
        type: 'actions',
      },
      {
        elements: [{ text: 'Add funds on https://wallet.tempo.xyz', type: 'mrkdwn' }],
        type: 'context',
      },
    ])
    handleTipRequest.mockRestore()
    fetchSpy.mockRestore()
  })

  test('handles insufficient funds from thread slash command', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handleTipRequest = vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
      code: 'insufficient_funds',
      ok: false,
    })
    const threadTs = `1700000012.${Nanoid.generate().slice(0, 6)}`

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}>`, { threadTs })

    expect(response.status).toBe(200)
    const postEphemeralCall = fetchSpy.mock.calls.find((call) => {
      const input = call[0]
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const params = slackFetchBodyParams(call[1]?.body)
      return (
        url.endsWith('/chat.postEphemeral') &&
        params.get('text')?.includes('Payment not sent. Your wallet has insufficient funds.')
      )
    })
    expect(
      postEphemeralCall?.[1]?.body instanceof URLSearchParams
        ? postEphemeralCall[1].body.get('thread_ts')
        : null,
    ).toBe(threadTs)
    handleTipRequest.mockRestore()
    fetchSpy.mockRestore()
  })

  test('handles recorded insufficient funds failure', async () => {
    const triggerId = 'trigger-recorded-insufficient-funds'
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    const senderAccount = await factory.account.insert({})
    const recipientAccount = await factory.account.insert({})
    const senderMember = await factory.member.insert({
      account_id: senderAccount.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    const recipientMember = await factory.member.insert({
      account_id: recipientAccount.id,
      provider_user_id: Constants.slack.memberUserId,
      workspace_id: workspace.id,
    })
    await factory.tip.insert({
      chain_id: Tempo.chainLookup.localnet,
      failed_at: new Date().toISOString(),
      failure_reason: 'execution reverted: insufficient balance',
      idempotency_key: `command:${providerId}:${triggerId}`,
      recipient_id: recipientAccount.id,
      recipient_member_id: recipientMember.id,
      sender_id: senderAccount.id,
      sender_member_id: senderMember.id,
      workspace_id: workspace.id,
    })

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}>`, { triggerId })

    expect(response.status).toBe(200)
    await expectSlackMessage('Payment not sent. Your wallet has insufficient funds.')
  })

  test('handles recorded tip without transaction', async () => {
    const triggerId = 'trigger-recorded-without-transaction'
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    const senderAccount = await factory.account.insert({})
    const recipientAccount = await factory.account.insert({})
    const senderMember = await factory.member.insert({
      account_id: senderAccount.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    const recipientMember = await factory.member.insert({
      account_id: recipientAccount.id,
      provider_user_id: Constants.slack.memberUserId,
      workspace_id: workspace.id,
    })
    await factory.tip.insert({
      chain_id: Tempo.chainLookup.localnet,
      idempotency_key: `command:${providerId}:${triggerId}`,
      recipient_id: recipientAccount.id,
      recipient_member_id: recipientMember.id,
      sender_id: senderAccount.id,
      sender_member_id: senderMember.id,
      transaction_hash: null,
      workspace_id: workspace.id,
    })

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}>`, { triggerId })

    expect(response.status).toBe(200)
    await expectSlackMessage('Payment still sending.')
    await expectSlackMessageNotContaining('Sending payment.')
  })
})

test('@Tipbot mention sends tip in thread', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  await connectTipAccounts()
  const messageTs = `1700000000.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })
  const tip = await db
    .selectFrom('tip')
    .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
    .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .select([
      'recipient.provider_user_id as recipient_provider_user_id',
      'sender.provider_user_id as sender_provider_user_id',
      'tip.amount',
      'tip.confirmed_at',
      'tip.idempotency_key',
      'tip.transaction_hash',
    ])
    .where('workspace.provider_id', '=', providerId)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackAssistantStatusCall(fetchSpy, messageTs, 'is sending a tip', ['Sending tip'])
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
  )
  expect(tip).toMatchObject({
    amount: 1000,
    idempotency_key: `mention:${providerId}:${Constants.slack.channelId}:${messageTs}`,
    recipient_provider_user_id: Constants.slack.memberUserId,
    sender_provider_user_id: Constants.slack.adminUserId,
  })
  expect(tip.confirmed_at).toEqual(expect.any(String))
  expect(tip.transaction_hash).toEqual(expect.any(String))
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test.each([
  {
    amount: 2000,
    memo: null,
    name: 'custom token',
    text: '0.002 BetaUSD',
    tokenAddress: Tempo.addressLookup.betaUsd,
  },
  {
    amount: 2000,
    memo: 'thanks for the help',
    name: 'memo after amount',
    text: '0.002 thanks for the help',
    tokenAddress: undefined,
  },
  {
    amount: 2000,
    memo: 'lunch',
    name: 'custom token with memo',
    text: '0.002 BetaUSD for lunch',
    tokenAddress: Tempo.addressLookup.betaUsd,
  },
])('@Tipbot mention parses $name', async (input) => {
  const handleTipRequest = vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
    code: 'pending',
    ok: false,
  })
  const messageTs = `1700000017.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}> ${input.text}`,
  })

  expect(response.status).toBe(200)
  expect(handleTipRequest).toHaveBeenCalledWith(
    env,
    expect.objectContaining({
      amount: input.amount,
      memo: input.memo,
      providerThreadId: messageTs,
      recipientProviderUserId: Constants.slack.memberUserId,
      tokenAddress: input.tokenAddress,
    }),
  )
  expect(aiRunMock).not.toHaveBeenCalled()
})

test.each(['pay', 'send', 'tip'])(
  '@Tipbot mention accepts %s before recipient',
  async (verb) => {
    await connectTipAccounts()
    const messageTs = `1700000010.${Nanoid.generate().slice(0, 6)}`

    const response = await postSlackAppMention({
      messageTs,
      text: `<@${Constants.slack.botUserId}> ${verb} <@${Constants.slack.memberUserId}>`,
    })
    const tip = await db
      .selectFrom('tip')
      .select(['confirmed_at', 'transaction_hash'])
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackThreadMessage(
      messageTs,
      `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
    )
    expect(tip.confirmed_at).toEqual(expect.any(String))
    expect(tip.transaction_hash).toEqual(expect.any(String))
  },
  20_000,
) // 20 seconds

test('@Tipbot mention introduces itself', async () => {
  const messageTs = `1700000000.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> introduce yourself`,
  })
  const tips = await db
    .selectFrom('tip')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .selectAll('tip')
    .where('workspace.provider_id', '=', providerId)
    .execute()

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(
    messageTs,
    'I’m Tipbot: sometime tipper, sometime messenger, always bot.',
  )
  await expectSlackThreadMessage(
    messageTs,
    'Connect with `/tip connect`, then send stablecoins with `@Tipbot @account for coffee`, `@Tipbot @account 0.005 for coffee`, `/tip @account for coffee`, or a 💸 reaction.',
  )
  expect(tips).toHaveLength(0)
})

test('@Tipbot mention ignores repeated self mention chatter', async () => {
  const messageTs = `1700000016.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `There’s 2 <@${Constants.slack.botUserId}> and <@${Constants.slack.botUserId}>`,
  })

  expect(response.status).toBe(200)
  expect(aiRunMock).not.toHaveBeenCalled()
  await expectNoSlackMessages()
})

test('@Tipbot mention answers thanks with AI reply', async () => {
  const messageTs = `1700000011.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> thank you king`,
  })
  const tips = await db
    .selectFrom('tip')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .selectAll('tip')
    .where('workspace.provider_id', '=', providerId)
    .execute()

  expect(response.status).toBe(200)
  expect(aiRunMock).toHaveBeenCalledOnce()
  await expectSlackThreadMessage(messageTs, 'Ack.')
  expect(tips).toHaveLength(0)
})

test('@Tipbot mention answers setup questions with AI reply', async () => {
  const messageTs = `1700000014.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> How do I set mine up`,
  })

  expect(response.status).toBe(200)
  expect(aiRunMock).toHaveBeenCalledOnce()
  await expectSlackThreadMessage(messageTs, 'Ack.')
})

test('@Tipbot mention falls back when AI returns bare Tipbot mention', async () => {
  aiRunMock.mockResolvedValueOnce({ response: '@Tipbot' } as never)
  const messageTs = `1700000013.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> hello`,
  })

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(messageTs, 'Anytime.')
})

test('@Tipbot mention sends goblins through AI reply', async () => {
  aiRunMock.mockResolvedValueOnce({ response: 'GOBLINS? AI goblin mode engaged.' } as never)
  const messageTs = `1700000012.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> goblins are amazing`,
  })

  expect(response.status).toBe(200)
  expect(aiRunMock).toHaveBeenCalledOnce()
  await expectSlackThreadMessage(messageTs, 'GOBLINS? AI goblin mode engaged.')
})

test('@Tipbot mention sends goblins in thanks through AI reply', async () => {
  aiRunMock.mockResolvedValueOnce({ response: 'GOBLINS? Gratitude accepted.' } as never)
  const messageTs = `1700000016.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> thanks for sending all the tips today. i heard you don't like goblins?`,
  })

  expect(response.status).toBe(200)
  expect(aiRunMock).toHaveBeenCalledOnce()
  await expectSlackThreadMessage(messageTs, 'GOBLINS? Gratitude accepted.')
})

test('@Tipbot mention falls back for creatures when AI reply is invalid', async () => {
  aiRunMock.mockResolvedValueOnce({ response: '@Tipbot' } as never)
  const messageTs = `1700000015.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> dragons are amazing`,
  })

  expect(response.status).toBe(200)
  expect(aiRunMock).toHaveBeenCalledOnce()
  await expectSlackThreadMessage(messageTs, 'DRAGONS? Now we are talking.')
})

test('@Tipbot mention accepts bot mention after recipient', async () => {
  await connectTipAccounts()
  const messageTs = `1700000001.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.memberUserId}> <@${Constants.slack.botUserId}> for coffee`,
  })
  const tip = await db
    .selectFrom('tip')
    .select(['confirmed_at', 'memo', 'transaction_hash'])
    .where('memo', '=', 'coffee')
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(aiRunMock).not.toHaveBeenCalled()
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> sent <@${Constants.slack.memberUserId}> $0.001 for coffee · Receipt`,
  )
  expect(tip.confirmed_at).toEqual(expect.any(String))
  expect(tip.transaction_hash).toEqual(expect.any(String))
}, 20_000) // 20 seconds

test('@Tipbot mention replies to creature memo with AI', async () => {
  await connectTipAccounts()
  aiRunMock.mockResolvedValueOnce({ response: 'GOBLINS? Tip lore unlocked.' } as never)
  const messageTs = `1700000007.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.memberUserId}> <@${Constants.slack.botUserId}> for goblin snacks`,
  })
  const tip = await db
    .selectFrom('tip')
    .select(['confirmed_at', 'memo', 'transaction_hash'])
    .where('memo', '=', 'goblin snacks')
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(aiRunMock).toHaveBeenCalledOnce()
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> sent <@${Constants.slack.memberUserId}> $0.001 for goblin snacks · Receipt`,
  )
  await expectSlackThreadMessage(messageTs, 'GOBLINS? Tip lore unlocked.')
  expect(tip.confirmed_at).toEqual(expect.any(String))
  expect(tip.transaction_hash).toEqual(expect.any(String))
}, 20_000) // 20 seconds

test('@Tipbot mention falls back for creature memo when AI reply is invalid', async () => {
  await connectTipAccounts()
  aiRunMock.mockResolvedValueOnce({ response: '@Tipbot' } as never)
  const messageTs = `1700000008.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.memberUserId}> <@${Constants.slack.botUserId}> for dragon chow`,
  })

  expect(response.status).toBe(200)
  expect(aiRunMock).toHaveBeenCalledOnce()
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> sent <@${Constants.slack.memberUserId}> $0.001 for dragon chow · Receipt`,
  )
  await expectSlackThreadMessage(messageTs, 'DRAGON? Now we are talking.')
}, 20_000) // 20 seconds

test('@Tipbot mention accepts repeated bot mentions', async () => {
  await connectTipAccounts()
  const messageTs = `1700000002.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}> 0.002`,
  })
  const tip = await db
    .selectFrom('tip')
    .select(['amount', 'confirmed_at', 'transaction_hash'])
    .where('amount', '=', 2000)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.002 · Receipt`,
  )
  expect(tip.confirmed_at).toEqual(expect.any(String))
  expect(tip.transaction_hash).toEqual(expect.any(String))
}, 20_000) // 20 seconds

test('@Tipbot mention rejects ambiguous mentions', async () => {
  aiRunMock.mockResolvedValueOnce({
    response: 'Almost. Try `@Tipbot @account for coffee`.',
  } as never)
  const messageTs = `1700000003.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}> <@${unconnectedProviderUserId}>`,
  })
  const tips = await db
    .selectFrom('tip')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .selectAll('tip')
    .where('workspace.provider_id', '=', providerId)
    .execute()

  expect(response.status).toBe(200)
  expect(tips).toHaveLength(0)
  await expectSlackThreadMessage(messageTs, 'Almost. Try `@Tipbot @account for coffee`.')
  await expectSlackThreadMessageNotContaining(messageTs, 'tipped')
})

test('@Tipbot mention rejects natural language before recipient', async () => {
  const messageTs = `1700000004.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `please <@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })
  const tips = await db
    .selectFrom('tip')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .selectAll('tip')
    .where('workspace.provider_id', '=', providerId)
    .execute()

  expect(response.status).toBe(200)
  expect(tips).toHaveLength(0)
  await expectSlackThreadMessage(messageTs, 'Ack.')
  await expectSlackThreadMessageNotContaining(messageTs, 'tipped')
})

test('@Tipbot mention shows confirmation action when approval is required', async () => {
  await connectTipAccounts()
  await db.deleteFrom('access_key').execute()
  const messageTs = `1700000005.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })

  expect(response.status).toBe(200)
  await expectSlackMessage('Tipbot needs your approval to send this payment.')
  await expectSlackThreadMessageNotContaining(messageTs, 'Receipt')
}, 20_000) // 20 seconds

test('@Tipbot mention shows add funds action when sender has insufficient funds', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const handleTipRequest = vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
    code: 'insufficient_funds',
    ok: false,
  })
  const messageTs = `1700000009.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })

  expect(response.status).toBe(200)
  await expectSlackPostEphemeralCall(
    fetchSpy,
    'Payment not sent. Your wallet has insufficient funds.',
  )
  expect(
    fetchSpy.mock.calls.some((call) => {
      const input = call[0]
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const params = slackFetchBodyParams(call[1]?.body)
      return (
        url.endsWith('/chat.postEphemeral') &&
        params.get('text')?.includes('Payment not sent. Your wallet has insufficient funds.') &&
        !params.has('thread_ts')
      )
    }),
  ).toBe(true)
  await expectSlackPostEphemeralCall(fetchSpy, 'Add funds on https://wallet.tempo.xyz')
  await expectSlackPostEphemeralCall(fetchSpy, '"url":"https://wallet.tempo.xyz"')
  await expectSlackAssistantStatusCall(fetchSpy, messageTs, '')
  handleTipRequest.mockRestore()
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('@Tipbot thread mention shows add funds action in thread', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const handleTipRequest = vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
    code: 'insufficient_funds',
    ok: false,
  })
  const parentTs = `1700000010.${Nanoid.generate().slice(0, 6)}`
  const messageTs = `1700000011.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
    threadTs: parentTs,
  })

  expect(response.status).toBe(200)
  await expectSlackPostEphemeralCall(
    fetchSpy,
    'Payment not sent. Your wallet has insufficient funds.',
  )
  expect(
    fetchSpy.mock.calls.some((call) => {
      const input = call[0]
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const params = slackFetchBodyParams(call[1]?.body)
      return (
        url.endsWith('/chat.postEphemeral') &&
        params.get('text')?.includes('Payment not sent. Your wallet has insufficient funds.') &&
        params.get('thread_ts') === parentTs
      )
    }),
  ).toBe(true)
  await expectSlackAssistantStatusCall(fetchSpy, parentTs, '')
  handleTipRequest.mockRestore()
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('@Tipbot mention clears assistant status after payment failure', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const handleTipRequest = vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
    code: 'failed',
    ok: false,
  })
  const messageTs = `1700000008.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })

  expect(response.status).toBe(200)
  await expectSlackMessage('Payment failed.')
  await expectSlackAssistantStatusCall(fetchSpy, messageTs, '')
  handleTipRequest.mockRestore()
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('@Tipbot mention ignores edited messages', async () => {
  await connectTipAccounts()
  const messageTs = `1700000006.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    subtype: 'message_changed',
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })
  const tips = await db
    .selectFrom('tip')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .selectAll('tip')
    .where('workspace.provider_id', '=', providerId)
    .execute()

  expect(response.status).toBe(200)
  expect(tips).toHaveLength(0)
  await expectSlackThreadMessageNotContaining(messageTs, 'tipped')
})

test('@Tipbot mention ignores duplicate signed Slack event deliveries', async () => {
  await connectTipAccounts()
  const eventId = `Ev${Nanoid.generate()}`
  const messageTs = `1700000007.${Nanoid.generate().slice(0, 6)}`

  const firstResponse = await postSlackAppMention({
    eventId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })
  const secondResponse = await postSlackAppMention({
    eventId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })
  const tips = await db
    .selectFrom('tip')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .selectAll('tip')
    .where('workspace.provider_id', '=', providerId)
    .where(
      'tip.idempotency_key',
      '=',
      `mention:${providerId}:${Constants.slack.channelId}:${messageTs}`,
    )
    .execute()

  expect(firstResponse.status).toBe(200)
  expect(secondResponse.status).toBe(200)
  expect(tips).toHaveLength(1)
}, 20_000) // 20 seconds

test('reaction tipping sends default tip and updates aggregate thread reply', async () => {
  await connectTipAccounts()
  const channelId = await createSlackTestChannel('rt')
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'nice work',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const response = await postSlackReaction({
    channelId,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })
  const readdResponse = await postSlackReaction({
    channelId,
    eventTs: `${message.ts}-readd`,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })
  const tips = await db
    .selectFrom('tip')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .selectAll('tip')
    .where('workspace.provider_id', '=', providerId)
    .where('tip.idempotency_key', 'like', `${Chat.reactionTipIdempotencyPrefix}%`)
    .execute()

  expect(response.status).toBe(200)
  expect(readdResponse.status).toBe(200)
  expect(tips).toHaveLength(1)
  expect(tips[0]).toMatchObject({ amount: 1000, confirmed_at: expect.any(String) })
  await expectSlackThreadMessage(
    message.ts,
    `<@${Constants.slack.memberUserId}> received a tip on <slack://channel?team=${providerId}&id=${channelId}&message=${message.ts}|this> message:\n\n• <@${Constants.slack.adminUserId}> tipped $0.001 · <`,
    { channelId },
  )
})

for (const subtype of ['thread_broadcast', 'reply_broadcast']) {
  test(`reaction tipping supports ${subtype} messages`, async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await connectTipAccounts()
    const channelId = await createSlackTestChannel('rt')
    const parent = await memberSlack.chat.postMessage({
      channel: channelId,
      text: 'broadcast parent',
    })
    if (!parent.ts) throw new Error('Expected Slack parent message timestamp.')
    const reply = await memberSlack.chat.postMessage({
      channel: channelId,
      text: `${subtype} reply`,
      thread_ts: parent.ts,
    })
    if (!reply.ts) throw new Error('Expected Slack reply message timestamp.')
    fetchSpy.mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const params = slackFetchBodyParams(init?.body)
      if (url.endsWith('/conversations.replies') && params.get('ts') === reply.ts)
        return Promise.resolve(
          Response.json({
            messages: [
              {
                subtype,
                thread_ts: parent.ts,
                ts: reply.ts,
                user: Constants.slack.memberUserId,
              },
            ],
            ok: true,
          }),
        )
      return originalFetch(input, init)
    })

    const response = await postSlackReaction({
      channelId,
      messageTs: reply.ts,
      reaction: 'money_with_wings',
      userId: Constants.slack.adminUserId,
    })
    let reactionTip = await db
      .selectFrom('reaction_tip')
      .innerJoin('workspace', 'workspace.id', 'reaction_tip.workspace_id')
      .selectAll('reaction_tip')
      .where('workspace.provider_id', '=', providerId)
      .executeTakeFirst()
    for (let index = 0; index < 20 && !reactionTip; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10)) // 10 milliseconds
      reactionTip = await db
        .selectFrom('reaction_tip')
        .innerJoin('workspace', 'workspace.id', 'reaction_tip.workspace_id')
        .selectAll('reaction_tip')
        .where('workspace.provider_id', '=', providerId)
        .executeTakeFirst()
    }

    expect(response.status).toBe(200)
    expect(reactionTip).toMatchObject({ message_ts: reply.ts, thread_ts: parent.ts })
    expect(
      fetchSpy.mock.calls.some((call) =>
        slackFetchBodyParams(call[1]?.body)
          .get('text')
          ?.includes('Reaction tips only work on regular account messages'),
      ),
    ).toBe(false)
    fetchSpy.mockRestore()
  }, 20_000) // 20 seconds
}

test('reaction tipping updates one aggregate reply for multiple tipped messages in a thread', async () => {
  const connected = await connectTipAccounts()
  if (!connected.recipientMember) throw new Error('Expected connected recipient.')
  const channelId = await createSlackTestChannel('rt')
  const parent = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'first nice work',
  })
  if (!parent.ts) throw new Error('Expected Slack parent message timestamp.')
  const reply = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'second nice work',
    thread_ts: parent.ts,
  })
  if (!reply.ts) throw new Error('Expected Slack reply message timestamp.')

  const firstTip = await factory.tip.insert({
    access_key_id: connected.accessKey.id,
    chain_id: connected.workspace.chain_id,
    confirmed_at: new Date().toISOString(),
    idempotency_key: `${Chat.reactionTipIdempotencyPrefix}${Nanoid.generate()}`,
    recipient_id: connected.recipientAccount.id,
    recipient_member_id: connected.recipientMember.id,
    sender_id: connected.senderAccount.id,
    sender_member_id: connected.senderMember.id,
    token_address: Tempo.addressLookup.pathUsd,
    transaction_hash: `0x${Nanoid.generate().padEnd(64, '1').slice(0, 64)}`,
    workspace_id: connected.workspace.id,
  })
  await factory.reaction_tip.insert({
    channel_id: channelId,
    idempotency_key: firstTip.idempotency_key,
    message_ts: parent.ts,
    reaction: 'money_with_wings',
    recipient_member_id: connected.recipientMember.id,
    sender_member_id: connected.senderMember.id,
    thread_ts: parent.ts,
    tip_id: firstTip.id,
    workspace_id: connected.workspace.id,
  })
  await Chat.updateReactionTipAggregate(providerId, {
    channelId,
    reaction: 'money_with_wings',
    threadTs: parent.ts,
    workspaceId: connected.workspace.id,
  })

  const secondTip = await factory.tip.insert({
    access_key_id: connected.accessKey.id,
    chain_id: connected.workspace.chain_id,
    confirmed_at: new Date().toISOString(),
    idempotency_key: `${Chat.reactionTipIdempotencyPrefix}${Nanoid.generate()}`,
    recipient_id: connected.recipientAccount.id,
    recipient_member_id: connected.recipientMember.id,
    sender_id: connected.senderAccount.id,
    sender_member_id: connected.senderMember.id,
    token_address: Tempo.addressLookup.pathUsd,
    transaction_hash: `0x${Nanoid.generate().padEnd(64, '2').slice(0, 64)}`,
    workspace_id: connected.workspace.id,
  })
  await factory.reaction_tip.insert({
    channel_id: channelId,
    idempotency_key: secondTip.idempotency_key,
    message_ts: reply.ts,
    reaction: 'money_with_wings',
    recipient_member_id: connected.recipientMember.id,
    sender_member_id: connected.senderMember.id,
    thread_ts: parent.ts,
    tip_id: secondTip.id,
    workspace_id: connected.workspace.id,
  })
  await Chat.updateReactionTipAggregate(providerId, {
    channelId,
    reaction: 'money_with_wings',
    threadTs: parent.ts,
    workspaceId: connected.workspace.id,
  })
  const thread = await slack.conversations.replies({ channel: channelId, ts: parent.ts })
  const aggregates = thread.messages?.filter((message) =>
    message.text?.includes('Tips received in this thread:'),
  )

  expect(aggregates, JSON.stringify(thread.messages)).toHaveLength(1)
  expect(aggregates?.[0]?.text).toContain(
    `<@${Constants.slack.memberUserId}> received a tip on <slack://channel?team=${providerId}&id=${channelId}&message=${parent.ts}|this> message:\n• <@${Constants.slack.adminUserId}> tipped $0.001 · <`,
  )
  expect(aggregates?.[0]?.text).toContain(
    `<@${Constants.slack.memberUserId}> received a tip on <slack://channel?team=${providerId}&id=${channelId}&message=${reply.ts}|this> message:\n• <@${Constants.slack.adminUserId}> tipped $0.001 · <`,
  )
})

test('reaction tipping ignores one-time confirmed tips for access key limit', async () => {
  const connected = await connectTipAccounts()
  if (!connected.recipientMember) throw new Error('Expected connected recipient.')
  await factory.tip.insert({
    access_key_id: null,
    amount: 100_000_000,
    chain_id: connected.workspace.chain_id,
    confirmed_at: new Date().toISOString(),
    idempotency_key: `onetime-${Nanoid.generate()}`,
    recipient_id: connected.recipientAccount.id,
    recipient_member_id: connected.recipientMember.id,
    sender_id: connected.senderAccount.id,
    sender_member_id: connected.senderMember.id,
    token_address: Tempo.addressLookup.pathUsd,
    transaction_hash: `0x${Nanoid.generate().padEnd(64, '1').slice(0, 64)}`,
    workspace_id: connected.workspace.id,
  })
  await Actions.token.mintSync(
    createClient({
      chain: Tempo.getChain(Tempo.chainLookup.localnet),
      transport: http(env.RPC_URL_TESTNET),
    }),
    {
      account: Account.fromSecp256k1(env.FEE_PAYER_PRIVATE_KEY_TESTNET),
      amount: parseUnits('1', 6),
      to: Account.fromSecp256k1(Constants.tip.senderRootPrivateKey).address,
      token: Tempo.addressLookup.pathUsd,
    },
  )
  const result = await Tip.handleTipRequest(env, {
    idempotencyKey: `reaction-accounting-${Nanoid.generate()}`,
    memo: null,
    provider: 'slack',
    providerChannelId: Constants.slack.channelId,
    providerId,
    recipientProviderUserId: Constants.slack.memberUserId,
    senderProviderUserId: Constants.slack.adminUserId,
  })

  expect(result).toMatchObject({ ok: true, status: 'sent' })
})

test('reaction tipping ignores duplicate signed Slack event deliveries', async () => {
  await connectTipAccounts()
  const channelId = await createSlackTestChannel('rt')
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'duplicate reaction delivery',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const eventId = `Ev${Nanoid.generate()}`
  const firstResponse = await postSlackReaction({
    channelId,
    eventId,
    eventTs: `${message.ts}-reaction`,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })
  const secondResponse = await postSlackReaction({
    channelId,
    eventId,
    eventTs: `${message.ts}-reaction`,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })
  const tips = await db
    .selectFrom('tip')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .selectAll('tip')
    .where('workspace.provider_id', '=', providerId)
    .where('tip.idempotency_key', 'like', `${Chat.reactionTipIdempotencyPrefix}%`)
    .execute()

  expect(firstResponse.status).toBe(200)
  expect(secondResponse.status).toBe(200)
  expect(tips).toHaveLength(1)
})

test('reaction tipping reports unconnected sender', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  await connectTipAccounts()
  const channelId = await createSlackTestChannel('rt')
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'unknown sender should not tip',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const response = await postSlackReaction({
    channelId,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: unconnectedProviderUserId,
  })
  const reactionTips = await db
    .selectFrom('reaction_tip')
    .innerJoin('workspace', 'workspace.id', 'reaction_tip.workspace_id')
    .selectAll('reaction_tip')
    .where('workspace.provider_id', '=', providerId)
    .execute()

  expect(response.status).toBe(200)
  expect(reactionTips).toHaveLength(0)
  await expectSlackPostEphemeralCall(
    fetchSpy,
    'Payment not sent. Connect to Tipbot with `/tip connect` and try again.',
  )
  await expectSlackThreadMessageNotContaining(message.ts, 'tipped', { channelId })
  fetchSpy.mockRestore()
})

test('reaction tipping reports unconnected recipient', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  await connectTipAccounts({ recipient: false })
  const channelId = await createSlackTestChannel('rt')
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'unconnected recipient should not receive tip',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const response = await postSlackReaction({
    channelId,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })
  const reactionTips = await db
    .selectFrom('reaction_tip')
    .innerJoin('workspace', 'workspace.id', 'reaction_tip.workspace_id')
    .selectAll('reaction_tip')
    .where('workspace.provider_id', '=', providerId)
    .execute()

  expect(response.status).toBe(200)
  expect(reactionTips).toHaveLength(0)
  await expectSlackPostEphemeralCall(
    fetchSpy,
    `Payment not sent. <@${Constants.slack.memberUserId}> needs to connect Tipbot before receiving payments.`,
  )
  await expectSlackThreadMessageNotContaining(message.ts, 'tipped', { channelId })
  fetchSpy.mockRestore()
})

test('reaction tipping reports approval required', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  await connectTipAccounts()
  await db.deleteFrom('access_key').execute()
  const channelId = await createSlackTestChannel('rt')
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'approval required reaction tip',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const response = await postSlackReaction({
    channelId,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })
  const reactionTips = await db
    .selectFrom('reaction_tip')
    .innerJoin('workspace', 'workspace.id', 'reaction_tip.workspace_id')
    .selectAll('reaction_tip')
    .where('workspace.provider_id', '=', providerId)
    .execute()
  const tips = await db
    .selectFrom('tip')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .selectAll('tip')
    .where('workspace.provider_id', '=', providerId)
    .execute()

  expect(response.status).toBe(200)
  expect(reactionTips).toHaveLength(0)
  expect(tips).toHaveLength(0)
  await expectSlackPostEphemeralCall(fetchSpy, 'Tipbot needs your approval to send this payment.')
  await expectSlackPostEphemeralCall(fetchSpy, '"action_id":"confirm_cancel"')
  await expectSlackPostEphemeralCall(fetchSpy, '"text":"Cancel"')
  await expectSlackThreadMessageNotContaining(message.ts, 'tipped', { channelId })
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

describe('/tip config', () => {
  test('shows current config', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const response = await postSlashCommand('config')

    expect(response.status).toBe(200)
    await expectSlackMessageNotContaining('Workspace settings')
    await expectSlackMessage('Setting')
    await expectSlackMessage('Value')
    await expectSlackMessage('Network')
    await expectSlackMessage('Testnet')
    await expectSlackMessage('Default token')
    await expectSlackMessage('PathUSD')
    await expectSlackMessage('Default amount')
    await expectSlackMessage('0.001')
    await expectSlackMessage('Reaction')
    await expectSlackMessage('💸 `:money_with_wings:`')
    await expectSlackPostEphemeralCall(fetchSpy, '"style":{"code":true}')
    await expectSlackPostEphemeralCall(fetchSpy, '"text":":money_with_wings:"')
    fetchSpy.mockRestore()
  })

  test('opens mainnet edit modal with only mainnet tokens', async () => {
    await db
      .updateTable('workspace')
      .set({ chain_id: Tempo.chainLookup.mainnet })
      .where('provider_id', '=', providerId)
      .execute()
    await postSlashCommand('config')
    const messageTs = await findSlackMessageTs('Network')
    const fetchOriginal = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/views.open'))
        return Promise.resolve(Response.json({ ok: true, view: { id: 'V1' } }))
      return fetchOriginal(input, init)
    })

    const response = await postSlackInteraction({
      actions: [{ action_id: 'config_edit', type: 'button' }],
      channel: { id: Constants.slack.channelId },
      container: {
        channel_id: Constants.slack.channelId,
        message_ts: messageTs,
        type: 'message',
      },
      message: { ts: messageTs },
      team: { id: providerId },
      trigger_id: 'config-edit-mainnet-trigger',
      type: 'block_actions',
      user: { id: Constants.slack.adminUserId, name: Constants.slack.adminUserName },
    })

    expect(response.status).toBe(200)
    await expect
      .poll(
        async () => {
          for (const call of fetchSpy.mock.calls) {
            const input = call[0]
            const url =
              typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
            if (!url.endsWith('/views.open')) continue
            const view = (await slackFetchCallBodyParams(call)).get('view')
            if (!view) continue
            const json = JSON.parse(view) as {
              blocks: { block_id?: string; element?: { options?: { value: string }[] } }[]
            }
            return json.blocks
              .find((block) => block.block_id === 'default_token')
              ?.element?.options?.map((option) => option.value)
          }
          return null
        },
        { timeout: 10_000 }, // 10 seconds
      )
      .toEqual(['pathUSD', 'USDC.e', 'USDT0'])
    fetchSpy.mockRestore()
  }, 20_000) // 20 seconds

  test('handles missing workspace', async () => {
    await db.deleteFrom('workspace').where('provider_id', '=', providerId).execute()

    const response = await postSlashCommand('config')
    const workspaces = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .execute()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
    )
    expect(workspaces).toEqual([])
  })

  test('handles missing Slack installation', async () => {
    await Chat.getSlack().deleteInstallation(providerId)

    const response = await postSlashCommand('config')
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
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
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectNoSlackMessages()
    expect(workspace.default_amount).toBe(1000)
  })

  test('ignores removed config arguments', async () => {
    const response = await postSlashCommand('config amount 0.002')
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessageNotContaining('Workspace settings')
    expect(workspace.default_amount).toBe(1000)
  })

  test('updates settings from edit modal', async () => {
    const response = await postSlackInteraction(
      createViewSubmissionPayload({
        amount: '0.002',
        network: 'testnet',
        token: 'BetaUSD',
      }),
    )
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(workspace.chain_id).toBe(Tempo.chainLookup.testnet)
    expect(workspace.default_amount).toBe(2000)
    expect(workspace.default_token_address).toBe(Tempo.addressLookup.betaUsd)
    expect(workspace.reaction_tip_emoji).toBe('tip')
  })

  test('allows settings edit from allowlisted connected account', async () => {
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    const account = await factory.account.insert({
      address: '0x00Ec0495bB6d03a32D75C460CA2f2a9E53654348',
    })
    await factory.member.insert({
      account_id: account.id,
      provider_user_id: Constants.slack.memberUserId,
      workspace_id: workspace.id,
    })

    const response = await postSlackInteraction(
      createViewSubmissionPayload({
        amount: '0.002',
        network: 'testnet',
        token: 'BetaUSD',
        userId: Constants.slack.memberUserId,
        userName: Constants.slack.memberUserName,
      }),
    )
    const updatedWorkspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(updatedWorkspace.chain_id).toBe(Tempo.chainLookup.testnet)
    expect(updatedWorkspace.default_amount).toBe(2000)
    expect(updatedWorkspace.default_token_address).toBe(Tempo.addressLookup.betaUsd)
  })

  test('rejects invalid edit modal amount', async () => {
    const response = await postSlackInteraction(
      createViewSubmissionPayload({
        amount: '0',
        network: 'testnet',
        token: 'pathUSD',
      }),
    )
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      errors: {
        default_amount: 'Enter a positive amount with up to 6 decimal places. Example: 0.005',
      },
      response_action: 'errors',
    })
    expect(workspace.default_amount).toBe(1000)
  })

  test('rejects unavailable token for selected network', async () => {
    const response = await postSlackInteraction(
      createViewSubmissionPayload({
        amount: '0.001',
        network: 'mainnet',
        token: 'AlphaUSD',
      }),
    )
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      errors: { default_token: 'This token isn’t available on the selected network.' },
      response_action: 'errors',
    })
    expect(workspace.default_token_address).toBe(null)
  })

  test('denies non-admin edit action', async () => {
    await postSlashCommand('config')
    const messageTs = await findSlackMessageTs('Network')
    const userList = await slack.users.list({})
    const member = userList.members?.find(
      (member) => member.id && !member.is_admin && !member.is_owner,
    )
    if (!member?.id) throw new Error('Expected Slack emulator to seed a non-admin member.')

    const response = await postSlackInteraction({
      actions: [{ action_id: 'config_edit', type: 'button' }],
      channel: { id: Constants.slack.channelId },
      container: {
        channel_id: Constants.slack.channelId,
        message_ts: messageTs,
        type: 'message',
      },
      message: { ts: messageTs },
      team: { id: providerId },
      trigger_id: 'config-edit-trigger',
      type: 'block_actions',
      user: { id: member.id, name: member.name },
    })

    expect(response.status).toBe(200)
    await expectSlackMessage('Admin permission required')
    await expectSlackMessage('Only Slack admins can change Tipbot settings.')
  })

  test('ignores duplicate signed Slack action deliveries', async () => {
    await postSlashCommand('config')
    const messageTs = await findSlackMessageTs('Network')
    const userList = await slack.users.list({})
    const member = userList.members?.find(
      (member) => member.id && !member.is_admin && !member.is_owner,
    )
    if (!member?.id) throw new Error('Expected Slack emulator to seed a non-admin member.')

    const payload = {
      actions: [{ action_id: 'config_edit', type: 'button' }],
      channel: { id: Constants.slack.channelId },
      container: {
        channel_id: Constants.slack.channelId,
        message_ts: messageTs,
        type: 'message',
      },
      message: { ts: messageTs },
      team: { id: providerId },
      trigger_id: 'config-edit-duplicate-trigger',
      type: 'block_actions',
      user: { id: member.id, name: member.name },
    }

    const firstResponse = await postSlackInteraction(payload)
    const secondResponse = await postSlackInteraction(payload)
    const history = await slack.conversations.history({ channel: Constants.slack.channelId })
    const duplicateMessages =
      history.messages?.filter((message) => message.text?.includes('Admin permission required')) ??
      []

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(duplicateMessages).toHaveLength(1)
  })
})

describe('/tip connect', () => {
  test('creates one-time account link', async () => {
    const response = await postSlashCommand('connect')
    const link = await db
      .selectFrom('account_link_token')
      .selectAll('account_link_token')
      .innerJoin('member', 'member.id', 'account_link_token.member_id')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .where('member.provider_user_id', '=', Constants.slack.adminUserId)
      .where('workspace.provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    const member = await db
      .selectFrom('member')
      .selectAll()
      .where('id', '=', link.member_id)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage('Link expires in 10 minutes.')
    expect(link).toEqual(expect.schemaMatching(Schema.account_link_token))
    expect(member).toEqual(expect.schemaMatching(Schema.member))
    expect(link.access_key_address).toEqual(expect.stringMatching(/^0x[0-9a-fA-F]{40}$/))
    expect(link.access_key_ciphertext).toEqual(expect.stringMatching(/^0x[0-9a-f]+\.0x[0-9a-f]+$/))
    expect(link.access_key_public_key).toEqual(expect.stringMatching(/^0x[0-9a-fA-F]+$/))
    expect(member.provider_user_id).toBe(Constants.slack.adminUserId)
    expect(new Date(link.expires_at).getTime()).toBeGreaterThan(Date.now())
    expect(new Date(link.access_key_expires_at).getTime()).toBeGreaterThan(Date.now())
  })

  test('invalidates previous unused links', async () => {
    await postSlashCommand('connect')
    await postSlashCommand('connect')
    const links = await db
      .selectFrom('account_link_token')
      .innerJoin('member', 'member.id', 'account_link_token.member_id')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .select(['account_link_token.id'])
      .where('member.provider_user_id', '=', Constants.slack.adminUserId)
      .where('workspace.provider_id', '=', providerId)
      .execute()

    expect(links).toHaveLength(1)
  })

  test('handles missing workspace', async () => {
    await db.deleteFrom('workspace').where('provider_id', '=', providerId).execute()

    const response = await postSlashCommand('connect')
    const workspaces = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .execute()
    const links = await db
      .selectFrom('account_link_token')
      .innerJoin('member', 'member.id', 'account_link_token.member_id')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .selectAll('account_link_token')
      .where('workspace.provider_id', '=', providerId)
      .execute()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
    )
    expect(workspaces).toEqual([])
    expect(links).toEqual([])
  })

  test('reuses existing unconnected member', async () => {
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    const member = await factory.member.insert({
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })

    const response = await postSlashCommand('connect')
    const members = await db
      .selectFrom('member')
      .selectAll()
      .where('provider_user_id', '=', Constants.slack.adminUserId)
      .where('workspace_id', '=', workspace.id)
      .execute()
    const link = await db
      .selectFrom('account_link_token')
      .selectAll()
      .where('member_id', '=', member.id)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage('Link expires in 10 minutes.')
    expect(members).toHaveLength(1)
    expect(link.member_id).toBe(member.id)
  })

  test('handles already connected account without showing address', async () => {
    const account = await factory.account.insert({})
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    await factory.member.insert({
      account_id: account.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    await factory.access_key.insert({ account_id: account.id, chain_id: workspace.chain_id })

    const response = await postSlashCommand('connect')

    expect(response.status).toBe(200)
    await expectSlackMessage('Already connected')
    await expectSlackMessageNotContaining(account.address)
  })

  test('creates account link when connected account is missing current network access key', async () => {
    const account = await factory.account.insert({})
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    await factory.member.insert({
      account_id: account.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    await factory.access_key.insert({ account_id: account.id, chain_id: Tempo.chainLookup.mainnet })

    const response = await postSlashCommand('connect')
    const link = await db
      .selectFrom('account_link_token')
      .selectAll('account_link_token')
      .innerJoin('member', 'member.id', 'account_link_token.member_id')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .where('member.provider_user_id', '=', Constants.slack.adminUserId)
      .where('workspace.provider_id', '=', providerId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage('Link expires in 10 minutes.')
    await expectSlackMessageNotContaining('Use `/tip disconnect` to disconnect.')
    expect(link.member_id).toEqual(expect.any(String))
  })
})

describe('/tip disconnect', () => {
  test('disconnects a connected account', async () => {
    const account = await factory.account.insert({})
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    const member = await factory.member.insert({
      account_id: account.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    const accessKey = await factory.access_key.insert({ account_id: account.id })

    const response = await postSlashCommand('disconnect')
    const updatedMember = await db
      .selectFrom('member')
      .selectAll()
      .where('id', '=', member.id)
      .executeTakeFirstOrThrow()
    const accessKeys = await db
      .selectFrom('access_key')
      .selectAll()
      .where('id', '=', accessKey.id)
      .execute()

    expect(response.status).toBe(200)
    await expectSlackMessage('Disconnected')
    expect(updatedMember.account_id).toBe(null)
    expect(accessKeys).toEqual([])
  })

  test('handles no connected account', async () => {
    const response = await postSlashCommand('disconnect')

    expect(response.status).toBe(200)
    await expectSlackMessage('No account connected.')
  })

  test('handles missing workspace', async () => {
    await db.deleteFrom('workspace').where('provider_id', '=', providerId).execute()

    const response = await postSlashCommand('disconnect')
    const workspaces = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .execute()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
    )
    expect(workspaces).toEqual([])
  })
})

describe('/tip help', () => {
  test('shows help', async () => {
    const response = await postSlashCommand('help')

    expect(response.status).toBe(200)
    await expectSlackMessageNotContaining('Tipbot commands')
    await expectSlackMessage('/tip @account [amount] [token] [for memo]')
    await expectSlackMessage('/tip @account')
    await expectSlackMessage('/tip @account for coffee')
    await expectSlackMessage('/tip @account 0.005')
    await expectSlackMessage('/tip @account 0.005 for coffee')
    await expectSlackMessage('/tip @account 0.005 USDC')
    await expectSlackMessage('/tip @account 0.005 USDC for coffee')
    await expectSlackMessage('@Tipbot @account')
    await expectSlackMessage('@Tipbot @account for coffee')
    await expectSlackMessage('@Tipbot @account 0.005 for coffee')
    await expectSlackMessage('[emoji] :money_with_wings:')
    await expectSlackMessage('Send default amount by reacting to a message')
    await expectSlackMessageNotContaining('Payment examples')
    await expectSlackMessage('/tip config')
    await expectSlackMessage('/tip connect')
    await expectSlackMessage('/tip disconnect')
    await expectSlackMessage('/tip help')
    await expectSlackMessage('/tip leaderboard')
    await expectSlackMessage('/tip stats')
    await expectSlackMessage('/tip status')
  })
})

describe('/tip leaderboard', () => {
  test('shows received and sent counts', async () => {
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    const otherWorkspace = await factory.workspace.insert({ provider_id: `T${Nanoid.generate()}` })
    const adminAccount = await factory.account.insert({})
    const memberAccount = await factory.account.insert({})
    const thirdAccount = await factory.account.insert({})
    const adminMember = await factory.member.insert({
      account_id: adminAccount.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    const memberMember = await factory.member.insert({
      account_id: memberAccount.id,
      provider_user_id: Constants.slack.memberUserId,
      workspace_id: workspace.id,
    })
    const thirdMember = await factory.member.insert({
      account_id: thirdAccount.id,
      provider_user_id: 'U000000003',
      workspace_id: workspace.id,
    })
    const otherMember = await factory.member.insert({
      account_id: thirdAccount.id,
      provider_user_id: 'U000000004',
      workspace_id: otherWorkspace.id,
    })
    const now = new Date().toISOString()
    const tips = [
      {
        confirmed_at: now,
        recipient_id: memberAccount.id,
        recipient_member_id: memberMember.id,
        sender_id: adminAccount.id,
        sender_member_id: adminMember.id,
        transaction_hash: '0x1',
        workspace_id: workspace.id,
      },
      {
        confirmed_at: now,
        recipient_id: memberAccount.id,
        recipient_member_id: memberMember.id,
        sender_id: adminAccount.id,
        sender_member_id: adminMember.id,
        transaction_hash: '0x2',
        workspace_id: workspace.id,
      },
      {
        confirmed_at: now,
        recipient_id: memberAccount.id,
        recipient_member_id: memberMember.id,
        sender_id: thirdAccount.id,
        sender_member_id: thirdMember.id,
        transaction_hash: '0x3',
        workspace_id: workspace.id,
      },
      {
        confirmed_at: now,
        recipient_id: adminAccount.id,
        recipient_member_id: adminMember.id,
        sender_id: memberAccount.id,
        sender_member_id: memberMember.id,
        transaction_hash: '0x4',
        workspace_id: workspace.id,
      },
      {
        confirmed_at: null,
        recipient_id: thirdAccount.id,
        recipient_member_id: thirdMember.id,
        sender_id: adminAccount.id,
        sender_member_id: adminMember.id,
        workspace_id: workspace.id,
      },
      {
        confirmed_at: now,
        recipient_id: thirdAccount.id,
        recipient_member_id: otherMember.id,
        sender_id: adminAccount.id,
        sender_member_id: otherMember.id,
        transaction_hash: '0x5',
        workspace_id: otherWorkspace.id,
      },
    ]
    for (const tip of tips) await factory.tip.insert(tip)

    const response = await postSlashCommand('leaderboard')

    expect(response.status).toBe(200)
    await expectSlackPublicMessage('Tips received')
    await expectSlackMessage('Tips received')
    await expectSlackMessage(`1 <@${Constants.slack.memberUserId}> 3`)
    await expectSlackMessage(`2 <@${Constants.slack.adminUserId}> 1`)
    await expectSlackMessage('Tips sent')
    await expectSlackMessage(`1 <@${Constants.slack.adminUserId}> 2`)
    await expectSlackMessage(`2 <@${Constants.slack.memberUserId}> 1`)
    await expectSlackMessage('3 <@U000000003> 1')
    await expectSlackMessageNotContaining('U000000004')
  })

  test('handles no confirmed tips', async () => {
    const response = await postSlashCommand('leaderboard')

    expect(response.status).toBe(200)
    await expectSlackPublicMessage('No confirmed tips yet.')
    await expectSlackMessage('No confirmed tips yet.')
  })
})

describe('/tip stats', () => {
  test('shows current user totals and top counterparties', async () => {
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    const otherWorkspace = await factory.workspace.insert({ provider_id: `T${Nanoid.generate()}` })
    const adminAccount = await factory.account.insert({})
    const memberAccount = await factory.account.insert({})
    const thirdAccount = await factory.account.insert({})
    const adminMember = await factory.member.insert({
      account_id: adminAccount.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    const memberMember = await factory.member.insert({
      account_id: memberAccount.id,
      provider_user_id: Constants.slack.memberUserId,
      workspace_id: workspace.id,
    })
    const thirdMember = await factory.member.insert({
      account_id: thirdAccount.id,
      provider_user_id: 'U000000003',
      workspace_id: workspace.id,
    })
    const otherMember = await factory.member.insert({
      account_id: thirdAccount.id,
      provider_user_id: 'U000000004',
      workspace_id: otherWorkspace.id,
    })
    const now = new Date().toISOString()
    const transactionHashPrefix = `0x${Nanoid.generate()}`
    const tips = [
      {
        amount: 1000,
        confirmed_at: now,
        recipient_id: memberAccount.id,
        recipient_member_id: memberMember.id,
        sender_id: adminAccount.id,
        sender_member_id: adminMember.id,
        transaction_hash: `${transactionHashPrefix}1`,
        workspace_id: workspace.id,
      },
      {
        amount: 2000,
        confirmed_at: now,
        recipient_id: memberAccount.id,
        recipient_member_id: memberMember.id,
        sender_id: adminAccount.id,
        sender_member_id: adminMember.id,
        transaction_hash: `${transactionHashPrefix}2`,
        workspace_id: workspace.id,
      },
      {
        amount: 500,
        confirmed_at: now,
        recipient_id: thirdAccount.id,
        recipient_member_id: thirdMember.id,
        sender_id: adminAccount.id,
        sender_member_id: adminMember.id,
        transaction_hash: `${transactionHashPrefix}3`,
        workspace_id: workspace.id,
      },
      {
        amount: 7000,
        confirmed_at: now,
        recipient_id: adminAccount.id,
        recipient_member_id: adminMember.id,
        sender_id: memberAccount.id,
        sender_member_id: memberMember.id,
        transaction_hash: `${transactionHashPrefix}4`,
        workspace_id: workspace.id,
      },
      {
        amount: 1000,
        confirmed_at: now,
        recipient_id: adminAccount.id,
        recipient_member_id: adminMember.id,
        sender_id: thirdAccount.id,
        sender_member_id: thirdMember.id,
        transaction_hash: `${transactionHashPrefix}5`,
        workspace_id: workspace.id,
      },
      {
        amount: 9000,
        confirmed_at: null,
        recipient_id: memberAccount.id,
        recipient_member_id: memberMember.id,
        sender_id: adminAccount.id,
        sender_member_id: adminMember.id,
        workspace_id: workspace.id,
      },
      {
        amount: 1000000,
        confirmed_at: now,
        recipient_id: thirdAccount.id,
        recipient_member_id: otherMember.id,
        sender_id: adminAccount.id,
        sender_member_id: otherMember.id,
        transaction_hash: `${transactionHashPrefix}6`,
        workspace_id: otherWorkspace.id,
      },
    ]
    for (const tip of tips) await factory.tip.insert(tip)

    const response = await postSlashCommand('stats')

    expect(response.status).toBe(200)
    await expectSlackMessage('Your tip stats')
    await expectSlackMessage('Received $0.008 (2 tips)')
    await expectSlackMessage('Tipped $0.0035 (3 tips)')
    await expectSlackMessage(`Most tipped <@${Constants.slack.memberUserId}> $0.003 (2 tips)`)
    await expectSlackMessage(`Most tipped by <@${Constants.slack.memberUserId}> $0.007 (1 tip)`)
    await expectSlackMessageNotContaining('U000000004')
    await expectSlackMessageNotContaining('$1.00')
  })

  test('shows zero stats when the user has no member', async () => {
    const response = await postSlashCommand('stats')

    expect(response.status).toBe(200)
    await expectSlackMessage('Your tip stats')
    await expectSlackMessage('Received $0.00 (0 tips)')
    await expectSlackMessage('Tipped $0.00 (0 tips)')
    await expectSlackMessage('Most tipped None')
    await expectSlackMessage('Most tipped by None')
  })
})

describe('/tip status', () => {
  test('shows current connected account', async () => {
    const account = await factory.account.insert({})
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    await factory.member.insert({
      account_id: account.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })

    const response = await postSlashCommand('status')

    expect(response.status).toBe(200)
    await expectSlackMessage(`Connected as \`${account.address}\``)
    await expectSlackMessageNotContaining('Account ID')
    await expectSlackMessageNotContaining('Provider user ID')
  })

  test('handles no connected account', async () => {
    const response = await postSlashCommand('status')

    expect(response.status).toBe(200)
    await expectSlackMessage('No account connected.')
  })

  test('handles missing workspace', async () => {
    await db.deleteFrom('workspace').where('provider_id', '=', providerId).execute()

    const response = await postSlashCommand('status')
    const workspaces = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .execute()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
    )
    expect(workspaces).toEqual([])
  })
})

describe('/tip usage', () => {
  test('shows usage for empty text', async () => {
    const response = await postSlashCommand('')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Invalid `/tip` usage. Try `/tip @account` or `/tip help` for more info.',
    )
  })

  test('shows usage for unknown text', async () => {
    const response = await postSlashCommand('hello')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Invalid `/tip` usage. Try `/tip @account` or `/tip help` for more info.',
    )
  })

  test('handles missing Slack installation', async () => {
    await Chat.getSlack().deleteInstallation(providerId)

    const response = await postSlashCommand('hello')

    expect(response.status).toBe(200)
    await expectNoSlackMessages()
  })

  test('handles Slack chat.postEphemeral failure', async () => {
    const response = await postSlashCommand('', { channelId: Constants.slack.missingChannelId })

    expect(response.status).toBe(200)
    await expectNoSlackMessages()
  })
})

////////////////////////////////////////////////////////////////////////////

async function connectTipAccounts(
  options: { memoScope?: boolean; recipient?: boolean; tokenAddress?: `0x${string}` } = {},
) {
  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  const senderRoot = Account.fromSecp256k1(Constants.tip.senderRootPrivateKey)
  const recipientRoot = Account.fromSecp256k1(Constants.tip.recipientRootPrivateKey)
  const accessKey = AccessKey.generate()
  const accessKeyExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
  const tokenAddress = options.tokenAddress ?? Tempo.addressLookup.pathUsd
  const senderAccount = await findOrCreateAccount(senderRoot.address)
  const recipientAccount = await findOrCreateAccount(recipientRoot.address)

  await db.deleteFrom('access_key').where('account_id', '=', senderAccount.id).execute()
  const senderMember = await factory.member.insert({
    account_id: senderAccount.id,
    provider_user_id: Constants.slack.adminUserId,
    workspace_id: workspace.id,
  })
  const recipientMember =
    (options.recipient ?? true)
      ? await factory.member.insert({
          account_id: recipientAccount.id,
          provider_user_id: Constants.slack.memberUserId,
          workspace_id: workspace.id,
        })
      : null
  const accessKeyRow = await factory.access_key.insert({
    account_id: senderAccount.id,
    address: accessKey.address,
    authorization: JSON.stringify(
      (options.memoScope ?? true)
        ? await AccountLink.signKeyAuthorization(senderRoot, {
            accessKeyAddress: accessKey.address,
            chainId: Tempo.chainLookup.localnet,
            expiresAt: accessKeyExpiresAt,
            tokenAddress,
          })
        : KeyAuthorization.toRpc(
            await senderRoot.signKeyAuthorization(
              { accessKeyAddress: accessKey.address, keyType: 'secp256k1' },
              {
                chainId: BigInt(Tempo.chainLookup.localnet),
                expiry: Math.floor(new Date(accessKeyExpiresAt).getTime() / 1000),
                limits: [
                  {
                    limit: BigInt(AccountLink.reusableAccessKeyLimit),
                    period: AccountLink.reusableAccessKeyPeriodSeconds,
                    token: tokenAddress,
                  },
                ],
                scopes: [
                  {
                    address: tokenAddress,
                    selector: AbiFunction.getSelector('transfer(address,uint256)'),
                  },
                ],
              },
            ),
          ),
    ),
    chain_id: Tempo.chainLookup.localnet,
    ciphertext: await AccessKey.encrypt(env, accessKey.privateKey),
    expires_at: accessKeyExpiresAt,
    token_address: tokenAddress,
  })
  if (!recipientMember)
    return { accessKey: accessKeyRow, recipientAccount, senderAccount, senderMember, workspace }
  return {
    accessKey: accessKeyRow,
    recipientAccount,
    recipientMember,
    senderAccount,
    senderMember,
    workspace,
  }
}

async function findOrCreateAccount(address: string) {
  const existing = await db
    .selectFrom('account')
    .selectAll()
    .where('address', '=', address)
    .executeTakeFirst()
  if (existing) return existing
  return await factory.account.insert({ address })
}

async function expectSlackMessage(text: string, options: { channelId?: string } = {}) {
  const history = await slack.conversations.history({
    channel: options.channelId ?? Constants.slack.channelId,
  })

  expect(history.ok).toBe(true)
  expect(
    history.messages?.some((message) => message.text?.includes(text)),
    JSON.stringify(history.messages),
  ).toBe(true)
}

async function expectSlackThreadMessage(
  messageTs: string,
  text: string,
  options: { channelId?: string } = {},
) {
  const history = await slack.conversations.replies({
    channel: options.channelId ?? Constants.slack.channelId,
    ts: messageTs,
  })

  expect(history.ok).toBe(true)
  expect(
    history.messages?.some((message) => message.text?.includes(text)),
    JSON.stringify(history.messages),
  ).toBe(true)
}

async function expectSlackThreadMessageNotContaining(
  messageTs: string,
  text: string,
  options: { channelId?: string } = {},
) {
  const history = await slack.conversations.replies({
    channel: options.channelId ?? Constants.slack.channelId,
    ts: messageTs,
  })

  expect(history.ok).toBe(true)
  expect(history.messages?.some((message) => message.text?.includes(text))).toBe(false)
}

async function expectSlackPublicMessage(text: string) {
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })

  expect(history.ok).toBe(true)
  expect(
    history.messages?.some(
      (message) => message.text?.includes(text) && message.subtype !== 'ephemeral',
    ),
    JSON.stringify(history.messages),
  ).toBe(true)
}

async function expectSlackPostEphemeralCall(
  fetchSpy: { mock: { calls: Parameters<typeof fetch>[] } },
  text: string,
) {
  await expect
    .poll(
      () =>
        fetchSpy.mock.calls.some((call) => {
          const input = call[0]
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const params = slackFetchBodyParams(call[1]?.body)
          const callText = `${params.get('text') ?? ''} ${params.get('blocks') ?? ''}`
          return url.endsWith('/chat.postEphemeral') && callText.includes(text)
        }),
      {
        message: fetchSpy.mock.calls
          .map((call) => {
            const input = call[0]
            const url =
              typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
            const params = slackFetchBodyParams(call[1]?.body)
            return `${url} ${params.get('text') ?? ''} ${params.get('blocks') ?? ''}`
          })
          .join('\n'),
        timeout: 10_000, // 10 seconds
      },
    )
    .toBe(true)
}

async function expectSlackAssistantStatusCall(
  fetchSpy: { mock: { calls: Parameters<typeof fetch>[] } },
  threadTs: string,
  status: string,
  loadingMessages?: readonly string[],
) {
  await expect
    .poll(
      async () => {
        for (const call of fetchSpy.mock.calls) {
          const input = call[0]
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const params = await slackFetchCallBodyParams(call)
          if (
            url.endsWith('/assistant.threads.setStatus') &&
            params.get('channel_id') === Constants.slack.channelId &&
            params.get('status') === status &&
            params.get('thread_ts') === threadTs
          ) {
            if (!loadingMessages) return true
            const parsedLoadingMessages = parseSlackLoadingMessages(params.get('loading_messages'))
            if (JSON.stringify(parsedLoadingMessages) === JSON.stringify(loadingMessages))
              return true
          }
        }
        return false
      },
      {
        message: fetchSpy.mock.calls
          .map((call) => {
            const input = call[0]
            const url =
              typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
            return url
          })
          .join('\n'),
        timeout: 10_000, // 10 seconds
      },
    )
    .toBe(true)
}

function parseSlackLoadingMessages(value: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed) && parsed.every((message) => typeof message === 'string'))
      return parsed
  } catch {
    return []
  }
  return []
}

async function slackFetchCallBodyParams(call: Parameters<typeof fetch>) {
  const initParams = slackFetchBodyParams(call[1]?.body)
  if ([...initParams].length > 0) return initParams

  const input = call[0]
  if (input instanceof Request) {
    try {
      return slackFetchBodyParams(await input.clone().text())
    } catch {
      return initParams
    }
  }
  return initParams
}

function slackFetchBodyParams(body: BodyInit | null | undefined) {
  if (body instanceof URLSearchParams) return body
  if (typeof body === 'string') {
    if (body.trim().startsWith('{')) {
      try {
        return new URLSearchParams(JSON.parse(body) as Record<string, string>)
      } catch {
        return new URLSearchParams()
      }
    }
    return new URLSearchParams(body)
  }
  return new URLSearchParams()
}

async function findSlackMessageTs(text: string) {
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })
  const message = history.messages?.find((message) => message.text?.includes(text))

  expect(history.ok).toBe(true)
  if (!message?.ts) throw new Error(`Expected Slack message containing ${text}.`)
  return message.ts
}

async function expectSlackMessageNotContaining(text: string) {
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })

  expect(history.ok).toBe(true)
  expect(history.messages?.some((message) => message.text?.includes(text))).toBe(false)
}

async function expectNoSlackMessages() {
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })

  expect(history).toMatchObject({ messages: [], ok: true })
}

async function createSlackTestChannel(prefix: string) {
  const channel = await slack.conversations.create({
    name: `${prefix}${Nanoid.generate()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')}`,
  })
  const channelId = channel.channel?.id
  if (!channelId) throw new Error('Expected Slack test channel.')
  return channelId
}

async function postSlashCommand(
  text: string,
  options: {
    channelId?: string
    command?: string
    responseUrl?: string
    threadTs?: string
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

async function postSlackInteraction(payload: unknown) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
  const response = await client.api.chat.slack.$post(
    {},
    {
      headers: {
        ...(await createSlackHeaders(body, env.SLACK_SIGNING_SECRET)),
        'content-type': 'application/x-www-form-urlencoded',
      },
      init: { body },
    },
  )
  await Promise.all(waitUntil)
  return response
}

async function postSlackAppMention(options: {
  channelId?: string
  eventId?: string
  messageTs: string
  subtype?: string
  text: string
  threadTs?: string
  userId?: string
}) {
  const body = JSON.stringify({
    event: {
      channel: options.channelId ?? Constants.slack.channelId,
      channel_type: 'channel',
      event_ts: options.messageTs,
      ...(options.subtype ? { subtype: options.subtype } : {}),
      team: providerId,
      text: options.text,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
      ts: options.messageTs,
      type: 'app_mention',
      user: options.userId ?? Constants.slack.adminUserId,
    },
    event_id: options.eventId ?? `Ev${Nanoid.generate()}`,
    team_id: providerId,
    type: 'event_callback',
  })
  const response = await client.api.chat.slack.$post(
    {},
    {
      headers: {
        ...(await createSlackHeaders(body, env.SLACK_SIGNING_SECRET)),
        'content-type': 'application/json',
      },
      init: { body },
    },
  )
  await Promise.all(waitUntil)
  return response
}

async function postSlackReaction(options: {
  channelId?: string
  eventId?: string
  eventTs?: string
  messageTs: string
  reaction: string
  userId: string
}) {
  const body = JSON.stringify({
    event: {
      event_ts: options.eventTs ?? `${options.messageTs}-reaction`,
      item: {
        channel: options.channelId ?? Constants.slack.channelId,
        ts: options.messageTs,
        type: 'message',
      },
      item_user: Constants.slack.memberUserId,
      reaction: options.reaction,
      type: 'reaction_added',
      user: options.userId,
    },
    event_id: options.eventId ?? `Ev${Nanoid.generate()}`,
    team_id: providerId,
    type: 'event_callback',
  })
  const response = await client.api.chat.slack.$post(
    {},
    {
      headers: {
        ...(await createSlackHeaders(body, env.SLACK_SIGNING_SECRET)),
        'content-type': 'application/json',
      },
      init: { body },
    },
  )
  await Promise.all(waitUntil)
  return response
}

function createViewSubmissionPayload(input: {
  amount: string
  emoji?: string
  network: string
  token: string
  userId?: string
  userName?: string
}) {
  return {
    team: { id: providerId },
    type: 'view_submission',
    user: {
      id: input.userId ?? Constants.slack.adminUserId,
      name: input.userName ?? Constants.slack.adminUserName,
    },
    view: {
      callback_id: 'config_edit',
      id: `V${Nanoid.generate()}`,
      private_metadata: JSON.stringify({ m: JSON.stringify({ providerId }) }),
      state: {
        values: {
          default_amount: {
            default_amount: { type: 'plain_text_input', value: input.amount },
          },
          default_token: {
            default_token: {
              selected_option: {
                text: { text: input.token, type: 'plain_text' },
                value: input.token,
              },
              type: 'static_select',
            },
          },
          network: {
            network: {
              selected_option: {
                text: { text: input.network, type: 'plain_text' },
                value: input.network,
              },
              type: 'static_select',
            },
          },
          reaction_tip_emoji: {
            reaction_tip_emoji: {
              type: 'plain_text_input',
              value: input.emoji ?? ':tip:',
            },
          },
        },
      },
    },
  }
}

async function createSlashCommandRequestInit(
  text: string,
  options: {
    channelId?: string
    command?: string
    responseUrl?: string
    threadTs?: string
    triggerId?: string
    userId?: string
  } = {},
) {
  const body = new URLSearchParams({
    channel_id: options.channelId ?? Constants.slack.channelId,
    command: options.command ?? '/tip',
    ...(options.responseUrl ? { response_url: options.responseUrl } : {}),
    team_id: providerId,
    text,
    ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    trigger_id: options.triggerId ?? `trigger-${text.replaceAll(/\W+/g, '-')}`,
    user_id: options.userId ?? Constants.slack.adminUserId,
  }).toString()

  return {
    headers: {
      ...(await createSlackHeaders(body, env.SLACK_SIGNING_SECRET)),
      'content-type': 'application/x-www-form-urlencoded',
    },
    init: { body },
  }
}
