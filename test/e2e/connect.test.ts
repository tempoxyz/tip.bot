import type { APIRequestContext } from '@playwright/test'
import { WebClient } from '@slack/web-api'
import * as AccountLink from '#/lib/accountLink.ts'
import * as Constants from '../constants.ts'
import { createSlackHeaders } from '../slack.ts'
import { expect, test } from './fixture.ts'

test('visitor opens an expired connection link', async ({ app, page }) => {
  await page.goto(app.url({ params: { token: 'missing' }, to: '/connect/$token' }))

  await expect(page.getByText('This connection link is invalid or expired.')).toBeVisible()
  await expect(page.getByText('Run `/tip connect` in Slack to get a new link.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect' })).toBeHidden()
})

test('slack member opens valid connection link', async ({ app, factory, page }) => {
  const token = crypto.randomUUID()
  const workspace = await factory.workspace.insert({ provider_id: `T${crypto.randomUUID()}` })
  const member = await factory.member.insert({
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

test('slack member connects wallet from slack', async ({ app, page, request }) => {
  await installSlack(app, request)
  await postSlashCommand(app, 'disconnect')
  await postSlashCommand(app, 'connect')
  const token = await getConnectToken(app)

  await page.goto(app.url({ params: { token }, to: '/connect/$token' }))
  await page.waitForLoadState('networkidle')

  const walletConnectTimeoutMs = 15_000 // 15 seconds
  await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Connected to Tipbot' })).toBeVisible({
    timeout: walletConnectTimeoutMs,
  })
  await expect(page.getByText('You can close this tab and return to Slack.')).toBeVisible()

  await page.goto(app.url({ params: { token }, to: '/connect/$token' }))
  await expect(page.getByText('This connection link is invalid or expired.')).toBeVisible()
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
    const text = history.messages?.find((message) =>
      message.text?.includes('Connect to Tipbot:'),
    )?.text
    const token = text?.match(/\/connect\/([^\s]+)/)?.[1]
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
      ...(await createSlackHeaders(body)),
      'content-type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  })
  const responseText = await response.text()
  expect(response.status, responseText).toBe(200)
}
