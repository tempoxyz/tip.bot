import { Address, Hex, PublicKey, Secp256k1 } from 'ox'

export function generate() {
  const privateKey = Secp256k1.randomPrivateKey()
  const publicKey = Secp256k1.getPublicKey({ privateKey })
  return {
    address: Address.checksum(Address.fromPublicKey(publicKey)),
    privateKey,
    publicKey: PublicKey.toHex(publicKey),
  }
}

export async function encrypt(env: Pick<Env, 'SECRET_KEY'>, privateKey: Hex.Hex) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const privateKeyBytes = new Uint8Array(Hex.toBytes(privateKey).length)
  privateKeyBytes.set(Hex.toBytes(privateKey))
  const encrypted = await crypto.subtle.encrypt(
    { iv, name: 'AES-GCM' },
    await (async () => {
      // Derive a fixed-length AES-GCM key from the app secret.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SECRET_KEY))
      return await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt'])
    })(),
    privateKeyBytes,
  )
  return `${Hex.fromBytes(iv)}.${Hex.fromBytes(new Uint8Array(encrypted))}`
}
