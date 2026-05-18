import type { APIRequestContext } from '@playwright/test'
import type { Kysely } from 'kysely'
import { WebClient } from '@slack/web-api'
import * as AccessKey from '#/lib/accessKey.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import { createSlackHeaders } from '#/lib/slack.ts'
import * as Tempo from '#/lib/tempo.ts'
import type { DB } from '#db/types.gen.ts'
import { Account } from 'viem/tempo'
import * as Constants from '../constants.ts'
import type * as Factory from '../factory.ts'
import { expect, test } from './fixture.ts'

test('visitor opens an expired connection link', async ({ app, page }) => {
  await page.goto(app.url({ params: { token: 'missing' }, to: '/connect/$token' }))

  await expect(page.getByText('This connection link is invalid or expired.')).toBeVisible()
  await expect(page.getByText('Run `/tip connect` in Slack to get a new link.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect' })).toBeHidden()
})

test('slack member opens valid connection link', async ({ app, db, factory, page }) => {
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

  await page.goto(app.url({ params: { token }, to: '/connect/$token' }))

  await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Cancel' })).toBeVisible()
  await expect(page.getByText('Authorize Tipbot to connect your Tempo Wallet')).toBeVisible()
})

test('slack member connects wallet from slack', async ({ app, db, page, request }) => {
  await installSlack(app, request)
  await postSlashCommand(app, 'disconnect')
  await postSlashCommand(app, 'connect')
  const token = await getConnectToken(app)
  const root = Account.fromSecp256k1(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  )

  await page.goto(app.url({ params: { token }, to: '/connect/$token' }))
  await page.waitForLoadState('networkidle')

  const walletConnectTimeoutMs = 15_000 // 15 seconds
  await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Connected to Tipbot' })).toBeVisible({
    timeout: walletConnectTimeoutMs,
  })
  await expect(page.getByText('You can close this tab and return to Slack.')).toBeVisible()

  const link = await db
    .selectFrom('account_link_token')
    .innerJoin('member', 'member.id', 'account_link_token.member_id')
    .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .innerJoin('account', 'account.id', 'provider_identity.account_id')
    .select([
      'account.address as account_address',
      'account.id as account_id',
      'account_link_token.access_key_address',
      'account_link_token.access_key_authorization',
      'account_link_token.account_id as link_account_id',
      'account_link_token.used_at',
      'provider_identity.account_id as identity_account_id',
    ])
    .where('account_link_token.token_hash', '=', await AccountLink.hashToken(app.env, token))
    .executeTakeFirstOrThrow()

  expect(link.account_address).toBe(root.address)
  expect(link.access_key_authorization).toEqual(expect.any(String))
  expect(link.identity_account_id).toBe(link.account_id)
  expect(link.link_account_id).toBe(link.account_id)
  expect(link.used_at).toEqual(expect.any(String))

  await page.goto(app.url({ params: { token }, to: '/connect/$token' }))
  await expect(page.getByText('This connection link is invalid or expired.')).toBeVisible()
})

test('slack member connects another link while wallet is already connected', async ({
  app,
  db,
  factory,
  page,
}) => {
  const firstAccessKey = AccessKey.generate()
  const firstToken = crypto.randomUUID()
  const firstTokenHash = await AccountLink.hashToken(app.env, firstToken)
  const root = Account.fromSecp256k1(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  )
  const secondAccessKey = AccessKey.generate()
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
    {
      access_key_address: firstAccessKey.address,
      access_key_ciphertext: await AccessKey.encrypt(app.env, firstAccessKey.privateKey),
      access_key_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      access_key_public_key: firstAccessKey.publicKey,
      member_id: member.id,
      token_hash: firstTokenHash,
    },
    {
      access_key_address: secondAccessKey.address,
      access_key_ciphertext: await AccessKey.encrypt(app.env, secondAccessKey.privateKey),
      access_key_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      access_key_public_key: secondAccessKey.publicKey,
      member_id: member.id,
      token_hash: secondTokenHash,
    },
  )

  const walletConnectTimeoutMs = 15_000 // 15 seconds
  await page.goto(app.url({ params: { token: firstToken }, to: '/connect/$token' }))
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Connected to Tipbot' })).toBeVisible({
    timeout: walletConnectTimeoutMs,
  })

  await page.goto(app.url({ params: { token: secondToken }, to: '/connect/$token' }))
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Connected to Tipbot' })).toBeVisible({
    timeout: walletConnectTimeoutMs,
  })

  const links = await db
    .selectFrom('account_link_token')
    .select(['access_key_authorization', 'account_id', 'token_hash', 'used_at'])
    .where('token_hash', 'in', [firstTokenHash, secondTokenHash])
    .execute()
  const firstLink = links.find((link) => link.token_hash === firstTokenHash)
  const secondLink = links.find((link) => link.token_hash === secondTokenHash)
  const account = await db
    .selectFrom('account')
    .selectAll()
    .where('address', '=', root.address)
    .executeTakeFirstOrThrow()

  expect(links).toHaveLength(2)
  expect(firstLink?.account_id).toBe(account.id)
  expect(firstLink?.access_key_authorization).toEqual(expect.any(String))
  expect(firstLink?.used_at).toEqual(expect.any(String))
  expect(secondLink?.account_id).toBe(account.id)
  expect(secondLink?.access_key_authorization).toEqual(expect.any(String))
  expect(secondLink?.used_at).toEqual(expect.any(String))
})

