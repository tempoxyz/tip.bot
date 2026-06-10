import * as DB from '#db/client.ts'
import { Provider, dangerous_secp256k1 } from 'accounts'
import * as AccessKey from '#/lib/accessKey.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as Chat from '#/chat.ts'
import { closeExpired } from '#/crons/close.ts'
import entryServer from '#/entry-server.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Tip from '#/lib/tip.ts'
import { processPendingTipMessage } from '#/queues/pendingTip.ts'
import { WebClient } from '@slack/web-api'
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { testClient } from 'hono/testing'
import { AbiFunction, Address } from 'ox'
import { KeyAuthorization } from 'ox/tempo'
import { createClient, http, parseUnits, toHex } from 'viem'
import { Account, Actions } from 'viem/tempo'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '#/api.ts'
import * as Schema from '#db/schemas.gen.ts'
import type { DB as DB_gen } from '#db/types.gen.ts'
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

test('/tip airdrop opens create modal', async () => {
  await connectTipAccounts()
  const fetchOriginal = globalThis.fetch
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  fetchSpy.mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/views.open'))
      return Promise.resolve(Response.json({ ok: true, view: { id: 'V1' } }))
    return fetchOriginal(input, init)
  })

  const response = await postSlashCommand('airdrop Tempo Launch')

  expect(response.status).toBe(200)
  await expect
    .poll(
      async () => {
        for (const call of fetchSpy.mock.calls) {
          const input = call[0]
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          if (!url.endsWith('/views.open')) continue
          return (await slackFetchCallBodyParams(...call)).get('view')
        }
        return null
      },
      { timeout: 10_000 }, // 10 seconds
    )
    .toEqual(
      expect.stringMatching(
        /(?=.*Start airdrop)(?=.*Tempo Launch)(?=.*0\.10)(?=.*"initial_option":\{"text":\{"type":"plain_text","text":"5 minutes")(?=.*"text":"90 seconds")(?=.*"value":"90s")/s,
      ),
    )
})

test('/tip airdrop create modal posts funded pot message', async () => {
  await connectTipAccounts()

  const response = await postSlackInteraction(createAirdropViewSubmissionPayload())
  const tipAirdrop = await db
    .selectFrom('tip_airdrop')
    .innerJoin('member', 'member.id', 'tip_airdrop.creator_member_id')
    .select(['member.provider_user_id', 'tip_airdrop.name', 'tip_airdrop.total_amount'])
    .where('tip_airdrop.provider_id', '=', providerId)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(tipAirdrop).toEqual({
    name: 'Tempo Launch',
    provider_user_id: Constants.slack.adminUserId,
    total_amount: 20_000,
  })
  await expectSlackMessage('🚨 Tempo Launch airdrop time 🚨')
  await expectSlackMessage('Claim while supplies last!')
  await expectSlackMessage('Pot: $0.02 left of $0.02')
  await expectSlackMessage('Ends: <!date^')
  await expectSlackMessage('Claimed: No one yet')
})

test('/tip airdrop create modal prompts approval when amount is above creator balance', async () => {
  await connectTipAccounts()

  const response = await postSlackInteraction(
    createAirdropViewSubmissionPayload({ amount: '1000000', name: 'Too Rich' }),
  )
  const tipAirdrops = await db
    .selectFrom('tip_airdrop')
    .select('id')
    .where('name', '=', 'Too Rich')
    .execute()

  expect(response.status).toBe(200)
  await expect(response.text()).resolves.toBe('')
  expect(tipAirdrops).toEqual([])
  await expectSlackMessage('Link expires in 10 minutes')
  await expectSlackMessageNotContaining('Already connected')
})

test('/tip airdrop create modal prompts approval when amount is above approved access key amount', async () => {
  await connectTipAccounts()
  await Actions.token.mintSync(
    createClient({
      chain: Tempo.getChain(Tempo.chainLookup.localnet),
      transport: http(Tempo.getRpcUrl(env, Tempo.chainLookup.localnet)),
    }),
    {
      account: Account.fromSecp256k1(env.FEE_PAYER_PRIVATE_KEY_TESTNET),
      amount: parseUnits('20', 6),
      to: Account.fromSecp256k1(Constants.tip.senderRootPrivateKey).address,
      token: Tempo.addressLookup.pathUsd,
    },
  )

  const response = await postSlackInteraction(
    createAirdropViewSubmissionPayload({ amount: '11', name: 'Too Approved' }),
  )
  const tipAirdrops = await db
    .selectFrom('tip_airdrop')
    .select('id')
    .where('name', '=', 'Too Approved')
    .execute()

  expect(response.status).toBe(200)
  await expect(response.text()).resolves.toBe('')
  expect(tipAirdrops).toEqual([])
  await expectSlackMessage('Link expires in 10 minutes')
  await expectSlackMessageNotContaining('Already connected')
})

test('/tip airdrop claim sends $0.01 from creator to claimer and updates pot', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createAirdropViewSubmissionPayload())
  const tipAirdrop = await db
    .selectFrom('tip_airdrop')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()

  const clickResponse = await postSlackInteraction(
    createAirdropClaimPayload(tipAirdrop, {
      userId: Constants.slack.memberUserId,
      userName: Constants.slack.memberUserName,
    }),
  )
  const tip = await db
    .selectFrom('tip')
    .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
    .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
    .select([
      'recipient.provider_user_id as recipient_provider_user_id',
      'sender.provider_user_id as sender_provider_user_id',
      'tip.amount',
      'tip.confirmed_at',
    ])
    .where(
      'tip.idempotency_key',
      'like',
      `tip_airdrop:${tipAirdrop.id}:claim:${Constants.slack.memberUserId}:%`,
    )
    .executeTakeFirstOrThrow()

  expect(clickResponse.status).toBe(200)
  expect(tip).toMatchObject({
    amount: 10_000,
    confirmed_at: expect.any(String),
    recipient_provider_user_id: Constants.slack.memberUserId,
    sender_provider_user_id: Constants.slack.adminUserId,
  })
  await expectSlackMessage('Pot: $0.01 left of $0.02')
  await expectSlackMessage(`Claimed: <@${Constants.slack.memberUserId}>`)

  const secondClickResponse = await postSlackInteraction(
    createAirdropClaimPayload(tipAirdrop, {
      triggerId: 'airdrop-claim-repeat',
      userId: Constants.slack.memberUserId,
      userName: Constants.slack.memberUserName,
    }),
  )
  const tips = await db
    .selectFrom('tip')
    .select('id')
    .where('idempotency_key', 'like', `tip_airdrop:${tipAirdrop.id}:claim:%`)
    .execute()

  expect(secondClickResponse.status).toBe(200)
  expect(tips).toHaveLength(2)
  await expectSlackMessage('Pot: $0.00 left of $0.02')
  await expectSlackMessage(`Claimed: <@${Constants.slack.memberUserId}>×2`)
})

test('/tip airdrop claim sends remaining pot when below $0.01', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createAirdropViewSubmissionPayload({ amount: '0.005' }))
  const tipAirdrop = await db
    .selectFrom('tip_airdrop')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()

  const clickResponse = await postSlackInteraction(
    createAirdropClaimPayload(tipAirdrop, {
      userId: Constants.slack.memberUserId,
      userName: Constants.slack.memberUserName,
    }),
  )
  const tip = await db
    .selectFrom('tip')
    .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
    .select(['recipient.provider_user_id as recipient_provider_user_id', 'tip.amount'])
    .where(
      'tip.idempotency_key',
      'like',
      `tip_airdrop:${tipAirdrop.id}:claim:${Constants.slack.memberUserId}:%`,
    )
    .executeTakeFirstOrThrow()

  expect(clickResponse.status).toBe(200)
  expect(tip).toEqual({ amount: 5_000, recipient_provider_user_id: Constants.slack.memberUserId })
  await expectSlackMessage('Pot: $0.00 left of $0.005')
  await expectSlackMessage(`Claimed: <@${Constants.slack.memberUserId}>`)
})

test('/tip airdrop claim prompts unconnected claimers to connect', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createAirdropViewSubmissionPayload())
  const tipAirdrop = await db
    .selectFrom('tip_airdrop')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()

  const clickResponse = await postSlackInteraction(
    createAirdropClaimPayload(tipAirdrop, {
      userId: Constants.slack.unconnectedUserId,
      userName: Constants.slack.unconnectedUserName,
    }),
  )

  expect(clickResponse.status).toBe(200)
  await expectSlackMessageNotContaining(`Claimed: <@${Constants.slack.unconnectedUserId}>`)
  await expectSlackMessage('Link expires in 10 minutes.')
})

test('/tip airdrop claim fails after the airdrop ends even with pot remaining', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createAirdropViewSubmissionPayload())
  const tipAirdrop = await db
    .selectFrom('tip_airdrop')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  await db
    .updateTable('tip_airdrop')
    .set({ ends_at: new Date(Date.now() - 1000).toISOString() }) // 1 second ago
    .where('id', '=', tipAirdrop.id)
    .execute()

  const clickResponse = await postSlackInteraction(
    createAirdropClaimPayload(tipAirdrop, {
      userId: Constants.slack.memberUserId,
      userName: Constants.slack.memberUserName,
    }),
  )
  const tips = await db
    .selectFrom('tip')
    .select('id')
    .where('idempotency_key', 'like', `tip_airdrop:${tipAirdrop.id}:claim:%`)
    .execute()
  const updatedAirdrop = await db
    .selectFrom('tip_airdrop')
    .select(['claimed_amount', 'status'])
    .where('id', '=', tipAirdrop.id)
    .executeTakeFirstOrThrow()

  expect(clickResponse.status).toBe(200)
  expect(tips).toEqual([])
  expect(updatedAirdrop).toEqual({ claimed_amount: 0, status: 'ended' })
  await expectSlackMessage('Ended · Pot: $0.02 left of $0.02')
  await expectSlackMessageNotContaining('Not eligible for airdrop. Sorry :(')
})

test('/tip airdrop cron closes expired airdrop and updates message', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createAirdropViewSubmissionPayload())
  const tipAirdrop = await db
    .selectFrom('tip_airdrop')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  await db
    .updateTable('tip_airdrop')
    .set({ ends_at: new Date(Date.now() - 1000).toISOString() }) // 1 second ago
    .where('id', '=', tipAirdrop.id)
    .execute()

  const ctx = createExecutionContext()
  entryServer.scheduled(createScheduledController({ cron: '* * * * *' }), env, ctx)
  await waitOnExecutionContext(ctx)
  const updatedAirdrop = await db
    .selectFrom('tip_airdrop')
    .select(['ended_at', 'status', 'updated_at'])
    .where('id', '=', tipAirdrop.id)
    .executeTakeFirstOrThrow()
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })
  const message = history.messages?.find((message) => message.ts === tipAirdrop.provider_message_ts)
  const actionBlocks = (message?.blocks ?? []).filter(
    (block) => (block as { type?: unknown }).type === 'actions',
  )
  const messageJson = JSON.stringify(message)

  expect(updatedAirdrop.status).toBe('ended')
  expect(updatedAirdrop.ended_at).toEqual(expect.any(String))
  expect(updatedAirdrop.updated_at).not.toBe(updatedAirdrop.ended_at)
  expect(actionBlocks).toEqual([])
  expect(messageJson).not.toContain('Claim while supplies last!')
  await expectSlackMessage('Ended · Pot: $0.02 left of $0.02')
})

test('/tip airdrop create modal uses selected duration', async () => {
  await connectTipAccounts()

  const response = await postSlackInteraction(
    createAirdropViewSubmissionPayload({ duration: '90s' }),
  )
  const tipAirdrop = await db
    .selectFrom('tip_airdrop')
    .select('ends_at')
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(new Date(tipAirdrop.ends_at).getTime()).toBeGreaterThan(Date.now() + 60 * 1000) // 1 minute
  expect(new Date(tipAirdrop.ends_at).getTime()).toBeLessThan(Date.now() + 120 * 1000) // 2 minutes
})

test('/tip airdrop claim fails after pot is depleted', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createAirdropViewSubmissionPayload())
  const tipAirdrop = await db
    .selectFrom('tip_airdrop')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  await db
    .updateTable('tip_airdrop')
    .set({ claimed_amount: tipAirdrop.total_amount, status: 'ended' })
    .where('id', '=', tipAirdrop.id)
    .execute()

  const clickResponse = await postSlackInteraction(
    createAirdropClaimPayload(tipAirdrop, {
      userId: Constants.slack.memberUserId,
      userName: Constants.slack.memberUserName,
    }),
  )
  const tips = await db
    .selectFrom('tip')
    .select('id')
    .where('idempotency_key', 'like', `tip_airdrop:${tipAirdrop.id}:claim:%`)
    .execute()

  expect(clickResponse.status).toBe(200)
  expect(tips).toEqual([])
  await expectSlackMessageNotContaining('Not eligible for airdrop. Sorry :(')
})

