import * as DB from '#db/client.ts'
import * as Chat from '#/chat.ts'
import { env } from 'cloudflare:workers'
import { HttpResponse, http } from 'msw'
import { beforeEach, expect, test, vi } from 'vitest'
import { server } from '#test/workers.server.ts'

let slackClient: MockSlackClient
beforeEach(async () => {
  slackClient = createMockSlackClient()
  setSlackClient(slackClient)
  await Chat.bot.initialize()
  await Chat.slack.setInstallation('T000000001', {
    botToken: 'xoxb-test',
    botUserId: 'B000000001',
    teamName: 'Tip Test',
  })
})

test('/tip config', async () => {
  const waitUntil: Promise<unknown>[] = []
  const response = await Chat.bot.webhooks.slack(await createSlashCommandRequest('config'), {
    waitUntil: (promise) => waitUntil.push(promise),
  })
  await Promise.all(waitUntil)

  expect(response.status).toBe(200)
  expect(slackClient.chat.postEphemeral).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: 'C000000001',
      text: 'Current config: emoji money_with_wings, amount 0.001, cap 1',
      user: 'U000000001',
    }),
  )
})

test('/tip config emoji coin', async () => {
  const waitUntil: Promise<unknown>[] = []
  server.use(
    http.post('https://slack.com/api/users.info', async ({ request }) => {
      expect(request.headers.get('authorization')).toBe('Bearer xoxb-test')
      expect((await request.text()).toString()).toBe('user=U000000001')
      return HttpResponse.json({ ok: true, user: { is_admin: true } })
    }),
  )

  const response = await Chat.bot.webhooks.slack(
    await createSlashCommandRequest('config emoji coin'),
    {
      waitUntil: (promise) => waitUntil.push(promise),
    },
  )
  await Promise.all(waitUntil)

  const workspace = await DB.create(env.DB)
    .selectFrom('workspace')
    .select(['tip_emoji'])
    .where('platform_team_id', '=', 'T000000001')
    .executeTakeFirstOrThrow()

  expect(response.status).toBe(200)
  expect(slackClient.users.info).toHaveBeenCalledWith(
    expect.objectContaining({ token: 'xoxb-test', user: 'U000000001' }),
  )
  expect(slackClient.chat.postEphemeral).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: 'C000000001',
      text: 'Updated emoji.',
      user: 'U000000001',
    }),
  )
  expect(workspace.tip_emoji).toBe('coin')
})

function createMockSlackClient() {
  return {
    chat: {
      postEphemeral: vi.fn(async () => ({ message_ts: '1000.000001', ok: true })),
      postMessage: vi.fn(async () => ({ ok: true, ts: '1000.000002' })),
    },
    conversations: {
      history: vi.fn(async () => ({ messages: [{ user: 'U000000002' }], ok: true })),
    },
    users: {
      info: vi.fn(async () => ({
        ok: true,
        user: {
          id: 'U000000001',
          is_admin: true,
          profile: { display_name: 'Admin', real_name: 'Admin User' },
          real_name: 'Admin User',
        },
      })),
    },
  }
}

async function createSlashCommandRequest(text: string) {
  const body = new URLSearchParams({
    channel_id: 'C000000001',
    command: '/tip',
    team_id: 'T000000001',
    text,
    trigger_id: `trigger-${text.replaceAll(/\W+/g, '-')}`,
    user_id: 'U000000001',
  }).toString()

  return new Request('https://tip.test/api/chat/slack', {
    body,
    headers: {
      ...(await createSlackHeaders(body)),
      'content-type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  })
}

const signingSecret = 'test-signing-secret'
async function createSlackHeaders(body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  )
  return {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${bytesToHex(new Uint8Array(digest))}`,
  }
}

function bytesToHex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function setSlackClient(client: MockSlackClient) {
  const slack = Chat.slack as unknown as { client: MockSlackClient }
  slack.client = client
}

type MockSlackClient = ReturnType<typeof createMockSlackClient>
