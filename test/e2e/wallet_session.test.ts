import * as Confirmation from '#/lib/confirmation.ts'
import * as Tempo from '#/lib/tempo.ts'
import { expect, test } from './fixture.ts'

for (const lostSession of [true, false])
  test(`confirmation ${lostSession ? 'recovers a lost wallet session' : 'preserves a genuine wallet decline'}`, async ({
    app,
    page,
  }) => {
    const token = await Confirmation.encrypt(app.env, {
      amount: 1_000,
      chainId: Tempo.chainLookup.localnet,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
      idempotencyKey: `confirm:${crypto.randomUUID()}`,
      kind: 'reusable_access_key',
      memo: null,
      nonce: crypto.randomUUID(),
      provider: 'slack',
      providerChannelId: 'C000000001',
      providerId: 'T000000001',
      recipientProviderUserId: 'U000000002',
      senderProviderUserId: 'U000000001',
      tokenAddress: Tempo.addressLookup.pathUsd,
      workspaceId: crypto.randomUUID(),
    })
    // Replace only the test connector at the browser module boundary. The real
    // confirmation component, Wagmi state, and recovery logic remain unchanged.
    await page.route('**/src/components/WalletProviders.tsx*', async (route) => {
      const response = await route.fetch()
      const body = await response.text()
      expect(body).toContain('dangerous_secp256k1({')
      await route.fulfill({
        body: body.replace('dangerous_secp256k1({', 'window.__confirmationTestConnector({'),
        response,
      })
    })
    await page.addInitScript((loseAccount) => {
      const address = '0x1111111111111111111111111111111111111111'
      const state = { connects: 0, disconnects: 0, hasAccount: true }
      Object.assign(globalThis, {
        __confirmationTestState: state,
        __confirmationTestConnector: () => () => ({
          id: 'confirmation-test',
          name: 'Confirmation test wallet',
          type: 'mock',
          async connect() {
            state.connects++
            if (state.connects === 1) {
              if (loseAccount) state.hasAccount = false
              throw Object.assign(new Error('The user rejected the request.'), { code: 4001 })
            }
            state.hasAccount = true
            return {
              accounts: [{ address, capabilities: { keyAuthorization: { test: true } } }],
              chainId: 1337,
            }
          },
          async disconnect() {
            state.disconnects++
            state.hasAccount = false
          },
          async getAccounts() {
            return state.hasAccount ? [address] : []
          },
          async getChainId() {
            return 1337
          },
          async getProvider() {
            return {
              async request() {
                return state.hasAccount ? [address] : []
              },
            }
          },
          async isAuthorized() {
            return false
          },
          onAccountsChanged() {},
          onChainChanged() {},
          onDisconnect() {},
        }),
      })
    }, lostSession)
    let submissions = 0
    await page.route('**/api/confirm/*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      submissions++
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, transactionHash: `0x${'1'.repeat(64)}` }),
      })
    })
    await page.goto(app.url({ params: { token }, to: '/confirm/$token' }))
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Confirm payment' }).click()
    await expect(
      page.getByText(
        lostSession
          ? 'Your wallet session expired. Select Confirm payment to reconnect and try again.'
          : 'Request rejected.',
        { exact: true },
      ),
    ).toBeVisible()
    expect(submissions).toBe(0)
    expect(
      await page.evaluate(() => Reflect.get(globalThis, '__confirmationTestState').connects),
    ).toBe(1)
    if (!lostSession) return
    await page.getByRole('button', { name: 'Confirm payment' }).click()
    await expect(page.getByRole('heading', { name: 'Payment sent' })).toBeVisible()
    expect(submissions).toBe(1)
    expect(
      await page.evaluate(() => Reflect.get(globalThis, '__confirmationTestState').disconnects),
    ).toBe(1)
  })