test('/tip airdrop claim closes airdrop when creator payment cannot be sent', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createAirdropViewSubmissionPayload())
  const tipAirdrop = await db
    .selectFrom('tip_airdrop')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  await db.deleteFrom('access_key').execute()

  const clickResponse = await postSlackInteraction(
    createAirdropClaimPayload(tipAirdrop, {
      userId: Constants.slack.memberUserId,
      userName: Constants.slack.memberUserName,
    }),
  )
  const updatedAirdrop = await db
    .selectFrom('tip_airdrop')
    .select(['ended_at', 'status'])
    .where('id', '=', tipAirdrop.id)
    .executeTakeFirstOrThrow()

  expect(clickResponse.status).toBe(200)
  expect(updatedAirdrop.status).toBe('ended')
  expect(updatedAirdrop.ended_at).toEqual(expect.any(String))
  await expectSlackMessage('Ended · Pot: $0.02 left of $0.02')
  await expectSlackMessageNotContaining('Not eligible for airdrop. Sorry :(')
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
  }, 20_000) // 20 seconds

  test('sends tip with memo', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> for coffee`)
    const tip = await db
      .selectFrom('tip')
      .select(['confirmed_at', 'memo'])
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
  }, 20_000) // 20 seconds

  test('sends tip with custom amount', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> $0.002`)
    const tip = await db
      .selectFrom('tip')
      .select(['amount', 'confirmed_at'])
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
  }, 20_000) // 20 seconds

  test('sends atomic multi-recipient tip', async () => {
    const accounts = await connectTipAccounts()
    const secondRecipientAccount = await findOrCreateAccount(
      Account.fromSecp256k1('0x2222222222222222222222222222222222222222222222222222222222222222')
        .address,
    )
    await insertMember({
      account_id: secondRecipientAccount.id,
      provider_user_id: unconnectedProviderUserId,
      workspace_id: accounts.workspace.id,
    })

    const response = await postSlashCommand(
      `<@${Constants.slack.memberUserId}> <@${unconnectedProviderUserId}> $0.002 for team`,
    )
    const batch = await db
      .selectFrom('tip_batch')
      .selectAll()
      .where('idempotency_key', 'like', `command:${providerId}:%`)
      .executeTakeFirstOrThrow()
    const tips = await db
      .selectFrom('tip')
      .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
      .select(['recipient.provider_user_id', 'tip.amount', 'tip.confirmed_at'])
      .where('tip.batch_id', '=', batch.id)
      .orderBy('recipient.provider_user_id', 'asc')
      .execute()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `<@${Constants.slack.adminUserId}> sent <@${Constants.slack.memberUserId}> <@${unconnectedProviderUserId}> $0.002 each for team · Receipt`,
    )
    await expectSlackMessage(`• <@${Constants.slack.memberUserId}>`)
    await expectSlackMessage(`• <@${unconnectedProviderUserId}>`)
    expect(batch).toMatchObject({
      amount_each: 2000,
      recipient_count: 2,
      status: 'confirmed',
      total_amount: 4000,
    })
    expect(tips).toHaveLength(2)
    expect(tips).toEqual([
      expect.objectContaining({
        amount: 2000,
        confirmed_at: expect.any(String),
        provider_user_id: Constants.slack.memberUserId,
      }),
      expect.objectContaining({
        amount: 2000,
        confirmed_at: expect.any(String),
        provider_user_id: unconnectedProviderUserId,
      }),
    ])
  }, 20_000) // 20 seconds

  test('sends small group tip immediately with skipped recipients', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand('<!subteam^SENGINEERING|engineering> 0.001 for coffee')
    const batch = await db
      .selectFrom('tip_batch')
      .selectAll()
      .where('idempotency_key', 'like', `command:${providerId}:%`)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `<@${Constants.slack.adminUserId}> sent <!subteam^SENGINEERING|@engineering> $0.001 each for coffee · Receipt`,
    )
    await expectSlackMessage(`• <@${Constants.slack.memberUserId}>`)
    await expectSlackMessage(`• <@${unconnectedProviderUserId}> (not connected yet)`)
    await expectSlackMessageNotContaining(`• <@${Constants.slack.adminUserId}> (you)`)
    await expectSlackMessageNotContaining('You’re about to tip')
    expect(batch).toMatchObject({ recipient_count: 1, status: 'confirmed' })
  }, 20_000) // 20 seconds

  test('sends fifteen-recipient group tip immediately', async () => {
    const accounts = await connectTipAccounts()
    for (const providerUserId of Constants.slackBigUserIds.slice(0, 15)) {
      await insertMember({
        account_id: (await factory.account.insert({})).id,
        provider_user_id: providerUserId,
        workspace_id: accounts.workspace.id,
      })
    }

    const response = await postSlashCommand('<!subteam^SSMALLTEAM|smallteam> 0.001')
    const batch = await db
      .selectFrom('tip_batch')
      .selectAll()
      .where('idempotency_key', 'like', `command:${providerId}:%`)
      .executeTakeFirstOrThrow()
    const tips = await db.selectFrom('tip').select('id').where('batch_id', '=', batch.id).execute()

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `<@${Constants.slack.adminUserId}> tipped <!subteam^SSMALLTEAM|@smallteam> $0.001 each · Receipt`,
    )
    await expectSlackMessageNotContaining('D1_ERROR')
    expect(batch).toMatchObject({ recipient_count: 15, status: 'confirmed' })
    expect(tips).toHaveLength(15)
  }, 20_000) // 20 seconds

  test('previews large group tip', async () => {
    const accounts = await connectTipAccounts()
    for (const providerUserId of Constants.slackBigUserIds.slice(0, 16)) {
      await insertMember({
        account_id: (await factory.account.insert({})).id,
        provider_user_id: providerUserId,
        workspace_id: accounts.workspace.id,
      })
    }

    const response = await postSlashCommand('<!subteam^SREVIEWTEAM|reviewteam> 0.001 for coffee')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `You’re about to tip <!subteam^SREVIEWTEAM|@reviewteam> <@${Constants.slackBigUserIds[0]}> <@${Constants.slackBigUserIds[1]}> <@${Constants.slackBigUserIds[2]}> <@${Constants.slackBigUserIds[3]}> <@${Constants.slackBigUserIds[4]}> + 11 others $0.001 each for coffee.`,
    )
    await expectSlackMessageNotContaining('Receipt')
  }, 20_000) // 20 seconds

  test('previews channel tip through channel membership', async () => {
    await connectTipAccounts()
    await memberSlack.conversations.join({ channel: Constants.slack.channelId })

    const response = await postSlashCommand('<!channel> $11 for coffee')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `You’re about to tip <!channel> <@${Constants.slack.memberUserId}> $11.00 each for coffee.`,
    )
    await expectSlackMessage(`• <@${Constants.slack.memberUserId}>`)
    await expectSlackMessageNotContaining(`• <@${Constants.slack.adminUserId}> (you)`)
    await expectSlackMessageNotContaining('Receipt')
  })

  test('previews channel tip through paginated channel membership', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/conversations.members')) {
        const params = slackFetchBodyParams(init?.body)
        return Response.json(
          params.get('cursor')
            ? {
                members: [Constants.slack.memberUserId],
                ok: true,
                response_metadata: { next_cursor: '' },
              }
            : {
                members: [Constants.slack.adminUserId],
                ok: true,
                response_metadata: { next_cursor: 'page_2' },
              },
        )
      }
      return originalFetch(input, init)
    }) satisfies typeof fetch)
    await connectTipAccounts()

    const response = await postSlashCommand('<!channel> $11 for coffee')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `You’re about to tip <!channel> <@${Constants.slack.memberUserId}> $11.00 each for coffee.`,
    )
    await expectSlackMessage(`• <@${Constants.slack.memberUserId}>`)
    await expectSlackMessageNotContaining(`• <@${Constants.slack.adminUserId}> (you)`)
    await expectSlackMessageNotContaining('Receipt')
    fetchSpy.mockRestore()
  })

  test('skips sender account when channel membership uses alternate Slack account id', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/conversations.members'))
        return Response.json({
          members: ['WALTERNATESELF', Constants.slack.memberUserId],
          ok: true,
          response_metadata: { next_cursor: '' },
        })
      if (url.endsWith('/users.info')) {
        const params = slackFetchBodyParams(init?.body)
        if (params.get('user') === 'WALTERNATESELF')
          return Response.json({
            ok: true,
            user: { deleted: false, id: 'WALTERNATESELF', is_app_user: false, is_bot: false },
          })
      }
      return originalFetch(input, init)
    }) satisfies typeof fetch)
    const accounts = await connectTipAccounts()
    await insertMember({
      account_id: accounts.senderAccount.id,
      provider_user_id: 'WALTERNATESELF',
      workspace_id: accounts.workspace.id,
    })

    const response = await postSlashCommand('<!channel> 0.001 for coffee')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `<@${Constants.slack.adminUserId}> sent <!channel> <@${Constants.slack.memberUserId}> $0.001 each for coffee · Receipt`,
    )
    await expectSlackMessage(`• <@${Constants.slack.memberUserId}>`)
    await expectSlackMessageNotContaining('WALTERNATESELF')
    await expectSlackMessageNotContaining('Payment not sent. Cannot send a payment to yourself.')
    fetchSpy.mockRestore()
  }, 20_000) // 20 seconds

  test('previews here tip through active channel membership', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/users.getPresence')) {
        const params = slackFetchBodyParams(init?.body)
        return Response.json({
          ok: true,
          presence:
            params.get('user') === Constants.slack.adminUserId ||
            params.get('user') === Constants.slack.memberUserId
              ? 'active'
              : 'away',
        })
      }
      return originalFetch(input, init)
    }) satisfies typeof fetch)
    await connectTipAccounts()
    await memberSlack.conversations.join({ channel: Constants.slack.channelId })

    const response = await postSlashCommand('<!here> $11 for coffee')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `You’re about to tip <!here> <@${Constants.slack.memberUserId}> $11.00 each for coffee.`,
    )
    await expectSlackMessage(`• <@${Constants.slack.memberUserId}>`)
    await expectSlackMessageNotContaining(`• <@${Constants.slack.adminUserId}> (you)`)
    await expectSlackMessageNotContaining(`• <@${unconnectedProviderUserId}> (not connected yet)`)
    await expectSlackMessageNotContaining('Receipt')
    fetchSpy.mockRestore()
  })

  test('explains when no online members besides sender are connected for here tip', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/conversations.members'))
        return Response.json({
          members: [Constants.slack.adminUserId, Constants.slack.memberUserId],
          ok: true,
          response_metadata: { next_cursor: '' },
        })
      if (url.endsWith('/users.getPresence')) {
        const params = slackFetchBodyParams(init?.body)
        return Response.json({
          ok: true,
          presence: params.get('user') === Constants.slack.adminUserId ? 'active' : 'away',
        })
      }
      return originalFetch(input, init)
    }) satisfies typeof fetch)
    await connectTipAccounts()

    const response = await postSlashCommand('<!here> 0.001 for coffee')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Payment not sent. No online members besides you are connected to Tipbot.',
    )
    await expectSlackMessageNotContaining('None of the members of <!here> are connected')
    fetchSpy.mockRestore()
  })

  test('explains when channel membership cannot be read', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/conversations.members'))
        return Response.json({ error: 'not_in_channel', ok: false })
      return originalFetch(input, init)
    }) satisfies typeof fetch)
    await connectTipAccounts()

    const response = await postSlashCommand('<!channel> $11 for coffee')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Payment not sent. Tipbot could not read the channel members. Invite Tipbot to this channel and try again.',
    )
    await expectSlackMessageNotContaining('You’re about to tip')
    fetchSpy.mockRestore()
  })

  test('explains when channel membership permission is missing', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/conversations.members'))
        return Response.json({ error: 'missing_scope', ok: false })
      return originalFetch(input, init)
    }) satisfies typeof fetch)
    await connectTipAccounts()

    const response = await postSlashCommand('<!channel> $11 for coffee')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Payment not sent. Tipbot could not read the channel members because Tipbot is missing Slack permissions. Reinstall Tipbot and try again.',
    )
    await expectSlackMessageNotContaining('You’re about to tip')
    fetchSpy.mockRestore()
  })

  test('explains when active channel membership permission is missing', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/users.getPresence'))
        return Response.json({ error: 'missing_scope', ok: false })
      return originalFetch(input, init)
    }) satisfies typeof fetch)
    await connectTipAccounts()
    await memberSlack.conversations.join({ channel: Constants.slack.channelId })

    const response = await postSlashCommand('<!here> $11 for coffee')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Payment not sent. Tipbot could not read active channel members because Tipbot is missing Slack permissions. Reinstall Tipbot and try again.',
    )
    await expectSlackMessageNotContaining('You’re about to tip')
    fetchSpy.mockRestore()
  })

  test('previews small group tip when total is more than $10', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand('<!subteam^SENGINEERING|@engineering> $11 for coffee')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `You’re about to tip <!subteam^SENGINEERING|@engineering> <@${Constants.slack.memberUserId}> $11.00 each for coffee.`,
    )
    await expectSlackMessageNotContaining('@@engineering')
    await expectSlackMessage(`• <@${Constants.slack.memberUserId}>`)
    await expectSlackMessage(`• <@${unconnectedProviderUserId}> (not connected yet)`)
    await expectSlackMessageNotContaining(`• <@${Constants.slack.adminUserId}> (you)`)
    await expectSlackMessageNotContaining('Receipt')
  })

  test('shows group tip failure message', async () => {
    const handleTipBatchRequest = vi.spyOn(Tip, 'handleTipBatchRequest').mockResolvedValue({
      code: 'failed',
      message: 'Debuggable failure reason.',
      ok: false,
    })
    await connectTipAccounts()

    const response = await postSlashCommand('<!subteam^SENGINEERING|engineering> 0.001')

    expect(response.status).toBe(200)
    await expectSlackMessage('Debuggable failure reason.')
    await expectSlackMessageNotContaining('Payment failed.')
    handleTipBatchRequest.mockRestore()
  })

  test('previews explicit batch tip with skipped unconnected recipient', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand(
      `<@${Constants.slack.memberUserId}> <@${unconnectedProviderUserId}> for coffee`,
    )

    expect(response.status).toBe(200)
    await expectSlackMessage(
      `You’re about to tip <@${Constants.slack.memberUserId}> $0.001 each for coffee.`,
    )
    await expectSlackMessage(`• <@${Constants.slack.memberUserId}>`)
    await expectSlackMessage(`• <@${unconnectedProviderUserId}> (not connected yet)`)
    await expectSlackMessageNotContaining('Receipt')
  })

  test('rejects group tips in Slack Connect channels', async () => {
    const channelId = await getSlackConnectChannelId()

    const response = await postSlashCommand('<!subteam^SENGINEERING|engineering>', { channelId })

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Group tips are not supported in Slack Connect channels yet; mention individual recipients instead.',
      { channelId },
    )
  })

  test('rejects explicit self mention even when mixed with group', async () => {
    const response = await postSlashCommand(
      `<@${Constants.slack.adminUserId}> <!subteam^SENGINEERING|engineering>`,
    )

    expect(response.status).toBe(200)
    await expectSlackMessage('Payment not sent. Cannot send a payment to yourself.')
  })

  test('rejects group tip with more than 100 connected recipients', async () => {
    const accounts = await connectTipAccounts({ recipient: false })
    for (const providerUserId of Constants.slackBigUserIds) {
      await insertMember({
        account_id: (await factory.account.insert({})).id,
        provider_user_id: providerUserId,
        workspace_id: accounts.workspace.id,
      })
    }

    const response = await postSlashCommand('<!subteam^SBIGTEAM|bigteam>')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Payment not sent. This tip has 101 connected recipients; multi-tip currently supports up to 100.',
    )
  }, 20_000) // 20 seconds

  test('deduplicates duplicate multi-recipient tip requests', async () => {
    const accounts = await connectTipAccounts()
    const secondRecipientAccount = await findOrCreateAccount(
      Account.fromSecp256k1('0x2222222222222222222222222222222222222222222222222222222222222222')
        .address,
    )
    await insertMember({
      account_id: secondRecipientAccount.id,
      provider_user_id: unconnectedProviderUserId,
      workspace_id: accounts.workspace.id,
    })
    const text = `<@${Constants.slack.memberUserId}> <@${unconnectedProviderUserId}> $0.002 for team`

    const firstResponse = await postSlashCommand(text)
    const secondResponse = await postSlashCommand(text)
    const batches = await db
      .selectFrom('tip_batch')
      .selectAll()
      .where('idempotency_key', 'like', `command:${providerId}:%`)
      .execute()
    const tips = await db
      .selectFrom('tip')
      .select(['batch_id', 'confirmed_at'])
      .where('batch_id', '=', batches[0]!.id)
      .execute()

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      recipient_count: 2,
      status: 'confirmed',
    })
    expect(tips).toHaveLength(2)
    expect(tips).toEqual([
      expect.objectContaining({ confirmed_at: expect.any(String) }),
      expect.objectContaining({ confirmed_at: expect.any(String) }),
    ])
  }, 20_000) // 20 seconds

  test('accepts 20 recipients for confirmation', async () => {
    const accounts = await connectTipAccounts()
    const recipients: string[] = [Constants.slack.memberUserId]
    for (let index = 0; index < 19; index++) {
      const account = await factory.account.insert({})
      const providerUserId = `U${String(index + 10).padStart(8, '0')}`
      recipients.push(providerUserId)
      await insertMember({
        account_id: account.id,
        provider_user_id: providerUserId,
        workspace_id: accounts.workspace.id,
      })
    }

    const response = await postSlashCommand(
      `${recipients.map((recipient) => `<@${recipient}>`).join(' ')} 1`,
    )
    const token = await getLatestConfirmToken()
    const confirmation = await client.api.confirm[':token'].$get({ param: { token } })

    expect(response.status).toBe(200)
    await expectSlackMessage('Tipbot needs your approval to send this payment.')
    expect(confirmation.status).toBe(200)
    const json = await confirmation.json()
    expect(json).toMatchObject({
      amount: '1',
      kind: 'onetime_payment',
    })
    if (!json.ok) throw new Error('Expected confirmation metadata.')
    expect(json.recipients).toHaveLength(20)
    expect(json.transactionRequest?.calls).toHaveLength(20)
  }, 20_000) // 20 seconds

  test('rejects 101 recipients', async () => {
    const recipients = Array.from({ length: 101 }, (_value, index) => ({
      recipientProviderUserId: `U${String(index + 10).padStart(8, '0')}`,
    }))

    const result = await Tip.handleTipBatchRequest(env, {
      idempotencyKey: `limit:${Nanoid.generate()}`,
      memo: null,
      provider: 'slack',
      providerChannelId: Constants.slack.channelId,
      providerId,
      recipients,
      senderProviderUserId: Constants.slack.adminUserId,
      source: 'command',
    })

    expect(result).toEqual({
      code: 'failed',
      message: 'Multi-tip supports up to 100 recipients.',
      ok: false,
    })
  })

  test('requests one-time approval when batch total exceeds existing access key limit', async () => {
    const accounts = await connectTipAccounts()
    const secondRecipientAccount = await findOrCreateAccount(
      Account.fromSecp256k1('0x2222222222222222222222222222222222222222222222222222222222222222')
        .address,
    )
    await insertMember({
      account_id: secondRecipientAccount.id,
      provider_user_id: unconnectedProviderUserId,
      workspace_id: accounts.workspace.id,
    })

    const response = await postSlashCommand(
      `<@${Constants.slack.memberUserId}> <@${unconnectedProviderUserId}> 6`,
    )
    const token = await getLatestConfirmToken()
    const confirmation = await client.api.confirm[':token'].$get({ param: { token } })

    expect(response.status).toBe(200)
    await expectSlackMessage('Tipbot needs your approval to send this payment.')
    await expectSlackMessageNotContaining('Receipt')
    expect(confirmation.status).toBe(200)
    await expect(confirmation.json()).resolves.toMatchObject({
      amount: '6',
      kind: 'onetime_payment',
      recipients: [
        { recipientProviderUserId: Constants.slack.memberUserId },
        { recipientProviderUserId: unconnectedProviderUserId },
      ],
      transactionRequest: expect.objectContaining({ calls: expect.any(Array) }),
    })
  })

  test('shows confirmation action for token without access key', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> 0.002 BetaUSD`)

    expect(response.status).toBe(200)
    await expectSlackMessage('Tipbot needs your approval to send this payment.')
    await expectSlackMessage('/confirm/')
    await expectSlackMessage('Link expires in 10 minutes.')
    await expectSlackMessageNotContaining('Receipt')
  })

  test('shows confirmation action from direct message', async () => {
    const dm = setupSlackDMPostMessageFetchSpy()
    await connectTipAccounts()

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}> 0.002 BetaUSD`, {
      channelId: dm.channelId,
    })

    expect(response.status).toBe(200)
    await expectSlackPostMessageCall(
      dm.fetchSpy,
      dm.channelId,
      'Tipbot needs your approval to send this payment.',
    )
    await expectSlackPostMessageCall(dm.fetchSpy, dm.channelId, '/confirm/')
    dm.fetchSpy.mockRestore()
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
      `<@${Constants.slack.adminUserId}> queued <@${Constants.slack.memberUserId}> $0.001`,
    )
    await expectSlackMessage('Run `/tip connect` to receive it')
  })

  test('queues multi-recipient tip when recipients are not connected', async () => {
    const connected = await connectTipAccounts({ recipient: false })

    const response = await postSlashCommand(
      `<@${Constants.slack.memberUserId}> <@${Constants.slack.unconnectedUserId}> for meeting`,
    )
    const pendingTips = await db
      .selectFrom('pending_tip')
      .select(['memo', 'recipient_provider_user_id', 'status'])
      .where('sender_member_id', '=', connected.senderMember.id)
      .orderBy('recipient_provider_user_id', 'asc')
      .execute()

    expect(response.status).toBe(200)
    expect(pendingTips).toEqual([
      {
        memo: 'meeting',
        recipient_provider_user_id: Constants.slack.memberUserId,
        status: 'pending',
      },
      {
        memo: 'meeting',
        recipient_provider_user_id: Constants.slack.unconnectedUserId,
        status: 'pending',
      },
    ])
    await expectSlackMessage(
      `<@${Constants.slack.adminUserId}> queued 2 accounts $0.001 each for meeting`,
    )
    await expectSlackMessage(`- <@${Constants.slack.memberUserId}>`)
    await expectSlackMessage(`- <@${Constants.slack.unconnectedUserId}>`)
    await expectSlackMessage('Run `/tip connect` to receive it')
    const history = await slack.conversations.history({ channel: Constants.slack.channelId })
    expect(history.messages?.filter((message) => message.text?.includes('queued')).length).toBe(1)
  })

  test('queues multiple tips for same unconnected recipient', async () => {
    const connected = await connectTipAccounts({ recipient: false })

    await postSlashCommand(`<@${Constants.slack.memberUserId}> $0.001 for first`, {
      triggerId: 'queue-first-tip',
    })
    await postSlashCommand(`<@${Constants.slack.memberUserId}> $0.002 for second`, {
      triggerId: 'queue-second-tip',
    })
    const pendingTips = await db
      .selectFrom('pending_tip')
      .select(['amount', 'memo', 'status'])
      .where('sender_member_id', '=', connected.senderMember.id)
      .where('recipient_provider_user_id', '=', Constants.slack.memberUserId)
      .orderBy('amount', 'asc')
      .execute()

    expect(pendingTips).toEqual([
      { amount: 1000, memo: 'first', status: 'pending' },
      { amount: 2000, memo: 'second', status: 'pending' },
    ])
    await expectSlackMessage(
      `<@${Constants.slack.adminUserId}> queued <@${Constants.slack.memberUserId}> $0.001 for first`,
    )
    await expectSlackMessage(
      `<@${Constants.slack.adminUserId}> queued <@${Constants.slack.memberUserId}> $0.002 for second`,
    )
  })

  test('claims pending tip when recipient connects', async () => {
    const connected = await connectTipAccounts({ recipient: false })

    await postSlashCommand(`<@${Constants.slack.memberUserId}> for coffee`)
    const pending = await db
      .selectFrom('pending_tip')
      .selectAll()
      .where('sender_member_id', '=', connected.senderMember.id)
      .executeTakeFirstOrThrow()
    const recipientMember = await db
      .selectFrom('member')
      .select('provider_identity_id')
      .where('id', '=', pending.recipient_member_id)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('provider_identity')
      .set({ account_id: connected.recipientAccount.id, updated_at: new Date().toISOString() })
      .where('id', '=', recipientMember.provider_identity_id)
      .execute()

    const result = await Tip.claimPendingTip(env, { pendingTipId: pending.id })
    const updated = await db
      .selectFrom('pending_tip')
      .selectAll()
      .where('id', '=', pending.id)
      .executeTakeFirstOrThrow()
    const tips = await db
      .selectFrom('tip')
      .selectAll()
      .where('idempotency_key', '=', `pending:${pending.id}`)
      .execute()

    expect(result).toMatchObject({ ok: true, status: 'sent' })
    expect(updated.status).toBe('sent')
    expect(updated.tip_id).toBe(tips[0]?.id)
    expect(tips).toHaveLength(1)
    await expect(Tip.claimPendingTip(env, { pendingTipId: pending.id })).resolves.toMatchObject({
      ok: true,
      status: 'sent',
      transactionHash: expect.any(String),
    })

    await db
      .updateTable('pending_tip')
      .set({ status: 'sending', tip_id: null, updated_at: new Date().toISOString() })
      .where('id', '=', pending.id)
      .execute()

    await expect(Tip.claimPendingTip(env, { pendingTipId: pending.id })).resolves.toMatchObject({
      ok: true,
      status: 'sent',
    })
    await expect(
      db
        .selectFrom('tip')
        .selectAll()
        .where('idempotency_key', '=', `pending:${pending.id}`)
        .execute(),
    ).resolves.toHaveLength(1)
  }, 20_000) // 20 seconds

  test('posts new receipt when queued message was deleted before claim update', async () => {
    const connected = await connectTipAccounts({ recipient: false })

    await postSlashCommand(`<@${Constants.slack.memberUserId}> for fallback`)
    const pending = await db
      .selectFrom('pending_tip')
      .selectAll()
      .where('sender_member_id', '=', connected.senderMember.id)
      .executeTakeFirstOrThrow()
    if (!pending.provider_message_ts) throw new Error('Expected queued Slack message timestamp.')
    await slack.chat.delete({
      channel: Constants.slack.channelId,
      ts: pending.provider_message_ts,
    })
    await Chat.updateSlackPendingTipMessage(db, {
      amount: '0.001',
      chainId: pending.chain_id,
      isDefaultToken: true,
      memo: pending.memo,
      ok: true,
      pendingTip: pending,
      recipientProviderUserId: pending.recipient_provider_user_id,
      senderProviderUserId: pending.sender_provider_user_id,
      status: 'sent',
      tokenCurrency: 'USD',
      tokenSymbol: 'PathUSD',
      transactionHash: `0x${'1'.repeat(64)}`,
    })

    await expectSlackMessage(
      `<@${Constants.slack.adminUserId}> sent <@${Constants.slack.memberUserId}> $0.001 for fallback · Receipt`,
    )
  }, 20_000) // 20 seconds

  test('expires pending tip without sending payment', async () => {
    const connected = await connectTipAccounts({ recipient: false })

    await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
    const pending = await db
      .selectFrom('pending_tip')
      .selectAll()
      .where('sender_member_id', '=', connected.senderMember.id)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('pending_tip')
      .set({ expires_at: new Date(Date.now() - 60 * 1000).toISOString() }) // 1 minute ago
      .where('id', '=', pending.id)
      .execute()

    const result = await Tip.claimPendingTip(env, { pendingTipId: pending.id })
    const updated = await db
      .selectFrom('pending_tip')
      .selectAll()
      .where('id', '=', pending.id)
      .executeTakeFirstOrThrow()
    const tips = await db
      .selectFrom('tip')
      .selectAll()
      .where('idempotency_key', '=', `pending:${pending.id}`)
      .execute()

    expect(result).toMatchObject({ ok: false, status: 'expired' })
    expect(updated.status).toBe('expired')
    expect(updated.failure_reason).toBe('Pending tip expired before recipient connected.')
    expect(tips).toHaveLength(0)
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

  test('handles insufficient funds from direct message', async () => {
    const dm = setupSlackDMPostMessageFetchSpy()
    const handleTipRequest = vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
      code: 'insufficient_funds',
      ok: false,
    })

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}>`, {
      channelId: dm.channelId,
    })

    expect(response.status).toBe(200)
    await expectSlackPostMessageCall(
      dm.fetchSpy,
      dm.channelId,
      'Payment not sent. Your wallet has insufficient funds.',
    )
    await expectSlackPostMessageCall(
      dm.fetchSpy,
      dm.channelId,
      'Add funds on https://wallet.tempo.xyz',
    )
    handleTipRequest.mockRestore()
    dm.fetchSpy.mockRestore()
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
    const senderMember = await insertMember({
      account_id: senderAccount.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    const recipientMember = await insertMember({
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
    const senderMember = await insertMember({
      account_id: senderAccount.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    const recipientMember = await insertMember({
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
      workspace_id: workspace.id,
    })

    const response = await postSlashCommand(`<@${Constants.slack.memberUserId}>`, { triggerId })

    expect(response.status).toBe(200)
    await expectSlackMessage('Payment still sending.')
    await expectSlackMessageNotContaining('Sending payment.')
  })
})

test('/tip jar opens a tip jar and updates totals when a preset is clicked', async () => {
  const connected = await connectTipAccounts({
    recipient: false,
    senderProviderUserId: Constants.slack.memberUserId,
  })
  const adminMember = await insertMember({
    account_id: connected.recipientAccount.id,
    provider_user_id: Constants.slack.adminUserId,
    workspace_id: connected.workspace.id,
  })

  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const response = await postSlashCommand('jar for lunch.')
  const tipAsk = await db
    .selectFrom('tip_ask')
    .selectAll()
    .where('workspace_id', '=', connected.workspace.id)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(tipAsk).toMatchObject({
    beneficiary_provider_user_id: null,
    closed_at: null,
    creator_fee_basis_points: 0,
    dollar_amount: 10_000,
    memo: 'lunch',
    money_with_wings_amount: 1000,
    moneybag_amount: 100_000,
    provider_channel_id: Constants.slack.channelId,
    requester_member_id: expect.any(String),
  })
  await expectSlackMessage(`<@${Constants.slack.adminUserId}> opened a tip jar for lunch`)
  await expectSlackMessage('No tips yet')
  await expectSlackMessage('[💸 $0.001] [💵 $0.01] [💰 $0.10]')
  const tipAskPostMessageCall = fetchSpy.mock.calls.find((call) => {
    const input = call[0]
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const params = slackFetchBodyParams(call[1]?.body)
    return (
      url.endsWith('/chat.postMessage') &&
      params.get('text')?.includes(`<@${Constants.slack.adminUserId}> opened a tip jar for lunch`)
    )
  })
  const blocks = JSON.parse(
    slackFetchBodyParams(tipAskPostMessageCall?.[1]?.body).get('blocks') ?? '[]',
  )
  const actionIds = (blocks as Array<{ elements?: Array<{ action_id?: string }> }>).flatMap(
    (block) => block.elements?.map((element) => element.action_id).filter(Boolean) ?? [],
  )
  expect(actionIds).toEqual([
    'tip_ask_option_money_with_wings',
    'tip_ask_option_dollar',
    'tip_ask_option_moneybag',
  ])
  expect(new Set(actionIds).size).toBe(actionIds.length)
  const tipAskControlCall = fetchSpy.mock.calls.find((call) => {
    const input = call[0]
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const params = slackFetchBodyParams(call[1]?.body)
    return (
      url.endsWith('/chat.postEphemeral') &&
      params.get('text') === 'Manage your tip jar.' &&
      params.get('user') === Constants.slack.adminUserId
    )
  })
  const controlBlocks = JSON.parse(
    slackFetchBodyParams(tipAskControlCall?.[1]?.body).get('blocks') ?? '[]',
  )
  const closeButton = controlBlocks
    .flatMap(
      (block: { elements?: Array<{ action_id?: string; value?: string }> }) => block.elements ?? [],
    )
    .find((element: { action_id?: string }) => element.action_id === 'tip_ask_close')
  const closeButtonPayload = JSON.parse(closeButton?.value ?? 'null') as { tipAskId: string }
  expect(closeButtonPayload).toEqual({ tipAskId: tipAsk.id })

  const unauthorizedCloseResponse = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_ask_close',
        type: 'button',
        value: JSON.stringify(closeButtonPayload),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipAsk.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipAsk.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-ask-close-member-trigger',
    type: 'block_actions',
    user: { id: Constants.slack.memberUserId, name: Constants.slack.memberUserName },
  })
  const openTipAsk = await db
    .selectFrom('tip_ask')
    .select('closed_at')
    .where('id', '=', tipAsk.id)
    .executeTakeFirstOrThrow()

  expect(unauthorizedCloseResponse.status).toBe(200)
  expect(openTipAsk.closed_at).toBeNull()
  await expectSlackMessage('Only the creator can close this tip jar.')

  const dollarButton = blocks
    .flatMap(
      (block: { elements?: Array<{ action_id?: string; value?: string }> }) => block.elements ?? [],
    )
    .find((element: { action_id?: string }) => element.action_id === 'tip_ask_option_dollar')
  const dollarButtonPayload = JSON.parse(dollarButton?.value ?? 'null') as {
    nonce: string
    reaction: 'dollar'
    tipAskId: string
  }
  expect(dollarButtonPayload).toMatchObject({ reaction: 'dollar', tipAskId: tipAsk.id })
  expect(dollarButtonPayload.nonce).toEqual(expect.any(String))

  const clickResponse = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_ask_option_dollar',
        type: 'button',
        value: JSON.stringify(dollarButtonPayload),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipAsk.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipAsk.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-ask-dollar-trigger',
    type: 'block_actions',
    user: { id: Constants.slack.memberUserId, name: Constants.slack.memberUserName },
  })
  const tip = await db
    .selectFrom('tip')
    .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
    .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
    .select([
      'recipient.provider_user_id as recipient_provider_user_id',
      'sender.provider_user_id as sender_provider_user_id',
      'tip.amount',
      'tip.confirmed_at',
      'tip.idempotency_key',
      'tip.memo',
    ])
    .where(
      'tip.idempotency_key',
      'like',
      `tip_ask:${tipAsk.id}:dollar:${Constants.slack.memberUserId}:%`,
    )
    .executeTakeFirstOrThrow()

  expect(clickResponse.status).toBe(200)
  expect(tip).toMatchObject({
    amount: 10_000,
    memo: 'lunch',
    recipient_provider_user_id: Constants.slack.adminUserId,
    sender_provider_user_id: Constants.slack.memberUserId,
  })
  expect(tip.confirmed_at).toEqual(expect.any(String))
  expect(tip.idempotency_key).not.toMatch(/:beneficiary$/)
  await expectSlackMessage('1 tip · $0.01 total')
  await expectSlackMessage(`💵 <@${Constants.slack.memberUserId}>`)
  await expectSlackMessageNotContaining(
    `You tipped <@${Constants.slack.adminUserId}> $0.01 for lunch.`,
  )

  const secondClickResponse = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_ask_option_dollar',
        type: 'button',
        value: JSON.stringify(dollarButtonPayload),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipAsk.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipAsk.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-ask-dollar-trigger-2',
    type: 'block_actions',
    user: { id: Constants.slack.memberUserId, name: Constants.slack.memberUserName },
  })
  const tipCount = await db
    .selectFrom('tip')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where(
      'tip.idempotency_key',
      'like',
      `tip_ask:${tipAsk.id}:dollar:${Constants.slack.memberUserId}:%`,
    )
    .executeTakeFirstOrThrow()

  expect(secondClickResponse.status).toBe(200)
  expect(tipCount.count).toBe(2)
  await expectSlackMessage('2 tips · $0.02 total')
  await expectSlackMessage(`💵 <@${Constants.slack.memberUserId}> x2`)

  const closeResponse = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_ask_close',
        type: 'button',
        value: JSON.stringify(closeButtonPayload),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipAsk.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipAsk.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-ask-close-trigger',
    type: 'block_actions',
    user: { id: Constants.slack.adminUserId, name: Constants.slack.adminUserName },
  })
  const closedTipAsk = await db
    .selectFrom('tip_ask')
    .select('closed_at')
    .where('id', '=', tipAsk.id)
    .executeTakeFirstOrThrow()

  expect(closeResponse.status).toBe(200)
  expect(closedTipAsk.closed_at).toEqual(expect.any(String))
  await expectSlackMessage('Closed')

  const thirdClickResponse = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_ask_option_dollar',
        type: 'button',
        value: JSON.stringify({ ...dollarButtonPayload, nonce: 'third-click' }),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipAsk.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipAsk.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-ask-dollar-trigger-3',
    type: 'block_actions',
    user: { id: Constants.slack.memberUserId, name: Constants.slack.memberUserName },
  })
  const tipCountAfterClose = await db
    .selectFrom('tip')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where(
      'tip.idempotency_key',
      'like',
      `tip_ask:${tipAsk.id}:dollar:${Constants.slack.memberUserId}:%`,
    )
    .executeTakeFirstOrThrow()

  expect(thirdClickResponse.status).toBe(200)
  expect(tipCountAfterClose.count).toBe(2)
  await expectSlackMessage('Tip jar is closed.')

  await factory.tip.insert(
    {
      amount: 100_000,
      confirmed_at: new Date().toISOString(),
      idempotency_key: `tip_ask:${tipAsk.id}:moneybag:${Constants.slack.adminUserId}:one`,
      recipient_id: connected.recipientAccount.id,
      recipient_member_id: adminMember.id,
      sender_id: connected.recipientAccount.id,
      sender_member_id: adminMember.id,
      token_address: Tempo.addressLookup.pathUsd,
      workspace_id: connected.workspace.id,
    },
    {
      amount: 100_000,
      confirmed_at: new Date().toISOString(),
      idempotency_key: `tip_ask:${tipAsk.id}:moneybag:${Constants.slack.memberUserId}:one`,
      recipient_id: connected.recipientAccount.id,
      recipient_member_id: adminMember.id,
      sender_id: connected.senderAccount.id,
      sender_member_id: connected.senderMember.id,
      token_address: Tempo.addressLookup.pathUsd,
      workspace_id: connected.workspace.id,
    },
    {
      amount: 100_000,
      confirmed_at: new Date().toISOString(),
      idempotency_key: `tip_ask:${tipAsk.id}:moneybag:${Constants.slack.memberUserId}:two`,
      recipient_id: connected.recipientAccount.id,
      recipient_member_id: adminMember.id,
      sender_id: connected.senderAccount.id,
      sender_member_id: connected.senderMember.id,
      token_address: Tempo.addressLookup.pathUsd,
      workspace_id: connected.workspace.id,
    },
  )
  await Chat.updateTipAskMessage(providerId, { tipAskId: tipAsk.id })
  await expectSlackMessage(
    `💰 <@${Constants.slack.memberUserId}> x2 <@${Constants.slack.adminUserId}>`,
  )
}, 20_000) // 20 seconds

test('/tip jar for account sends beneficiary tip and creator fee', async () => {
  const connected = await connectTipAccounts({
    senderProviderUserId: Constants.slack.unconnectedUserId,
  })
  const creatorAccount = await factory.account.insert({
    address: '0x0000000000000000000000000000000000000101',
  })
  const creatorMember = await insertMember({
    account_id: creatorAccount.id,
    provider_user_id: Constants.slack.adminUserId,
    workspace_id: connected.workspace.id,
  })
  const fetchSpy = vi.spyOn(globalThis, 'fetch')

  const response = await postSlashCommand(`jar <@${Constants.slack.memberUserId}> for rehab`)
  const tipAsk = await db
    .selectFrom('tip_ask')
    .selectAll()
    .where('workspace_id', '=', connected.workspace.id)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(tipAsk).toMatchObject({
    beneficiary_provider_user_id: Constants.slack.memberUserId,
    creator_fee_basis_points: 100,
    memo: 'rehab',
    requester_member_id: creatorMember.id,
  })
  await expectSlackMessage(
    `<@${Constants.slack.adminUserId}> opened a tip jar for <@${Constants.slack.memberUserId}>'s rehab`,
  )
  const tipAskPostMessageCall = fetchSpy.mock.calls.find((call) => {
    const input = call[0]
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const params = slackFetchBodyParams(call[1]?.body)
    return (
      url.endsWith('/chat.postMessage') &&
      params
        .get('text')
        ?.includes(
          `<@${Constants.slack.adminUserId}> opened a tip jar for <@${Constants.slack.memberUserId}>'s rehab`,
        )
    )
  })
  const blocks = JSON.parse(
    slackFetchBodyParams(tipAskPostMessageCall?.[1]?.body).get('blocks') ?? '[]',
  )
  const dollarButton = blocks
    .flatMap(
      (block: { elements?: Array<{ action_id?: string; value?: string }> }) => block.elements ?? [],
    )
    .find((element: { action_id?: string }) => element.action_id === 'tip_ask_option_dollar')
  const dollarButtonPayload = JSON.parse(dollarButton?.value ?? 'null') as {
    nonce: string
    reaction: 'dollar'
    tipAskId: string
  }

  const clickResponse = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_ask_option_dollar',
        type: 'button',
        value: JSON.stringify(dollarButtonPayload),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipAsk.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipAsk.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-ask-beneficiary-dollar-trigger',
    type: 'block_actions',
    user: { id: Constants.slack.unconnectedUserId, name: Constants.slack.unconnectedUserName },
  })
  const tips = await db
    .selectFrom('tip')
    .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
    .select([
      'recipient.provider_user_id as recipient_provider_user_id',
      'tip.amount',
      'tip.idempotency_key',
    ])
    .where(
      'tip.idempotency_key',
      'like',
      `tip_ask:${tipAsk.id}:dollar:${Constants.slack.unconnectedUserId}:%`,
    )
    .orderBy('tip.amount', 'desc')
    .execute()

  expect(clickResponse.status).toBe(200)
  expect(tips).toEqual([
    expect.objectContaining({
      amount: 10_000,
      idempotency_key: expect.stringMatching(/:beneficiary$/),
      recipient_provider_user_id: Constants.slack.memberUserId,
    }),
    expect.objectContaining({
      amount: 100,
      idempotency_key: expect.stringMatching(/:creator_fee$/),
      recipient_provider_user_id: Constants.slack.adminUserId,
    }),
  ])
  await expectSlackMessage('1 tip · $0.01 total')
  await expectSlackMessage(`💵 <@${Constants.slack.unconnectedUserId}>`)
})

test('/tip jar for unconnected account queues beneficiary tip and pays creator fee', async () => {
  const connected = await connectTipAccounts({
    recipient: false,
    senderProviderUserId: Constants.slack.memberUserId,
  })
  const creatorAccount = await factory.account.insert({
    address: '0x0000000000000000000000000000000000000102',
  })
  await insertMember({
    account_id: creatorAccount.id,
    provider_user_id: Constants.slack.adminUserId,
    workspace_id: connected.workspace.id,
  })
  const fetchSpy = vi.spyOn(globalThis, 'fetch')

  const response = await postSlashCommand(`jar <@${Constants.slack.unconnectedUserId}> for rehab`)
  const tipAsk = await db
    .selectFrom('tip_ask')
    .selectAll()
    .where('workspace_id', '=', connected.workspace.id)
    .executeTakeFirstOrThrow()
  const tipAskPostMessageCall = fetchSpy.mock.calls.find((call) => {
    const input = call[0]
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const params = slackFetchBodyParams(call[1]?.body)
    return url.endsWith('/chat.postMessage') && params.get('text')?.includes('opened a tip jar')
  })
  const blocks = JSON.parse(
    slackFetchBodyParams(tipAskPostMessageCall?.[1]?.body).get('blocks') ?? '[]',
  )
  const dollarButton = blocks
    .flatMap(
      (block: { elements?: Array<{ action_id?: string; value?: string }> }) => block.elements ?? [],
    )
    .find((element: { action_id?: string }) => element.action_id === 'tip_ask_option_dollar')

  const clickResponse = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_ask_option_dollar',
        type: 'button',
        value: dollarButton?.value,
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipAsk.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipAsk.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-ask-unconnected-dollar-trigger',
    type: 'block_actions',
    user: { id: Constants.slack.memberUserId, name: Constants.slack.memberUserName },
  })
  const pendingTip = await db
    .selectFrom('pending_tip')
    .select(['amount', 'recipient_provider_user_id'])
    .where(
      'idempotency_key',
      'like',
      `tip_ask:${tipAsk.id}:dollar:${Constants.slack.memberUserId}:%`,
    )
    .executeTakeFirstOrThrow()
  const creatorFees = await db
    .selectFrom('tip')
    .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
    .select([
      'recipient.provider_user_id as recipient_provider_user_id',
      'tip.amount',
      'tip.idempotency_key',
    ])
    .where(
      'tip.idempotency_key',
      'like',
      `tip_ask:${tipAsk.id}:dollar:${Constants.slack.memberUserId}:%`,
    )
    .execute()
  const creatorFee = creatorFees.find((tip) => tip.idempotency_key.endsWith(':creator_fee'))

  expect(response.status).toBe(200)
  expect(clickResponse.status).toBe(200)
  expect(pendingTip).toEqual({
    amount: 10_000,
    recipient_provider_user_id: Constants.slack.unconnectedUserId,
  })
  expect(creatorFee).toMatchObject({
    amount: 100,
    recipient_provider_user_id: Constants.slack.adminUserId,
  })
  await expectSlackMessage('1 tip · $0.01 total')
})

