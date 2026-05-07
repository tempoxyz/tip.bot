export async function decryptSecret(ciphertext: string, secret: string) {
  const json = JSON.parse(atob(ciphertext)) as { data: string; iv: string }
  const key = await getEncryptionKey(secret)
  const decrypted = await crypto.subtle.decrypt(
    { iv: base64ToBytes(json.iv), name: 'AES-GCM' },
    key,
    base64ToBytes(json.data),
  )
  return new TextDecoder().decode(decrypted)
}

export async function encryptSecret(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await getEncryptionKey(secret)
  const encrypted = await crypto.subtle.encrypt(
    { iv, name: 'AES-GCM' },
    key,
    new TextEncoder().encode(value),
  )
  return btoa(
    JSON.stringify({ data: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) }),
  )
}

export async function hashValue(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(digest))
}

async function getEncryptionKey(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'decrypt',
    'encrypt',
  ])
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}

function bytesToBase64(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
}

function bytesToHex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
