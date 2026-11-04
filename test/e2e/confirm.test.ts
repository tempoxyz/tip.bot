import { Address, Secp256k1 } from 'ox'
import * as AccessKey from '#/lib/accessKey.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import * as Confirmation from '#/lib/confirmation.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as TempoNode from '../tempo.ts'
import { expect, test } from './fixture.ts'
import { insertMember } from './members.ts'

test('visitor opens an expired confirmation link', async ({ app, page }) => {
  await page.goto(app.url('/api/confirm/missing/start'))

  await expect(page).toHaveURL(app.url({ params: { token: 'missing' }, to: '/confirm/$token' }))
  await expect(page.getByRole('heading', { name: 'Confirmation link expired' })).toBeVisible()
  await expect(page.getByText('Run `/tip` again in Slack.')).toBeVisible()
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
    await page.goto(app.url(`/api/account/link/${linkToken}/start`))
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

    await page.goto(app.url(`/api/confirm/${token}/start`))
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