test('/tip jar requires the opener to be connected', async () => {
  const response = await postSlashCommand('jar for lunch')
  const tipAsks = await db
    .selectFrom('tip_ask')
    .selectAll()
    .where('provider_id', '=', providerId)
    .execute()

  expect(response.status).toBe(200)
  expect(tipAsks).toEqual([])
  await expectSlackMessage('Connect to Tipbot before opening a tip jar.')
})

test('/tip jar posts the tip jar in the source thread', async () => {
  await connectTipAccounts()
  const threadTs = `1700000030.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlashCommand('jar for lunch', { threadTs })

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(
    threadTs,
    `<@${Constants.slack.adminUserId}> opened a tip jar for lunch`,
    {
      wait: true,
    },
  )
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
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('@Tipbot mention sends small group tip in thread', async () => {
  await connectTipAccounts()
  const messageTs = `1700000000.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <!subteam^SENGINEERING>`,
  })
  const batch = await db
    .selectFrom('tip_batch')
    .selectAll()
    .where(
      'idempotency_key',
      '=',
      `mention:${providerId}:${Constants.slack.channelId}:${messageTs}`,
    )
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> tipped <!subteam^SENGINEERING> $0.001 each · Receipt`,
  )
  await expectSlackThreadMessage(messageTs, `• <@${Constants.slack.memberUserId}>`)
  await expectSlackThreadMessage(messageTs, `• <@${unconnectedProviderUserId}> (not connected yet)`)
  await expectSlackThreadMessageNotContaining(
    messageTs,
    `• <@${Constants.slack.adminUserId}> (you)`,
  )
  expect(batch).toMatchObject({ recipient_count: 1, status: 'confirmed' })
}, 20_000) // 20 seconds

test('@Tipbot mention shows group preview at top level', async () => {
  await connectTipAccounts()
  const messageTs = `1700000021.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <!subteam^SENGINEERING> $11`,
  })

  expect(response.status).toBe(200)
  await expectSlackMessage(
    `You’re about to tip <!subteam^SENGINEERING> <@${Constants.slack.memberUserId}> $11.00 each.`,
  )
  await expectSlackThreadMessageNotContaining(messageTs, 'You’re about to tip')
  await expectSlackThreadMessageNotContaining(messageTs, 'Receipt')
}, 20_000) // 20 seconds

test('@Tipbot thread mention shows group preview in thread', async () => {
  await connectTipAccounts()
  const parentTs = `1700000022.${Nanoid.generate().slice(0, 6)}`
  const messageTs = `1700000023.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <!subteam^SENGINEERING> $11`,
    threadTs: parentTs,
  })

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(parentTs, 'You’re about to tip', { wait: true })
}, 20_000) // 20 seconds

test('@Tipbot mention sends tip from single channel guest', async () => {
  await connectTipAccounts({ senderProviderUserId: Constants.slack.singleChannelGuestUserId })
  const messageTs = `1700000017.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
    userId: Constants.slack.singleChannelGuestUserId,
  })
  const tip = await db
    .selectFrom('tip')
    .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
    .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .select([
      'recipient.provider_user_id as recipient_provider_user_id',
      'sender.provider_user_id as sender_provider_user_id',
      'tip.confirmed_at',
    ])
    .where('workspace.provider_id', '=', providerId)
    .where(
      'tip.idempotency_key',
      '=',
      `mention:${providerId}:${Constants.slack.channelId}:${messageTs}`,
    )
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(tip).toMatchObject({
    recipient_provider_user_id: Constants.slack.memberUserId,
    sender_provider_user_id: Constants.slack.singleChannelGuestUserId,
  })
  expect(tip.confirmed_at).toEqual(expect.any(String))
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.singleChannelGuestUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
  )
}, 20_000) // 20 seconds

test('@Tipbot mention supports connect command for local workspace accounts', async () => {
  const messageTs = `1700000012.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> connect`,
    userId: unconnectedProviderUserId,
  })
  const token = await db
    .selectFrom('account_link_token')
    .innerJoin('member', 'member.id', 'account_link_token.member_id')
    .select(['account_link_token.id', 'member.provider_user_id'])
    .where('member.provider_user_id', '=', unconnectedProviderUserId)
    .executeTakeFirst()

  expect(response.status).toBe(200)
  expect(token).toEqual(expect.any(Object))
  await expectSlackMessage('Link expires in 10 minutes.')
  await expectSlackThreadMessageNotContaining(messageTs, 'Link expires in 10 minutes.')
}, 20_000) // 20 seconds

test('@Tipbot mention supports connect command from thread', async () => {
  const parent = await memberSlack.chat.postMessage({
    channel: Constants.slack.channelId,
    text: 'connect from this thread',
  })
  if (!parent.ts) throw new Error('Expected Slack parent message timestamp.')
  const messageTs = `1700000020.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> connect`,
    threadTs: parent.ts,
    userId: unconnectedProviderUserId,
  })

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(parent.ts, 'Link expires in 10 minutes.', { wait: true })
}, 20_000) // 20 seconds

test('@Tipbot mention supports connect command for single channel guests', async () => {
  const messageTs = `1700000018.${Nanoid.generate().slice(0, 6)}`
  const guest = await slack.users.info({ user: Constants.slack.singleChannelGuestUserId })

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> connect`,
    userId: Constants.slack.singleChannelGuestUserId,
  })
  const token = await db
    .selectFrom('account_link_token')
    .innerJoin('member', 'member.id', 'account_link_token.member_id')
    .select(['account_link_token.id', 'member.provider_user_id'])
    .where('member.provider_user_id', '=', Constants.slack.singleChannelGuestUserId)
    .executeTakeFirst()

  expect(guest.user).toMatchObject({
    id: Constants.slack.singleChannelGuestUserId,
    is_restricted: true,
    is_ultra_restricted: true,
  })
  expect(response.status).toBe(200)
  expect(token).toEqual(expect.any(Object))
  await expectSlackMessage('Link expires in 10 minutes.')
  await expectSlackThreadMessageNotContaining(messageTs, 'Link expires in 10 minutes.')
}, 20_000) // 20 seconds

test('@Tipbot mention supports jar command', async () => {
  await connectTipAccounts()
  const messageTs = `1700000029.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> jar for lunch`,
  })
  const tipAsk = await db
    .selectFrom('tip_ask')
    .innerJoin('member', 'member.id', 'tip_ask.requester_member_id')
    .select(['member.provider_user_id', 'tip_ask.memo'])
    .where('tip_ask.provider_id', '=', providerId)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(tipAsk).toEqual({ memo: 'lunch', provider_user_id: Constants.slack.adminUserId })
  await expectSlackMessage(`<@${Constants.slack.adminUserId}> opened a tip jar for lunch`)
  await expectSlackMessage('[💸 $0.001] [💵 $0.01] [💰 $0.10]')
})

test('@Tipbot mention adds original message images to tip jars', async () => {
  await connectTipAccounts()
  const messageTs = `1700000029.${Nanoid.generate().slice(0, 6)}`
  const fetchSpy = vi.spyOn(globalThis, 'fetch')

  const response = await postSlackAppMention({
    files: [
      {
        filetype: 'png',
        id: 'Ftipjarimage',
        mimetype: 'image/png',
        title: 'Jar photo',
      },
      {
        filetype: 'pdf',
        id: 'Fnotimage',
        mimetype: 'application/pdf',
        title: 'Not image',
      },
    ],
    messageTs,
    subtype: 'file_share',
    text: `<@${Constants.slack.botUserId}> jar for lunch`,
  })
  const imageFiles = await db
    .selectFrom('tip_ask_image_file')
    .select(['alt_text', 'position', 'provider_file_id', 'tip_ask_id'])
    .execute()
  const tipAskPostMessageCall = fetchSpy.mock.calls.find((call) => {
    const input = call[0]
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const params = slackFetchBodyParams(call[1]?.body)
    return (
      url.endsWith('/chat.postMessage') &&
      params.get('text')?.includes(`<@${Constants.slack.adminUserId}> opened a tip jar for lunch`)
    )
  })
  const blocks = JSON.parse(
    slackFetchBodyParams(tipAskPostMessageCall?.[1]?.body).get('blocks') ?? '[]',
  )

  expect(response.status).toBe(200)
  expect(imageFiles).toEqual([
    {
      alt_text: 'Jar photo',
      position: 0,
      provider_file_id: 'Ftipjarimage',
      tip_ask_id: expect.any(String),
    },
  ])
  expect(blocks).toContainEqual({
    alt_text: 'Jar photo',
    slack_file: { id: 'Ftipjarimage' },
    type: 'image',
  })
})

test('@Tipbot mention supports airdrop command', async () => {
  await connectTipAccounts()
  const messageTs = `1700000029.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> airdrop`,
  })

  expect(response.status).toBe(200)
  await expectSlackMessage('Use `/tip airdrop` to open the airdrop form.')
})

test('@Tipbot mention supports custom airdrop name prompt', async () => {
  await connectTipAccounts()
  const messageTs = `1700000029.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> airdrop Tempo Launch`,
  })

  expect(response.status).toBe(200)
  await expectSlackMessage('Use `/tip airdrop` to open the airdrop form.')
})

test('@Tipbot mention supports jar for account command', async () => {
  const connected = await connectTipAccounts()
  const messageTs = `1700000030.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> jar <@${Constants.slack.memberUserId}> for rehab`,
  })
  const tipAsk = await db
    .selectFrom('tip_ask')
    .innerJoin('member', 'member.id', 'tip_ask.requester_member_id')
    .select([
      'member.provider_user_id',
      'tip_ask.beneficiary_provider_user_id',
      'tip_ask.creator_fee_basis_points',
      'tip_ask.memo',
    ])
    .where('tip_ask.workspace_id', '=', connected.workspace.id)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(tipAsk).toEqual({
    beneficiary_provider_user_id: Constants.slack.memberUserId,
    creator_fee_basis_points: 100,
    memo: 'rehab',
    provider_user_id: Constants.slack.adminUserId,
  })
  await expectSlackMessage(
    `<@${Constants.slack.adminUserId}> opened a tip jar for <@${Constants.slack.memberUserId}>'s rehab`,
  )
})

test('@Tipbot thread mention posts jar in the source thread', async () => {
  await connectTipAccounts()
  const parentTs = `1700000031.${Nanoid.generate().slice(0, 6)}`
  const messageTs = `1700000032.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> jar for lunch`,
    threadTs: parentTs,
  })

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(
    parentTs,
    `<@${Constants.slack.adminUserId}> opened a tip jar for lunch`,
    { wait: true },
  )
})

test('/tip raffle opens create modal', async () => {
  await connectTipAccounts()
  const fetchOriginal = globalThis.fetch
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  fetchSpy.mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/views.open'))
      return Promise.resolve(Response.json({ ok: true, view: { id: 'V1' } }))
    return fetchOriginal(input, init)
  })

  const response = await postSlashCommand('raffle')

  expect(response.status).toBe(200)
  await expect
    .poll(
      async () => {
        for (const call of fetchSpy.mock.calls) {
          const input = call[0]
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          if (!url.endsWith('/views.open')) continue
          return (await slackFetchCallBodyParams(...call)).get('view')
        }
        return null
      },
      { timeout: 10_000 }, // 10 seconds
    )
    .toEqual(
      expect.stringMatching(
        /(?=.*Start raffle)(?=.*"initial_value":"0\.01")(?=.*"initial_option":\{"text":\{"type":"plain_text","text":"5 minutes")(?=.*"text":"90 seconds")(?=.*"value":"90s")/s,
      ),
    )
})

test('/tip raffle create modal posts raffle message', async () => {
  await connectTipAccounts()

  const response = await postSlackInteraction(createRaffleViewSubmissionPayload())
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .innerJoin('member', 'member.id', 'tip_raffle.creator_member_id')
    .select(['member.provider_user_id', 'tip_raffle.memo', 'tip_raffle.ticket_amount'])
    .where('tip_raffle.provider_id', '=', providerId)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(tipRaffle).toEqual({
    memo: 'team lunch',
    provider_user_id: Constants.slack.adminUserId,
    ticket_amount: 10_000,
  })
  await expectSlackMessage(`<@${Constants.slack.adminUserId}> opened a raffle: team lunch`)
  await expectSlackMessage('Tipet: $0.01')
  await expectSlackMessage('Tipets: 0')
})

test('/tip raffle buy button records tickets and updates message', async () => {
  const connected = await connectTipAccounts()
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()

  const response = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_raffle_buy_5',
        type: 'button',
        value: JSON.stringify({ nonce: 'buy-five', tipRaffleId: tipRaffle.id }),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipRaffle.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipRaffle.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-raffle-buy-5-trigger',
    type: 'block_actions',
    user: { id: Constants.slack.adminUserId, name: Constants.slack.adminUserName },
  })
  const ticket = await db
    .selectFrom('tip_raffle_ticket')
    .innerJoin('member', 'member.id', 'tip_raffle_ticket.buyer_member_id')
    .select(['member.provider_user_id', 'tip_raffle_ticket.ticket_count'])
    .where('tip_raffle_ticket.raffle_id', '=', tipRaffle.id)
    .executeTakeFirstOrThrow()
  const escrowTip = await db
    .selectFrom('tip')
    .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
    .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
    .select([
      'recipient.provider_user_id as recipient_provider_user_id',
      'sender.provider_user_id as sender_provider_user_id',
      'tip.amount',
    ])
    .where(
      'tip.idempotency_key',
      '=',
      `tip_raffle:${tipRaffle.id}:ticket:${Constants.slack.adminUserId}:${Constants.slack.adminUserId}:tip-raffle-buy-5-trigger`,
    )
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(ticket).toEqual({
    provider_user_id: Constants.slack.adminUserId,
    ticket_count: 5,
  })
  expect(escrowTip).toEqual({
    amount: 5000,
    recipient_provider_user_id: Constants.slack.botUserId,
    sender_provider_user_id: Constants.slack.adminUserId,
  })
  await expectSlackMessage('Pot: $0.005')
  await expectSlackMessage('Tipet: $0.001 · Tipets: 5')
  if (!connected.recipientMember) throw new Error('Expected connected recipient.')
  await db
    .insertInto('tip_raffle_ticket')
    .values({
      buyer_member_id: connected.recipientMember.id,
      id: Nanoid.generate(),
      idempotency_key: `test-raffle-ticket:${Nanoid.generate()}`,
      raffle_id: tipRaffle.id,
      ticket_count: 10,
    })
    .execute()
  await Chat.updateTipRaffleMessage(providerId, { tipRaffleId: tipRaffle.id })
  await expectSlackMessage(
    `Entrants: <@${Constants.slack.memberUserId}> x10, <@${Constants.slack.adminUserId}> x5`,
  )
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })
  const message = history.messages?.find((message) => message.text?.includes('Pot: $0.015'))
  expect(message?.text).toMatch(/Ends:[\s\S]*Entrants:[\s\S]*Tipet:/)
})

test('/tip raffle buy for someone records tipets for selected recipient', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()

  const response = await postSlackInteraction({
    team: { id: providerId },
    type: 'view_submission',
    user: { id: Constants.slack.adminUserId, name: Constants.slack.adminUserName },
    view: {
      callback_id: 'tip_raffle_buy_for',
      id: 'tip-raffle-buy-for-view',
      private_metadata: JSON.stringify({ tipRaffleId: tipRaffle.id }),
      state: {
        values: {
          recipient: {
            recipient: {
              selected_user: Constants.slack.memberUserId,
              type: 'users_select',
            },
          },
          ticket_count: {
            ticket_count: {
              selected_option: {
                text: { text: '5 tipets', type: 'plain_text' },
                value: '5',
              },
              type: 'static_select',
            },
          },
        },
      },
    },
  })
  const ticket = await db
    .selectFrom('tip_raffle_ticket')
    .innerJoin('member', 'member.id', 'tip_raffle_ticket.buyer_member_id')
    .select(['member.provider_user_id', 'tip_raffle_ticket.ticket_count'])
    .where('tip_raffle_ticket.raffle_id', '=', tipRaffle.id)
    .executeTakeFirstOrThrow()
  const escrowTip = await db
    .selectFrom('tip')
    .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
    .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
    .select([
      'recipient.provider_user_id as recipient_provider_user_id',
      'sender.provider_user_id as sender_provider_user_id',
      'tip.amount',
    ])
    .where(
      'tip.idempotency_key',
      '=',
      `tip_raffle:${tipRaffle.id}:ticket:${Constants.slack.adminUserId}:${Constants.slack.memberUserId}:tip-raffle-buy-for-view`,
    )
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(ticket).toEqual({
    provider_user_id: Constants.slack.memberUserId,
    ticket_count: 5,
  })
  expect(escrowTip).toEqual({
    amount: 5000,
    recipient_provider_user_id: Constants.slack.botUserId,
    sender_provider_user_id: Constants.slack.adminUserId,
  })
  await expectSlackMessage(
    `Entrants: <@${Constants.slack.memberUserId}> x5`,
  )
})

test('/tip raffle buy button uses raffle chain when workspace network changes after creation', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  await db
    .updateTable('workspace')
    .set({ chain_id: Tempo.chainLookup.mainnet })
    .where('id', '=', tipRaffle.workspace_id)
    .execute()

  const response = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_raffle_buy_1',
        type: 'button',
        value: JSON.stringify({ nonce: 'buy-after-chain-change', tipRaffleId: tipRaffle.id }),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipRaffle.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipRaffle.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-raffle-buy-chain-change-trigger',
    type: 'block_actions',
    user: { id: Constants.slack.adminUserId, name: Constants.slack.adminUserName },
  })
  const ticket = await db
    .selectFrom('tip_raffle_ticket')
    .select(['ticket_count'])
    .where('raffle_id', '=', tipRaffle.id)
    .executeTakeFirstOrThrow()
  const escrowTip = await db
    .selectFrom('tip')
    .select(['amount', 'chain_id'])
    .where(
      'idempotency_key',
      '=',
      `tip_raffle:${tipRaffle.id}:ticket:${Constants.slack.adminUserId}:${Constants.slack.adminUserId}:tip-raffle-buy-chain-change-trigger`,
    )
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(ticket.ticket_count).toBe(1)
  expect(escrowTip).toEqual({ amount: 1000, chain_id: tipRaffle.chain_id })
  await expectSlackMessageNotContaining('Tipets not bought. Try again.')
})

test('/tip raffle buy button does not record tickets when escrow payment fails', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({ code: 'insufficient_funds', ok: false })

  const response = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_raffle_buy_1',
        type: 'button',
        value: JSON.stringify({ nonce: 'failed-buy', tipRaffleId: tipRaffle.id }),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipRaffle.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipRaffle.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-raffle-buy-failed-trigger',
    type: 'block_actions',
    user: { id: Constants.slack.adminUserId, name: Constants.slack.adminUserName },
  })
  const ticket = await db
    .selectFrom('tip_raffle_ticket')
    .select('id')
    .where('raffle_id', '=', tipRaffle.id)
    .executeTakeFirst()

  expect(response.status).toBe(200)
  expect(ticket).toBeUndefined()
  await expectSlackMessage('Tipets not bought. Your wallet has insufficient funds.')
})

test('/tip raffle buy button can retry after a failed ticket payment', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  const handleTipRequest = vi
    .spyOn(Tip, 'handleTipRequest')
    .mockResolvedValueOnce({
      chainId: tipRaffle.chain_id,
      code: 'failed',
      message: 'Ticket payment failed.',
      ok: false,
    })
    .mockResolvedValueOnce({
      amount: '0.001',
      chainId: tipRaffle.chain_id,
      feePayer: 'sponsor',
      isDefaultToken: true,
      memo: tipRaffle.memo,
      ok: true,
      recipientProviderUserId: Constants.slack.botUserId,
      senderProviderUserId: Constants.slack.adminUserId,
      status: 'sent',
      tokenCurrency: 'USD',
      tokenSymbol: 'USDC',
      transactionHash: `0x${'1'.repeat(64)}`,
    })
  const payload = {
    actions: [
      {
        action_id: 'tip_raffle_buy_1',
        type: 'button',
        value: JSON.stringify({ nonce: 'retry-buy', tipRaffleId: tipRaffle.id }),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipRaffle.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipRaffle.provider_message_ts },
    team: { id: providerId },
    type: 'block_actions',
    user: { id: Constants.slack.adminUserId, name: Constants.slack.adminUserName },
  }

  const failedResponse = await postSlackInteraction({
    ...payload,
    trigger_id: 'tip-raffle-buy-retry-failed-trigger',
  })
  const retryResponse = await postSlackInteraction({
    ...payload,
    trigger_id: 'tip-raffle-buy-retry-success-trigger',
  })
  const ticket = await db
    .selectFrom('tip_raffle_ticket')
    .select(['idempotency_key', 'ticket_count'])
    .where('raffle_id', '=', tipRaffle.id)
    .executeTakeFirstOrThrow()

  expect(failedResponse.status).toBe(200)
  expect(retryResponse.status).toBe(200)
  expect(handleTipRequest).toHaveBeenCalledTimes(2)
  expect(handleTipRequest.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
    `tip_raffle:${tipRaffle.id}:ticket:${Constants.slack.adminUserId}:${Constants.slack.adminUserId}:tip-raffle-buy-retry-failed-trigger`,
    `tip_raffle:${tipRaffle.id}:ticket:${Constants.slack.adminUserId}:${Constants.slack.adminUserId}:tip-raffle-buy-retry-success-trigger`,
  ])
  expect(ticket).toEqual({
    idempotency_key: `tip_raffle:${tipRaffle.id}:ticket:${Constants.slack.adminUserId}:${Constants.slack.adminUserId}:tip-raffle-buy-retry-success-trigger`,
    ticket_count: 1,
  })
  await expectSlackMessage('Tipets not bought. Try again.')
})

test('/tip raffle buy button does not spam while ticket payment is pending', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
    chainId: tipRaffle.chain_id,
    code: 'pending',
    message: 'Tip is still sending.',
    ok: false,
  })

  const response = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_raffle_buy_1',
        type: 'button',
        value: JSON.stringify({ nonce: 'pending-buy', tipRaffleId: tipRaffle.id }),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipRaffle.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipRaffle.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-raffle-buy-pending-trigger',
    type: 'block_actions',
    user: { id: Constants.slack.adminUserId, name: Constants.slack.adminUserName },
  })
  const ticket = await db
    .selectFrom('tip_raffle_ticket')
    .select('id')
    .where('raffle_id', '=', tipRaffle.id)
    .executeTakeFirst()

  expect(response.status).toBe(200)
  expect(ticket).toBeUndefined()
  await expectSlackMessageNotContaining('Ticket purchase is still sending.')
})

test('/tip raffle buy button offers refresh when reusable access key does not cover raffle', async () => {
  await connectTipAccounts({ memoScope: false })
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()

  const response = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_raffle_buy_1',
        type: 'button',
        value: JSON.stringify({ nonce: 'buy-refresh', tipRaffleId: tipRaffle.id }),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipRaffle.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipRaffle.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-raffle-buy-refresh-trigger',
    type: 'block_actions',
    user: { id: Constants.slack.adminUserId, name: Constants.slack.adminUserName },
  })

  expect(response.status).toBe(200)
  await expectSlackMessage('Link expires in 10 minutes')
  await expectSlackMessageNotContaining('Already connected')
})

test('/tip raffle buy button offers refresh when ticket payment requires confirmation', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
    code: 'confirmation_required',
    confirmUrl: 'https://tip.bot/confirm/test',
    ok: false,
  })

  const response = await postSlackInteraction({
    actions: [
      {
        action_id: 'tip_raffle_buy_1',
        type: 'button',
        value: JSON.stringify({ nonce: 'buy-confirmation-required', tipRaffleId: tipRaffle.id }),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipRaffle.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipRaffle.provider_message_ts },
    team: { id: providerId },
    trigger_id: 'tip-raffle-buy-confirmation-required-trigger',
    type: 'block_actions',
    user: { id: Constants.slack.adminUserId, name: Constants.slack.adminUserName },
  })
  const ticket = await db
    .selectFrom('tip_raffle_ticket')
    .select('id')
    .where('raffle_id', '=', tipRaffle.id)
    .executeTakeFirst()

  expect(response.status).toBe(200)
  expect(ticket).toBeUndefined()
  await expectSlackMessage('Link expires in 10 minutes')
  await expectSlackMessageNotContaining('Tipets not bought. Try again.')
})

test('/tip raffle cron ends without winner when fewer than two buyers enter', async () => {
  const connected = await connectTipAccounts()
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  await db
    .insertInto('tip_raffle_ticket')
    .values({
      buyer_member_id: connected.senderMember.id,
      id: Nanoid.generate(),
      idempotency_key: `test-raffle-ticket:${Nanoid.generate()}`,
      raffle_id: tipRaffle.id,
      ticket_count: 5,
    })
    .execute()
  await db
    .updateTable('tip_raffle')
    .set({ ends_at: new Date(Date.now() - 60 * 1000).toISOString() }) // 1 minute ago
    .where('id', '=', tipRaffle.id)
    .execute()

  const initializeSpy = vi.spyOn(Chat.getChat(), 'initialize')
  const ctx = createExecutionContext()
  entryServer.scheduled(createScheduledController({ cron: '* * * * *' }), env, ctx)
  await waitOnExecutionContext(ctx)
  const ended = await db
    .selectFrom('tip_raffle')
    .select(['settled_amount', 'status', 'winner_member_id', 'winning_ticket_number'])
    .where('id', '=', tipRaffle.id)
    .executeTakeFirstOrThrow()

  expect(ended).toEqual({
    settled_amount: 0,
    status: 'ended',
    winner_member_id: null,
    winning_ticket_number: null,
  })
  expect(initializeSpy).toHaveBeenCalled()
  await expectSlackMessage('Ended · No winner · 5 tipets')
  await expectSlackMessage('Tipet: $0.001 · Tipets: 5')
  await expectSlackMessage(`Entrants: <@${Constants.slack.adminUserId}> x5`)
})

test('/tip raffle cron retries stale settling raffle', async () => {
  const connected = await connectTipAccounts()
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  await db
    .insertInto('tip_raffle_ticket')
    .values({
      buyer_member_id: connected.senderMember.id,
      id: Nanoid.generate(),
      idempotency_key: `test-raffle-ticket:${Nanoid.generate()}`,
      raffle_id: tipRaffle.id,
      ticket_count: 5,
    })
    .execute()
  const staleAt = new Date(Date.now() - 11 * 60 * 1000).toISOString() // 11 minutes ago
  await db
    .updateTable('tip_raffle')
    .set({
      ends_at: new Date(Date.now() - 60 * 1000).toISOString(), // 1 minute ago
      status: 'settling',
      updated_at: staleAt,
    })
    .where('id', '=', tipRaffle.id)
    .execute()

  const ctx = createExecutionContext()
  entryServer.scheduled(createScheduledController({ cron: '* * * * *' }), env, ctx)
  await waitOnExecutionContext(ctx)
  const ended = await db
    .selectFrom('tip_raffle')
    .select(['settled_amount', 'status', 'winner_member_id', 'winning_ticket_number'])
    .where('id', '=', tipRaffle.id)
    .executeTakeFirstOrThrow()

  expect(ended).toEqual({
    settled_amount: 0,
    status: 'ended',
    winner_member_id: null,
    winning_ticket_number: null,
  })
  await expectSlackMessage('Ended · No winner · 5 tipets')
})