test('slack member can disconnect an existing member and connect wallet', async ({
  app,
  db,
  factory,
  page,
}) => {
  const token = crypto.randomUUID()
  const accessKey = AccessKey.generate()
  const root = Account.fromSecp256k1(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  )
  const workspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    provider_id: `T${crypto.randomUUID()}`,
  })
  const currentMember = await insertMember(db, factory, {
    provider_user_id: `U${crypto.randomUUID()}`,
    workspace_id: workspace.id,
  })
  const existingAccount = await db
    .selectFrom('account')
    .selectAll()
    .where('address', '=', root.address)
    .executeTakeFirst()
  const account = existingAccount ?? (await factory.account.insert({ address: root.address }))
  const duplicateMember = await insertMember(db, factory, {
    account_id: account.id,
    provider_user_id: `U${crypto.randomUUID()}`,
    workspace_id: workspace.id,
  })
  await factory.account_link_token.insert({
    access_key_address: accessKey.address,
    access_key_ciphertext: await AccessKey.encrypt(app.env, accessKey.privateKey),
    access_key_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    access_key_public_key: accessKey.publicKey,
    member_id: currentMember.id,
    token_hash: await AccountLink.hashToken(app.env, token),
  })

  await page.goto(app.url({ params: { token }, to: '/connect/$token' }))
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Connect' }).click()

  const walletConnectTimeoutMs = 15_000 // 15 seconds
  await expect(
    page.getByText('This wallet is already connected to another Slack account in this workspace.'),
  ).toBeVisible({ timeout: walletConnectTimeoutMs })
  await page.getByRole('button', { name: 'Disconnect existing account and connect' }).click()
  await expect(page.getByRole('heading', { name: 'Connected to Tipbot' })).toBeVisible({
    timeout: walletConnectTimeoutMs,
  })

  const updatedCurrentMember = await db
    .selectFrom('member')
    .selectAll()
    .where('id', '=', currentMember.id)
    .executeTakeFirstOrThrow()
  const updatedDuplicateMember = await db
    .selectFrom('member')
    .selectAll()
    .where('id', '=', duplicateMember.id)
    .executeTakeFirstOrThrow()
  const link = await db
    .selectFrom('account_link_token')
    .select(['access_key_authorization', 'account_id', 'used_at'])
    .where('token_hash', '=', await AccountLink.hashToken(app.env, token))
    .executeTakeFirstOrThrow()

  expect(updatedCurrentMember.account_id).toBe(account.id)
  expect(updatedDuplicateMember.account_id).toBe(null)
  expect(link.account_id).toBe(account.id)
  expect(link.access_key_authorization).toEqual(expect.any(String))
  expect(link.used_at).toEqual(expect.any(String))
})

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
    const token = text.match(/\/connect\/([^\s"\\)]+)/)?.[1]
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
  const callbackResponse = await request.get(
    app.url(`${callbackUrl.pathname}${callbackUrl.search}` as `/api/${string}`),
    {
      maxRedirects: 0,
    },
  )
  expect(callbackResponse.status(), await callbackResponse.text()).toBe(302)
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

async function insertMember(
  db: Kysely<DB>,
  factory: ReturnType<typeof Factory.create>,
  attrs: Partial<DB.Insertable.member> & Pick<DB.Insertable.member, 'workspace_id'>,
) {
  const member = factory.member.attrs(attrs as never)
  if (member.provider_identity_id !== null) return await factory.member.insert(member)

  const workspace = await db
    .selectFrom('workspace')
    .select(['provider', 'provider_id'])
    .where('id', '=', member.workspace_id)
    .executeTakeFirstOrThrow()
  const identity = await factory.provider_identity.insert({
    account_id: member.account_id,
    created_at: member.created_at,
    display_name: member.login,
    provider: workspace.provider,
    provider_user_id: member.provider_user_id,
    provider_workspace_id: workspace.provider_id,
    real_name: member.name,
    updated_at: member.updated_at,
  })
  return await factory.member.insert({ ...member, provider_identity_id: identity.id })
}
