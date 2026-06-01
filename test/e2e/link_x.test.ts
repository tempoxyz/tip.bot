import * as AccessKey from '#/lib/accessKey.ts'
import * as Tempo from '#/lib/tempo.ts'
import { Account } from 'viem/tempo'
import { expect, test } from './fixture.ts'

test('visitor connects X account with OAuth', async ({ app, page }) => {
  const accessKey = AccessKey.generate()
  const challengeId = crypto.randomUUID()
  const root = Account.fromSecp256k1(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  )

  await page.route('**/api/link/twitter/oauth/challenge', async (route) => {
    expect(route.request().method()).toBe('POST')
    const json = route.request().postDataJSON() as {
      address?: string
      json?: { address?: string }
    }
    expect(json.address ?? json.json?.address).toBe(root.address)
    await route.fulfill({
      body: JSON.stringify({
        accessKeyExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        accessKeyLimit: '3000000',
        accessKeyLimitPeriodSeconds: 30 * 24 * 60 * 60, // 30 days
        accessKeyPublicKey: accessKey.publicKey,
        chainId: Tempo.chainLookup.mainnet,
        challengeId,
        ok: true,
        tokenAddress: Tempo.addressLookup.usdcE,
      }),
      contentType: 'application/json',
      status: 200,
    })
  })
  await page.route('**/api/link/twitter/oauth/start', async (route) => {
    expect(route.request().method()).toBe('POST')
    const json = route.request().postDataJSON() as {
      address?: string
      challengeId?: string
      json?: { address?: string; challengeId?: string; keyAuthorization?: unknown }
      keyAuthorization?: unknown
    }
    expect(json.address ?? json.json?.address).toBe(root.address)
    expect(json.challengeId ?? json.json?.challengeId).toBe(challengeId)
    expect(json.keyAuthorization ?? json.json?.keyAuthorization).toEqual(expect.any(Object))
    await route.fulfill({
      body: JSON.stringify({
        authorizationUrl: `${app.url({ to: '/link/x' })}?status=connected`,
        ok: true,
      }),
      contentType: 'application/json',
      status: 200,
    })
  })

  await page.goto(app.url({ to: '/link/x' }))
  await page.waitForLoadState('networkidle')

  await expect(page.getByText('Step 1/3')).toBeVisible()
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await expect(page.getByText('Step 2/3')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect X' })).toBeVisible()
  await expect(page.getByText('Read your X profile')).toBeVisible()
  await page.getByRole('button', { name: 'Connect X' }).click()

  await expect(page.getByText('You can now receive and send tips on X.')).toBeVisible()
})

test('visitor connects X account with proof tweet', async ({ app, page }) => {
  const accessKey = AccessKey.generate()
  const challengeId = crypto.randomUUID()
  const proof = `tb1_${crypto.randomUUID().replaceAll('-', '')}`
  const root = Account.fromSecp256k1(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  )
  const tweetText = ['Verifying my identity for @tipbotgg', '', proof, '', 'https://tip.bot'].join(
    '\n',
  )
  const intentUrl = new URL('/intent/tweet', 'https://twitter.com')
  intentUrl.searchParams.set('text', tweetText)

  await page.addInitScript(
    `window.open = (url) => { window.sessionStorage.setItem('openedUrl', String(url)); return null }`,
  )
  await page.route('**/api/link/twitter/challenge', async (route) => {
    expect(route.request().method()).toBe('POST')
    const json = route.request().postDataJSON() as {
      address?: string
      json?: { address?: string; username?: string }
      username?: string
    }
    expect(json.address ?? json.json?.address).toBe(root.address)
    expect(json.username ?? json.json?.username).toBe('tipbotgg')
    await route.fulfill({
      body: JSON.stringify({
        accessKeyExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        accessKeyLimit: '3000000',
        accessKeyLimitPeriodSeconds: 30 * 24 * 60 * 60, // 30 days
        accessKeyPublicKey: accessKey.publicKey,
        chainId: Tempo.chainLookup.mainnet,
        challengeId,
        avatarUrl: 'https://example.com/avatar.jpg',
        name: 'Tipbot',
        ok: true,
        tokenAddress: Tempo.addressLookup.usdcE,
        username: 'tipbotgg',
      }),
      contentType: 'application/json',
      status: 200,
    })
  })
  await page.route('**/api/link/twitter/proof', async (route) => {
    expect(route.request().method()).toBe('POST')
    const json = route.request().postDataJSON() as {
      address?: string
      challengeId?: string
      json?: { address?: string; challengeId?: string; keyAuthorization?: unknown }
      keyAuthorization?: unknown
    }
    expect(json.address ?? json.json?.address).toBe(root.address)
    expect(json.challengeId ?? json.json?.challengeId).toBe(challengeId)
    expect(json.keyAuthorization ?? json.json?.keyAuthorization).toEqual(expect.any(Object))
    await route.fulfill({
      body: JSON.stringify({
        intentUrl: intentUrl.toString(),
        ok: true,
        proof,
        tweetText,
      }),
      contentType: 'application/json',
      status: 200,
    })
  })
  await page.route('**/api/link/twitter/verify', async (route) => {
    expect(route.request().method()).toBe('POST')
    const json = route.request().postDataJSON() as {
      challengeId?: string
      json?: { challengeId?: string; proof?: string; tweetUrl?: string }
      proof?: string
      tweetUrl?: string
    }
    expect(json.challengeId ?? json.json?.challengeId).toBe(challengeId)
    expect(json.proof ?? json.json?.proof).toBe(proof)
    if (!(json.tweetUrl ?? json.json?.tweetUrl)) {
      await route.fulfill({
        body: JSON.stringify({ code: 'pending', ok: false }),
        contentType: 'application/json',
        status: 200,
      })
      return
    }
    expect(json.tweetUrl ?? json.json?.tweetUrl).toBe('https://x.com/tipbotgg/status/123')
    await route.fulfill({
      body: JSON.stringify({ handle: 'tipbotgg', ok: true }),
      contentType: 'application/json',
      status: 200,
    })
  })

  await page.goto(app.url({ to: '/link/x' }))
  await page.waitForLoadState('networkidle')

  await expect(page.getByRole('heading', { name: 'Connect X to Tipbot' })).toBeVisible()
  await expect(page.getByText('Step 1/3')).toBeVisible()
  await expect(page.getByLabel('X username')).toBeHidden()
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await expect(page.getByText('Step 2/3')).toBeVisible()
  await expect(page.getByLabel('X username')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Disconnect wallet' })).toBeVisible()
  await page.getByRole('button', { name: 'Disconnect wallet' }).click()
  await expect(page.getByText('Step 1/3')).toBeVisible()
  await expect(page.getByLabel('X username')).toBeHidden()
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await expect(page.getByText('Step 2/3')).toBeVisible()
  await expect(page.getByLabel('X username')).toBeHidden()
  await page.getByRole('button', { name: 'Verify with proof tweet instead' }).click()
  await expect(page.getByLabel('X username')).toBeVisible()
  await page.getByLabel('X username').fill('@tipbotgg')
  await page.getByRole('button', { name: 'Prepare proof tweet' }).click()
  await expect(page.getByText('Step 3/3')).toBeVisible()
  await expect(page.getByText(tweetText)).toBeVisible()
  await expect(page.getByRole('img', { name: 'Tipbot avatar' })).toBeVisible()
  await expect(
    page.getByRole('img', { name: 'Tipbot avatar' }).locator('..').getByText('Tipbot', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(page.getByText('Tipbot prepared this tweet for @tipbotgg.')).toBeVisible()
  await expect.poll(() => page.evaluate("window.sessionStorage.getItem('openedUrl')")).toBe(null)
  await page.getByRole('button', { name: 'Post connection tweet' }).click()
  await expect
    .poll(() => page.evaluate("window.sessionStorage.getItem('openedUrl')"))
    .toBe(intentUrl.toString())

  await page.getByRole('button', { name: 'Manual verification' }).click()
  await page.getByLabel('Paste your tweet URL').fill('https://x.com/tipbotgg/status/123')

  await expect(page.getByText('You can now receive and send tips on X.')).toBeVisible()
})

test('visitor connects X account after automatic proof tweet polling', async ({ app, page }) => {
  const accessKey = AccessKey.generate()
  const challengeId = crypto.randomUUID()
  const proof = `tb1_${crypto.randomUUID().replaceAll('-', '')}`
  const root = Account.fromSecp256k1(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  )
  const tweetText = ['Verifying my identity for @tipbotgg', '', proof, '', 'https://tip.bot'].join(
    '\n',
  )
  const intentUrl = new URL('/intent/tweet', 'https://twitter.com')
  let automaticVerifyCount = 0
  intentUrl.searchParams.set('text', tweetText)

  await page.addInitScript(
    `window.open = (url) => { window.sessionStorage.setItem('openedUrl', String(url)); return null }`,
  )
  await page.route('**/api/link/twitter/challenge', async (route) => {
    expect(route.request().method()).toBe('POST')
    const json = route.request().postDataJSON() as {
      address?: string
      json?: { address?: string; username?: string }
      username?: string
    }
    expect(json.address ?? json.json?.address).toBe(root.address)
    expect(json.username ?? json.json?.username).toBe('tipbotgg')
    await route.fulfill({
      body: JSON.stringify({
        accessKeyExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        accessKeyLimit: '3000000',
        accessKeyLimitPeriodSeconds: 30 * 24 * 60 * 60, // 30 days
        accessKeyPublicKey: accessKey.publicKey,
        chainId: Tempo.chainLookup.mainnet,
        challengeId,
        avatarUrl: 'https://example.com/avatar.jpg',
        name: 'Tipbot',
        ok: true,
        tokenAddress: Tempo.addressLookup.usdcE,
        username: 'tipbotgg',
      }),
      contentType: 'application/json',
      status: 200,
    })
  })
  await page.route('**/api/link/twitter/proof', async (route) => {
    expect(route.request().method()).toBe('POST')
    const json = route.request().postDataJSON() as {
      address?: string
      challengeId?: string
      json?: { address?: string; challengeId?: string; keyAuthorization?: unknown }
      keyAuthorization?: unknown
    }
    expect(json.address ?? json.json?.address).toBe(root.address)
    expect(json.challengeId ?? json.json?.challengeId).toBe(challengeId)
    expect(json.keyAuthorization ?? json.json?.keyAuthorization).toEqual(expect.any(Object))
    await route.fulfill({
      body: JSON.stringify({
        intentUrl: intentUrl.toString(),
        ok: true,
        proof,
        tweetText,
      }),
      contentType: 'application/json',
      status: 200,
    })
  })
  await page.route('**/api/link/twitter/verify', async (route) => {
    expect(route.request().method()).toBe('POST')
    const json = route.request().postDataJSON() as {
      challengeId?: string
      json?: { challengeId?: string; proof?: string; tweetUrl?: string }
      proof?: string
      tweetUrl?: string
    }
    expect(json.challengeId ?? json.json?.challengeId).toBe(challengeId)
    expect(json.proof ?? json.json?.proof).toBe(proof)
    expect(json.tweetUrl ?? json.json?.tweetUrl).toBeUndefined()
    automaticVerifyCount += 1
    await route.fulfill({
      body: JSON.stringify(
        automaticVerifyCount === 1
          ? { code: 'pending', ok: false }
          : { handle: 'tipbotgg', ok: true },
      ),
      contentType: 'application/json',
      status: 200,
    })
  })

  await page.goto(app.url({ to: '/link/x' }))
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await expect(page.getByLabel('X username')).toBeHidden()
  await page.getByRole('button', { name: 'Verify with proof tweet instead' }).click()
  await expect(page.getByLabel('X username')).toBeVisible()
  await page.getByLabel('X username').fill('tipbotgg')
  await page.getByRole('button', { name: 'Prepare proof tweet' }).click()
  await expect(page.getByText(tweetText)).toBeVisible()
  await page.getByRole('button', { name: 'Post connection tweet' }).click()

  await expect(page.getByText('You can now receive and send tips on X.')).toBeVisible({
    timeout: 10_000,
  })
  expect(automaticVerifyCount).toBeGreaterThan(1)
})
