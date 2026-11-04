import type { APIRequestContext, APIResponse } from '@playwright/test'
import { WebClient } from '@slack/web-api'
import { Address, Secp256k1 } from 'ox'
import * as AccessKey from '#/lib/accessKey.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import { createSlackHeaders } from '#/lib/slack.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Constants from '../constants.ts'
import { expect, test } from './fixture.ts'
import { insertMember } from './members.ts'

test('visitor opens an expired connection link', async ({ app, page }) => {
  await page.goto(app.url('/api/account/link/missing/start'))

  await expect(page).toHaveURL(app.url({ params: { token: 'missing' }, to: '/connect/$token' }))
  await expect(page.getByText('This connection link is invalid or expired.')).toBeVisible()
  await expect(page.getByText('Run `/tip connect` in Slack to get a new link.')).toBeVisible()
})

test('slack member opens a connection link, which starts the Tempo ID sign-in', async ({
  app,
  db,
  factory,
  page,
}) => {
  const token = crypto.randomUUID()
  const workspace = await factory.workspace.insert({ provider_id: `T${crypto.randomUUID()}` })
  const member = await insertMember(db, factory, {
    provider_user_id: `U${crypto.randomUUID()}`,
    workspace_id: workspace.id,
  })
  await factory.account_link_token.insert({
    member_id: member.id,
    token_hash: await AccountLink.hashToken(app.env, token),
  })

  await page.goto(app.url(`/api/account/link/${token}/start`))

  await expect(page).toHaveURL((url) => url.origin === new URL(app.tempoId.url).origin)
})

test('slack member connects a Tempo Account from slack', async ({ app, db, page, request }) => {
  await installSlack(app, request)
  await postSlashCommand(app, 'disconnect')
  await postSlashCommand(app, 'connect')
  const token = await getConnectToken(app)
  await app.tempoId.signIn(page)

  await page.goto(app.url(`/api/account/link/${token}/start`))
  await expect(page.getByText('Spend $10 per day')).toBeVisible()
  await app.tempoId.approve(page)

  await expect(page.getByRole('heading', { name: 'Connected to Tipbot' })).toBeVisible()
  await expect(page.getByText('You can close this tab and return to Slack.')).toBeVisible()

  const link = await db
    .selectFrom('account_link_token')
    .innerJoin('member', 'member.id', 'account_link_token.member_id')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .innerJoin('account', 'account.id', 'provider_identity.account_id')
    .select([
      'account.id as account_id',
      'account_link_token.access_key_address',
      'account_link_token.access_key_authorization',
      'account_link_token.account_id as link_account_id',
      'account_link_token.used_at',
      'provider_identity.account_id as identity_account_id',
    ])
    .where('account_link_token.token_hash', '=', await AccountLink.hashToken(app.env, token))
    .executeTakeFirstOrThrow()
  const accessKey = await db
    .selectFrom('access_key')
    .select(['address', 'ciphertext'])
    .where('account_id', '=', link.account_id)
    .executeTakeFirstOrThrow()

  expect(link.access_key_authorization).toEqual(expect.any(String))
  expect(link.identity_account_id).toBe(link.account_id)
  expect(link.link_account_id).toBe(link.account_id)
  expect(link.used_at).toEqual(expect.any(String))
  // The access key that Tempo ID authorized is the one that Tipbot stores and signs with.
  expect(accessKey.address).toBe(link.access_key_address)
  expect(
    Address.isEqual(
      Address.fromPublicKey(
        Secp256k1.getPublicKey({
          privateKey: await AccessKey.decrypt(app.env, accessKey.ciphertext),
        }),
      ),
      accessKey.address as Address.Address,
    ),
  ).toBe(true)

  await page.goto(app.url({ params: { token }, to: '/connect/$token' }))
  await expect(page.getByText('This connection link is invalid or expired.')).toBeVisible()
})

test('slack member connects another link with the same Tempo Account', async ({
  app,
  db,
  factory,
  page,
}) => {
  const firstToken = crypto.randomUUID()
  const firstTokenHash = await AccountLink.hashToken(app.env, firstToken)
  const secondToken = crypto.randomUUID()
  const secondTokenHash = await AccountLink.hashToken(app.env, secondToken)
  const workspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    provider_id: `T${crypto.randomUUID()}`,
  })
  const member = await insertMember(db, factory, {
    provider_user_id: `U${crypto.randomUUID()}`,
    workspace_id: workspace.id,
  })
  await factory.account_link_token.insert(
    await pendingLink(app, { memberId: member.id, tokenHash: firstTokenHash }),
    await pendingLink(app, { memberId: member.id, tokenHash: secondTokenHash }),
  )
  await app.tempoId.signIn(page)

  for (const token of [firstToken, secondToken]) {
    await page.goto(app.url(`/api/account/link/${token}/start`))
    await app.tempoId.approve(page)
    await expect(page.getByRole('heading', { name: 'Connected to Tipbot' })).toBeVisible()
  }

  const links = await db
    .selectFrom('account_link_token')
    .select(['access_key_authorization', 'account_id', 'token_hash', 'used_at'])
    .where('token_hash', 'in', [firstTokenHash, secondTokenHash])
    .execute()

  expect(links).toHaveLength(2)
  expect(links[0]?.account_id).toEqual(expect.any(String))
  expect(links[1]?.account_id).toBe(links[0]?.account_id)
  for (const link of links) {
    expect(link.access_key_authorization).toEqual(expect.any(String))
    expect(link.used_at).toEqual(expect.any(String))
  }
})

