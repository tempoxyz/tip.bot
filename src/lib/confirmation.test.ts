import { Address } from 'ox'
import { expect, test } from 'vitest'
import * as Confirmation from '#/lib/confirmation.ts'
import * as Tempo from '#/lib/tempo.ts'

const env = { SECRET_KEY: 'test-secret' } satisfies Pick<Env, 'SECRET_KEY'>

test('encrypts and decrypts confirmation payloads', async () => {
  const payload = createPayload()
  const token = await Confirmation.encrypt(env, payload)

  await expect(Confirmation.decrypt(env, token)).resolves.toEqual(payload)
})

test('rejects tampered confirmation tokens', async () => {
  const token = await Confirmation.encrypt(env, createPayload())
  const tampered = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`

  await expect(Confirmation.decrypt(env, tampered)).rejects.toThrow()
})

test('derives stable access keys from confirmation nonces', async () => {
  const first = await Confirmation.deriveAccessKey(env, 'nonce')
  const second = await Confirmation.deriveAccessKey(env, 'nonce')
  const other = await Confirmation.deriveAccessKey(env, 'other')

  expect(first).toEqual(second)
  expect(first.address).not.toBe(other.address)
  expect(Address.validate(first.address)).toBe(true)
})

function createPayload(): Confirmation.Payload {
  return {
    amount: 5_000_000,
    chainId: Tempo.chainLookup.localnet,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
    idempotencyKey: 'confirm:test',
    kind: 'reusable_access_key',
    memo: 'lunch',
    nonce: 'nonce',
    provider: 'slack',
    providerChannelId: 'C000000001',
    providerId: 'T000000001',
    recipientProviderUserId: 'U000000002',
    senderProviderUserId: 'U000000001',
    tokenAddress: Tempo.addressLookup.pathUsd,
    workspaceId: 'workspace',
  }
}