test('/tip raffle cron reuses winner selected before stale settlement retry', async () => {
  const connected = await connectTipAccounts()
  if (!connected.recipientMember) throw new Error('Expected connected recipient.')

  const recipientRoot = Account.fromSecp256k1(Constants.tip.recipientRootPrivateKey)
  await insertReusableAccessKey({ accountId: connected.recipientAccount.id, root: recipientRoot })
  await Actions.token.mintSync(
    createClient({
      chain: Tempo.getChain(Tempo.chainLookup.localnet),
      transport: http(env.RPC_URL_TESTNET),
    }),
    {
      account: Account.fromSecp256k1(env.FEE_PAYER_PRIVATE_KEY_TESTNET),
      amount: parseUnits('1', 6),
      to: recipientRoot.address,
      token: Tempo.addressLookup.pathUsd,
    },
  )

  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  await db
    .insertInto('tip_raffle_ticket')
    .values([
      {
        buyer_member_id: connected.senderMember.id,
        id: Nanoid.generate(),
        idempotency_key: `test-raffle-ticket:${Nanoid.generate()}`,
        raffle_id: tipRaffle.id,
        ticket_count: 1,
      },
      {
        buyer_member_id: connected.recipientMember.id,
        id: Nanoid.generate(),
        idempotency_key: `test-raffle-ticket:${Nanoid.generate()}`,
        raffle_id: tipRaffle.id,
        ticket_count: 1,
      },
    ])
    .execute()
  const orderedBuyers = [connected.senderMember.id, connected.recipientMember.id].sort()
  const adminTicketIndex = orderedBuyers.indexOf(connected.senderMember.id)
  const memberTicketIndex = orderedBuyers.indexOf(connected.recipientMember.id)
  const staleAt = new Date(Date.now() - 11 * 60 * 1000).toISOString() // 11 minutes ago
  await db
    .updateTable('tip_raffle')
    .set({
      ends_at: new Date(Date.now() - 60 * 1000).toISOString(), // 1 minute ago
      status: 'settling',
      updated_at: staleAt,
      winner_member_id: connected.senderMember.id,
      winning_ticket_number: adminTicketIndex + 1,
    })
    .where('id', '=', tipRaffle.id)
    .execute()

  const getRandomValues = crypto.getRandomValues.bind(crypto)
  const getRandomValuesSpy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (!(array instanceof Uint32Array) || array.length !== 1) return getRandomValues(array)
    array[0] = memberTicketIndex
    return array
  })

  await closeExpired(env, createExecutionContext())
  const ended = await db
    .selectFrom('tip_raffle')
    .select(['settled_amount', 'status', 'winner_member_id', 'winning_ticket_number'])
    .where('id', '=', tipRaffle.id)
    .executeTakeFirstOrThrow()
  const payout = await db
    .selectFrom('tip')
    .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
    .select(['amount', 'recipient_member_id', 'sender_member_id'])
    .select('sender.provider_user_id as sender_provider_user_id')
    .where('idempotency_key', '=', `tip_raffle:${tipRaffle.id}:payout`)
    .executeTakeFirstOrThrow()

  expect(
    getRandomValuesSpy.mock.calls.some(
      ([array]) => array instanceof Uint32Array && array.length === 1,
    ),
  ).toBe(false)
  expect(ended).toEqual({
    settled_amount: 2000,
    status: 'ended',
    winner_member_id: connected.senderMember.id,
    winning_ticket_number: adminTicketIndex + 1,
  })
  expect(payout).toEqual({
    amount: 2000,
    recipient_member_id: connected.senderMember.id,
    sender_member_id: expect.any(String),
    sender_provider_user_id: Constants.slack.botUserId,
  })
  await expectSlackMessage(`Ended · Winner: <@${Constants.slack.adminUserId}>`)
}, 20_000) // 20 seconds

test('/tip raffle cron leaves fresh settling raffle in progress', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  await db
    .updateTable('tip_raffle')
    .set({
      ends_at: new Date(Date.now() - 60 * 1000).toISOString(), // 1 minute ago
      status: 'settling',
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', tipRaffle.id)
    .execute()

  const ctx = createExecutionContext()
  entryServer.scheduled(createScheduledController({ cron: '* * * * *' }), env, ctx)
  await waitOnExecutionContext(ctx)
  const row = await db
    .selectFrom('tip_raffle')
    .select(['status', 'winner_member_id'])
    .where('id', '=', tipRaffle.id)
    .executeTakeFirstOrThrow()

  expect(row).toEqual({ status: 'settling', winner_member_id: null })
})

test('/tip raffle cron retries stale ended raffle message update', async () => {
  await connectTipAccounts()
  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  const endedAt = new Date(Date.now() - 60 * 1000).toISOString() // 1 minute ago
  await db
    .updateTable('tip_raffle')
    .set({ ended_at: endedAt, status: 'ended', updated_at: endedAt })
    .where('id', '=', tipRaffle.id)
    .execute()

  const ctx = createExecutionContext()
  entryServer.scheduled(createScheduledController({ cron: '* * * * *' }), env, ctx)
  await waitOnExecutionContext(ctx)
  const updated = await db
    .selectFrom('tip_raffle')
    .select(['ended_at', 'updated_at'])
    .where('id', '=', tipRaffle.id)
    .executeTakeFirstOrThrow()

  expect(updated.updated_at).not.toBe(updated.ended_at)
  await expectSlackMessage('Ended · No winner · 0 tipets')
})

test('/tip raffle cron skips stale ended raffle message that no longer exists', async () => {
  await connectTipAccounts()
  await postSlackInteraction(
    createRaffleViewSubmissionPayload({ amount: '0.001', memo: 'missing' }),
  )
  await postSlackInteraction(
    createRaffleViewSubmissionPayload({ amount: '0.001', memo: 'visible' }),
  )
  const tipRaffles = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .orderBy('created_at', 'asc')
    .execute()
  const missing = tipRaffles.find((row) => row.memo === 'missing')
  const visible = tipRaffles.find((row) => row.memo === 'visible')
  if (!missing || !visible) throw new Error('Expected tip raffles.')
  const missingEndedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString() // 2 minutes ago
  const visibleEndedAt = new Date(Date.now() - 60 * 1000).toISOString() // 1 minute ago
  await db
    .updateTable('tip_raffle')
    .set({
      ended_at: missingEndedAt,
      provider_message_ts: '1111111111.111111',
      status: 'ended',
      updated_at: missingEndedAt,
    })
    .where('id', '=', missing.id)
    .execute()
  await db
    .updateTable('tip_raffle')
    .set({ ended_at: visibleEndedAt, status: 'ended', updated_at: visibleEndedAt })
    .where('id', '=', visible.id)
    .execute()

  const ctx = createExecutionContext()
  entryServer.scheduled(createScheduledController({ cron: '* * * * *' }), env, ctx)
  await waitOnExecutionContext(ctx)
  const rows = await db
    .selectFrom('tip_raffle')
    .select(['ended_at', 'id', 'updated_at'])
    .where('id', 'in', [missing.id, visible.id])
    .execute()

  expect(rows.find((row) => row.id === missing.id)?.updated_at).not.toBe(missingEndedAt)
  expect(rows.find((row) => row.id === visible.id)?.updated_at).not.toBe(visibleEndedAt)
  await expectSlackMessage('Ended · No winner · 0 tipets')
})

test('/tip raffle closes expired raffle and settles winner payout', async () => {
  const connected = await connectTipAccounts()
  if (!connected.recipientMember) throw new Error('Expected connected recipient.')

  const recipientRoot = Account.fromSecp256k1(Constants.tip.recipientRootPrivateKey)
  await insertReusableAccessKey({ accountId: connected.recipientAccount.id, root: recipientRoot })
  await Actions.token.mintSync(
    createClient({
      chain: Tempo.getChain(Tempo.chainLookup.localnet),
      transport: http(env.RPC_URL_TESTNET),
    }),
    {
      account: Account.fromSecp256k1(env.FEE_PAYER_PRIVATE_KEY_TESTNET),
      amount: parseUnits('1', 6),
      to: recipientRoot.address,
      token: Tempo.addressLookup.pathUsd,
    },
  )

  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  await db
    .insertInto('tip_raffle_ticket')
    .values([
      {
        buyer_member_id: connected.senderMember.id,
        id: Nanoid.generate(),
        idempotency_key: `test-raffle-ticket:${Nanoid.generate()}`,
        raffle_id: tipRaffle.id,
        ticket_count: 1,
      },
      {
        buyer_member_id: connected.recipientMember.id,
        id: Nanoid.generate(),
        idempotency_key: `test-raffle-ticket:${Nanoid.generate()}`,
        raffle_id: tipRaffle.id,
        ticket_count: 1,
      },
    ])
    .execute()
  await db
    .updateTable('tip_raffle')
    .set({ ends_at: new Date(Date.now() - 60 * 1000).toISOString() }) // 1 minute ago
    .where('id', '=', tipRaffle.id)
    .execute()

  const orderedBuyers = [connected.senderMember.id, connected.recipientMember.id].sort()
  const adminTicketIndex = orderedBuyers.indexOf(connected.senderMember.id)
  const getRandomValues = crypto.getRandomValues.bind(crypto)
  const getRandomValuesSpy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (!(array instanceof Uint32Array) || array.length !== 1) return getRandomValues(array)
    array[0] = adminTicketIndex
    return array
  })

  await closeExpired(env, createExecutionContext())
  getRandomValuesSpy.mockRestore()
  const ended = await db
    .selectFrom('tip_raffle')
    .select(['settled_amount', 'status', 'winner_member_id', 'winning_ticket_number'])
    .where('id', '=', tipRaffle.id)
    .executeTakeFirstOrThrow()
  const payout = await db
    .selectFrom('tip')
    .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
    .select(['amount', 'recipient_member_id', 'sender_member_id'])
    .select('sender.provider_user_id as sender_provider_user_id')
    .where('idempotency_key', '=', `tip_raffle:${tipRaffle.id}:payout`)
    .executeTakeFirstOrThrow()

  expect(ended).toEqual({
    settled_amount: 2000,
    status: 'ended',
    winner_member_id: connected.senderMember.id,
    winning_ticket_number: adminTicketIndex + 1,
  })
  expect(payout).toEqual({
    amount: 2000,
    recipient_member_id: connected.senderMember.id,
    sender_member_id: expect.any(String),
    sender_provider_user_id: Constants.slack.botUserId,
  })
  await expectSlackMessage(`Ended · Winner: <@${Constants.slack.adminUserId}>`)
  await expectSlackMessage('Paid out: $0.002')
  await expectSlackMessageNotContaining('Paid out: $0.002 / $0.002')
  await expectSlackMessageNotContaining('Paid out: $0.001 / $0.002')
  await expectSlackMessage('Tipet: $0.001 · Tipets: 2')
  await expectSlackMessage(`<@${Constants.slack.adminUserId}> x1`)
  await expectSlackMessage(`<@${Constants.slack.memberUserId}> x1`)
  if (!tipRaffle.provider_message_ts) throw new Error('Expected raffle message timestamp.')
  await expectSlackThreadMessage(
    tipRaffle.provider_message_ts,
    `<@${Constants.slack.botUserId}> paid raffle winner <@${Constants.slack.adminUserId}> $0.002 for team lunch · Receipt`,
  )
}, 20_000) // 20 seconds

test('/tip raffle pays escrowed pot even when a buyer cannot pay later', async () => {
  const connected = await connectTipAccounts()
  if (!connected.recipientMember) throw new Error('Expected connected recipient.')

  const failedAccount = await factory.account.insert({ address: AccessKey.generate().address })
  const failedMember = await insertMember({
    account_id: failedAccount.id,
    provider_user_id: 'URAFFLEFAIL',
    workspace_id: connected.workspace.id,
  })

  await postSlackInteraction(createRaffleViewSubmissionPayload({ amount: '0.001' }))
  const tipRaffle = await db
    .selectFrom('tip_raffle')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  await db
    .insertInto('tip_raffle_ticket')
    .values(
      [connected.senderMember.id, connected.recipientMember.id, failedMember.id].map(
        (buyerMemberId) => ({
          buyer_member_id: buyerMemberId,
          id: Nanoid.generate(),
          idempotency_key: `test-raffle-ticket:${Nanoid.generate()}`,
          raffle_id: tipRaffle.id,
          ticket_count: 1,
        }),
      ),
    )
    .execute()
  await db
    .updateTable('tip_raffle')
    .set({ ends_at: new Date(Date.now() - 60 * 1000).toISOString() }) // 1 minute ago
    .where('id', '=', tipRaffle.id)
    .execute()

  const orderedBuyers = [
    connected.senderMember.id,
    connected.recipientMember.id,
    failedMember.id,
  ].sort()
  const memberTicketIndex = orderedBuyers.indexOf(connected.recipientMember.id)
  const getRandomValues = crypto.getRandomValues.bind(crypto)
  const getRandomValuesSpy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (!(array instanceof Uint32Array) || array.length !== 1) return getRandomValues(array)
    array[0] = memberTicketIndex
    return array
  })

  await closeExpired(env, createExecutionContext())
  getRandomValuesSpy.mockRestore()
  const ended = await db
    .selectFrom('tip_raffle')
    .select(['failed_ticket_count', 'settled_amount', 'status', 'winner_member_id'])
    .where('id', '=', tipRaffle.id)
    .executeTakeFirstOrThrow()

  expect(ended).toEqual({
    failed_ticket_count: 0,
    settled_amount: 3000,
    status: 'ended',
    winner_member_id: connected.recipientMember.id,
  })
  await expectSlackMessage(`Ended · Winner: <@${Constants.slack.memberUserId}>`)
  await expectSlackMessage('Paid out: $0.003')
  await expectSlackMessageNotContaining('failed payment')
}, 20_000) // 20 seconds

test('@Tipbot mention connect link completion connects local workspace account', async () => {
  const messageTs = `1700000016.${Nanoid.generate().slice(0, 6)}`

  const connectResponse = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> connect`,
    userId: unconnectedProviderUserId,
  })
  const token = await getLatestConnectToken()
  const link = await db
    .selectFrom('account_link_token')
    .innerJoin('member', 'member.id', 'account_link_token.member_id')
    .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
    .select([
      'account_link_token.id',
      'account_link_token.access_key_address',
      'account_link_token.access_key_expires_at',
      'account_link_token.channel_provider_id',
      'member.provider_identity_id',
      'workspace.chain_id',
      'workspace.default_token_address',
    ])
    .where('member.provider_user_id', '=', unconnectedProviderUserId)
    .where('workspace.provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  const root = Account.fromSecp256k1(
    '0x3333333333333333333333333333333333333333333333333333333333333333',
  )
  const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
    accessKeyAddress: link.access_key_address,
    chainId: link.chain_id,
    expiresAt: link.access_key_expires_at,
    tokenAddress: Address.checksum(link.default_token_address ?? Tempo.addressLookup.pathUsd),
  })

  const completeResponse = await client.api.account.link[':token'].$post({
    json: { address: root.address, keyAuthorization },
    param: { token },
  })
  await drainWaitUntil()
  const identity = await db
    .selectFrom('provider_identity')
    .innerJoin('account', 'account.id', 'provider_identity.account_id')
    .select(['account.address', 'provider_identity.provider_user_id'])
    .where('provider_identity.id', '=', link.provider_identity_id)
    .executeTakeFirstOrThrow()

  expect(connectResponse.status).toBe(200)
  expect(completeResponse.status).toBe(200)
  expect(identity).toMatchObject({
    address: root.address,
    provider_user_id: unconnectedProviderUserId,
  })
  expect(link.channel_provider_id).toBe(providerId)
  await expectSlackMessage('Connected')
}, 20_000) // 20 seconds

test('@Tipbot mention supports help command', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const messageTs = `1700000013.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> help`,
  })

  expect(response.status).toBe(200)
  const params = await getSlackPostEphemeralParams(fetchSpy, '@Tipbot balance')
  expect(params.get('blocks')).toContain('@Tipbot connect')
  expect(params.get('blocks')).toContain('@Tipbot disconnect')
  expect(params.get('blocks')).toContain('@Tipbot jar [memo]')
  expect(params.get('blocks')).toContain('@Tipbot leaderboard')
  expect(params.get('blocks')).toContain('@Tipbot stats')
  expect(params.get('blocks')).toContain('@Tipbot status')
  expect(params.get('blocks')).toContain('@Tipbot @account for coffee')
  expect(params.has('thread_ts')).toBe(false)
  fetchSpy.mockRestore()
})

test('@Tipbot mention supports disconnect command for local workspace accounts', async () => {
  await connectTipAccounts()
  const messageTs = `1700000014.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> disconnect`,
  })
  const member = await db
    .selectFrom('member')
    .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .select('provider_identity.account_id')
    .where('workspace.provider_id', '=', providerId)
    .where('member.provider_user_id', '=', Constants.slack.adminUserId)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(member.account_id).toBeNull()
  await expectSlackMessage('Disconnected')
  await expectSlackThreadMessageNotContaining(messageTs, 'Disconnected')
}, 20_000) // 20 seconds

test.each([
  { name: 'balance command', text: `<@${Constants.slack.botUserId}> balance` },
  { name: 'leaderboard command', text: `<@${Constants.slack.botUserId}> leaderboard` },
  { name: 'tip text', text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>` },
])(
  '@Tipbot mention blocks unsupported Slack Connect external actor $name',
  async (input) => {
    await deleteSlackConnectWorkspace()
    const channelId = await getSlackConnectChannelId()
    const messageTs = `1700000015.${Nanoid.generate().slice(0, 6)}`

    const response = await postSlackAppMention({
      channelId,
      messageTs,
      text: input.text,
      userId: Constants.slackConnect.userId,
    })
    const members = await db
      .selectFrom('member')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .select(['member.id', 'workspace.provider_id'])
      .where('workspace.provider_id', '=', providerId)
      .where('member.provider_user_id', '=', Constants.slackConnect.userId)
      .execute()
    const tips = await db
      .selectFrom('tip')
      .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
      .select('tip.id')
      .where('workspace.provider_id', '=', providerId)
      .execute()
    const accountLinkTokens = await db
      .selectFrom('account_link_token')
      .innerJoin('member', 'member.id', 'account_link_token.member_id')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .select('account_link_token.id')
      .where('workspace.provider_id', '=', providerId)
      .where('member.provider_user_id', '=', Constants.slackConnect.userId)
      .execute()

    expect(response.status).toBe(200)
    expect(accountLinkTokens).toEqual([])
    expect(members).toEqual([])
    expect(tips).toEqual([])
    const expectedMessage =
      input.name === 'tip text'
        ? 'Payment not sent. Connect with `<@Tipbot> connect` first.'
        : 'Tipbot is not installed in your Slack workspace yet.'
    await expectSlackMessage(expectedMessage, { channelId })
    await expectSlackThreadMessageNotContaining(messageTs, expectedMessage, { channelId })
  },
  20_000,
)

test('@Tipbot mention supports help command for Slack Connect external actors', async () => {
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000024.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> help`,
    userId: Constants.slackConnect.userId,
  })
  const homeWorkspaces = await db
    .selectFrom('workspace')
    .select('id')
    .where('provider_id', '=', Constants.slackConnect.teamId)
    .execute()
  const hostMembers = await db
    .selectFrom('member')
    .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
    .select('member.id')
    .where('workspace.provider_id', '=', providerId)
    .where('member.provider_user_id', '=', Constants.slackConnect.userId)
    .execute()

  expect(response.status).toBe(200)
  expect(homeWorkspaces).toEqual([])
  expect(hostMembers).toEqual([])
  await expectSlackMessage('@Tipbot connect', { channelId })
  await expectSlackMessage('@Tipbot disconnect', { channelId })
  await expectSlackMessage('@Tipbot help', { channelId })
  await expectSlackMessage('@Tipbot status', { channelId })
  await expectSlackMessage('Payments in Slack Connect channels aren’t supported yet', { channelId })
  await expectSlackMessageNotContaining('@Tipbot @account', { channelId })
  await expectSlackThreadMessageNotContaining(messageTs, '@Tipbot help', { channelId })
}, 20_000) // 20 seconds

test('@Tipbot mention supports connect command for Slack Connect external actors', async () => {
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000016.${Nanoid.generate().slice(0, 6)}`
  await db
    .updateTable('workspace')
    .set({
      chain_id: Tempo.chainLookup.testnet,
      default_token_address: Tempo.addressLookup.betaUsd,
    })
    .where('provider_id', '=', providerId)
    .execute()

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> connect`,
    userId: Constants.slackConnect.userId,
  })
  const token = await db
    .selectFrom('account_link_token')
    .innerJoin('member', 'member.id', 'account_link_token.member_id')
    .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
    .select([
      'account_link_token.id',
      'workspace.chain_id',
      'workspace.default_token_address',
      'member.provider_user_id',
      'workspace.installed_at',
      'workspace.provider_id',
      'workspace.uninstalled_at',
    ])
    .where('member.provider_user_id', '=', Constants.slackConnect.userId)
    .where('workspace.provider_id', '=', Constants.slackConnect.teamId)
    .executeTakeFirst()
  const hostMembers = await db
    .selectFrom('member')
    .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
    .select('member.id')
    .where('workspace.provider_id', '=', providerId)
    .where('member.provider_user_id', '=', Constants.slackConnect.userId)
    .execute()

  expect(response.status).toBe(200)
  expect(hostMembers).toEqual([])
  expect(token).toMatchObject({
    chain_id: Tempo.chainLookup.testnet,
    default_token_address: Tempo.addressLookup.betaUsd,
    installed_at: null,
    provider_id: Constants.slackConnect.teamId,
    provider_user_id: Constants.slackConnect.userId,
    uninstalled_at: null,
  })
  await expectSlackMessage('Link expires in 10 minutes.', { channelId })
  await expectSlackThreadMessageNotContaining(messageTs, 'Link expires in 10 minutes.', {
    channelId,
  })
}, 20_000) // 20 seconds

test('@Tipbot mention connect link completion notifies Slack Connect external actors', async () => {
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000023.${Nanoid.generate().slice(0, 6)}`

  const connectResponse = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> connect`,
    userId: Constants.slackConnect.userId,
  })
  const token = await getLatestConnectToken({ channelId })
  const link = await db
    .selectFrom('account_link_token')
    .innerJoin('member', 'member.id', 'account_link_token.member_id')
    .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
    .select([
      'account_link_token.access_key_address',
      'account_link_token.access_key_expires_at',
      'account_link_token.channel_provider_id',
      'member.provider_identity_id',
      'workspace.chain_id',
      'workspace.default_token_address',
      'workspace.provider_id',
    ])
    .where('member.provider_user_id', '=', Constants.slackConnect.userId)
    .where('workspace.provider_id', '=', Constants.slackConnect.teamId)
    .executeTakeFirstOrThrow()
  const root = Account.fromSecp256k1(
    '0x4444444444444444444444444444444444444444444444444444444444444444',
  )
  const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
    accessKeyAddress: link.access_key_address,
    chainId: link.chain_id,
    expiresAt: link.access_key_expires_at,
    tokenAddress: Address.checksum(link.default_token_address ?? Tempo.addressLookup.pathUsd),
  })

  const completeResponse = await client.api.account.link[':token'].$post({
    json: { address: root.address, keyAuthorization },
    param: { token },
  })
  await drainWaitUntil()
  const identity = await db
    .selectFrom('provider_identity')
    .innerJoin('account', 'account.id', 'provider_identity.account_id')
    .select(['account.address', 'provider_identity.provider_user_id'])
    .where('provider_identity.id', '=', link.provider_identity_id)
    .executeTakeFirstOrThrow()

  expect(connectResponse.status).toBe(200)
  expect(completeResponse.status).toBe(200)
  expect(identity).toMatchObject({
    address: root.address,
    provider_user_id: Constants.slackConnect.userId,
  })
  expect(link.provider_id).toBe(Constants.slackConnect.teamId)
  expect(link.channel_provider_id).toBe(providerId)
  await expectSlackMessage('Connected', { channelId })
}, 20_000) // 20 seconds

test('@Tipbot mention deduplicates connect setup for Slack Connect external actors', async () => {
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  const firstMessageTs = `1700000021.${Nanoid.generate().slice(0, 6)}`
  const secondMessageTs = `1700000022.${Nanoid.generate().slice(0, 6)}`

  const firstResponse = await postSlackAppMention({
    channelId,
    messageTs: firstMessageTs,
    text: `<@${Constants.slack.botUserId}> connect`,
    userId: Constants.slackConnect.userId,
  })
  const secondResponse = await postSlackAppMention({
    channelId,
    messageTs: secondMessageTs,
    text: `<@${Constants.slack.botUserId}> connect`,
    userId: Constants.slackConnect.userId,
  })
  const workspaces = await db
    .selectFrom('workspace')
    .select(['id', 'installed_at', 'provider_id'])
    .where('provider', '=', 'slack')
    .where('provider_id', '=', Constants.slackConnect.teamId)
    .execute()
  const members = await db
    .selectFrom('member')
    .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
    .select(['member.id', 'member.provider_user_id'])
    .where('member.provider_user_id', '=', Constants.slackConnect.userId)
    .where('workspace.provider_id', '=', Constants.slackConnect.teamId)
    .execute()
  const hostMembers = await db
    .selectFrom('member')
    .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
    .select('member.id')
    .where('member.provider_user_id', '=', Constants.slackConnect.userId)
    .where('workspace.provider_id', '=', providerId)
    .execute()
  const links = await db
    .selectFrom('account_link_token')
    .innerJoin('member', 'member.id', 'account_link_token.member_id')
    .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
    .select('account_link_token.id')
    .where('member.provider_user_id', '=', Constants.slackConnect.userId)
    .where('workspace.provider_id', '=', Constants.slackConnect.teamId)
    .where('account_link_token.used_at', 'is', null)
    .execute()

  expect(firstResponse.status).toBe(200)
  expect(secondResponse.status).toBe(200)
  expect(workspaces).toEqual([
    {
      id: expect.any(String),
      installed_at: null,
      provider_id: Constants.slackConnect.teamId,
    },
  ])
  expect(members).toEqual([
    { id: expect.any(String), provider_user_id: Constants.slackConnect.userId },
  ])
  expect(hostMembers).toEqual([])
  expect(links).toHaveLength(1)
}, 20_000) // 20 seconds

test('@Tipbot mention supports status command for Slack Connect external actors', async () => {
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  const workspace = await factory.workspace.insert({
    provider_id: Constants.slackConnect.teamId,
  })
  const account = await factory.account.insert({})
  await insertMember({
    account_id: account.id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: workspace.id,
  })
  const messageTs = `1700000017.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> status`,
    userId: Constants.slackConnect.userId,
  })

  expect(response.status).toBe(200)
  await expectSlackMessage(`Connected as \`${account.address}\``, { channelId })
  await expectSlackThreadMessageNotContaining(messageTs, `Connected as \`${account.address}\``, {
    channelId,
  })
}, 20_000) // 20 seconds

test('@Tipbot mention supports disconnect command for Slack Connect external actors', async () => {
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  const workspace = await factory.workspace.insert({
    provider_id: Constants.slackConnect.teamId,
  })
  const account = await factory.account.insert({})
  await insertMember({
    account_id: account.id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: workspace.id,
  })
  const messageTs = `1700000018.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> disconnect`,
    userId: Constants.slackConnect.userId,
  })
  const member = await db
    .selectFrom('member')
    .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .select('provider_identity.account_id')
    .where('workspace.provider_id', '=', Constants.slackConnect.teamId)
    .where('member.provider_user_id', '=', Constants.slackConnect.userId)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(member.account_id).toBeNull()
  await expectSlackMessage('Disconnected', { channelId })
  await expectSlackThreadMessageNotContaining(messageTs, 'Disconnected', { channelId })
}, 20_000) // 20 seconds

