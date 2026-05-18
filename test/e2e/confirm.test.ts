import type { Kysely } from 'kysely'
import * as Confirmation from '#/lib/confirmation.ts'
import * as Tempo from '#/lib/tempo.ts'
import type { DB } from '#db/types.gen.ts'
import { Account } from 'viem/tempo'
import type * as Factory from '../factory.ts'
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
  const senderAccount = await (async () => {
    const existing = await db
      .selectFrom('account')
      .selectAll()
      .where('address', '=', senderRoot.address)
      .executeTakeFirst()
    if (existing) return existing
    try {
      return await factory.account.insert({ address: senderRoot.address })
    } catch (error) {
      if (!(error instanceof Error && /unique constraint/i.test(error.message))) throw error
      return await db
        .selectFrom('account')
        .selectAll()
        .where('address', '=', senderRoot.address)
        .executeTakeFirstOrThrow()
    }
  })()
  const recipientAccount = await (async () => {
    const existing = await db
      .selectFrom('account')
      .selectAll()
      .where('address', '=', recipientRoot.address)
      .executeTakeFirst()
    if (existing) return existing
    try {
      return await factory.account.insert({ address: recipientRoot.address })
    } catch (error) {
      if (!(error instanceof Error && /unique constraint/i.test(error.message))) throw error
      return await db
        .selectFrom('account')
        .selectAll()
        .where('address', '=', recipientRoot.address)
        .executeTakeFirstOrThrow()
    }
  })()
  await insertMember(db, factory, {
    account_id: senderAccount.id,
    provider_user_id: 'U000000001',
    workspace_id: workspace.id,
  })
  await insertMember(db, factory, {
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
  const senderAccount = await (async () => {
    const existing = await db
      .selectFrom('account')
      .selectAll()
      .where('address', '=', senderRoot.address)
      .executeTakeFirst()
    if (existing) return existing
    try {
      return await factory.account.insert({ address: senderRoot.address })
    } catch (error) {
      if (!(error instanceof Error && /unique constraint/i.test(error.message))) throw error
      return await db
        .selectFrom('account')
        .selectAll()
        .where('address', '=', senderRoot.address)
        .executeTakeFirstOrThrow()
    }
  })()
  const firstRecipientAccount = await factory.account.insert({})
  const secondRecipientAccount = await factory.account.insert({})
  await insertMember(db, factory, {
    account_id: senderAccount.id,
    provider_user_id: 'U000000001',
    workspace_id: workspace.id,
  })
  await insertMember(db, factory, {
    account_id: firstRecipientAccount.id,
    provider_user_id: 'U000000002',
    workspace_id: workspace.id,
  })
  await insertMember(db, factory, {
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

async function insertMember(
  db: Kysely<DB>,
  factory: ReturnType<typeof Factory.create>,
  attrs: Partial<DB.Insertable.member> &
    Pick<DB.Insertable.member, 'workspace_id'> & { account_id?: string | null },
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
