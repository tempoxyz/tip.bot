import * as AccessKey from '#/lib/accessKey.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import { expect, test } from './fixture.ts'

test('visitor connects X with OAuth after Tempo ID approves the access key', async ({
  app,
  db,
  page,
}) => {
  await app.tempoId.signIn(page)

  await page.goto(app.url({ to: '/link/x' }))
  await page.getByRole('link', { name: 'Connect X' }).click()
  await expect(page.getByText('Spend $10 per day')).toBeVisible()
  await app.tempoId.approve(page)

  // The callback redirects to X's authorization page, which the suite does not drive.
  await page.waitForURL((url) => url.href.startsWith('https://x.com/i/oauth2/authorize'), {
    waitUntil: 'commit',
  })
  const authorizeUrl = new URL(page.url())
  expect(authorizeUrl.searchParams.get('client_id')).toBe(app.env.TWITTER_OAUTH_CLIENT_ID)
  expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(
    app.url('/api/link/twitter/oauth/callback'),
  )
  const challenge = await db
    .selectFrom('provider_link_challenge')
    .select(['access_key_authorization', 'wallet_address'])
    .orderBy('created_at', 'desc')
    .executeTakeFirstOrThrow()
  expect(challenge.access_key_authorization).toEqual(expect.any(String))
  expect(challenge.wallet_address).not.toBe('0x0000000000000000000000000000000000000000')
})

test('visitor posts the proof tweet, and the page connects once X shows it', async ({
  app,
  db,
  page,
}) => {
  const challengeId = crypto.randomUUID()
  const proof = `tb1_${crypto.randomUUID()}`
  const accessKey = AccessKey.generate()
  const now = new Date()
  await db
    .insertInto('provider_link_challenge')
    .values({
      access_key_address: accessKey.address,
      access_key_authorization: '{}',
      access_key_ciphertext: await AccessKey.encrypt(app.env, accessKey.privateKey),
      access_key_expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), // 1 hour
      access_key_public_key: accessKey.publicKey,
      account_id: null,
      created_at: now.toISOString(),
      expected_provider_handle: '@tipbotuser',
      expected_provider_user_id: '123',
      expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(), // 10 minutes
      id: challengeId,
      proof_hash: await AccountLink.hashToken(app.env, proof),
      provider: 'twitter',
      provider_handle: null,
      provider_user_id: null,
      tweet_id: null,
      updated_at: now.toISOString(),
      used_at: null,
      wallet_address: '0x0000000000000000000000000000000000000001',
    })
    .execute()
  // X's search is outside the suite, so the first check finds no tweet, and the next one finds it.
  let checks = 0
  await page.route('**/api/link/twitter/verify', async (route) => {
    checks += 1
    await route.fulfill({
      body: JSON.stringify(checks < 2 ? { code: 'pending', ok: false } : { ok: true }),
      contentType: 'application/json',
      status: 200,
    })
  })
  await page.addInitScript(() => {
    // The composer opens X in a popup, which the suite does not load.
    Object.assign(globalThis, { open: () => null })
  })

  await page.goto(app.url({ search: { challenge: challengeId, proof }, to: '/link/x' }))
  await page.waitForLoadState('networkidle')

  await expect(page.getByText('@tipbotuser')).toBeVisible()
  await expect(page.getByText(proof)).toBeVisible()
  await page.getByRole('button', { name: 'Post connection tweet' }).click()
  await expect(page.getByRole('heading', { name: 'Connected to Tipbot' })).toBeVisible({
    timeout: 15_000, // 15 seconds, for the second check
  })
})

test('visitor sees an expired proof tweet', async ({ app, page }) => {
  await page.goto(
    app.url({ search: { challenge: crypto.randomUUID(), proof: 'tb1_missing' }, to: '/link/x' }),
  )

  await expect(page.getByText('This proof tweet expired. Start again.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Connect X' })).toHaveAttribute(
    'href',
    '/api/link/twitter/oauth/begin',
  )
})

test('visitor prepares a proof tweet instead of X sign-in', async ({ app, page }) => {
  await page.goto(app.url({ to: '/link/x' }))
  await page.waitForLoadState('networkidle')

  await page.getByRole('button', { name: 'Verify with proof tweet' }).click()

  await expect(page.getByLabel('X username')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Prepare proof tweet' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Connect X' })).toBeHidden()
})
