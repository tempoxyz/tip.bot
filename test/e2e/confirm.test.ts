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
    recipientProviderLabel: 'member',
    recipientProviderUserId: 'U000000002',
    senderProviderUserId: 'U000000001',
    tokenAddress: Tempo.addressLookup.pathUsd,
    workspaceId: crypto.randomUUID(),
  })

  await page.goto(app.url({ params: { token }, to: '/confirm/$token' }))

  await expect(page.getByRole('heading', { name: 'Confirm payment' })).toBeVisible()
  await expect(page.getByText('Approve this payment in Tempo Wallet.')).toBeVisible()
  await expect(page.getByText('$5.00 PathUSD')).toBeVisible()
  await expect(page.getByText('@member')).toBeVisible()
  await expect(page.getByText('lunch')).toBeVisible()
  await expect(page.getByText('Tipbot can send future PathUSD tips from Slack')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm payment' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Cancel' })).toBeVisible()
})

test('slack member opens valid multi-recipient confirmation link', async ({ app, page }) => {
  const token = await Confirmation.encrypt(app.env, {
    accessKeyExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    accessKeyLimit: '3000000',
    amount: 1_500_000,
    chainId: Tempo.chainLookup.localnet,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
    idempotencyKey: `confirm:${crypto.randomUUID()}`,
    kind: 'reusable_access_key',
    memo: 'team lunch',
    nonce: crypto.randomUUID(),
    provider: 'slack',
    providerChannelId: 'C000000001',
    providerId: 'T000000001',
    recipientProviderLabel: 'foo',
    recipientProviderUserId: 'U000000002',
    recipients: [
      { recipientProviderLabel: 'foo', recipientProviderUserId: 'U000000002' },
      { recipientProviderLabel: 'bar', recipientProviderUserId: 'U000000003' },
    ],
    senderProviderUserId: 'U000000001',
    tokenAddress: Tempo.addressLookup.pathUsd,
    workspaceId: crypto.randomUUID(),
  })

  await page.goto(app.url({ params: { token }, to: '/confirm/$token' }))

  await expect(page.getByRole('heading', { name: 'Confirm payment' })).toBeVisible()
  await expect(page.getByText('$1.50 PathUSD each')).toBeVisible()
  await expect(page.getByText('Total')).toBeVisible()
  await expect(page.getByText('$3.00 PathUSD')).toBeVisible()
  await expect(page.getByText('@foo')).toBeVisible()
  await expect(page.getByText('@bar')).toBeVisible()
  await expect(page.getByText('team lunch')).toBeVisible()
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
    recipientProviderLabel: 'member',
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

test('slack member confirms one-time payment with wallet signature', async ({
  app,
  db,
  factory,
  page,
}) => {
  const senderRoot = Account.fromSecp256k1(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  )
  const recipientRoot = Account.fromSecp256k1(
    '0x0000000000000000000000000000000000000000000000000000000000000002',
  )
  const workspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.testnet,
    provider_id: `T${crypto.randomUUID().replaceAll('-', '')}`,
  })
  const senderAccount =
    (await db
      .selectFrom('account')
      .selectAll()
      .where('address', '=', senderRoot.address)
      .executeTakeFirst()) ?? (await factory.account.insert({ address: senderRoot.address }))
  const recipientAccount =
    (await db
      .selectFrom('account')
      .selectAll()
      .where('address', '=', recipientRoot.address)
      .executeTakeFirst()) ?? (await factory.account.insert({ address: recipientRoot.address }))
  await factory.member.insert({
    account_id: senderAccount.id,
    provider_user_id: 'U000000001',
    workspace_id: workspace.id,
  })
  await factory.member.insert({
    account_id: recipientAccount.id,
    provider_user_id: 'U000000002',
    workspace_id: workspace.id,
  })
  const token = await Confirmation.encrypt(app.env, {
    amount: 11_000_000,
    chainId: Tempo.chainLookup.testnet,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
    idempotencyKey: `confirm:${crypto.randomUUID()}`,
    kind: 'onetime_payment',
    memo: 'lunch',
    nonce: crypto.randomUUID(),
    provider: 'slack',
    providerChannelId: 'C000000001',
    providerId: workspace.provider_id,
    recipientProviderLabel: 'member',
    recipientProviderUserId: 'U000000002',
    senderProviderUserId: 'U000000001',
    tokenAddress: Tempo.addressLookup.pathUsd,
    workspaceId: workspace.id,
  })
  await page.route('**/api/confirm/*', async (route) => {
    if (route.request().method() !== 'POST') return await route.continue()

    const json = route.request().postDataJSON() as {
      address?: string
      keyAuthorization?: unknown
      signedTransaction?: string
    }
    expect(json.address).toBe(senderRoot.address)
    expect(json.keyAuthorization).toBeUndefined()
    expect(json.signedTransaction).toMatch(/^0x[0-9a-f]+$/)
    await route.fulfill({
      body: JSON.stringify({ ok: true, transactionHash: `0x${'2'.repeat(64)}` }),
      contentType: 'application/json',
      status: 200,
    })
  })

  await page.goto(app.url({ params: { token }, to: '/confirm/$token' }))
  await page.waitForLoadState('networkidle')
  await expect(page.getByText('Tipbot will use this approval once')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm payment' }).click()

  await expect(page.getByRole('heading', { name: 'Payment sent' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'View receipt' })).toHaveAttribute(
    'href',
    Tempo.formatTxLink(Tempo.chainLookup.testnet, `0x${'2'.repeat(64)}`),
  )
})

test('slack member confirms multi-recipient one-time payment with wallet signature', async ({
  app,
  db,
  factory,
  page,
}) => {
  const senderRoot = Account.fromSecp256k1(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  )
  const workspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.testnet,
    provider_id: `T${crypto.randomUUID().replaceAll('-', '')}`,
  })
  const senderAccount =
    (await db
      .selectFrom('account')
      .selectAll()
      .where('address', '=', senderRoot.address)
      .executeTakeFirst()) ?? (await factory.account.insert({ address: senderRoot.address }))
  const firstRecipientAccount = await factory.account.insert({})
  const secondRecipientAccount = await factory.account.insert({})
  await factory.member.insert({
    account_id: senderAccount.id,
    provider_user_id: 'U000000001',
    workspace_id: workspace.id,
  })
  await factory.member.insert({
    account_id: firstRecipientAccount.id,
    provider_user_id: 'U000000002',
    workspace_id: workspace.id,
  })
  await factory.member.insert({
    account_id: secondRecipientAccount.id,
    provider_user_id: 'U000000003',
    workspace_id: workspace.id,
  })
  const token = await Confirmation.encrypt(app.env, {
    amount: 1_500_000,
    chainId: Tempo.chainLookup.testnet,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
    idempotencyKey: `confirm:${crypto.randomUUID()}`,
    kind: 'onetime_payment',
    memo: 'team lunch',
    nonce: crypto.randomUUID(),
    provider: 'slack',
    providerChannelId: 'C000000001',
    providerId: workspace.provider_id,
    recipientProviderLabel: 'foo',
    recipientProviderUserId: 'U000000002',
    recipients: [
      { recipientProviderLabel: 'foo', recipientProviderUserId: 'U000000002' },
      { recipientProviderLabel: 'bar', recipientProviderUserId: 'U000000003' },
    ],
    senderProviderUserId: 'U000000001',
    tokenAddress: Tempo.addressLookup.pathUsd,
    workspaceId: workspace.id,
  })
  await page.route('**/api/confirm/*', async (route) => {
    if (route.request().method() !== 'POST') return await route.continue()

    const json = route.request().postDataJSON() as {
      address?: string
      keyAuthorization?: unknown
      signedTransaction?: string
    }
    expect(json.address).toBe(senderRoot.address)
    expect(json.keyAuthorization).toBeUndefined()
    expect(json.signedTransaction).toMatch(/^0x[0-9a-f]+$/)
    await route.fulfill({
      body: JSON.stringify({ ok: true, transactionHash: `0x${'3'.repeat(64)}` }),
      contentType: 'application/json',
      status: 200,
    })
  })

  await page.goto(app.url({ params: { token }, to: '/confirm/$token' }))
  await page.waitForLoadState('networkidle')
  await expect(page.getByText('$1.50 PathUSD each')).toBeVisible()
  await expect(page.getByText('$3.00 PathUSD')).toBeVisible()
  await expect(page.getByText('@foo')).toBeVisible()
  await expect(page.getByText('@bar')).toBeVisible()
  await expect(page.getByText('Tipbot will use this approval once')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm payment' }).click()

  await expect(page.getByRole('heading', { name: 'Payment sent' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'View receipt' })).toHaveAttribute(
    'href',
    Tempo.formatTxLink(Tempo.chainLookup.testnet, `0x${'3'.repeat(64)}`),
  )
})
