import * as Tempo from '#/lib/tempo.ts'
import { expect, test } from './fixture.ts'

test('visitor opens a confirmed Tipbot receipt', async ({ app, factory, page }) => {
  const transactionHash = `0x${'1'.repeat(64)}`
  const workspace = await factory.workspace.insert({
    chain_id: Tempo.chainLookup.localnet,
    default_token_address: Tempo.addressLookup.pathUsd,
    provider_id: `T${crypto.randomUUID().replaceAll('-', '')}`,
  })
  const senderAccount = await factory.account.insert({})
  const recipientAccount = await factory.account.insert({})
  const senderIdentity = await factory.provider_identity.insert({
    account_id: senderAccount.id,
    display_name: 'alice',
    provider_user_id: 'U000000001',
    provider_workspace_id: workspace.provider_id,
  })
  const recipientIdentity = await factory.provider_identity.insert({
    account_id: recipientAccount.id,
    display_name: 'bob',
    provider_user_id: 'U000000002',
    provider_workspace_id: workspace.provider_id,
  })
  const senderMember = await factory.member.insert({
    provider_user_id: 'U000000001',
    provider_identity_id: senderIdentity.id,
    workspace_id: workspace.id,
  })
  const recipientMember = await factory.member.insert({
    provider_user_id: 'U000000002',
    provider_identity_id: recipientIdentity.id,
    workspace_id: workspace.id,
  })
  const batch = await factory.tip_batch.insert({
    amount_each: 5_000_000,
    idempotency_key: `command:${crypto.randomUUID()}`,
    memo: 'coffee',
    provider: 'slack',
    provider_channel_id: 'C000000001',
    provider_id: workspace.provider_id,
    recipient_count: 1,
    sender_member_id: senderMember.id,
    source: 'command',
    status: 'confirmed',
    token_address: Tempo.addressLookup.pathUsd,
    total_amount: 5_000_000,
    transaction_hash: transactionHash,
    workspace_id: workspace.id,
  })
  await factory.tip.insert({
    amount: 5_000_000,
    batch_id: batch.id,
    chain_id: workspace.chain_id,
    confirmed_at: new Date().toISOString(),
    idempotency_key: batch.idempotency_key,
    recipient_id: recipientAccount.id,
    recipient_member_id: recipientMember.id,
    sender_id: senderAccount.id,
    sender_member_id: senderMember.id,
    token_address: Tempo.addressLookup.pathUsd,
    workspace_id: workspace.id,
  })

  await page.goto(new URL(Tempo.formatReceiptPath(transactionHash), app.baseUrl).toString())

  await expect(page.getByRole('heading', { name: '@alice sent @bob' })).toBeVisible()
  await expect(page.getByText('$5.00').first()).toBeVisible()
  await expect(page.getByText('coffee')).toBeVisible()
  await expect(page.locator('dd').getByText('Tempo', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'View on Tempo Explorer' })).toHaveAttribute(
    'href',
    Tempo.formatTxLink(Tempo.chainLookup.localnet, transactionHash),
  )
})

test('visitor opens a non Tipbot receipt link', async ({ app, page }) => {
  const response = await page.goto(
    new URL(Tempo.formatReceiptPath(`0x${'2'.repeat(64)}`), app.baseUrl).toString(),
  )

  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Receipt not found' })).toBeVisible()
})
