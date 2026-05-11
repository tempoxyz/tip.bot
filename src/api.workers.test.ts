import { env } from 'cloudflare:workers'
import { testClient } from 'hono/testing'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '#/api.ts'
import * as DB from '#db/client.ts'
import * as Constants from '#test/constants.ts'
import * as Factory from '#test/factory.ts'
import { createSlackHeaders } from '#test/slack.ts'

let waitUntil: Promise<unknown>[] = []
const db = DB.create(env.DB)
const factory = Factory.create(db)
const executionCtx = {
  passThroughOnException: vi.fn(),
  props: {},
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    waitUntil.push(promise)
  }),
}
const client = testClient(api, env, executionCtx)

beforeEach(async () => {
  waitUntil = []
  executionCtx.passThroughOnException.mockClear()
  executionCtx.waitUntil.mockClear()
  vi.restoreAllMocks()
  await db.deleteFrom('workspace').execute()
})

describe('/api/chat/slack', () => {
  test('Slack URL verification reaches the Worker API route', async () => {
    const body = JSON.stringify({
      challenge: 'slack-challenge',
      event_id: 'Ev000000001',
      team_id: Constants.slack.teamId,
      type: 'url_verification',
    })

    const response = await client.api.chat.slack.$post(
      {},
      {
        headers: {
          ...(await createSlackHeaders(body)),
          'content-type': 'application/json',
        },
        init: { body },
      },
    )
    await Promise.all(waitUntil)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ challenge: 'slack-challenge' })
  })

  test('invalid Slack signatures are rejected by the Worker API route', async () => {
    const response = await client.api.chat.slack.$post(
      {},
      {
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
          'x-slack-signature': 'v0=bad',
        },
        init: { body: '{}' },
      },
    )
    await Promise.all(waitUntil)

    expect(response.status).toBe(401)
  })
})

describe('/api/chat/slack/install', () => {
  test('redirects to Slack OAuth', async () => {
    const response = await client.api.chat.slack.install.$get()
    const location = response.headers.get('location')
    if (!location) throw new Error('Expected Slack install redirect location.')

    const url = new URL(location)
    expect(response.status).toBe(302)
    expect(url.origin).toBe(env.SLACK_API_URL.replace(/\/api$/, ''))
    expect(url.pathname).toBe('/oauth/v2/authorize')
    expect(url.searchParams.get('client_id')).toBe(env.SLACK_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(
      `https://${env.HOST}/api/chat/slack/oauth/callback`,
    )
    expect(url.searchParams.get('scope')).toBe('chat:write,commands,users:read')
    expect(url.searchParams.get('state')).toMatch(/^[^.]+\.[^.]+$/)
  })
})

describe('/api/chat/slack/oauth/callback', () => {
  test('rejects missing code or state', async () => {
    const response = await client.api.chat.slack.oauth.callback.$get({ query: {} as never })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'validation_error',
      message: 'Validation failed',
    })
  })

  test('rejects Slack error', async () => {
    const response = await client.api.chat.slack.oauth.callback.$get({
      query: { error: 'access_denied' },
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 'slack_install_failed',
      message: 'Slack install failed: access_denied',
    })
  })

  test('rejects tampered state', async () => {
    const installResponse = await client.api.chat.slack.install.$get()
    const location = installResponse.headers.get('location')
    if (!location) throw new Error('Expected Slack install redirect location.')

    const state = new URL(location).searchParams.get('state')
    if (!state) throw new Error('Expected Slack install state.')

    const response = await client.api.chat.slack.oauth.callback.$get({
      query: { code: 'oauth-code', state: `${state}tampered` },
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 'invalid_slack_install_state',
      message: 'Slack install state signature is invalid.',
    })
  })

  test('stores workspace and redirects', async () => {
    const installResponse = await client.api.chat.slack.install.$get()
    const location = installResponse.headers.get('location')
    if (!location) throw new Error('Expected Slack install redirect location.')

    const authorizeUrl = new URL(location)
    const authorizeResponse = await fetch(`${authorizeUrl.origin}/oauth/v2/authorize/callback`, {
      body: new URLSearchParams({
        client_id: authorizeUrl.searchParams.get('client_id') ?? '',
        redirect_uri: authorizeUrl.searchParams.get('redirect_uri') ?? '',
        scope: authorizeUrl.searchParams.get('scope') ?? '',
        state: authorizeUrl.searchParams.get('state') ?? '',
        user_id: Constants.slack.adminUserId,
      }),
      method: 'POST',
      redirect: 'manual',
    })
    const callbackLocation = authorizeResponse.headers.get('location')
    if (!callbackLocation) throw new Error('Expected Slack OAuth callback redirect location.')
    const callbackUrl = new URL(callbackLocation)

    const response = await client.api.chat.slack.oauth.callback.$get({
      query: {
        code: callbackUrl.searchParams.get('code') ?? '',
        state: callbackUrl.searchParams.get('state') ?? '',
      },
    })
    const workspace = await db
      .selectFrom('workspace')
      .select(['name', 'provider', 'provider_id'])
      .where('provider_id', '=', Constants.slack.teamId)
      .executeTakeFirstOrThrow()

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('http://localhost/?slack=installed&team=Emulate')
    expect(workspace).toEqual({
      name: 'Emulate',
      provider: 'slack',
      provider_id: Constants.slack.teamId,
    })
  })

  test('updates existing workspace and redirects', async () => {
    await factory.workspace.insert({ name: 'Old Name', provider_id: Constants.slack.teamId })
    const installResponse = await client.api.chat.slack.install.$get()
    const location = installResponse.headers.get('location')
    if (!location) throw new Error('Expected Slack install redirect location.')

    const authorizeUrl = new URL(location)
    const authorizeResponse = await fetch(`${authorizeUrl.origin}/oauth/v2/authorize/callback`, {
      body: new URLSearchParams({
        client_id: authorizeUrl.searchParams.get('client_id') ?? '',
        redirect_uri: authorizeUrl.searchParams.get('redirect_uri') ?? '',
        scope: authorizeUrl.searchParams.get('scope') ?? '',
        state: authorizeUrl.searchParams.get('state') ?? '',
        user_id: Constants.slack.adminUserId,
      }),
      method: 'POST',
      redirect: 'manual',
    })
    const callbackLocation = authorizeResponse.headers.get('location')
    if (!callbackLocation) throw new Error('Expected Slack OAuth callback redirect location.')
    const callbackUrl = new URL(callbackLocation)

    const response = await client.api.chat.slack.oauth.callback.$get({
      query: {
        code: callbackUrl.searchParams.get('code') ?? '',
        state: callbackUrl.searchParams.get('state') ?? '',
      },
    })
    const workspaces = await db
      .selectFrom('workspace')
      .select(['name', 'provider', 'provider_id'])
      .where('provider_id', '=', Constants.slack.teamId)
      .execute()

    expect(response.status).toBe(302)
    expect(workspaces).toEqual([
      { name: 'Emulate', provider: 'slack', provider_id: Constants.slack.teamId },
    ])
  })
})
