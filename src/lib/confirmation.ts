import { Address, Hex, PublicKey, Secp256k1 } from 'ox'
import { z } from 'zod'

export const payloadSchema = z.object({
  accessKeyExpiresAt: z.string().min(1).optional(),
  accessKeyLimit: z.string().min(1).optional(),
  amount: z.number().int().positive(),
  chainId: z.number().int().positive(),
  expiresAt: z.string().min(1),
  groupId: z.string().min(1).optional(),
  groupLabel: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  kind: z.enum(['reusable_access_key', 'onetime_payment']),
  memo: z.string().nullable(),
  nonce: z.string().min(1),
  provider: z.enum(['slack', 'telegram']),
  providerChannelId: z.string().min(1),
  providerId: z.string().min(1),
  providerThreadId: z.string().min(1).optional(),
  recipientProviderLabel: z.string().min(1).optional(),
  recipientProviderUserId: z.string().min(1),
  recipientProviderWorkspaceId: z.string().min(1).optional(),
  recipients: z
    .array(
      z.object({
        recipientProviderLabel: z.string().min(1).optional(),
        recipientProviderUserId: z.string().min(1),
        recipientProviderWorkspaceId: z.string().min(1).optional(),
      }),
    )
    .optional(),
  senderProviderUserId: z.string().min(1),
  skippedRecipients: z
    .array(
      z.object({
        reason: z.enum(['not_connected', 'you']),
        recipientProviderLabel: z.string().min(1).optional(),
        recipientProviderUserId: z.string().min(1),
      }),
    )
    .optional(),
  source: z.enum(['command', 'mention', 'reaction']).optional(),
  tokenAddress: z.string().min(1),
  workspaceId: z.string().min(1),
})

export type Payload = z.infer<typeof payloadSchema>

export async function encrypt(env: Pick<Env, 'SECRET_KEY'>, payload: Payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { iv, name: 'AES-GCM' },
    await getAesKey(env, ['encrypt']),
    new TextEncoder().encode(JSON.stringify(payload)),
  )
  return `${Hex.fromBytes(iv)}.${Hex.fromBytes(new Uint8Array(encrypted))}`
}

export async function decrypt(env: Pick<Env, 'SECRET_KEY'>, token: string) {
  const [iv, encrypted] = token.split('.')
  if (!iv || !encrypted) throw new Error('Confirmation link is invalid.')
  const decrypted = await crypto.subtle.decrypt(
    { iv: new Uint8Array(Hex.toBytes(iv as Hex.Hex)), name: 'AES-GCM' },
    await getAesKey(env, ['decrypt']),
    new Uint8Array(Hex.toBytes(encrypted as Hex.Hex)),
  )
  return payloadSchema.parse(JSON.parse(new TextDecoder().decode(decrypted)))
}

export async function deriveAccessKey(env: Pick<Env, 'SECRET_KEY'>, nonce: string) {
  for (let index = 0; index < 8; index++) {
    const privateKey = Hex.fromBytes(await sign(env, `${nonce}:${index}`))
    try {
      const publicKey = Secp256k1.getPublicKey({ privateKey })
      return {
        address: Address.checksum(Address.fromPublicKey(publicKey)),
        privateKey,
        publicKey: PublicKey.toHex(publicKey),
      }
    } catch {
      // Try another deterministic candidate if the digest is not a valid secp256k1 key.
    }
  }
  throw new Error('Could not derive access key.')
}

async function getAesKey(env: Pick<Env, 'SECRET_KEY'>, usages: ('decrypt' | 'encrypt')[]) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SECRET_KEY))
  return await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, usages)
}

async function sign(env: Pick<Env, 'SECRET_KEY'>, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SECRET_KEY),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
}
