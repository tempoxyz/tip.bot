import { Address, Secp256k1 } from 'ox'
import * as AccessKey from '#/lib/accessKey.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as Confirmation from '#/lib/confirmation.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as TempoNode from '../tempo.ts'
import { expect, test } from './fixture.ts'
import { insertMember } from './members.ts'

test('visitor opens an expired confirmation link', async ({ app, page }) => {
  await page.goto(app.url({ params: { token: 'missing' }, to: '/confirm/$token' }))

  await expect(page.getByRole('heading', { name: 'Confirmation link expired' })).toBeVisible()
  await expect(page.getByText('Run `/tip` again in Slack.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Confirm payment' })).toBeHidden()
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
  await expect(page.getByText('Approve this payment with Tempo ID.')).toBeVisible()
  await expect(page.getByText('$5.00 PathUSD')).toBeVisible()
  await expect(page.getByText('@member')).toBeVisible()
  await expect(page.getByText('lunch')).toBeVisible()
  await expect(page.getByText('Tipbot can send future PathUSD tips from Slack')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Confirm payment' })).toBeVisible()
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

test('slack member opens group confirmation link with skipped recipients', async ({
  app,
  page,
}) => {
  const token = await Confirmation.encrypt(app.env, {
    accessKeyExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    accessKeyLimit: '3000000',
    amount: 1_000,
    chainId: Tempo.chainLookup.localnet,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
    groupLabel: 'engineering',
    idempotencyKey: `confirm:${crypto.randomUUID()}`,
    kind: 'reusable_access_key',
    memo: 'coffee',
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
    skippedRecipients: [
      { reason: 'not_connected', recipientProviderLabel: 'boo', recipientProviderUserId: 'UBOO' },
      { reason: 'you', recipientProviderLabel: 'joshie', recipientProviderUserId: 'UJOSHIE' },
    ],
    tokenAddress: Tempo.addressLookup.pathUsd,
    workspaceId: crypto.randomUUID(),
  })

  await page.goto(app.url({ params: { token }, to: '/confirm/$token' }))

  await expect(page.getByText('Group')).toBeVisible()
  await expect(page.getByText('@engineering')).toBeVisible()
  await expect(page.getByText('Skipped')).toBeVisible()
  await expect(page.getByText('@boo (not connected yet)')).toBeVisible()
  await expect(page.getByText('@joshie (you)')).toBeVisible()
  await expect(page.getByText('$0.001 PathUSD each')).toBeVisible()
  await expect(page.getByText('$0.002 PathUSD')).toBeVisible()
  await expect(page.getByText('coffee')).toBeVisible()
})

for (const kind of ['onetime_payment', 'reusable_access_key'] as const)
  test(`slack member confirms a ${kind === 'onetime_payment' ? 'one-time payment' : 'payment with a reusable access key'} with Tempo ID`, async ({
    app,
    db,
    factory,
    page,
  }) => {
    const workspace = await factory.workspace.insert({
      chain_id: Tempo.chainLookup.localnet,
      provider_id: `T${crypto.randomUUID()}`,
    })
    const recipient = await insertMember(db, factory, {
      account_id: (
        await factory.account.insert({
          address: Address.fromPublicKey(
            Secp256k1.getPublicKey({ privateKey: Secp256k1.randomPrivateKey() }),
          ),
        })
      ).id,
      provider_user_id: `U${crypto.randomUUID()}`,
      workspace_id: workspace.id,
    })
    const sender = await insertMember(db, factory, {
      provider_user_id: `U${crypto.randomUUID()}`,
      workspace_id: workspace.id,
    })
    const linkToken = crypto.randomUUID()
    const accessKey = AccessKey.generate()
    await factory.account_link_token.insert({
      access_key_address: accessKey.address,
      access_key_ciphertext: await AccessKey.encrypt(app.env, accessKey.privateKey),
      access_key_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      access_key_public_key: accessKey.publicKey,
      member_id: sender.id,
      token_hash: await AccountLink.hashToken(app.env, linkToken),
    })

    // The sender connects a Tempo Account, which then holds funds on the local chain.
    await app.tempoId.signIn(page)
    await page.goto(app.url({ params: { token: linkToken }, to: '/connect/$token' }))
    await page.getByRole('link', { name: 'Connect' }).click()
    await app.tempoId.approve(page)
    await expect(page.getByRole('heading', { name: 'Connected to Tipbot' })).toBeVisible()
    const senderAccount = await db
      .selectFrom('member')
      .innerJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
      .innerJoin('account', 'account.id', 'provider_identity.account_id')
      .select('account.address')
      .where('member.id', '=', sender.id)
      .executeTakeFirstOrThrow()
    await TempoNode.mint({
      amount: '10',
      feePayer: app.env.FEE_PAYER_PRIVATE_KEY_TESTNET,
      rpcUrl: app.env.RPC_URL_TESTNET!,
      to: senderAccount.address,
    })
    const idempotencyKey = `confirm:${crypto.randomUUID()}`
    const token = await Confirmation.encrypt(app.env, {
      amount: 1_000_000,
      chainId: Tempo.chainLookup.localnet,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
      idempotencyKey,
      kind,
      memo: 'lunch',
      nonce: crypto.randomUUID(),
      provider: 'slack',
      providerChannelId: 'C000000001',
      providerId: workspace.provider_id,
      recipientProviderUserId: recipient.provider_user_id,
      senderProviderUserId: sender.provider_user_id,
      tokenAddress: Tempo.addressLookup.pathUsd,
      workspaceId: workspace.id,
    })

    await page.goto(app.url({ params: { token }, to: '/confirm/$token' }))
    await page.getByRole('link', { name: 'Confirm payment' }).click()
    await expect(
      page.getByText(kind === 'onetime_payment' ? 'Spend $1' : 'Spend $10 per day'),
    ).toBeVisible()
    await app.tempoId.approve(page)

    await expect(page.getByRole('heading', { name: 'Payment sent' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'View receipt' })).toBeVisible()
    const tip = await db
      .selectFrom('tip')
      .select('confirmed_at')
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirstOrThrow()
    expect(tip.confirmed_at).toEqual(expect.any(String))
  })