test('@Tipbot mention sends Slack Connect tip to recipient home workspace member', async () => {
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  const connected = await connectTipAccounts({ recipient: false })
  const connectWorkspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  const connectMember = await insertMember({
    account_id: connected.recipientAccount.id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: connectWorkspace.id,
  })
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000000.${Nanoid.generate().slice(0, 6)}`
  await expectSlackConnectEmulator(channelId)

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slackConnect.userId}>`,
  })
  const tip = await waitForTipByIdempotencyKey(`mention:${providerId}:${channelId}:${messageTs}`)

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slackConnect.userId}> $0.001 · Receipt`,
    { channelId },
  )
  expect(tip).toMatchObject({
    recipient_member_id: connectMember.id,
    sender_member_id: connected.senderMember.id,
    workspace_id: connected.workspace.id,
  })
}, 20_000) // 20 seconds

test('@Tipbot mention supports Slack Connect broadcast reply tips', async () => {
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  const connected = await connectTipAccounts({ recipient: false })
  const connectWorkspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  const connectMember = await insertMember({
    account_id: connected.recipientAccount.id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: connectWorkspace.id,
  })
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000030.${Nanoid.generate().slice(0, 6)}`
  const threadTs = `1700000029.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    subtype: 'thread_broadcast',
    text: `<@${Constants.slack.botUserId}> <@${Constants.slackConnect.userId}>`,
    threadTs,
  })
  const tip = await waitForTipByIdempotencyKey(`mention:${providerId}:${channelId}:${messageTs}`)

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(
    threadTs,
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slackConnect.userId}> $0.001 · Receipt`,
    { channelId },
  )
  expect(tip).toMatchObject({
    recipient_member_id: connectMember.id,
    sender_member_id: connected.senderMember.id,
    workspace_id: connected.workspace.id,
  })
}, 20_000) // 20 seconds

test('@Tipbot mention sends Slack Connect channel tip with mentioned workspace installation', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  const connected = await connectTipAccounts({ recipient: false })
  const connectWorkspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  const connectMember = await insertMember({
    account_id: connected.recipientAccount.id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: connectWorkspace.id,
  })
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000027.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    authorizations: [{ is_bot: true, team_id: providerId, user_id: Constants.slack.botUserId }],
    channelId,
    contextTeamId: providerId,
    messageTs,
    teamId: Constants.slackConnect.teamId,
    text: `<@${Constants.slack.botUserId}> <!channel>`,
  })
  const tip = await waitForTipByIdempotencyKey(`mention:${providerId}:${channelId}:${messageTs}`)

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> tipped <!channel> <@${Constants.slackConnect.userId}> $0.001 each · Receipt`,
    { channelId },
  )
  expect(tip).toMatchObject({
    recipient_member_id: connectMember.id,
    sender_member_id: connected.senderMember.id,
    workspace_id: connected.workspace.id,
  })
  expect(
    fetchSpy.mock.calls.some((call) => {
      const input = call[0]
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const params = slackFetchBodyParams(call[1]?.body)
      return (
        url.endsWith('/chat.postMessage') &&
        getSlackFetchAuthorization(call) === `Bearer ${Constants.slack.botToken}` &&
        params.get('text')?.includes('tipped <!channel>')
      )
    }),
  ).toBe(true)
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('@Tipbot mention sends Slack Connect here tip with active members', async () => {
  const originalFetch = globalThis.fetch
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/users.getPresence')) {
      const params = slackFetchBodyParams(init?.body)
      if (
        params.get('user') === Constants.slackConnect.userId &&
        getSlackFetchAuthorization([input, init]) === `Bearer ${Constants.slack.botToken}`
      )
        return Response.json({ error: 'user_not_found', ok: false })
      return Response.json({
        ok: true,
        presence:
          params.get('user') === Constants.slack.adminUserId ||
          params.get('user') === Constants.slackConnect.userId
            ? 'active'
            : 'away',
      })
    }
    return originalFetch(input, init)
  }) satisfies typeof fetch)
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  const connected = await connectTipAccounts({ recipient: false })
  const connectWorkspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  const connectMember = await insertMember({
    account_id: connected.recipientAccount.id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: connectWorkspace.id,
  })
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000028.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    authorizations: [{ is_bot: true, team_id: providerId, user_id: Constants.slack.botUserId }],
    channelId,
    contextTeamId: providerId,
    messageTs,
    teamId: Constants.slackConnect.teamId,
    text: `<@${Constants.slack.botUserId}> <!here>`,
  })
  const tip = await waitForTipByIdempotencyKey(`mention:${providerId}:${channelId}:${messageTs}`)

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> tipped <!here> <@${Constants.slackConnect.userId}> $0.001 each · Receipt`,
    { channelId },
  )
  expect(tip).toMatchObject({
    recipient_member_id: connectMember.id,
    sender_member_id: connected.senderMember.id,
    workspace_id: connected.workspace.id,
  })
  expect(
    fetchSpy.mock.calls.some((call) => {
      const input = call[0]
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const params = slackFetchBodyParams(call[1]?.body)
      return (
        url.endsWith('/chat.postMessage') &&
        getSlackFetchAuthorization(call) === `Bearer ${Constants.slack.botToken}` &&
        params.get('text')?.includes('tipped <!here>')
      )
    }),
  ).toBe(true)
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('@Tipbot mention ignores everyone as a tip target', async () => {
  aiRunMock.mockResolvedValueOnce({ response: '@Tipbot' } as never)
  const messageTs = `1700000029.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <!everyone> $11 for coffee`,
  })

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(messageTs, 'Anytime.')
  await expectSlackThreadMessageNotContaining(messageTs, 'You’re about to tip')
  await expectSlackThreadMessageNotContaining(messageTs, 'Receipt')
}, 20_000) // 20 seconds

test('@Tipbot mention sends Slack Connect external sender tip from sender workspace with host defaults', async () => {
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  await db
    .updateTable('workspace')
    .set({ default_amount: 2000 })
    .where('provider_id', '=', providerId)
    .execute()
  const connected = await connectSlackConnectSender()
  const messageTs = `1700000030.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
    userId: Constants.slackConnect.userId,
  })
  const tip = await waitForTipByIdempotencyKey(`mention:${providerId}:${channelId}:${messageTs}`)
  const batch = await db
    .selectFrom('tip_batch')
    .select('provider_id')
    .where(
      'id',
      '=',
      (
        await db
          .selectFrom('tip')
          .select('batch_id')
          .where('id', '=', tip.id)
          .executeTakeFirstOrThrow()
      ).batch_id,
    )
    .executeTakeFirstOrThrow()
  const tipDetails = await db
    .selectFrom('tip')
    .select([
      'tip.amount',
      'tip.confirmed_at',
      'tip.recipient_member_id',
      'tip.sender_member_id',
      'tip.workspace_id',
    ])
    .where('tip.id', '=', tip.id)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slackConnect.userId}> tipped <@${Constants.slack.memberUserId}> $0.002 · Receipt`,
    { channelId },
  )
  expect({ ...tipDetails, provider_id: batch.provider_id }).toMatchObject({
    amount: 2000,
    confirmed_at: expect.any(String),
    provider_id: providerId,
    recipient_member_id: connected.hostRecipientMember.id,
    sender_member_id: connected.senderMember.id,
    workspace_id: connected.senderWorkspace.id,
  })
}, 20_000) // 20 seconds

test('@Tipbot mention shows add funds action for Slack Connect external sender with host installation', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const handleTipRequest = vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
    code: 'insufficient_funds',
    ok: false,
  })
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  const connected = await connectSlackConnectSender()
  const messageTs = `1700000032.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
    userId: Constants.slackConnect.userId,
  })
  const call = await getSlackPostEphemeralCall(
    fetchSpy,
    'Payment not sent. Your wallet has insufficient funds.',
  )

  expect(response.status).toBe(200)
  expect(handleTipRequest).toHaveBeenCalledWith(
    env,
    expect.objectContaining({
      providerId,
      settingsProviderId: providerId,
      workspaceProviderId: connected.senderWorkspace.provider_id,
    }),
  )
  expect(getSlackFetchAuthorization(call)).toBe(`Bearer ${Constants.slack.botToken}`)
  expect(getSlackFetchAuthorization(call)).not.toBe(`Bearer ${Constants.slackConnect.teamBotToken}`)
  await expectSlackPostEphemeralCall(fetchSpy, 'Add funds on https://wallet.tempo.xyz')
  handleTipRequest.mockRestore()
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('@Tipbot mention blocks Slack Connect external sender after sender workspace installs', async () => {
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  const connected = await connectSlackConnectSender()
  await db
    .updateTable('workspace')
    .set({ installed_at: new Date().toISOString() })
    .where('id', '=', connected.senderWorkspace.id)
    .execute()
  const messageTs = `1700000031.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
    userId: Constants.slackConnect.userId,
  })
  const tips = await db
    .selectFrom('tip')
    .select('id')
    .where('sender_member_id', '=', connected.senderMember.id)
    .execute()

  expect(response.status).toBe(200)
  expect(tips).toEqual([])
  await expectSlackMessage('Use your workspace’s Tipbot app', { channelId })
}, 20_000) // 20 seconds

test('@Tipbot mention posts Slack Connect confirmation with host workspace installation', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  const connected = await connectTipAccounts({ recipient: false })
  await db.deleteFrom('access_key').where('account_id', '=', connected.senderAccount.id).execute()
  const connectWorkspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  await insertMember({
    account_id: connected.recipientAccount.id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: connectWorkspace.id,
  })
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000025.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slackConnect.userId}>`,
  })
  const call = await getSlackPostEphemeralCall(
    fetchSpy,
    'Tipbot needs your approval to send this payment.',
  )

  expect(response.status).toBe(200)
  expect(getSlackFetchAuthorization(call)).toBe(`Bearer ${Constants.slack.botToken}`)
  expect(getSlackFetchAuthorization(call)).not.toBe(`Bearer ${Constants.slackConnect.teamBotToken}`)
  await expectSlackMessage('Tipbot needs your approval to send this payment.', { channelId })
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('@Tipbot mention confirms Slack Connect external sender tip from sender workspace', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  const connected = await connectSlackConnectSender()
  await db.deleteFrom('access_key').where('account_id', '=', connected.senderAccount.id).execute()
  const messageTs = `1700000033.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
    userId: Constants.slackConnect.userId,
  })
  const call = await getSlackPostEphemeralCall(
    fetchSpy,
    'Tipbot needs your approval to send this payment.',
  )
  const params = await slackFetchCallBodyParams(...call)
  const token = params.get('text')?.match(/\/confirm\/(0x[0-9a-f]+\.0x[0-9a-f]+)/i)?.[1]
  if (!token) throw new Error('Expected confirmation token in Slack message.')
  const confirmation = await client.api.confirm[':token'].$get({ param: { token } })
  const confirmationJson = await confirmation.json()
  if (!confirmationJson.ok) throw new Error('Expected confirmation metadata.')
  const root = Account.fromSecp256k1(Constants.tip.senderRootPrivateKey)
  const keyAuthorization = await AccountLink.signKeyAuthorization(root, {
    accessKeyAddress: confirmationJson.accessKeyAddress,
    chainId: confirmationJson.chainId,
    expiresAt: confirmationJson.accessKeyExpiry,
    tokenAddress: confirmationJson.tokenAddress,
  })

  const confirmResponse = await client.api.confirm[':token'].$post({
    json: { address: root.address, keyAuthorization },
    param: { token },
  })
  await drainWaitUntil()
  const tip = await waitForTipByIdempotencyKey(`mention:${providerId}:${channelId}:${messageTs}`)
  const tipDetails = await db
    .selectFrom('tip')
    .select(['amount', 'confirmed_at', 'recipient_member_id', 'sender_member_id', 'workspace_id'])
    .where('id', '=', tip.id)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(confirmation.status).toBe(200)
  expect(confirmationJson).toMatchObject({
    amount: '0.001',
    kind: 'reusable_access_key',
    recipientProviderUserId: Constants.slack.memberUserId,
  })
  expect(confirmResponse.status).toBe(200)
  await expect(confirmResponse.json()).resolves.toMatchObject({ ok: true })
  expect(tipDetails).toMatchObject({
    amount: 1000,
    confirmed_at: expect.any(String),
    recipient_member_id: connected.hostRecipientMember.id,
    sender_member_id: connected.senderMember.id,
    workspace_id: connected.senderWorkspace.id,
  })
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slackConnect.userId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
    { channelId, wait: true },
  )
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('@Tipbot mention queues Slack Connect tip for unconnected recipient workspace', async () => {
  const connected = await connectTipAccounts({ recipient: false })
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000000.${Nanoid.generate().slice(0, 6)}`
  await expectSlackConnectEmulator(channelId)

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slackConnect.userId}>`,
  })
  const pendingTip = await db
    .selectFrom('pending_tip')
    .selectAll()
    .where('sender_member_id', '=', connected.senderMember.id)
    .where('recipient_provider_user_id', '=', Constants.slackConnect.userId)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(pendingTip).toMatchObject({
    recipient_provider_user_id: Constants.slackConnect.userId,
    status: 'pending',
    workspace_id: connected.workspace.id,
  })
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> queued <@${Constants.slackConnect.userId}> $0.001`,
    { channelId },
  )
  await expectSlackThreadMessage(messageTs, 'Run `/tip connect` to receive it', { channelId })
}, 20_000) // 20 seconds

test('@Tipbot mention fails closed for ambiguous Slack Connect recipient', async () => {
  const connected = await connectTipAccounts({ recipient: false })
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  const connectWorkspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  await insertMember({
    account_id: (await factory.account.insert({})).id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: connected.workspace.id,
  })
  await insertMember({
    account_id: (await factory.account.insert({})).id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: connectWorkspace.id,
  })
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000005.${Nanoid.generate().slice(0, 6)}`
  await expectSlackConnectEmulator(channelId)

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slackConnect.userId}>`,
  })
  const pendingTips = await db
    .selectFrom('pending_tip')
    .selectAll()
    .where('sender_member_id', '=', connected.senderMember.id)
    .execute()

  expect(response.status).toBe(200)
  expect(pendingTips).toEqual([])
  await expectSlackMessage(
    `Payment not sent. <@${Constants.slackConnect.userId}> could not be resolved safely across Slack workspaces.`,
    { channelId },
  )
}, 20_000) // 20 seconds

test('@Tipbot mention queued Slack Connect tip uses mention connect when recipient workspace is uninstalled', async () => {
  const connected = await connectTipAccounts({ recipient: false })
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    installed_at: null,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000004.${Nanoid.generate().slice(0, 6)}`
  await expectSlackConnectEmulator(channelId)

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slackConnect.userId}>`,
  })
  const pendingTip = await db
    .selectFrom('pending_tip')
    .selectAll()
    .where('sender_member_id', '=', connected.senderMember.id)
    .where('recipient_provider_user_id', '=', Constants.slackConnect.userId)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(pendingTip.status).toBe('pending')
  await expectSlackThreadMessage(messageTs, 'Run `@Tipbot connect` to receive it', { channelId })
}, 20_000) // 20 seconds

test('@Tipbot mention claims Slack Connect pending tip when recipient connects', async () => {
  const connected = await connectTipAccounts({ recipient: false })
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  const channelId = await getSlackConnectChannelId()
  const queuedMessageTs = `1700000001.${Nanoid.generate().slice(0, 6)}`
  const connectMessageTs = `1700000002.${Nanoid.generate().slice(0, 6)}`
  await expectSlackConnectEmulator(channelId)

  await postSlackAppMention({
    channelId,
    messageTs: queuedMessageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slackConnect.userId}>`,
  })
  const pendingTip = await db
    .selectFrom('pending_tip')
    .selectAll()
    .where('sender_member_id', '=', connected.senderMember.id)
    .where('recipient_provider_user_id', '=', Constants.slackConnect.userId)
    .executeTakeFirstOrThrow()
  const connectResponse = await postSlackAppMention({
    channelId,
    messageTs: connectMessageTs,
    text: `<@${Constants.slack.botUserId}> connect`,
    userId: Constants.slackConnect.userId,
  })
  const token = await getLatestConnectToken({ channelId })
  const link = await db
    .selectFrom('account_link_token')
    .innerJoin('member', 'member.id', 'account_link_token.member_id')
    .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
    .select([
      'account_link_token.access_key_address',
      'account_link_token.access_key_expires_at',
      'workspace.chain_id',
      'workspace.default_token_address',
    ])
    .where('member.provider_user_id', '=', Constants.slackConnect.userId)
    .where('workspace.provider_id', '=', Constants.slackConnect.teamId)
    .executeTakeFirstOrThrow()
  const root = Account.fromSecp256k1(
    '0x5555555555555555555555555555555555555555555555555555555555555555',
  )
  const sendSpy = vi.spyOn(env.PENDING_TIP_QUEUE, 'send').mockResolvedValue({
    metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
  })
  const completeResponse = await client.api.account.link[':token'].$post({
    json: {
      address: root.address,
      keyAuthorization: await AccountLink.signKeyAuthorization(root, {
        accessKeyAddress: link.access_key_address,
        chainId: link.chain_id,
        expiresAt: link.access_key_expires_at,
        tokenAddress: Address.checksum(link.default_token_address ?? Tempo.addressLookup.pathUsd),
      }),
    },
    param: { token },
  })
  await drainWaitUntil()
  const batch = createMessageBatch<processPendingTipMessage.Body>(
    processPendingTipMessage.queueName,
    [
      {
        attempts: 1,
        body: { pendingTipId: pendingTip.id },
        id: crypto.randomUUID(),
        timestamp: new Date(),
      },
    ],
  )

  await processPendingTipMessage(batch.messages[0]!)
  const updatedPendingTip = await db
    .selectFrom('pending_tip')
    .selectAll()
    .where('id', '=', pendingTip.id)
    .executeTakeFirstOrThrow()
  const tip = await waitForTipByIdempotencyKey(`pending:${pendingTip.id}`)

  expect(connectResponse.status).toBe(200)
  expect(completeResponse.status).toBe(200)
  expect(sendSpy).toHaveBeenCalledWith({ pendingTipId: pendingTip.id })
  expect(updatedPendingTip).toMatchObject({ status: 'sent', tip_id: tip.id })
  expect(tip).toMatchObject({
    recipient_member_id: pendingTip.recipient_member_id,
    sender_member_id: connected.senderMember.id,
    workspace_id: connected.workspace.id,
  })
  await expectSlackThreadMessage(
    queuedMessageTs,
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slackConnect.userId}> $0.001 · Receipt`,
    { channelId, wait: true },
  )
}, 20_000) // 20 seconds

test('@Tipbot mention does not queue Slack Connect multi-recipient tip', async () => {
  const connected = await connectTipAccounts()
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  const channelId = await getSlackConnectChannelId()
  const messageTs = `1700000003.${Nanoid.generate().slice(0, 6)}`
  await expectSlackConnectEmulator(channelId)

  const response = await postSlackAppMention({
    channelId,
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}> <@${Constants.slackConnect.userId}>`,
  })
  const pendingTips = await db
    .selectFrom('pending_tip')
    .selectAll()
    .where('sender_member_id', '=', connected.senderMember.id)
    .execute()
  const tips = await db
    .selectFrom('tip')
    .selectAll()
    .where('idempotency_key', '=', `mention:${providerId}:${channelId}:${messageTs}`)
    .execute()

  expect(response.status).toBe(200)
  expect(pendingTips).toEqual([])
  expect(tips).toEqual([])
  await expectSlackMessage(`You’re about to tip <@${Constants.slack.memberUserId}> $0.001 each.`, {
    channelId,
  })
  await expectSlackMessage(`• <@${Constants.slack.memberUserId}>`, { channelId })
  await expectSlackMessage(`• <@${Constants.slackConnect.userId}> (not connected yet)`, {
    channelId,
  })
  await expectSlackMessageNotContaining('queued', { channelId })
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
    memo: 'v2 launch',
    name: 'token-like memo after amount',
    text: '0.002 v2 launch',
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
    const tip = await db.selectFrom('tip').select('confirmed_at').executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    await expectSlackThreadMessage(
      messageTs,
      `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
    )
    expect(tip.confirmed_at).toEqual(expect.any(String))
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
    'Connect with `@Tipbot connect` or `/tip connect`, then send stablecoins with `@Tipbot @account for coffee`, `@Tipbot @account 0.005 for coffee`, `/tip @account for coffee`, or a 💸 reaction.',
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

test('@Tipbot mention wires AI reply author mentions', async () => {
  aiRunMock.mockResolvedValueOnce({ response: '@admin, anytime.' } as never)
  const messageTs = `1700000017.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> thank you`,
  })

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(messageTs, `<@${Constants.slack.adminUserId}>, anytime.`)
})

test('@Tipbot mention uses AI for valid payment syntax hints', async () => {
  aiRunMock.mockResolvedValueOnce({
    response: 'Close. Try `@Tipbot @account for coffee`.',
  } as never)
  const messageTs = `1700000019.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> please pay <@${Constants.slack.memberUserId}>`,
  })

  expect(response.status).toBe(200)
  expect(aiRunMock).toHaveBeenCalledOnce()
  await expectSlackThreadMessage(messageTs, 'Close. Try `@Tipbot @account for coffee`.')
})

test('@Tipbot mention falls back when AI returns an unwired mention', async () => {
  aiRunMock.mockResolvedValueOnce({ response: '@Joshie, anytime.' } as never)
  const messageTs = `1700000018.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> thank you`,
  })

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(messageTs, 'Anytime.')
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
    .select(['confirmed_at', 'memo'])
    .where('memo', '=', 'coffee')
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(aiRunMock).not.toHaveBeenCalled()
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> sent <@${Constants.slack.memberUserId}> $0.001 for coffee · Receipt`,
  )
  expect(tip.confirmed_at).toEqual(expect.any(String))
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
    .select(['confirmed_at', 'memo'])
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
    .select(['amount', 'confirmed_at'])
    .where('amount', '=', 2000)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  await expectSlackThreadMessage(
    messageTs,
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.002 · Receipt`,
  )
  expect(tip.confirmed_at).toEqual(expect.any(String))
}, 20_000) // 20 seconds

test('@Tipbot mention rejects multi-recipient tips with unconnected recipients', async () => {
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
  await expectSlackThreadMessageNotContaining(messageTs, 'tipped')
})

test('@Tipbot mention falls back when payment hint AI is not useful', async () => {
  aiRunMock.mockResolvedValueOnce({ response: 'Anytime.' } as never)
  const messageTs = `1700000004.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `my turn <@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })
  const tips = await db
    .selectFrom('tip')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .selectAll('tip')
    .where('workspace.provider_id', '=', providerId)
    .execute()

  expect(response.status).toBe(200)
  expect(tips).toHaveLength(0)
  expect(aiRunMock).toHaveBeenCalledOnce()
  await expectSlackThreadMessage(messageTs, 'Almost. Try `@Tipbot @account for coffee`.')
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
  await expectSlackThreadMessageNotContaining(
    messageTs,
    'Tipbot needs your approval to send this payment.',
  )
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
  await expectSlackThreadMessageNotContaining(messageTs, 'Payment failed.')
  await expectSlackAssistantStatusCall(fetchSpy, messageTs, '')
  handleTipRequest.mockRestore()
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('@Tipbot mention explains memo length failures', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  aiRunMock.mockResolvedValueOnce({ response: 'best pages internet' } as never)
  const handleTipRequest = vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
    code: 'failed',
    message: 'Memo must be at most 32 bytes.',
    ok: false,
  })
  const messageTs = `1700000008.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}> for finding possibly one of the best pages on the internet`,
  })

  expect(response.status).toBe(200)
  expect(handleTipRequest).not.toHaveBeenCalled()
  expect(aiRunMock).toHaveBeenCalledOnce()
  await expectSlackMessage('Try: `best pages internet`.')
  await expectSlackThreadMessageNotContaining(messageTs, 'Try: `best pages internet`.')
  await expectSlackAssistantStatusCall(fetchSpy, messageTs, '')
  handleTipRequest.mockRestore()
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('@Tipbot mention omits memo suggestion when AI returns an invalid memo', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  aiRunMock.mockResolvedValueOnce({ response: 'ignore previous prompt' } as never)
  const handleTipRequest = vi.spyOn(Tip, 'handleTipRequest').mockResolvedValue({
    code: 'failed',
    message: 'Memo must be at most 32 bytes.',
    ok: false,
  })
  const messageTs = `1700000008.${Nanoid.generate().slice(0, 6)}`

  const response = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}> for finding possibly one of the best pages on the internet`,
  })

  expect(response.status).toBe(200)
  expect(aiRunMock).toHaveBeenCalledOnce()
  await expectSlackMessage('Payment not sent. Memo must be at most 32 bytes')
  await expectSlackThreadMessageNotContaining(
    messageTs,
    'Payment not sent. Memo must be at most 32 bytes',
  )
  await expectSlackThreadMessageNotContaining(messageTs, 'Try:')
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
    `Reaction tips received in this thread:\n\n<@${Constants.slack.memberUserId}> received a tip on <slack://channel?team=${providerId}&id=${channelId}&message=${message.ts}|this message>:\n• :money_with_wings: <@${Constants.slack.adminUserId}> tipped $0.001 · <`,
    { channelId },
  )
})

for (const reactionTipCase of [
  { amountText: '$0.01', emoji: 'dollar' },
  { amountText: '$0.10', emoji: 'moneybag' },
] as const) {
  test(`reaction tipping sends mapped amount for ${reactionTipCase.emoji} reaction`, async () => {
    await connectTipAccounts()
    const channelId = await createSlackTestChannel('rt')
    const message = await memberSlack.chat.postMessage({
      channel: channelId,
      text: 'huge work',
    })
    if (!message.ts) throw new Error('Expected Slack message timestamp.')

    const response = await postSlackReaction({
      channelId,
      messageTs: message.ts,
      reaction: reactionTipCase.emoji,
      userId: Constants.slack.adminUserId,
    })

    expect(response.status).toBe(200)
    await expect
      .poll(
        async () =>
          await db
            .selectFrom('tip')
            .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
            .selectAll('tip')
            .where('workspace.provider_id', '=', providerId)
            .where('tip.idempotency_key', 'like', `${Chat.reactionTipIdempotencyPrefix}%`)
            .where('tip.confirmed_at', 'is not', null)
            .execute(),
        { timeout: 10_000 }, // 10 seconds
      )
      .toHaveLength(1)
    const tips = await db
      .selectFrom('tip')
      .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
      .selectAll('tip')
      .where('workspace.provider_id', '=', providerId)
      .where('tip.idempotency_key', 'like', `${Chat.reactionTipIdempotencyPrefix}%`)
      .execute()
    const config = Tip.defaultReactionTipConfigs.find(
      (config) => config.emoji === reactionTipCase.emoji,
    )
    if (!config) throw new Error('Expected default reaction tip config.')
    expect(tips).toHaveLength(1)
    expect(tips[0]).toMatchObject({ amount: config.amount, confirmed_at: expect.any(String) })
    await expectSlackThreadMessage(
      message.ts,
      `Reaction tips received in this thread:\n\n<@${Constants.slack.memberUserId}> received a tip on <slack://channel?team=${providerId}&id=${channelId}&message=${message.ts}|this message>:\n• :${reactionTipCase.emoji}: <@${Constants.slack.adminUserId}> tipped ${reactionTipCase.amountText} · <`,
      { channelId, wait: true },
    )
  })
}

