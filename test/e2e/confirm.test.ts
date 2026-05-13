import * as Confirmation from '#/lib/confirmation.ts'
import * as Tempo from '#/lib/tempo.ts'
import { Account } from 'viem/tempo'
import { expect, test } from './fixture.ts'

test('visitor opens an expired confirmation link', async ({ app, page }) => {
  await page.goto(app.url({ params: { token: 'missing' }, to: '/confirm/$token' }))

  await expect(page.getByRole('heading', { name: 'Confirmation link expired' })).toBeVisible()
  await expect(page.getByText('Run `/tip` again in Slack.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm payment' })).toBeHidden()
})

test('slack member opens valid confirmation link', async ({ app, page }) => {
  const token = await Confirmation.encrypt(app.env, {
    amount: 5_000_000,
    chainId: Tempo.chainLookup.localnet,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
    idempotencyKey: `confirm:${crypto.randomUUID()}`,
    kind: 'reusable_access_key',
    memo: 'lunch',
    nonce: crypto.randomUUID(),
    provider: 'slack',
    providerChannelId: 'C000000001',
    providerId: 'T000000001',
    recipientProviderUserId: 'U000000002',
    senderProviderUserId: 'U000000001',
    tokenAddress: Tempo.addressLookup.pathUsd,
    workspaceId: crypto.randomUUID(),
  })

  await page.goto(app.url({ params: { token }, to: '/confirm/$token' }))

  await expect(page.getByRole('heading', { name: 'Confirm payment' })).toBeVisible()
  await expect(page.getByText('Send $5.00 PathUSD to U000000002 for lunch.')).toBeVisible()
  await expect(page.getByText('Tipbot can send future PathUSD tips from Slack')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm payment' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Cancel' })).toBeVisible()
})

test('slack member confirms payment with wallet approval', async ({ app, page }) => {
  const root = Account.fromSecp256k1(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  )
  const token = await Confirmation.encrypt(app.env, {
    amount: 5_000_000,
    chainId: Tempo.chainLookup.localnet,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
    idempotencyKey: `confirm:${crypto.randomUUID()}`,
    kind: 'reusable_access_key',
    memo: 'lunch',
    nonce: crypto.randomUUID(),
    provider: 'slack',
    providerChannelId: 'C000000001',
    providerId: 'T000000001',
    recipientProviderUserId: 'U000000002',
    senderProviderUserId: 'U000000001',
    tokenAddress: Tempo.addressLookup.pathUsd,
    workspaceId: crypto.randomUUID(),
  })
  await page.route('**/api/confirm/*', async (route) => {
    if (route.request().method() !== 'POST') return await route.continue()

    const json = route.request().postDataJSON() as {
      address?: string
      keyAuthorization?: unknown
    }
    expect(json.address).toBe(root.address)
    expect(json.keyAuthorization).toEqual(expect.any(Object))
    await route.fulfill({
      body: JSON.stringify({ ok: true, transactionHash: `0x${'1'.repeat(64)}` }),
      contentType: 'application/json',
      status: 200,
    })
  })

  await page.goto(app.url({ params: { token }, to: '/confirm/$token' }))
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: 'Confirm payment' })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm payment' }).click()

  await expect(page.getByRole('heading', { name: 'Payment sent' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'View receipt' })).toHaveAttribute(
    'href',
    Tempo.formatTxLink(Tempo.chainLookup.localnet, `0x${'1'.repeat(64)}`),
  )
  await expect(page.getByText('You can close this tab and return to Slack.')).toBeVisible()
})