test('slack member disconnects another member of the same Tempo Account, then connects', async ({
  app,
  db,
  factory,
  page,
}) => {
  const firstToken = crypto.randomUUID()
  const secondToken = crypto.randomUUID()
  const workspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    provider_id: `T${crypto.randomUUID()}`,
  })
  const firstMember = await insertMember(db, factory, {
    provider_user_id: `U${crypto.randomUUID()}`,
    workspace_id: workspace.id,
  })
  const secondMember = await insertMember(db, factory, {
    provider_user_id: `U${crypto.randomUUID()}`,
    workspace_id: workspace.id,
  })
  await factory.account_link_token.insert(
    await pendingLink(app, {
      memberId: firstMember.id,
      tokenHash: await AccountLink.hashToken(app.env, firstToken),
    }),
    await pendingLink(app, {
      memberId: secondMember.id,
      tokenHash: await AccountLink.hashToken(app.env, secondToken),
    }),
  )
  await app.tempoId.signIn(page)
  await page.goto(app.url(`/api/account/link/${firstToken}/start`))
  await app.tempoId.approve(page)
  await expect(page.getByRole('heading', { name: 'Connected to Tipbot' })).toBeVisible()

  await page.goto(app.url(`/api/account/link/${secondToken}/start`))
  await app.tempoId.approve(page)

  await expect(
    page.getByText('This wallet is already connected to another Slack account in this workspace.'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Disconnect existing account and connect' }).click()
  await expect(page.getByRole('heading', { name: 'Connected to Tipbot' })).toBeVisible()

  const accounts = await db
    .selectFrom('member')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .select(['member.id', 'provider_identity.account_id'])
    .where('member.id', 'in', [firstMember.id, secondMember.id])
    .execute()

  expect(accounts.find((row) => row.id === firstMember.id)?.account_id).toBe(null)
  expect(accounts.find((row) => row.id === secondMember.id)?.account_id).toEqual(expect.any(String))
})

/** Returns a pending link row, with an access key that the Tempo ID callback replaces. */
async function pendingLink(
  app: { env: Pick<Env, 'SECRET_KEY'> },
  options: { memberId: string; tokenHash: string },
) {
  const accessKey = AccessKey.generate()
  return {
    access_key_address: accessKey.address,
    access_key_ciphertext: await AccessKey.encrypt(app.env, accessKey.privateKey),
    access_key_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    access_key_public_key: accessKey.publicKey,
    member_id: options.memberId,
    token_hash: options.tokenHash,
  }
}

async function getConnectToken(app: { slackUrl: string }) {
  const slack = new WebClient(Constants.slack.botToken, {
    slackApiUrl: `${app.slackUrl}/api`,
  })
  const deadline = Date.now() + 15_000 // 15 seconds
  let messages: string[] = []
  while (Date.now() < deadline) {
    const history = await slack.conversations.history({ channel: Constants.slack.channelId })
    messages = (history.messages ?? []).flatMap((message) => (message.text ? [message.text] : []))
    const text = JSON.stringify(history.messages ?? [])
    const token = text.match(/\/api\/account\/link\/([^\s"\\)/]+)\/start/)?.[1]
    if (token) return token
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Expected Slack connect link message. Messages: ${JSON.stringify(messages)}`)
}

async function installSlack(
  app: { url: (path: `/api/${string}`) => string },
  request: APIRequestContext,
) {
  const installResponse = await request.get(app.url('/api/chat/slack/install'), { maxRedirects: 0 })
  const location = installResponse.headers().location
  if (!location) throw new Error('Expected Slack install redirect location.')

  const authorizeUrl = new URL(location)
  const authorizeResponse = await request.post(
    `${authorizeUrl.origin}/oauth/v2/authorize/callback`,
    {
      form: {
        client_id: authorizeUrl.searchParams.get('client_id') ?? '',
        redirect_uri: authorizeUrl.searchParams.get('redirect_uri') ?? '',
        scope: authorizeUrl.searchParams.get('scope') ?? '',
        state: authorizeUrl.searchParams.get('state') ?? '',
        user_id: Constants.slack.adminUserId,
      },
      maxRedirects: 0,
    },
  )
  const callbackLocation = authorizeResponse.headers().location
  if (!callbackLocation) throw new Error('Expected Slack OAuth callback redirect location.')

  const callbackUrl = new URL(callbackLocation)
  let callbackResponse: APIResponse | undefined
  let callbackResponseText = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    callbackResponse = await request.get(
      app.url(`${callbackUrl.pathname}${callbackUrl.search}` as `/api/${string}`),
      {
        maxRedirects: 0,
      },
    )
    callbackResponseText = await callbackResponse.text()
    if (callbackResponse.status() === 302) break
    if (
      !callbackResponseText.includes('D1_ERROR') ||
      !callbackResponseText.includes('internal error')
    )
      break
    await new Promise((resolve) => setTimeout(resolve, 100)) // 100 milliseconds
  }
  expect(callbackResponse?.status(), callbackResponseText).toBe(302)
}

async function postSlashCommand(app: { url: (path: `/api/${string}`) => string }, text: string) {
  const body = new URLSearchParams({
    channel_id: Constants.slack.channelId,
    command: '/tip',
    team_id: Constants.slack.teamId,
    text,
    trigger_id: `trigger-${Date.now()}`,
    user_id: Constants.slack.adminUserId,
  }).toString()
  const response = await fetch(app.url('/api/chat/slack'), {
    body,
    headers: {
      ...(await createSlackHeaders(body, 'test-signing-secret')),
      'content-type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  })
  const responseText = await response.text()
  expect(response.status, responseText).toBe(200)
}
