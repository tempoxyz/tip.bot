import { Address } from 'ox'
import { expect, test } from 'vitest'
import * as AccessKey from '#/lib/accessKey.ts'

test('generates account access keys', () => {
  const accessKey = AccessKey.generate()

  expect(Address.validate(accessKey.address)).toBe(true)
  expect(accessKey.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
  expect(accessKey.publicKey).toMatch(/^0x[0-9a-f]+$/)
})

test('encrypts access keys', async () => {
  const env = { SECRET_KEY: 'test-secret' } satisfies Pick<Env, 'SECRET_KEY'>
  const accessKey = AccessKey.generate()

  await expect(AccessKey.encrypt(env, accessKey.privateKey)).resolves.toMatch(
    /^0x[0-9a-f]+\.0x[0-9a-f]+$/,
  )
})

test('decrypts encrypted access keys', async () => {
  const env = { SECRET_KEY: 'test-secret' } satisfies Pick<Env, 'SECRET_KEY'>
  const accessKey = AccessKey.generate()
  const ciphertext = await AccessKey.encrypt(env, accessKey.privateKey)

  await expect(AccessKey.decrypt(env, ciphertext)).resolves.toBe(accessKey.privateKey)
})

test('rejects invalid encrypted access keys', async () => {
  const env = { SECRET_KEY: 'test-secret' } satisfies Pick<Env, 'SECRET_KEY'>
  const accessKey = AccessKey.generate()
  const ciphertext = await AccessKey.encrypt(env, accessKey.privateKey)

  await expect(AccessKey.decrypt(env, 'invalid')).rejects.toThrow(
    'Access key ciphertext is invalid.',
  )
  await expect(AccessKey.decrypt({ SECRET_KEY: 'other-secret' }, ciphertext)).rejects.toThrow()
})
