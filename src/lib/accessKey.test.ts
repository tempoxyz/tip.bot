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