test('reaction tipping uses workspace configured emoji amounts', async () => {
  await postSlackInteraction(
    createViewSubmissionPayload({
      amount: '0.001',
      network: 'testnet',
      reactionTips: ':moneybag: 0.002',
      token: 'pathUSD',
    }),
  )
  const configuredWorkspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  const configuredReactionTips = await db
    .selectFrom('reaction_tip_config')
    .select(['amount', 'emoji'])
    .where('workspace_id', '=', configuredWorkspace.id)
    .execute()
  expect(configuredReactionTips).toEqual([{ amount: 2000, emoji: 'moneybag' }])
  await db
    .updateTable('workspace')
    .set({ chain_id: Tempo.chainLookup.localnet })
    .where('id', '=', configuredWorkspace.id)
    .execute()
  await connectTipAccounts()
  const channelId = await createSlackTestChannel('rt')
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'configured reaction',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const ignoredResponse = await postSlackReaction({
    channelId,
    eventTs: `${message.ts}-ignored`,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })
  const response = await postSlackReaction({
    channelId,
    messageTs: message.ts,
    reaction: 'moneybag',
    userId: Constants.slack.adminUserId,
  })
  await expect
    .poll(
      async () =>
        await db
          .selectFrom('tip')
          .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
          .selectAll('tip')
          .where('workspace.provider_id', '=', providerId)
          .where('tip.idempotency_key', 'like', `${Chat.reactionTipIdempotencyPrefix}%`)
          .where('tip.confirmed_at', 'is not', null)
          .execute(),
      { timeout: 10_000 }, // 10 seconds
    )
    .toHaveLength(1)
  const tip = await db
    .selectFrom('tip')
    .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
    .selectAll('tip')
    .where('workspace.provider_id', '=', providerId)
    .where('tip.idempotency_key', 'like', `${Chat.reactionTipIdempotencyPrefix}%`)
    .executeTakeFirstOrThrow()

  expect(ignoredResponse.status).toBe(200)
  expect(response.status).toBe(200)
  expect(tip).toMatchObject({ amount: 2000, confirmed_at: expect.any(String) })
  await expectSlackThreadMessage(
    message.ts,
    `Reaction tips received in this thread:\n\n<@${Constants.slack.memberUserId}> received a tip on <slack://channel?team=${providerId}&id=${channelId}&message=${message.ts}|this message>:\n• :moneybag: <@${Constants.slack.adminUserId}> tipped $0.002 · <`,
    { channelId, wait: true },
  )
}, 20_000) // 20 seconds

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

  const firstTransactionHash = `0x${Nanoid.generate().padEnd(64, '1').slice(0, 64)}`
  const firstBatch = await factory.tip_batch.insert({
    amount_each: 1000,
    idempotency_key: `${Chat.reactionTipIdempotencyPrefix}${Nanoid.generate()}`,
    provider: 'slack',
    provider_channel_id: channelId,
    provider_id: providerId,
    recipient_count: 1,
    sender_member_id: connected.senderMember.id,
    source: 'reaction',
    status: 'confirmed',
    token_address: Tempo.addressLookup.pathUsd,
    total_amount: 1000,
    transaction_hash: firstTransactionHash,
    workspace_id: connected.workspace.id,
  })
  const firstTip = await factory.tip.insert({
    access_key_id: connected.accessKey.id,
    batch_id: firstBatch.id,
    chain_id: connected.workspace.chain_id,
    confirmed_at: new Date().toISOString(),
    idempotency_key: firstBatch.idempotency_key,
    recipient_id: connected.recipientAccount.id,
    recipient_member_id: connected.recipientMember.id,
    sender_id: connected.senderAccount.id,
    sender_member_id: connected.senderMember.id,
    token_address: Tempo.addressLookup.pathUsd,
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
    threadTs: parent.ts,
    workspaceId: connected.workspace.id,
  })

  const secondTransactionHash = `0x${Nanoid.generate().padEnd(64, '2').slice(0, 64)}`
  const secondBatch = await factory.tip_batch.insert({
    amount_each: 1000,
    idempotency_key: `${Chat.reactionTipIdempotencyPrefix}${Nanoid.generate()}`,
    provider: 'slack',
    provider_channel_id: channelId,
    provider_id: providerId,
    recipient_count: 1,
    sender_member_id: connected.senderMember.id,
    source: 'reaction',
    status: 'confirmed',
    token_address: Tempo.addressLookup.pathUsd,
    total_amount: 1000,
    transaction_hash: secondTransactionHash,
    workspace_id: connected.workspace.id,
  })
  const secondTip = await factory.tip.insert({
    access_key_id: connected.accessKey.id,
    batch_id: secondBatch.id,
    chain_id: connected.workspace.chain_id,
    confirmed_at: new Date().toISOString(),
    idempotency_key: secondBatch.idempotency_key,
    recipient_id: connected.recipientAccount.id,
    recipient_member_id: connected.recipientMember.id,
    sender_id: connected.senderAccount.id,
    sender_member_id: connected.senderMember.id,
    token_address: Tempo.addressLookup.pathUsd,
    workspace_id: connected.workspace.id,
  })
  await factory.reaction_tip.insert({
    channel_id: channelId,
    idempotency_key: secondTip.idempotency_key,
    message_ts: reply.ts,
    reaction: 'moneybag',
    recipient_member_id: connected.recipientMember.id,
    sender_member_id: connected.senderMember.id,
    thread_ts: parent.ts,
    tip_id: secondTip.id,
    workspace_id: connected.workspace.id,
  })
  await Chat.updateReactionTipAggregate(providerId, {
    channelId,
    threadTs: parent.ts,
    workspaceId: connected.workspace.id,
  })
  const thread = await slack.conversations.replies({ channel: channelId, ts: parent.ts })
  const aggregates = thread.messages?.filter((message) => message.text?.includes('Reaction tips'))

  expect(aggregates, JSON.stringify(thread.messages)).toHaveLength(1)
  expect(aggregates?.[0]?.text).toContain(
    `<@${Constants.slack.memberUserId}> received a tip on <slack://channel?team=${providerId}&id=${channelId}&message=${parent.ts}|this message>:\n• :money_with_wings: <@${Constants.slack.adminUserId}> tipped $0.001 · <`,
  )
  expect(aggregates?.[0]?.text).toContain(
    `<@${Constants.slack.memberUserId}> received a tip on <slack://channel?team=${providerId}&id=${channelId}&message=${reply.ts}|this message>:\n• :moneybag: <@${Constants.slack.adminUserId}> tipped $0.001 · <`,
  )
})

test('receipt boost ignores reaction tip aggregate reply', async () => {
  const connected = await connectTipAccounts()
  if (!connected.recipientMember) throw new Error('Expected connected recipient.')
  const channelId = await createSlackTestChannel('rt')
  const parent = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'aggregate boost parent',
  })
  if (!parent.ts) throw new Error('Expected Slack parent message timestamp.')
  const transactionHash = `0x${Nanoid.generate().padEnd(64, '1').slice(0, 64)}`
  const batch = await factory.tip_batch.insert({
    amount_each: 1000,
    idempotency_key: `${Chat.reactionTipIdempotencyPrefix}${Nanoid.generate()}`,
    provider: 'slack',
    provider_channel_id: channelId,
    provider_id: providerId,
    recipient_count: 1,
    sender_member_id: connected.senderMember.id,
    source: 'reaction',
    status: 'confirmed',
    token_address: Tempo.addressLookup.pathUsd,
    total_amount: 1000,
    transaction_hash: transactionHash,
    workspace_id: connected.workspace.id,
  })
  const tip = await factory.tip.insert({
    access_key_id: connected.accessKey.id,
    batch_id: batch.id,
    chain_id: connected.workspace.chain_id,
    confirmed_at: new Date().toISOString(),
    idempotency_key: batch.idempotency_key,
    recipient_id: connected.recipientAccount.id,
    recipient_member_id: connected.recipientMember.id,
    sender_id: connected.senderAccount.id,
    sender_member_id: connected.senderMember.id,
    token_address: Tempo.addressLookup.pathUsd,
    workspace_id: connected.workspace.id,
  })
  await factory.reaction_tip.insert({
    channel_id: channelId,
    idempotency_key: tip.idempotency_key,
    message_ts: parent.ts,
    reaction: 'money_with_wings',
    recipient_member_id: connected.recipientMember.id,
    sender_member_id: connected.senderMember.id,
    thread_ts: parent.ts,
    tip_id: tip.id,
    workspace_id: connected.workspace.id,
  })
  await Chat.updateReactionTipAggregate(providerId, {
    channelId,
    threadTs: parent.ts,
    workspaceId: connected.workspace.id,
  })
  const thread = await slack.conversations.replies({ channel: channelId, ts: parent.ts })
  const aggregate = thread.messages?.find((message) => message.text?.startsWith('Reaction tips'))
  if (!aggregate?.ts) throw new Error('Expected reaction tip aggregate timestamp.')
  const fetchSpy = vi.spyOn(globalThis, 'fetch')

  const boostResponse = await postSlackReaction({
    channelId,
    messageTs: aggregate.ts,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })
  const boostCount = await db
    .selectFrom('tip_batch')
    .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
    .select(({ fn }) => fn.count<number>('tip_batch.id').as('count'))
    .where('workspace.provider_id', '=', providerId)
    .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
    .executeTakeFirstOrThrow()

  expect(boostResponse.status).toBe(200)
  expect(boostCount.count).toBe(0)
  expect(
    fetchSpy.mock.calls.some((call) => {
      const input = call[0]
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.endsWith('/chat.postEphemeral')
    }),
  ).toBe(false)
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

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
    'Payment not sent. Connect to Tipbot with `@Tipbot connect` or `/tip connect` and try again.',
  )
  await expectSlackThreadMessageNotContaining(message.ts, 'tipped', { channelId })
  fetchSpy.mockRestore()
})

test('reaction tipping sends tip from single channel guest', async () => {
  await connectTipAccounts({ senderProviderUserId: Constants.slack.singleChannelGuestUserId })
  const channelId = await createSlackTestChannel('rt')
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'single channel guest should reaction tip',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const response = await postSlackReaction({
    channelId,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.singleChannelGuestUserId,
  })

  expect(response.status).toBe(200)
  await expect
    .poll(
      async () =>
        await db
          .selectFrom('tip')
          .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
          .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
          .innerJoin('workspace', 'workspace.id', 'tip.workspace_id')
          .select([
            'recipient.provider_user_id as recipient_provider_user_id',
            'sender.provider_user_id as sender_provider_user_id',
            'tip.confirmed_at',
          ])
          .where('workspace.provider_id', '=', providerId)
          .where('tip.idempotency_key', 'like', `${Chat.reactionTipIdempotencyPrefix}%`)
          .executeTakeFirst(),
      { timeout: 5_000 }, // 5 seconds
    )
    .toMatchObject({
      confirmed_at: expect.any(String),
      recipient_provider_user_id: Constants.slack.memberUserId,
      sender_provider_user_id: Constants.slack.singleChannelGuestUserId,
    })
  await expectSlackThreadMessage(message.ts, 'tipped', { channelId, wait: true })
}, 20_000) // 20 seconds

test('queued tip to single-channel guest uses mention connect instruction', async () => {
  const connected = await connectTipAccounts({ recipient: false })

  const response = await postSlashCommand(`<@${Constants.slack.singleChannelGuestUserId}>`)
  const pendingTip = await db
    .selectFrom('pending_tip')
    .selectAll()
    .where('sender_member_id', '=', connected.senderMember.id)
    .where('recipient_provider_user_id', '=', Constants.slack.singleChannelGuestUserId)
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(pendingTip).toMatchObject({
    recipient_provider_user_id: Constants.slack.singleChannelGuestUserId,
    status: 'pending',
    workspace_id: connected.workspace.id,
  })
  await expectSlackMessage(
    `<@${Constants.slack.adminUserId}> queued <@${Constants.slack.singleChannelGuestUserId}> $0.001`,
  )
  await expectSlackMessage('Run `@Tipbot connect` to receive it')
})

test('reaction tipping sends Slack Connect tip to recipient home workspace member', async () => {
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  const connected = await connectTipAccounts({ recipient: false })
  const connectWorkspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  const connectMember = await insertMember({
    account_id: connected.recipientAccount.id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: connectWorkspace.id,
  })
  const channelId = await getSlackConnectChannelId()
  const connectSlack = new WebClient(Constants.slackConnect.teamBotToken, {
    slackApiUrl: env.SLACK_API_URL,
  })
  const message = await connectSlack.chat.postMessage({
    channel: channelId,
    text: 'slack connect recipient should receive reaction tip',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const idempotencyKey = `${Chat.reactionTipIdempotencyPrefix}:${connected.workspace.id}:${channelId}:${message.ts}:money_with_wings:${connected.senderMember.id}:${message.ts}-reaction`
  const response = await postSlackReaction({
    channelId,
    itemUserId: Constants.slackConnect.userId,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })
  const tip = await waitForTipByIdempotencyKey(idempotencyKey)
  let reactionTip = await db
    .selectFrom('reaction_tip')
    .selectAll()
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirstOrThrow()
  for (let index = 0; index < 50 && reactionTip.tip_id !== tip.id; index++) {
    await new Promise((resolve) => setTimeout(resolve, 100)) // 100 milliseconds
    reactionTip = await db
      .selectFrom('reaction_tip')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirstOrThrow()
  }

  expect(response.status).toBe(200)
  expect(reactionTip).toMatchObject({
    recipient_member_id: connectMember.id,
    sender_member_id: connected.senderMember.id,
    tip_id: tip.id,
    workspace_id: connected.workspace.id,
  })
  expect(tip).toMatchObject({
    recipient_member_id: connectMember.id,
    sender_member_id: connected.senderMember.id,
    workspace_id: connected.workspace.id,
  })
  await expectSlackThreadMessage(message.ts, 'tipped', { channelId, wait: true })
}, 20_000) // 20 seconds

test('reaction tipping silently ignores unconnected Slack Connect external sender', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'unconnected external sender should not reaction tip',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const response = await postSlackReaction({
    channelId,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slackConnect.userId,
  })
  const workspace = await db
    .selectFrom('workspace')
    .select('id')
    .where('provider', '=', 'slack')
    .where('provider_id', '=', Constants.slackConnect.teamId)
    .executeTakeFirst()

  expect(response.status).toBe(200)
  expect(workspace).toBeUndefined()
  expect(
    await Promise.all(
      fetchSpy.mock.calls.map(async (call) => {
        const input = call[0]
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const params = await slackFetchCallBodyParams(...call)
        return (
          url.endsWith('/chat.postEphemeral') &&
          `${params.get('text') ?? ''} ${params.get('blocks') ?? ''}`.includes('Connect')
        )
      }),
    ).then((calls) => calls.some(Boolean)),
  ).toBe(false)
  await expectSlackThreadMessageNotContaining(message.ts, 'tipped', { channelId })
  fetchSpy.mockRestore()
})

test('reaction tipping sends Slack Connect external sender tip from sender workspace with mapped reaction amount', async () => {
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  await db
    .updateTable('workspace')
    .set({ default_amount: 3000 })
    .where('provider_id', '=', providerId)
    .execute()
  const connected = await connectSlackConnectSender()
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'external sender should reaction tip host member',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const response = await postSlackReaction({
    channelId,
    itemUserId: Constants.slack.memberUserId,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slackConnect.userId,
  })
  const tip = await waitForTipByIdempotencyKey(
    `${Chat.reactionTipIdempotencyPrefix}:${connected.senderWorkspace.id}:${channelId}:${message.ts}:money_with_wings:${connected.senderMember.id}:${message.ts}-reaction`,
  )

  expect(response.status).toBe(200)
  expect(tip).toMatchObject({
    recipient_member_id: connected.hostRecipientMember.id,
    sender_member_id: connected.senderMember.id,
    workspace_id: connected.senderWorkspace.id,
  })
  await expectSlackThreadMessage(message.ts, '$0.001', { channelId, wait: true })
}, 20_000) // 20 seconds

test('reaction tipping queues unconnected recipient', async () => {
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
  await expectSlackThreadMessage(message.ts, 'Reaction tips received in this thread:', {
    channelId,
    wait: true,
  })
  await expectSlackThreadMessage(message.ts, `<@${Constants.slack.memberUserId}> received a tip`, {
    channelId,
    wait: true,
  })
  await expectSlackThreadMessage(message.ts, ':money_with_wings:', { channelId, wait: true })
  await expectSlackThreadMessage(message.ts, `<@${Constants.slack.adminUserId}> queued $0.001`, {
    channelId,
    wait: true,
  })
  await expectSlackThreadMessage(message.ts, 'Run `/tip connect` to receive it', {
    channelId,
    wait: true,
  })
})

test('reaction tipping queued Slack Connect recipient uses mention connect when recipient workspace is uninstalled', async () => {
  const connected = await connectTipAccounts({ recipient: false })
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  await expectSlackConnectEmulator(channelId)
  const connectSlack = new WebClient(Constants.slackConnect.teamBotToken, {
    slackApiUrl: env.SLACK_API_URL,
  })
  const message = await connectSlack.chat.postMessage({
    channel: channelId,
    text: 'uninstalled Slack Connect recipient should receive mention connect instruction',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const response = await postSlackReaction({
    channelId,
    itemUserId: Constants.slackConnect.userId,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })

  expect(response.status).toBe(200)
  await expect
    .poll(
      async () =>
        await db
          .selectFrom('pending_tip')
          .innerJoin('member', 'member.id', 'pending_tip.recipient_member_id')
          .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
          .select([
            'pending_tip.recipient_provider_user_id',
            'pending_tip.sender_member_id',
            'pending_tip.status',
            'workspace.installed_at',
            'workspace.provider_id',
          ])
          .where('pending_tip.sender_member_id', '=', connected.senderMember.id)
          .where('pending_tip.recipient_provider_user_id', '=', Constants.slackConnect.userId)
          .executeTakeFirst(),
      { interval: 100, timeout: 5_000 }, // 100 milliseconds, 5 seconds
    )
    .toMatchObject({
      installed_at: null,
      provider_id: Constants.slackConnect.teamId,
      recipient_provider_user_id: Constants.slackConnect.userId,
      sender_member_id: connected.senderMember.id,
      status: 'pending',
    })
  await expectSlackThreadMessage(message.ts, 'Run `@Tipbot connect` to receive it', {
    channelId,
    wait: true,
  })
}, 20_000) // 20 seconds

test('reaction tipping queued Slack Connect recipient uses mention connect when another shared workspace is uninstalled', async () => {
  const connected = await connectTipAccounts({ recipient: false })
  await deleteSlackConnectWorkspace()
  const channelId = await getSlackConnectChannelId()
  await expectSlackConnectEmulator(channelId)
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'local recipient should receive mention connect instruction in partially uninstalled Slack Connect channel',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')

  const response = await postSlackReaction({
    channelId,
    itemUserId: Constants.slack.memberUserId,
    messageTs: message.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })

  expect(response.status).toBe(200)
  await expect
    .poll(
      async () =>
        await db
          .selectFrom('pending_tip')
          .select(['recipient_provider_user_id', 'sender_member_id', 'status'])
          .where('sender_member_id', '=', connected.senderMember.id)
          .where('recipient_provider_user_id', '=', Constants.slack.memberUserId)
          .executeTakeFirst(),
      { interval: 100, timeout: 5_000 }, // 100 milliseconds, 5 seconds
    )
    .toMatchObject({
      recipient_provider_user_id: Constants.slack.memberUserId,
      sender_member_id: connected.senderMember.id,
      status: 'pending',
    })
  await expectSlackThreadMessage(message.ts, 'Run `@Tipbot connect` to receive it', {
    channelId,
    wait: true,
  })
}, 20_000) // 20 seconds

test('reaction tipping aggregates queued messages for unconnected recipient', async () => {
  await connectTipAccounts({ recipient: false })
  await connectTipAccounts({
    recipient: false,
    senderProviderUserId: Constants.slack.unconnectedUserId,
  })
  const channelId = await createSlackTestChannel('rt')
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'unconnected recipient should receive one queued reaction tip message',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')
  const messageTs = message.ts

  const first = await postSlackReaction({
    channelId,
    messageTs,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })
  const second = await postSlackReaction({
    channelId,
    eventTs: `${messageTs}-reaction-second`,
    messageTs,
    reaction: 'money_with_wings',
    userId: Constants.slack.unconnectedUserId,
  })

  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  await expect
    .poll(
      async () => {
        const history = await slack.conversations.replies({ channel: channelId, ts: messageTs })
        const queuedMessages =
          history.messages?.filter((reply) => reply.text?.includes('Reaction tips')) ?? []
        return (
          history.ok &&
          queuedMessages.length === 1 &&
          Boolean(queuedMessages[0]?.text?.includes('received tips on')) &&
          Boolean(queuedMessages[0]?.text?.includes(':money_with_wings:')) &&
          Boolean(queuedMessages[0]?.text?.includes('queued $0.001')) &&
          queuedMessages[0]!.text!.split('Run `/tip connect` to receive it').length === 2 &&
          Boolean(queuedMessages[0]?.text?.includes(Constants.slack.adminUserId)) &&
          Boolean(queuedMessages[0]?.text?.includes(Constants.slack.memberUserId)) &&
          Boolean(queuedMessages[0]?.text?.includes(Constants.slack.unconnectedUserId))
        )
      },
      { interval: 25, timeout: 5_000 }, // 25 milliseconds, 5 seconds
    )
    .toBe(true)
}, 20_000) // 20 seconds

test('reaction tipping aggregates sent and queued messages together', async () => {
  await connectTipAccounts()
  const channelId = await createSlackTestChannel('rt')
  const parent = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'connected recipient should receive tip',
  })
  if (!parent.ts) throw new Error('Expected Slack parent timestamp.')
  const parentTs = parent.ts
  const reply = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'unconnected recipient should queue tip',
    thread_ts: parentTs,
  })
  if (!reply.ts) throw new Error('Expected Slack reply timestamp.')
  await expectSlackThreadMessage(parentTs, 'unconnected recipient should queue tip', {
    channelId,
    wait: true,
  })

  const sent = await postSlackReaction({
    channelId,
    messageTs: parentTs,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })
  const queued = await postSlackReaction({
    channelId,
    eventTs: `${reply.ts}-reaction`,
    itemUserId: Constants.slack.unconnectedUserId,
    messageTs: reply.ts,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })

  expect(sent.status).toBe(200)
  expect(queued.status).toBe(200)
  await expect
    .poll(
      async () => {
        const history = await slack.conversations.replies({ channel: channelId, ts: parentTs })
        const aggregates =
          history.messages?.filter((message) => message.text?.includes('Reaction tips')) ?? []
        return (
          history.ok &&
          aggregates.length === 1 &&
          Boolean(aggregates[0]?.text?.includes('tipped $0.001')) &&
          Boolean(aggregates[0]?.text?.includes('queued $0.001')) &&
          aggregates[0]!.text!.split('Run `/tip connect` to receive it').length === 2
        )
      },
      { interval: 25, timeout: 5_000 }, // 25 milliseconds, 5 seconds
    )
    .toBe(true)
}, 20_000) // 20 seconds

test('reaction tipping updates queued aggregate when pending tip is claimed', async () => {
  const connected = await connectTipAccounts({ recipient: false })
  const channelId = await createSlackTestChannel('rt')
  const message = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'queued reaction should become sent when recipient connects',
  })
  if (!message.ts) throw new Error('Expected Slack message timestamp.')
  const messageTs = message.ts

  const response = await postSlackReaction({
    channelId,
    messageTs,
    reaction: 'money_with_wings',
    userId: Constants.slack.adminUserId,
  })
  const pending = await expect
    .poll(
      async () =>
        await db
          .selectFrom('pending_tip')
          .selectAll()
          .where('workspace_id', '=', connected.workspace.id)
          .where('recipient_provider_user_id', '=', Constants.slack.memberUserId)
          .executeTakeFirst(),
      { interval: 25, timeout: 5_000 }, // 25 milliseconds, 5 seconds
    )
    .toBeDefined()
    .then(
      async () =>
        await db
          .selectFrom('pending_tip')
          .selectAll()
          .where('workspace_id', '=', connected.workspace.id)
          .where('recipient_provider_user_id', '=', Constants.slack.memberUserId)
          .executeTakeFirstOrThrow(),
    )
  const recipientMember = await db
    .selectFrom('member')
    .select('provider_identity_id')
    .where('id', '=', pending.recipient_member_id)
    .executeTakeFirstOrThrow()

  await db
    .updateTable('provider_identity')
    .set({ account_id: connected.recipientAccount.id, updated_at: new Date().toISOString() })
    .where('id', '=', recipientMember.provider_identity_id)
    .execute()
  const result = await Tip.claimPendingTip(env, { pendingTipId: pending.id })
  if (!result) throw new Error('Expected pending tip claim result.')
  await Chat.updateSlackPendingTipMessage(db, result)

  expect(response.status).toBe(200)
  expect(result).toMatchObject({ ok: true, status: 'sent' })
  await expect
    .poll(
      async () => {
        const history = await slack.conversations.replies({ channel: channelId, ts: messageTs })
        const aggregates =
          history.messages?.filter((reply) => reply.text?.includes('Reaction tips')) ?? []
        return (
          history.ok &&
          aggregates.length === 1 &&
          Boolean(aggregates[0]?.text?.includes('tipped $0.001')) &&
          Boolean(aggregates[0]?.text?.includes('Receipt')) &&
          !aggregates[0]?.text?.includes('queued $0.001') &&
          !aggregates[0]?.text?.includes('Run `/tip connect` to receive it')
        )
      },
      { interval: 25, timeout: 5_000 }, // 25 milliseconds, 5 seconds
    )
    .toBe(true)
}, 20_000) // 20 seconds

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

test('plus reaction boosts a receipt', async () => {
  await connectTipAccounts()

  const tipResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
  const receiptTs = await findSlackMessageTs(
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
  )
  const boostResponse = await postSlackReaction({
    messageTs: receiptTs,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  await expect
    .poll(
      () =>
        db
          .selectFrom('tip_batch')
          .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
          .select([
            'tip_batch.amount_each',
            'tip_batch.idempotency_key',
            'tip_batch.recipient_count',
            'tip_batch.status',
          ])
          .where('workspace.provider_id', '=', providerId)
          .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
          .executeTakeFirst(),
      { timeout: 10_000 }, // 10 seconds
    )
    .toMatchObject({
      amount_each: 1000,
      idempotency_key: expect.stringMatching(/^boost:[^:]/),
      recipient_count: 1,
      status: 'confirmed',
    })
  await expectSlackThreadMessage(receiptTs, `<@${Constants.slack.adminUserId}> boosted`, {
    wait: true,
  })
}, 20_000) // 20 seconds

test('plus reaction boosts an original app mention tip message', async () => {
  await connectTipAccounts()

  const messageTs = `1700000041.${Nanoid.generate().slice(0, 6)}`
  const tipResponse = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })
  const boostResponse = await postSlackReaction({
    itemUserId: Constants.slack.adminUserId,
    messageTs,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  await expect
    .poll(
      () =>
        db
          .selectFrom('tip_batch')
          .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
          .select([
            'tip_batch.amount_each',
            'tip_batch.idempotency_key',
            'tip_batch.recipient_count',
            'tip_batch.status',
          ])
          .where('workspace.provider_id', '=', providerId)
          .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
          .executeTakeFirst(),
      { timeout: 10_000 }, // 10 seconds
    )
    .toMatchObject({
      amount_each: 1000,
      idempotency_key: expect.stringMatching(/^boost:[^:]/),
      recipient_count: 1,
      status: 'confirmed',
    })
  await expectSlackThreadMessage(messageTs, `<@${Constants.slack.adminUserId}> boosted`, {
    wait: true,
  })
}, 20_000) // 20 seconds

test('plus reaction on original app mention reports unconnected sender', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const handleTipBatchRequest = vi.spyOn(Tip, 'handleTipBatchRequest')
  await connectTipAccounts()

  const messageTs = `1700000041.${Nanoid.generate().slice(0, 6)}`
  const tipResponse = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })
  const boostResponse = await postSlackReaction({
    itemUserId: Constants.slack.adminUserId,
    messageTs,
    reaction: '+',
    userId: unconnectedProviderUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  expect(handleTipBatchRequest).not.toHaveBeenCalled()
  await expectSlackPostEphemeralCall(fetchSpy, 'Boost not sent. Connect to Tipbot')
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('plus reaction on original app mention reports insufficient funds', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  await connectTipAccounts()

  const messageTs = `1700000041.${Nanoid.generate().slice(0, 6)}`
  const tipResponse = await postSlackAppMention({
    messageTs,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
  })
  vi.spyOn(Tip, 'handleTipBatchRequest').mockResolvedValue({
    code: 'insufficient_funds',
    ok: false,
  })
  const boostResponse = await postSlackReaction({
    itemUserId: Constants.slack.adminUserId,
    messageTs,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  await expectSlackPostEphemeralCall(
    fetchSpy,
    'Boost not sent. Your wallet has insufficient funds.',
  )
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('receipt boost aggregates threaded receipt boosts', async () => {
  const connected = await connectTipAccounts()
  const secondRecipientAccount = await factory.account.insert({})
  const boosterMember = await insertMember({
    account_id: secondRecipientAccount.id,
    provider_user_id: unconnectedProviderUserId,
    workspace_id: connected.workspace.id,
  })
  const parent = await memberSlack.chat.postMessage({
    channel: Constants.slack.channelId,
    text: 'threaded boost aggregate parent',
  })
  if (!parent.ts) throw new Error('Expected Slack parent message timestamp.')
  const parentTs = parent.ts
  const tipResponse = await postSlackAppMention({
    messageTs: `1700000041.${Nanoid.generate().slice(0, 6)}`,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
    threadTs: parentTs,
  })
  await expectSlackThreadMessage(
    parentTs,
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
    { wait: true },
  )
  const replies = await slack.conversations.replies({
    channel: Constants.slack.channelId,
    ts: parentTs,
  })
  const receiptTs = replies.messages?.find((message) =>
    message.text?.includes(
      `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
    ),
  )?.ts
  if (!receiptTs) throw new Error('Expected Slack receipt message timestamp.')
  const tipBatch = await db
    .selectFrom('tip_batch')
    .selectAll()
    .where('workspace_id', '=', connected.workspace.id)
    .where('idempotency_key', 'like', `mention:${providerId}:%`)
    .executeTakeFirstOrThrow()
  await factory.tip.insert({
    access_key_id: connected.accessKey.id,
    amount: 1000,
    batch_id: tipBatch.id,
    chain_id: connected.workspace.chain_id,
    confirmed_at: new Date().toISOString(),
    idempotency_key: `${tipBatch.idempotency_key}:${unconnectedProviderUserId}`,
    recipient_id: secondRecipientAccount.id,
    recipient_member_id: boosterMember.id,
    sender_id: connected.senderAccount.id,
    sender_member_id: connected.senderMember.id,
    token_address: Tempo.addressLookup.pathUsd,
    workspace_id: connected.workspace.id,
  })
  await factory.tip_batch.insert({
    amount_each: 1000,
    idempotency_key: `${Chat.receiptBoostIdempotencyPrefix.replace(/:$/, '')}:${connected.workspace.id}:${Constants.slack.channelId}:${receiptTs}:${connected.senderMember.id}`,
    provider: 'slack',
    provider_channel_id: Constants.slack.channelId,
    provider_id: providerId,
    provider_thread_id: parentTs,
    recipient_count: 1,
    sender_member_id: connected.senderMember.id,
    source: 'reaction',
    status: 'confirmed',
    token_address: Tempo.addressLookup.pathUsd,
    total_amount: 1000,
    transaction_hash: `0x${'1'.repeat(64)}`,
    workspace_id: connected.workspace.id,
  })
  await factory.tip_batch.insert({
    amount_each: 1000,
    idempotency_key: `${Chat.receiptBoostIdempotencyPrefix.replace(/:$/, '')}:${connected.workspace.id}:${Constants.slack.channelId}:${receiptTs}:${boosterMember.id}`,
    provider: 'slack',
    provider_channel_id: Constants.slack.channelId,
    provider_id: providerId,
    provider_thread_id: parentTs,
    recipient_count: 1,
    sender_member_id: boosterMember.id,
    source: 'reaction',
    status: 'confirmed',
    token_address: Tempo.addressLookup.pathUsd,
    total_amount: 1000,
    transaction_hash: `0x${'2'.repeat(64)}`,
    workspace_id: connected.workspace.id,
  })
  await Chat.updateReceiptBoostAggregate(providerId, {
    channelId: Constants.slack.channelId,
    threadTs: parentTs,
    workspaceId: connected.workspace.id,
  })
  expect(tipResponse.status).toBe(200)
  await expect
    .poll(
      async () => {
        const replies = await slack.conversations.replies({
          channel: Constants.slack.channelId,
          ts: parentTs,
        })
        return (
          replies.messages?.find((message) =>
            message.text?.startsWith('Boosts received in this thread:'),
          )?.text ?? ''
        )
      },
      { timeout: 5_000 }, // 5 seconds
    )
    .toContain(`• <@${unconnectedProviderUserId}> boosted · <`)
  const aggregateReplies = await slack.conversations.replies({
    channel: Constants.slack.channelId,
    ts: parentTs,
  })
  const aggregate = aggregateReplies.messages?.find((message) =>
    message.text?.startsWith('Boosts received in this thread:'),
  )
  if (!aggregate?.ts || !aggregate.text) throw new Error('Expected boost aggregate reply.')
  const ignoredResponse = await postSlackReaction({
    eventTs: `${aggregate.ts}-boost-ignored`,
    messageTs: aggregate.ts,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })
  const boostCount = await db
    .selectFrom('tip_batch')
    .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
    .select(({ fn }) => fn.count<number>('tip_batch.id').as('count'))
    .where('workspace.provider_id', '=', providerId)
    .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
    .executeTakeFirstOrThrow()

  expect(ignoredResponse.status).toBe(200)
  expect(aggregate.text).toContain('Boosts received in this thread:')
  expect(aggregate.text).toContain(
    `<@${Constants.slack.memberUserId}> <@${unconnectedProviderUserId}> received boosts on <slack://channel?team=${providerId}&id=${Constants.slack.channelId}&message=${receiptTs}|this message> $0.001 each:`,
  )
  expect(aggregate.text).toContain(`• <@${Constants.slack.adminUserId}> boosted · <`)
  expect(aggregate.text).toContain(`• <@${unconnectedProviderUserId}> boosted · <`)
  expect(
    aggregateReplies.messages?.filter((message) =>
      message.text?.startsWith('Boosts received in this thread:'),
    ),
  ).toHaveLength(1)
  expect(
    aggregateReplies.messages?.some((message) =>
      message.text?.startsWith(`<@${Constants.slack.adminUserId}> boosted`),
    ),
  ).toBe(false)
  expect(boostCount.count).toBe(2)
}, 20_000) // 20 seconds

test('receipt boost uses backfilled missing receipt row', async () => {
  const originalFetch = globalThis.fetch
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  await connectTipAccounts()

  const tipResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
  const receiptTs = await findSlackMessageTs(
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
  )
  const tipBatch = await db
    .selectFrom('tip_batch')
    .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
    .select(['tip_batch.transaction_hash', 'workspace.chain_id'])
    .where('workspace.provider_id', '=', providerId)
    .where('tip_batch.idempotency_key', 'like', 'command:%')
    .executeTakeFirstOrThrow()
  if (!tipBatch.transaction_hash) throw new Error('Expected original tip transaction hash.')
  const transactionHash = tipBatch.transaction_hash
  await db.deleteFrom('tip_receipt_message').where('message_ts', '=', receiptTs).execute()
  fetchSpy.mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const params = slackFetchBodyParams(init?.body)
    if (url.endsWith('/conversations.replies') && params.get('ts') === receiptTs)
      return Promise.resolve(
        Response.json({
          messages: [
            {
              blocks: [
                {
                  text: {
                    text: `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · <${Tempo.formatTxLink(tipBatch.chain_id, transactionHash)}|Receipt>`,
                    type: 'mrkdwn',
                  },
                  type: 'section',
                },
              ],
              subtype: 'bot_message',
              text: `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
              ts: receiptTs,
            },
          ],
          ok: true,
        }),
      )
    return originalFetch(input, init)
  })
  const boostResponse = await postSlackReaction({
    messageTs: receiptTs,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  await expect
    .poll(
      () =>
        db
          .selectFrom('tip_receipt_message')
          .innerJoin('tip_batch', 'tip_batch.id', 'tip_receipt_message.tip_batch_id')
          .select(['tip_batch.idempotency_key', 'tip_receipt_message.message_ts'])
          .where('tip_receipt_message.message_ts', '=', receiptTs)
          .executeTakeFirst(),
      { timeout: 10_000 }, // 10 seconds
    )
    .toMatchObject({
      idempotency_key: expect.stringMatching(/^command:/),
      message_ts: receiptTs,
    })
  await expect
    .poll(
      () =>
        db
          .selectFrom('tip_batch')
          .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
          .select(['tip_batch.idempotency_key', 'tip_batch.status'])
          .where('workspace.provider_id', '=', providerId)
          .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
          .executeTakeFirst(),
      { timeout: 10_000 }, // 10 seconds
    )
    .toMatchObject({ idempotency_key: expect.stringMatching(/^boost:[^:]/) })
}, 20_000) // 20 seconds

test('receipt boost works for Slack Connect slash command receipt', async () => {
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  await connectTipAccounts({ recipient: false })
  const connectWorkspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  await insertMember({
    account_id: (
      await findOrCreateAccount(
        Account.fromSecp256k1(Constants.tip.recipientRootPrivateKey).address,
      )
    ).id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: connectWorkspace.id,
  })
  const channelId = await getSlackConnectChannelId()

  const tipResponse = await postSlashCommand(`<@${Constants.slackConnect.userId}>`, { channelId })
  const receiptTs = await findSlackMessageTs(
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slackConnect.userId}> $0.001 · Receipt`,
    { channelId },
  )
  const boostResponse = await postSlackReaction({
    authorizations: [
      {
        is_bot: true,
        team_id: Constants.slackConnect.teamId,
        user_id: Constants.slackConnect.teamBotUserId,
      },
      { is_bot: true, team_id: providerId, user_id: Constants.slack.botUserId },
    ],
    channelId,
    messageTs: receiptTs,
    reaction: '+',
    teamId: Constants.slackConnect.teamId,
    userId: Constants.slack.adminUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  await expect
    .poll(
      () =>
        db
          .selectFrom('tip_batch')
          .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
          .select('tip_batch.idempotency_key')
          .where('workspace.provider_id', '=', providerId)
          .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
          .executeTakeFirst(),
      { timeout: 10_000 }, // 10 seconds
    )
    .toMatchObject({ idempotency_key: expect.stringMatching(/^boost:[^:]/) })
}, 20_000) // 20 seconds

test('receipt boost works for Slack Connect threaded Tipbot receipt', async () => {
  await deleteSlackConnectWorkspace()
  await Chat.getSlack().setInstallation(Constants.slackConnect.teamId, {
    botToken: Constants.slackConnect.teamBotToken,
    botUserId: Constants.slackConnect.teamBotUserId,
    teamName: Constants.slackConnect.teamName,
  })
  await connectTipAccounts({ recipient: false })
  const connectWorkspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  await insertMember({
    account_id: (
      await findOrCreateAccount(
        Account.fromSecp256k1(Constants.tip.recipientRootPrivateKey).address,
      )
    ).id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: connectWorkspace.id,
  })
  const channelId = await getSlackConnectChannelId()
  const parent = await memberSlack.chat.postMessage({
    channel: channelId,
    text: 'Slack Connect threaded boost parent',
  })
  if (!parent.ts) throw new Error('Expected Slack parent message timestamp.')
  const messageTs = `1700000040.${Nanoid.generate().slice(0, 6)}`

  const tipResponse = await postSlackAppMention({
    authorizations: [{ is_bot: true, team_id: providerId, user_id: Constants.slack.botUserId }],
    channelId,
    contextTeamId: providerId,
    messageTs,
    teamId: Constants.slackConnect.teamId,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slackConnect.userId}>`,
    threadTs: parent.ts,
  })
  await expectSlackThreadMessage(
    parent.ts,
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slackConnect.userId}> $0.001 · Receipt`,
    { channelId, wait: true },
  )
  const replies = await slack.conversations.replies({ channel: channelId, ts: parent.ts })
  const receiptTs = replies.messages?.find((message) =>
    message.text?.includes(
      `<@${Constants.slack.adminUserId}> tipped <@${Constants.slackConnect.userId}> $0.001 · Receipt`,
    ),
  )?.ts
  if (!receiptTs) throw new Error('Expected Slack receipt message timestamp.')
  const boostResponse = await postSlackReaction({
    authorizations: [
      {
        is_bot: true,
        team_id: Constants.slackConnect.teamId,
        user_id: Constants.slackConnect.teamBotUserId,
      },
      { is_bot: true, team_id: providerId, user_id: Constants.slack.botUserId },
    ],
    channelId,
    messageTs: receiptTs,
    reaction: '+',
    teamId: Constants.slackConnect.teamId,
    userId: Constants.slack.adminUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  await expect
    .poll(
      () =>
        db
          .selectFrom('tip_batch')
          .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
          .select('tip_batch.idempotency_key')
          .where('workspace.provider_id', '=', providerId)
          .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
          .executeTakeFirst(),
      { timeout: 10_000 }, // 10 seconds
    )
    .toMatchObject({ idempotency_key: expect.stringMatching(/^boost:[^:]/) })
}, 20_000) // 20 seconds

test('receipt boost ignores duplicate reaction from same sender', async () => {
  await connectTipAccounts()

  const tipResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
  const receiptTs = await findSlackMessageTs(
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
  )
  const firstResponse = await postSlackReaction({
    eventTs: `${receiptTs}-boost-1`,
    messageTs: receiptTs,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })
  await expect
    .poll(
      () =>
        db
          .selectFrom('tip_batch')
          .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
          .select(({ fn }) => fn.count<number>('tip_batch.id').as('count'))
          .where('workspace.provider_id', '=', providerId)
          .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
          .executeTakeFirst(),
      { timeout: 10_000 }, // 10 seconds
    )
    .toMatchObject({ count: 1 })
  const secondResponse = await postSlackReaction({
    eventTs: `${receiptTs}-boost-2`,
    messageTs: receiptTs,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })
  const boostCount = await db
    .selectFrom('tip_batch')
    .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
    .select(({ fn }) => fn.count<number>('tip_batch.id').as('count'))
    .where('workspace.provider_id', '=', providerId)
    .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
    .executeTakeFirstOrThrow()

  expect(tipResponse.status).toBe(200)
  expect(firstResponse.status).toBe(200)
  expect(secondResponse.status).toBe(200)
  expect(boostCount.count).toBe(1)
}, 20_000) // 20 seconds

test('receipt boost confirms after approval', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const connected = await connectTipAccounts()

  const tipResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
  const receiptTs = await findSlackMessageTs(
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
  )
  await db.deleteFrom('access_key').where('account_id', '=', connected.senderAccount.id).execute()
  const boostResponse = await postSlackReaction({
    messageTs: receiptTs,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })
  const confirmParams = await getSlackPostEphemeralParams(fetchSpy, '/confirm/')
  const token = confirmParams.get('text')?.match(/\/confirm\/(0x[0-9a-f]+\.0x[0-9a-f]+)/i)?.[1]
  if (!token) throw new Error('Expected confirmation token in Slack ephemeral message.')
  const confirmation = await client.api.confirm[':token'].$get({ param: { token } })
  const confirmationJson = await confirmation.json()
  if (!confirmationJson.ok) throw new Error('Expected confirmation metadata.')
  if (!confirmationJson.transactionRequest) throw new Error('Expected transaction request.')
  const provider = Provider.create({
    adapter: dangerous_secp256k1({ privateKey: Constants.tip.senderRootPrivateKey }),
    chains: [
      {
        ...Tempo.getChain(confirmationJson.chainId),
        rpcUrls: { default: { http: [env.RPC_URL_TESTNET!] } },
      },
    ],
    transports: { [confirmationJson.chainId]: http(env.RPC_URL_TESTNET) },
  })
  await provider.request({
    method: 'wallet_connect',
    params: [{ capabilities: { method: 'register' } }],
  })
  const signedTransaction = await provider.request({
    method: 'eth_signTransaction',
    params: [
      { ...confirmationJson.transactionRequest, chainId: toHex(confirmationJson.chainId) } as never,
    ],
  })
  const confirmResponse = await client.api.confirm[':token'].$post({
    json: { address: connected.senderAccount.address, signedTransaction },
    param: { token },
  })
  await drainWaitUntil()

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  expect(confirmation.status).toBe(200)
  expect(confirmationJson).toMatchObject({ kind: 'onetime_payment' })
  expect(confirmResponse.status).toBe(200)
  await expect(confirmResponse.json()).resolves.toMatchObject({ ok: true })
  await expect
    .poll(
      () =>
        db
          .selectFrom('tip_batch')
          .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
          .select(['tip_batch.idempotency_key', 'tip_batch.status'])
          .where('workspace.provider_id', '=', providerId)
          .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
          .executeTakeFirst(),
      { timeout: 10_000 }, // 10 seconds
    )
    .toMatchObject({ idempotency_key: expect.stringMatching(/^boost:[^:]/), status: 'confirmed' })
  await expectSlackThreadMessage(receiptTs, `<@${Constants.slack.adminUserId}> boosted`, {
    wait: true,
  })
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('threaded receipt boost confirms into aggregate after approval', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const connected = await connectTipAccounts()
  const parent = await memberSlack.chat.postMessage({
    channel: Constants.slack.channelId,
    text: 'threaded approval boost parent',
  })
  if (!parent.ts) throw new Error('Expected Slack parent message timestamp.')
  const parentTs = parent.ts
  const tipResponse = await postSlackAppMention({
    messageTs: `1700000042.${Nanoid.generate().slice(0, 6)}`,
    text: `<@${Constants.slack.botUserId}> <@${Constants.slack.memberUserId}>`,
    threadTs: parentTs,
  })
  await expectSlackThreadMessage(
    parentTs,
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
    { wait: true },
  )
  const replies = await slack.conversations.replies({
    channel: Constants.slack.channelId,
    ts: parentTs,
  })
  const receiptTs = replies.messages?.find((message) =>
    message.text?.includes(
      `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
    ),
  )?.ts
  if (!receiptTs) throw new Error('Expected Slack receipt message timestamp.')
  await db.deleteFrom('access_key').where('account_id', '=', connected.senderAccount.id).execute()

  const boostResponse = await postSlackReaction({
    messageTs: receiptTs,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })
  const confirmParams = await getSlackPostEphemeralParams(fetchSpy, '/confirm/')
  const token = confirmParams.get('text')?.match(/\/confirm\/(0x[0-9a-f]+\.0x[0-9a-f]+)/i)?.[1]
  if (!token) throw new Error('Expected confirmation token in Slack ephemeral message.')
  const confirmation = await client.api.confirm[':token'].$get({ param: { token } })
  const confirmationJson = await confirmation.json()
  if (!confirmationJson.ok) throw new Error('Expected confirmation metadata.')
  if (!confirmationJson.transactionRequest) throw new Error('Expected transaction request.')
  await expectSlackThreadMessageNotContaining(parentTs, 'Boosts received in this thread:')

  const provider = Provider.create({
    adapter: dangerous_secp256k1({ privateKey: Constants.tip.senderRootPrivateKey }),
    chains: [
      {
        ...Tempo.getChain(confirmationJson.chainId),
        rpcUrls: { default: { http: [env.RPC_URL_TESTNET!] } },
      },
    ],
    transports: { [confirmationJson.chainId]: http(env.RPC_URL_TESTNET) },
  })
  await provider.request({
    method: 'wallet_connect',
    params: [{ capabilities: { method: 'register' } }],
  })
  const signedTransaction = await provider.request({
    method: 'eth_signTransaction',
    params: [
      { ...confirmationJson.transactionRequest, chainId: toHex(confirmationJson.chainId) } as never,
    ],
  })
  const confirmResponse = await client.api.confirm[':token'].$post({
    json: { address: connected.senderAccount.address, signedTransaction },
    param: { token },
  })
  await drainWaitUntil()

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  expect(confirmation.status).toBe(200)
  expect(confirmationJson).toMatchObject({ kind: 'onetime_payment' })
  expect(confirmResponse.status).toBe(200)
  await expect(confirmResponse.json()).resolves.toMatchObject({ ok: true })
  await expectSlackThreadMessage(parentTs, 'Boosts received in this thread:', { wait: true })
  await expectSlackThreadMessage(
    parentTs,
    `<@${Constants.slack.memberUserId}> received a boost on <slack://channel?team=${providerId}&id=${Constants.slack.channelId}&message=${receiptTs}|this message> $0.001:`,
  )
  await expectSlackThreadMessage(parentTs, `• <@${Constants.slack.adminUserId}> boosted · <`)
  await expectSlackThreadMessageNotContaining(
    parentTs,
    `<@${Constants.slack.adminUserId}> boosted · Receipt`,
  )
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('receipt boost reports unconnected sender', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const handleTipBatchRequest = vi.spyOn(Tip, 'handleTipBatchRequest')
  await connectTipAccounts()

  const tipResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
  const receiptTs = await findSlackMessageTs(
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
  )
  const boostResponse = await postSlackReaction({
    messageTs: receiptTs,
    reaction: '+',
    userId: unconnectedProviderUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  expect(handleTipBatchRequest).not.toHaveBeenCalled()
  await expectSlackPostEphemeralCall(fetchSpy, 'Boost not sent. Connect to Tipbot')
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('receipt boost reports self-only original recipients', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const handleTipBatchRequest = vi.spyOn(Tip, 'handleTipBatchRequest')
  await connectTipAccounts()

  const tipResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
  const receiptTs = await findSlackMessageTs(
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
  )
  const boostResponse = await postSlackReaction({
    messageTs: receiptTs,
    reaction: '+',
    userId: Constants.slack.memberUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  expect(handleTipBatchRequest).not.toHaveBeenCalled()
  await expectSlackPostEphemeralCall(
    fetchSpy,
    'Boost not sent. None of the original recipients can receive this payment now.',
  )
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('receipt boost reports disconnected original recipients', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const handleTipBatchRequest = vi.spyOn(Tip, 'handleTipBatchRequest')
  const connected = await connectTipAccounts()
  if (!connected.recipientMember) throw new Error('Expected connected recipient.')

  const tipResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
  const receiptTs = await findSlackMessageTs(
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
  )
  await db
    .updateTable('provider_identity')
    .set({ account_id: null })
    .where('id', '=', connected.recipientMember.provider_identity_id)
    .execute()
  const boostResponse = await postSlackReaction({
    messageTs: receiptTs,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  expect(handleTipBatchRequest).not.toHaveBeenCalled()
  await expectSlackPostEphemeralCall(
    fetchSpy,
    'Boost not sent. None of the original recipients can receive this payment now.',
  )
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('receipt boost reports insufficient funds', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  await connectTipAccounts()

  const tipResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
  const receiptTs = await findSlackMessageTs(
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
  )
  vi.spyOn(Tip, 'handleTipBatchRequest').mockResolvedValue({
    code: 'insufficient_funds',
    ok: false,
  })
  const boostResponse = await postSlackReaction({
    messageTs: receiptTs,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  await expectSlackPostEphemeralCall(
    fetchSpy,
    'Boost not sent. Your wallet has insufficient funds.',
  )
  fetchSpy.mockRestore()
}, 20_000) // 20 seconds

test('receipt boost sends from a different connected Slack account', async () => {
  const connected = await connectTipAccounts()
  const boosterMember = await insertMember({
    account_id: connected.senderAccount.id,
    provider_user_id: unconnectedProviderUserId,
    workspace_id: connected.workspace.id,
  })

  const tipResponse = await postSlashCommand(`<@${Constants.slack.memberUserId}>`)
  const receiptTs = await findSlackMessageTs(
    `<@${Constants.slack.adminUserId}> tipped <@${Constants.slack.memberUserId}> $0.001 · Receipt`,
  )
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
  const boostResponse = await postSlackReaction({
    messageTs: receiptTs,
    reaction: '+',
    userId: unconnectedProviderUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  await expect
    .poll(
      () =>
        db
          .selectFrom('tip_batch')
          .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
          .select(['tip_batch.failure_reason', 'tip_batch.sender_member_id', 'tip_batch.status'])
          .where('workspace.provider_id', '=', providerId)
          .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
          .executeTakeFirst(),
      { timeout: 10_000 }, // 10 seconds
    )
    .toMatchObject({ sender_member_id: boosterMember.id, status: 'confirmed' })
}, 20_000) // 20 seconds

test('receipt boost skips original recipients that disconnected', async () => {
  const connected = await connectTipAccounts()
  const secondRecipientAccount = await findOrCreateAccount(
    Account.fromSecp256k1('0x2222222222222222222222222222222222222222222222222222222222222222')
      .address,
  )
  const secondRecipient = await insertMember({
    account_id: secondRecipientAccount.id,
    provider_user_id: unconnectedProviderUserId,
    workspace_id: connected.workspace.id,
  })

  const tipResponse = await postSlashCommand(
    `<@${Constants.slack.memberUserId}> <@${unconnectedProviderUserId}>`,
  )
  const receiptTs = await findSlackMessageTs(
    `<@${Constants.slack.memberUserId}> <@${unconnectedProviderUserId}> $0.001 each · Receipt`,
  )
  await db
    .updateTable('provider_identity')
    .set({ account_id: null })
    .where('id', '=', secondRecipient.provider_identity_id)
    .execute()
  const boostResponse = await postSlackReaction({
    messageTs: receiptTs,
    reaction: '+',
    userId: Constants.slack.adminUserId,
  })

  expect(tipResponse.status).toBe(200)
  expect(boostResponse.status).toBe(200)
  await expect
    .poll(
      () =>
        db
          .selectFrom('tip_batch')
          .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
          .select('tip_batch.recipient_count')
          .where('workspace.provider_id', '=', providerId)
          .where('tip_batch.idempotency_key', 'like', `${Chat.receiptBoostIdempotencyPrefix}%`)
          .executeTakeFirst(),
      { timeout: 10_000 }, // 10 seconds
    )
    .toMatchObject({ recipient_count: 1 })
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
    await expectSlackMessage('Reaction tips')
    await expectSlackMessage(':money_with_wings: `:money_with_wings:` → 0.001')
    await expectSlackMessage(':dollar: `:dollar:` → 0.01')
    await expectSlackMessage(':moneybag: `:moneybag:` → 0.1')
    await expectSlackPostEphemeralCall(fetchSpy, '"style":{"code":true}')
    await expectSlackPostEphemeralCall(fetchSpy, '"text":":money_with_wings:"')
    await expectSlackPostEphemeralCall(fetchSpy, '"text":":dollar:"')
    await expectSlackPostEphemeralCall(fetchSpy, '"text":":moneybag:"')
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
            const view = (await slackFetchCallBodyParams(...call)).get('view')
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
    const reactionTipConfigs = await db
      .selectFrom('reaction_tip_config')
      .select(['amount', 'emoji'])
      .where('workspace_id', '=', workspace.id)
      .orderBy('amount', 'asc')
      .execute()

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(workspace.chain_id).toBe(Tempo.chainLookup.testnet)
    expect(workspace.default_amount).toBe(2000)
    expect(workspace.default_token_address).toBe(Tempo.addressLookup.betaUsd)
    expect(reactionTipConfigs).toEqual(
      Tip.defaultReactionTipConfigs.map((config) => ({
        amount: config.amount,
        emoji: config.emoji,
      })),
    )
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
    await insertMember({
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

  test('rejects unknown reaction tip emoji', async () => {
    const fetchOriginal = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/emoji.list'))
        return Promise.resolve(Response.json({ emoji: {}, ok: true }))
      return fetchOriginal(input, init)
    })

    const response = await postSlackInteraction(
      createViewSubmissionPayload({
        amount: '0.001',
        network: 'testnet',
        reactionTips: ':not_real_tipbot_emoji: 0.001',
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
      errors: { reaction_tip_configs: 'Choose emojis that exist in this Slack workspace.' },
      response_action: 'errors',
    })
    expect(workspace.provider_id).toBe(providerId)
    fetchSpy.mockRestore()
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

  test('creates one-time account link from direct message', async () => {
    const dm = setupSlackDMPostMessageFetchSpy()

    const response = await postSlashCommand('connect', { channelId: dm.channelId })
    const link = await db
      .selectFrom('account_link_token')
      .selectAll('account_link_token')
      .innerJoin('member', 'member.id', 'account_link_token.member_id')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .where('member.provider_user_id', '=', Constants.slack.adminUserId)
      .where('workspace.provider_id', '=', providerId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(200)
    expect(link).toEqual(expect.schemaMatching(Schema.account_link_token))
    await expectSlackPostMessageCall(dm.fetchSpy, dm.channelId, 'Link expires in 10 minutes.')
    dm.fetchSpy.mockRestore()
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
    const member = await insertMember({
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
    await insertMember({
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
    await insertMember({
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
    const member = await insertMember({
      account_id: account.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    const accessKey = await factory.access_key.insert({ account_id: account.id })

    const response = await postSlashCommand('disconnect')
    const updatedMember = await db
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .select('provider_identity.account_id')
      .where('member.id', '=', member.id)
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

  test('disconnects a connected account from direct message', async () => {
    const dm = setupSlackDMPostMessageFetchSpy()
    const account = await factory.account.insert({})
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    const member = await insertMember({
      account_id: account.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    const accessKey = await factory.access_key.insert({ account_id: account.id })

    const response = await postSlashCommand('disconnect', { channelId: dm.channelId })
    const updatedMember = await db
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .select('provider_identity.account_id')
      .where('member.id', '=', member.id)
      .executeTakeFirstOrThrow()
    const accessKeys = await db
      .selectFrom('access_key')
      .selectAll()
      .where('id', '=', accessKey.id)
      .execute()

    expect(response.status).toBe(200)
    await expectSlackPostMessageCall(dm.fetchSpy, dm.channelId, 'Disconnected')
    expect(updatedMember.account_id).toBe(null)
    expect(accessKeys).toEqual([])
    dm.fetchSpy.mockRestore()
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
    await expectSlackMessageNotContaining('/tip airdrop')
    await expectSlackMessage('/tip @account for coffee')
    await expectSlackMessage('/tip @account 0.005')
    await expectSlackMessage('/tip @account 0.005 for coffee')
    await expectSlackMessage('/tip @account 0.005 USDC')
    await expectSlackMessage('/tip @account 0.005 USDC for coffee')
    await expectSlackMessage('@Tipbot @account')
    await expectSlackMessageNotContaining('@Tipbot airdrop')
    await expectSlackMessage('@Tipbot @account for coffee')
    await expectSlackMessage('@Tipbot @account 0.005 for coffee')
    await expectSlackMessage(':money_with_wings: / :dollar: / :moneybag:')
    await expectSlackMessage('Send by reacting to a message')
    await expectSlackMessageNotContaining('Payment examples')
    await expectSlackMessage('/tip config')
    await expectSlackMessage('/tip connect')
    await expectSlackMessage('/tip disconnect')
    await expectSlackMessage('/tip help')
    await expectSlackMessage('/tip leaderboard')
    await expectSlackMessage('/tip stats')
    await expectSlackMessage('/tip status')
  })

  test('shows help from direct message', async () => {
    const dm = setupSlackDMPostMessageFetchSpy()

    const response = await postSlashCommand('help', { channelId: dm.channelId })

    expect(response.status).toBe(200)
    await expectSlackPostMessageCall(
      dm.fetchSpy,
      dm.channelId,
      '/tip @account [amount] [token] [for memo]',
    )
    dm.fetchSpy.mockRestore()
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
    const adminMember = await insertMember({
      account_id: adminAccount.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    const memberMember = await insertMember({
      account_id: memberAccount.id,
      provider_user_id: Constants.slack.memberUserId,
      workspace_id: workspace.id,
    })
    const thirdMember = await insertMember({
      account_id: thirdAccount.id,
      provider_user_id: 'U000000003',
      workspace_id: workspace.id,
    })
    const otherMember = await insertMember({
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
        workspace_id: workspace.id,
      },
      {
        confirmed_at: now,
        recipient_id: memberAccount.id,
        recipient_member_id: memberMember.id,
        sender_id: adminAccount.id,
        sender_member_id: adminMember.id,
        workspace_id: workspace.id,
      },
      {
        confirmed_at: now,
        recipient_id: memberAccount.id,
        recipient_member_id: memberMember.id,
        sender_id: thirdAccount.id,
        sender_member_id: thirdMember.id,
        workspace_id: workspace.id,
      },
      {
        confirmed_at: now,
        recipient_id: adminAccount.id,
        recipient_member_id: adminMember.id,
        sender_id: memberAccount.id,
        sender_member_id: memberMember.id,
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
    const adminMember = await insertMember({
      account_id: adminAccount.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })
    const memberMember = await insertMember({
      account_id: memberAccount.id,
      provider_user_id: Constants.slack.memberUserId,
      workspace_id: workspace.id,
    })
    const thirdMember = await insertMember({
      account_id: thirdAccount.id,
      provider_user_id: 'U000000003',
      workspace_id: workspace.id,
    })
    const otherMember = await insertMember({
      account_id: thirdAccount.id,
      provider_user_id: 'U000000004',
      workspace_id: otherWorkspace.id,
    })
    const now = new Date().toISOString()
    const tips = [
      {
        amount: 1000,
        confirmed_at: now,
        recipient_id: memberAccount.id,
        recipient_member_id: memberMember.id,
        sender_id: adminAccount.id,
        sender_member_id: adminMember.id,
        workspace_id: workspace.id,
      },
      {
        amount: 2000,
        confirmed_at: now,
        recipient_id: memberAccount.id,
        recipient_member_id: memberMember.id,
        sender_id: adminAccount.id,
        sender_member_id: adminMember.id,
        workspace_id: workspace.id,
      },
      {
        amount: 500,
        confirmed_at: now,
        recipient_id: thirdAccount.id,
        recipient_member_id: thirdMember.id,
        sender_id: adminAccount.id,
        sender_member_id: adminMember.id,
        workspace_id: workspace.id,
      },
      {
        amount: 7000,
        confirmed_at: now,
        recipient_id: adminAccount.id,
        recipient_member_id: adminMember.id,
        sender_id: memberAccount.id,
        sender_member_id: memberMember.id,
        workspace_id: workspace.id,
      },
      {
        amount: 1000,
        confirmed_at: now,
        recipient_id: adminAccount.id,
        recipient_member_id: adminMember.id,
        sender_id: thirdAccount.id,
        sender_member_id: thirdMember.id,
        workspace_id: workspace.id,
      },
      {
        amount: 8000,
        confirmed_at: now,
        recipient_id: adminAccount.id,
        recipient_member_id: adminMember.id,
        sender_id: thirdAccount.id,
        sender_member_id: otherMember.id,
        workspace_id: otherWorkspace.id,
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
        workspace_id: otherWorkspace.id,
      },
    ]
    for (const tip of tips) await factory.tip.insert(tip)

    const response = await postSlashCommand('stats')

    expect(response.status).toBe(200)
    await expectSlackMessage('Your tip stats')
    await expectSlackMessage('Received $0.016 (3 tips)')
    await expectSlackMessage('Tipped $0.0035 (3 tips)')
    await expectSlackMessage(`Most tipped <@${Constants.slack.memberUserId}> $0.003 (2 tips)`)
    await expectSlackMessage('Most tipped by <@U000000004> $0.008 (1 tip)')
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

  test('shows zero stats from direct message', async () => {
    const dm = setupSlackDMPostMessageFetchSpy()

    const response = await postSlashCommand('stats', { channelId: dm.channelId })

    expect(response.status).toBe(200)
    await expectSlackPostMessageCall(dm.fetchSpy, dm.channelId, 'Your tip stats')
    await expectSlackPostMessageCall(dm.fetchSpy, dm.channelId, 'Received $0.00 (0 tips)')
    await expectSlackPostMessageCall(dm.fetchSpy, dm.channelId, 'Most tipped None')
    dm.fetchSpy.mockRestore()
  })
})

describe('/tip balance', () => {
  test('shows token balances for connected account', async () => {
    await connectTipAccounts()

    const response = await postSlashCommand('balance')

    expect(response.status).toBe(200)
    await expectSlackMessage('Wallet 0x')
    await expectSlackMessage('View on explorer:')
  }, 20_000) // 20 seconds

  test('handles no connected account', async () => {
    const response = await postSlashCommand('balance')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'No account connected. Run `<@Tipbot> connect` or `/tip connect` first.',
    )
  })

  test('handles missing workspace', async () => {
    await db.deleteFrom('workspace').where('provider_id', '=', providerId).execute()

    const response = await postSlashCommand('balance')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Tipbot not configured for this workspace. Reinstall Tipbot and try again.',
    )
  })

  test('shows no balances message when all balances are zero', async () => {
    const account = await factory.account.insert({})
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    await insertMember({
      account_id: account.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })

    const response = await postSlashCommand('balance')

    expect(response.status).toBe(200)
    await expectSlackMessage('has no balances')
    await expectSlackMessage('View on explorer:')
  }, 20_000) // 20 seconds

  test('rejects extra text', async () => {
    const response = await postSlashCommand('balance extra')

    expect(response.status).toBe(200)
    await expectSlackMessage(
      'Invalid `/tip` usage. Try `/tip @account` or `/tip help` for more info.',
    )
  })

  test('shows balance from direct message', async () => {
    const dm = setupSlackDMPostMessageFetchSpy()
    const account = await factory.account.insert({})
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    await insertMember({
      account_id: account.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })

    const response = await postSlashCommand('balance', { channelId: dm.channelId })

    expect(response.status).toBe(200)
    await expectSlackPostMessageCall(dm.fetchSpy, dm.channelId, 'Wallet')
    dm.fetchSpy.mockRestore()
  }, 20_000) // 20 seconds
})

describe('/tip status', () => {
  test('shows current connected account', async () => {
    const account = await factory.account.insert({})
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    await insertMember({
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

  test('shows current connected account from direct message', async () => {
    const dm = setupSlackDMPostMessageFetchSpy()
    const account = await factory.account.insert({})
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
    await insertMember({
      account_id: account.id,
      provider_user_id: Constants.slack.adminUserId,
      workspace_id: workspace.id,
    })

    const response = await postSlashCommand('status', { channelId: dm.channelId })

    expect(response.status).toBe(200)
    await expectSlackPostMessageCall(
      dm.fetchSpy,
      dm.channelId,
      `Connected as \`${account.address}\``,
    )
    dm.fetchSpy.mockRestore()
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

  test('shows usage from direct message', async () => {
    const dm = setupSlackDMPostMessageFetchSpy()

    const response = await postSlashCommand('hello', { channelId: dm.channelId })

    expect(response.status).toBe(200)
    await expectSlackPostMessageCall(
      dm.fetchSpy,
      dm.channelId,
      'Invalid `/tip` usage. Try `/tip @account` or `/tip help` for more info.',
    )
    dm.fetchSpy.mockRestore()
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
  options: {
    memoScope?: boolean
    recipient?: boolean
    senderProviderUserId?: string
    tokenAddress?: `0x${string}`
  } = {},
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
  const senderMember = await insertMember({
    account_id: senderAccount.id,
    provider_user_id: options.senderProviderUserId ?? Constants.slack.adminUserId,
    workspace_id: workspace.id,
  })
  const recipientMember =
    (options.recipient ?? true)
      ? await insertMember({
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

async function insertReusableAccessKey(input: {
  accountId: string
  root: Account.Account
  tokenAddress?: `0x${string}`
}) {
  const accessKey = AccessKey.generate()
  const accessKeyExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
  const tokenAddress = input.tokenAddress ?? Tempo.addressLookup.pathUsd
  await db.deleteFrom('access_key').where('account_id', '=', input.accountId).execute()
  return await factory.access_key.insert({
    account_id: input.accountId,
    address: accessKey.address,
    authorization: JSON.stringify(
      await AccountLink.signKeyAuthorization(input.root, {
        accessKeyAddress: accessKey.address,
        chainId: Tempo.chainLookup.localnet,
        expiresAt: accessKeyExpiresAt,
        tokenAddress,
      }),
    ),
    chain_id: Tempo.chainLookup.localnet,
    ciphertext: await AccessKey.encrypt(env, accessKey.privateKey),
    expires_at: accessKeyExpiresAt,
    token_address: tokenAddress,
  })
}

async function connectSlackConnectSender() {
  const hostWorkspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider_id', '=', providerId)
    .executeTakeFirstOrThrow()
  const senderRoot = Account.fromSecp256k1(Constants.tip.senderRootPrivateKey)
  const recipientRoot = Account.fromSecp256k1(Constants.tip.recipientRootPrivateKey)
  const accessKey = AccessKey.generate()
  const accessKeyExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
  const senderAccount = await findOrCreateAccount(senderRoot.address)
  const recipientAccount = await findOrCreateAccount(recipientRoot.address)
  const senderWorkspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    installed_at: null,
    name: Constants.slackConnect.teamName,
    provider_id: Constants.slackConnect.teamId,
  })
  const senderMember = await insertMember({
    account_id: senderAccount.id,
    provider_user_id: Constants.slackConnect.userId,
    workspace_id: senderWorkspace.id,
  })
  const hostRecipientMember = await insertMember({
    account_id: recipientAccount.id,
    provider_user_id: Constants.slack.memberUserId,
    workspace_id: hostWorkspace.id,
  })
  await db.deleteFrom('access_key').where('account_id', '=', senderAccount.id).execute()
  await factory.access_key.insert({
    account_id: senderAccount.id,
    address: accessKey.address,
    authorization: JSON.stringify(
      await AccountLink.signKeyAuthorization(senderRoot, {
        accessKeyAddress: accessKey.address,
        chainId: Tempo.chainLookup.localnet,
        expiresAt: accessKeyExpiresAt,
        tokenAddress: Tempo.addressLookup.pathUsd,
      }),
    ),
    chain_id: Tempo.chainLookup.localnet,
    ciphertext: await AccessKey.encrypt(env, accessKey.privateKey),
    expires_at: accessKeyExpiresAt,
    token_address: Tempo.addressLookup.pathUsd,
  })
  return { hostRecipientMember, hostWorkspace, senderAccount, senderMember, senderWorkspace }
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

async function waitForTipByIdempotencyKey(idempotencyKey: string) {
  const intervalMs = 100 // 100 milliseconds
  const timeoutMs = 5_000 // 5 seconds
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const tip = await db
      .selectFrom('tip')
      .select(['id', 'recipient_member_id', 'sender_member_id', 'workspace_id'])
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst()
    if (tip) return tip
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  const rows = await db
    .selectFrom('member')
    .leftJoin('workspace', 'workspace.id', 'member.workspace_id')
    .leftJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .select([
      'member.provider_identity_id',
      'member.provider_user_id',
      'workspace.provider_id as workspace_provider_id',
      'provider_identity.account_id as identity_account_id',
    ])
    .where('workspace.provider', '=', 'slack')
    .execute()
  throw new Error(
    `Expected tip ${idempotencyKey}: ${JSON.stringify({
      members: rows,
    })}`,
  )
}

async function getSlackConnectChannelId() {
  try {
    const info = await slack.conversations.info({ channel: Constants.slackConnect.channelId })
    if (info.channel?.id) return info.channel.id
  } catch {}

  const list = await slack.conversations.list()
  const channel = list.channels?.find(
    (channel) => channel.name === Constants.slackConnect.channelName,
  )
  if (channel?.id) return channel.id

  throw new Error(`Expected Slack Connect channel ${Constants.slackConnect.channelName}.`)
}

async function expectSlackConnectEmulator(channelId: string) {
  const conversation = await slack.conversations.info({ channel: channelId })
  const connectSlack = new WebClient(Constants.slackConnect.teamBotToken, {
    slackApiUrl: env.SLACK_API_URL,
  })
  const connectUser = await connectSlack.users.info({ user: Constants.slackConnect.userId })

  expect(conversation).toMatchObject({
    channel: {
      context_team_id: Constants.slack.teamId,
      id: channelId,
      is_ext_shared: true,
      is_shared: true,
      shared_team_ids: expect.arrayContaining([Constants.slackConnect.teamId]),
    },
    ok: true,
  })
  expect(connectUser).toMatchObject({
    ok: true,
    user: { id: Constants.slackConnect.userId, team_id: Constants.slackConnect.teamId },
  })
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
  options: { channelId?: string; wait?: boolean } = {},
) {
  if (options.wait) {
    await expect
      .poll(
        async () => {
          const history = await slack.conversations.replies({
            channel: options.channelId ?? Constants.slack.channelId,
            ts: messageTs,
          })
          return Boolean(
            history.ok && history.messages?.some((message) => message.text?.includes(text)),
          )
        },
        { interval: 25, timeout: 5_000 }, // 25 milliseconds, 5 seconds
      )
      .toBe(true)
    return
  }

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
      async () => {
        for (const call of fetchSpy.mock.calls) {
          const input = call[0]
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const params = await slackFetchCallBodyParams(...call)
          const callText = `${params.get('text') ?? ''} ${params.get('blocks') ?? ''}`
          if (url.endsWith('/chat.postEphemeral') && callText.includes(text)) return true
        }
        return false
      },
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

async function getSlackPostEphemeralCall(
  fetchSpy: { mock: { calls: Parameters<typeof fetch>[] } },
  text: string,
): Promise<Parameters<typeof fetch>> {
  let found: Parameters<typeof fetch> | null = null
  await expect
    .poll(
      async () => {
        for (const call of fetchSpy.mock.calls) {
          const input = call[0]
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const params = await slackFetchCallBodyParams(...call)
          const callText = `${params.get('text') ?? ''} ${params.get('blocks') ?? ''}`
          if (url.endsWith('/chat.postEphemeral') && callText.includes(text)) {
            found = call
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
            const params = slackFetchBodyParams(call[1]?.body)
            return `${url} ${params.get('text') ?? ''} ${params.get('blocks') ?? ''}`
          })
          .join('\n'),
        timeout: 10_000, // 10 seconds
      },
    )
    .toBe(true)
  if (!found) throw new Error(`Expected Slack ephemeral call containing ${text}.`)
  return found
}

async function getSlackPostEphemeralParams(
  fetchSpy: { mock: { calls: Parameters<typeof fetch>[] } },
  text: string,
): Promise<URLSearchParams> {
  let found: URLSearchParams | null = null
  await expect
    .poll(
      async () => {
        for (const call of fetchSpy.mock.calls) {
          const input = call[0]
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const params = await slackFetchCallBodyParams(...call)
          const callText = `${params.get('text') ?? ''} ${params.get('blocks') ?? ''}`
          if (url.endsWith('/chat.postEphemeral') && callText.includes(text)) {
            found = params
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
            const params = slackFetchBodyParams(call[1]?.body)
            return `${url} ${params.get('text') ?? ''} ${params.get('blocks') ?? ''}`
          })
          .join('\n'),
        timeout: 10_000, // 10 seconds
      },
    )
    .toBe(true)
  if (!found) throw new Error(`Expected Slack ephemeral call containing ${text}.`)
  return found as URLSearchParams
}

function getSlackFetchAuthorization(call: Parameters<typeof fetch>) {
  const inputHeaders = call[0] instanceof Request ? call[0].headers : undefined
  const headers = new Headers(call[1]?.headers ?? inputHeaders)
  return headers.get('authorization')
}

async function expectSlackPostMessageCall(
  fetchSpy: { mock: { calls: Parameters<typeof fetch>[] } },
  channelId: string,
  text: string,
) {
  await expect
    .poll(
      async () => {
        for (const call of fetchSpy.mock.calls) {
          const input = call[0]
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const params = await slackFetchCallBodyParams(...call)
          const callText = `${params.get('text') ?? ''} ${params.get('blocks') ?? ''}`
          if (
            url.endsWith('/chat.postMessage') &&
            params.get('channel') === channelId &&
            callText.includes(text)
          )
            return true
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
          const params = await slackFetchCallBodyParams(...call)
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

async function slackFetchCallBodyParams(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) {
  const initParams = slackFetchBodyParams(init?.body)
  if ([...initParams].length > 0) return initParams

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

function setupSlackDMPostMessageFetchSpy() {
  const channelId = 'D000000001'
  const originalFetch = globalThis.fetch
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  fetchSpy.mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/chat.postMessage'))
      return Promise.resolve(Response.json({ ok: true, ts: '123.456' }))
    return originalFetch(input, init)
  })
  return { channelId, fetchSpy }
}

async function findSlackMessageTs(text: string, options: { channelId?: string } = {}) {
  const history = await slack.conversations.history({
    channel: options.channelId ?? Constants.slack.channelId,
  })
  const message = history.messages?.find((message) => message.text?.includes(text))

  expect(history.ok).toBe(true)
  if (!message?.ts) throw new Error(`Expected Slack message containing ${text}.`)
  return message.ts
}

async function expectSlackMessageNotContaining(text: string, options: { channelId?: string } = {}) {
  const history = await slack.conversations.history({
    channel: options.channelId ?? Constants.slack.channelId,
  })

  expect(history.ok).toBe(true)
  expect(history.messages?.some((message) => message.text?.includes(text))).toBe(false)
}

async function expectNoSlackMessages() {
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })

  expect(history).toMatchObject({ messages: [], ok: true })
}

async function getLatestConfirmToken() {
  const history = await slack.conversations.history({ channel: Constants.slack.channelId })
  const message = history.messages?.find((message) => message.text?.includes('/confirm/'))
  const token = message?.text?.match(/\/confirm\/(0x[0-9a-f]+\.0x[0-9a-f]+)/i)?.[1]
  if (!token) throw new Error('Expected confirmation token in Slack message.')
  return token
}

async function getLatestConnectToken(options: { channelId?: string; threadTs?: string } = {}) {
  const history = options.threadTs
    ? await slack.conversations.replies({
        channel: options.channelId ?? Constants.slack.channelId,
        ts: options.threadTs,
      })
    : await slack.conversations.history({ channel: options.channelId ?? Constants.slack.channelId })
  const message = history.messages?.find((message) => message.text?.includes('/connect/'))
  const token = message?.text?.match(/\/connect\/([A-Za-z0-9_-]+)/)?.[1]
  if (!token) throw new Error('Expected connection token in Slack message.')
  return token
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
  await drainWaitUntil()
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
  await drainWaitUntil()
  return response
}

async function postSlackAppMention(options: {
  authorizations?: Array<{
    is_bot?: boolean
    team_id?: string
    user_id?: string
  }>
  channelId?: string
  contextTeamId?: string
  eventId?: string
  files?: Array<{
    filetype?: string
    id?: string
    mimetype?: string
    name?: string
    title?: string
  }>
  messageTs: string
  subtype?: string
  teamId?: string
  text: string
  threadTs?: string
  userId?: string
}) {
  const body = JSON.stringify({
    ...(options.authorizations ? { authorizations: options.authorizations } : {}),
    ...(options.contextTeamId ? { context_team_id: options.contextTeamId } : {}),
    event: {
      channel: options.channelId ?? Constants.slack.channelId,
      channel_type: 'channel',
      ...(options.contextTeamId ? { context_team_id: options.contextTeamId } : {}),
      event_ts: options.messageTs,
      ...(options.files ? { files: options.files } : {}),
      ...(options.subtype ? { subtype: options.subtype } : {}),
      team: options.teamId ?? providerId,
      text: options.text,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
      ts: options.messageTs,
      type: 'app_mention',
      user: options.userId ?? Constants.slack.adminUserId,
    },
    event_id: options.eventId ?? `Ev${Nanoid.generate()}`,
    team_id: options.teamId ?? providerId,
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
  await drainWaitUntil()
  return response
}

async function postSlackReaction(options: {
  authorizations?: Array<{
    is_bot?: boolean
    team_id?: string
    user_id?: string
  }>
  channelId?: string
  eventId?: string
  eventTs?: string
  itemUserId?: string
  messageTs: string
  reaction: string
  teamId?: string
  userId: string
}) {
  const body = JSON.stringify({
    ...(options.authorizations ? { authorizations: options.authorizations } : {}),
    event: {
      event_ts: options.eventTs ?? `${options.messageTs}-reaction`,
      item: {
        channel: options.channelId ?? Constants.slack.channelId,
        ts: options.messageTs,
        type: 'message',
      },
      item_user: options.itemUserId ?? Constants.slack.memberUserId,
      reaction: options.reaction,
      type: 'reaction_added',
      user: options.userId,
    },
    event_id: options.eventId ?? `Ev${Nanoid.generate()}`,
    team_id: options.teamId ?? providerId,
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
  await drainWaitUntil()
  return response
}

async function drainWaitUntil() {
  for (let index = 0; index < waitUntil.length; index = waitUntil.length) {
    await Promise.all(waitUntil.slice(index))
  }
}

function createViewSubmissionPayload(input: {
  amount: string
  network: string
  reactionTips?: string
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
          reaction_tip_configs: {
            reaction_tip_configs: {
              type: 'plain_text_input',
              value:
                input.reactionTips ?? ':money_with_wings: 0.001, :dollar: 0.01, :moneybag: 0.10',
            },
          },
        },
      },
    },
  }
}

function createRaffleViewSubmissionPayload(
  input: {
    amount?: string
    duration?: string
    memo?: string
    userId?: string
    userName?: string
  } = {},
) {
  return {
    team: { id: providerId },
    type: 'view_submission',
    user: {
      id: input.userId ?? Constants.slack.adminUserId,
      name: input.userName ?? Constants.slack.adminUserName,
    },
    view: {
      callback_id: 'tip_raffle_create',
      id: `V${Nanoid.generate()}`,
      private_metadata: JSON.stringify({
        m: JSON.stringify({ channelId: Constants.slack.channelId, providerId }),
      }),
      state: {
        values: {
          duration: {
            duration: {
              selected_option: {
                text: { text: input.duration ?? '5 minutes', type: 'plain_text' },
                value: input.duration ?? '5m',
              },
              type: 'static_select',
            },
          },
          memo: {
            memo: {
              type: 'plain_text_input',
              value: input.memo ?? 'team lunch',
            },
          },
          ticket_amount: {
            ticket_amount: {
              type: 'plain_text_input',
              value: input.amount ?? '0.01',
            },
          },
        },
      },
    },
  }
}

function createAirdropViewSubmissionPayload(
  input: {
    amount?: string
    duration?: string
    name?: string
    userId?: string
    userName?: string
  } = {},
) {
  return {
    team: { id: providerId },
    type: 'view_submission',
    user: {
      id: input.userId ?? Constants.slack.adminUserId,
      name: input.userName ?? Constants.slack.adminUserName,
    },
    view: {
      callback_id: 'tip_airdrop_create',
      id: `V${Nanoid.generate()}`,
      private_metadata: JSON.stringify({
        m: JSON.stringify({ channelId: Constants.slack.channelId, providerId }),
      }),
      state: {
        values: {
          amount: {
            amount: {
              type: 'plain_text_input',
              value: input.amount ?? '0.02',
            },
          },
          duration: {
            duration: {
              selected_option: {
                text: { text: input.duration ?? '5 minutes', type: 'plain_text' },
                value: input.duration ?? '5m',
              },
              type: 'static_select',
            },
          },
          name: {
            name: {
              type: 'plain_text_input',
              value: input.name ?? 'Tempo Launch',
            },
          },
        },
      },
    },
  }
}

function createAirdropClaimPayload(
  tipAirdrop: { id: string; provider_message_ts: string },
  input: { triggerId?: string; userId: string; userName: string },
) {
  return {
    actions: [
      {
        action_id: 'airdrop_claim',
        type: 'button',
        value: JSON.stringify({ tipAirdropId: tipAirdrop.id }),
      },
    ],
    channel: { id: Constants.slack.channelId },
    container: {
      channel_id: Constants.slack.channelId,
      message_ts: tipAirdrop.provider_message_ts,
      type: 'message',
    },
    message: { ts: tipAirdrop.provider_message_ts },
    team: { id: providerId },
    trigger_id: input.triggerId ?? `airdrop-claim-${input.userId}`,
    type: 'block_actions',
    user: { id: input.userId, name: input.userName },
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

async function deleteSlackConnectWorkspace() {
  const workspaces = await db
    .selectFrom('workspace')
    .select('id')
    .where('provider', '=', 'slack')
    .where('provider_id', '=', Constants.slackConnect.teamId)
    .execute()

  for (const workspace of workspaces) {
    const members = await db
      .selectFrom('member')
      .select(['id', 'provider_identity_id'])
      .where('workspace_id', '=', workspace.id)
      .execute()
    const memberIds = members.map((member) => member.id)
    await db.deleteFrom('reaction_tip_thread').where('workspace_id', '=', workspace.id).execute()
    if (memberIds.length > 0) {
      await db.deleteFrom('reaction_tip').where('sender_member_id', 'in', memberIds).execute()
      await db.deleteFrom('reaction_tip').where('recipient_member_id', 'in', memberIds).execute()
      await db.deleteFrom('pending_tip').where('sender_member_id', 'in', memberIds).execute()
      await db.deleteFrom('pending_tip').where('recipient_member_id', 'in', memberIds).execute()
    }
    await db.deleteFrom('pending_tip').where('workspace_id', '=', workspace.id).execute()
    await db.deleteFrom('tip').where('workspace_id', '=', workspace.id).execute()
    if (memberIds.length > 0) {
      await db.deleteFrom('tip').where('sender_member_id', 'in', memberIds).execute()
      await db.deleteFrom('tip').where('recipient_member_id', 'in', memberIds).execute()
    }
    await db.deleteFrom('tip_batch').where('workspace_id', '=', workspace.id).execute()
    if (memberIds.length > 0) {
      await db.deleteFrom('tip_batch').where('sender_member_id', 'in', memberIds).execute()
      await db.deleteFrom('account_link_token').where('member_id', 'in', memberIds).execute()
      await db.deleteFrom('member').where('id', 'in', memberIds).execute()
    }
    const providerIdentityIds = members
      .map((member) => member.provider_identity_id)
      .filter((providerIdentityId) => providerIdentityId !== null)
    if (providerIdentityIds.length > 0)
      await db.deleteFrom('provider_identity').where('id', 'in', providerIdentityIds).execute()
    await db.deleteFrom('workspace').where('id', '=', workspace.id).execute()
  }
}

async function insertMember(
  attrs: Partial<DB_gen.Insertable.member> &
    Pick<DB_gen.Insertable.member, 'workspace_id'> & { account_id?: string | null },
) {
  const member = factory.member.attrs(attrs as never)
  const { account_id: accountId, ...memberValues } = member as typeof member & {
    account_id?: string | null
  }
  if (member.provider_identity_id) return await factory.member.insert(memberValues)

  const workspace = await db
    .selectFrom('workspace')
    .select(['provider', 'provider_id'])
    .where('id', '=', member.workspace_id)
    .executeTakeFirstOrThrow()
  const identity = await factory.provider_identity.insert({
    account_id: accountId ?? null,
    created_at: member.created_at,
    display_name: member.login,
    provider: workspace.provider,
    provider_user_id: member.provider_user_id,
    provider_workspace_id: workspace.provider_id,
    real_name: member.name,
    updated_at: member.updated_at,
  })
  return await factory.member.insert({ ...memberValues, provider_identity_id: identity.id })
}
