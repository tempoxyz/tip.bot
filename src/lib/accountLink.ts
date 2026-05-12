import { AbiFunction, Address, Hex } from 'ox'
import { KeyAuthorization, SignatureEnvelope } from 'ox/tempo'
import { createClient, http, parseUnits } from 'viem'
import { verifyHash } from 'viem/actions'
import { Account as TempoAccount } from 'viem/tempo'
import * as Tempo from '#/lib/tempo.ts'

export async function hashToken(env: Pick<Env, 'SECRET_KEY'>, token: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SECRET_KEY),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token))
  return Hex.fromBytes(new Uint8Array(digest))
}

export async function signKeyAuthorization(
  account: ReturnType<typeof TempoAccount.fromSecp256k1>,
  input: { accessKeyAddress: string; expiresAt: string; tokenAddress: string },
) {
  const tokenAddress = Address.checksum(input.tokenAddress)
  const policy = (() => {
    return {
      chainId: BigInt(Tempo.chain.id),
      expiry: Math.floor(new Date(input.expiresAt).getTime() / 1000),
      limits: [
        {
          limit: parseUnits('10', 6),
          period: 24 * 60 * 60, // 1 day
          token: tokenAddress,
        },
      ],
      scopes: [
        { address: tokenAddress, selector: AbiFunction.getSelector('transfer(address,uint256)') },
        {
          address: tokenAddress,
          selector: AbiFunction.getSelector('transferWithMemo(address,uint256,bytes32)'),
        },
      ],
    } as const
  })()
  return KeyAuthorization.toRpc(
    await account.signKeyAuthorization(
      { accessKeyAddress: input.accessKeyAddress, keyType: 'secp256k1' },
      {
        chainId: policy.chainId,
        expiry: policy.expiry,
        limits: policy.limits,
        scopes: policy.scopes,
      },
    ),
  )
}

export async function verifyKeyAuthorization(input: {
  accessKeyAddress: string
  expiresAt: string
  keyAuthorization: unknown
  rootAddress: string
  tokenAddress: string
}) {
  const rootAddress = Address.checksum(input.rootAddress)
  const accessKeyAddress = Address.checksum(input.accessKeyAddress)
  const tokenAddress = Address.checksum(input.tokenAddress)
  const authorization = KeyAuthorization.fromRpc(input.keyAuthorization as never)
  const policy = (() => {
    return {
      chainId: BigInt(Tempo.chain.id),
      expiry: Math.floor(new Date(input.expiresAt).getTime() / 1000),
      limits: [
        {
          limit: parseUnits('10', 6),
          period: 24 * 60 * 60, // 1 day
          token: tokenAddress,
        },
      ],
      scopes: [
        { address: tokenAddress, selector: AbiFunction.getSelector('transfer(address,uint256)') },
        {
          address: tokenAddress,
          selector: AbiFunction.getSelector('transferWithMemo(address,uint256,bytes32)'),
        },
      ],
    } as const
  })()

  if (!Address.isEqual(authorization.address, accessKeyAddress))
    throw new Error('Key authorization does not match link access key.')
  if (authorization.type !== 'secp256k1')
    throw new Error('Key authorization type does not match link access key.')
  if (authorization.chainId !== policy.chainId)
    throw new Error('Key authorization chain does not match Tipbot policy.')
  if (authorization.expiry !== policy.expiry)
    throw new Error('Key authorization expiry does not match Tipbot policy.')
  if (
    !authorization.limits ||
    authorization.limits.length !== policy.limits.length ||
    !policy.limits.every((limit, index) => {
      const actualLimit = authorization.limits?.[index]
      return Boolean(
        actualLimit &&
        actualLimit.limit === limit.limit &&
        actualLimit.period === limit.period &&
        Address.isEqual(actualLimit.token as Address.Address, limit.token as Address.Address),
      )
    })
  )
    throw new Error('Key authorization limits do not match Tipbot policy.')
  if (
    !authorization.scopes ||
    authorization.scopes.length !== policy.scopes.length ||
    !policy.scopes.every((scope, index) => {
      const actualScope = authorization.scopes?.[index]
      return Boolean(
        actualScope &&
        Address.isEqual(actualScope.address as Address.Address, scope.address as Address.Address) &&
        actualScope.selector?.toLowerCase() === scope.selector.toLowerCase(),
      )
    })
  )
    throw new Error('Key authorization scopes do not match Tipbot policy.')

  const unsigned = KeyAuthorization.from({
    address: authorization.address,
    chainId: authorization.chainId,
    expiry: authorization.expiry,
    limits: authorization.limits,
    scopes: authorization.scopes,
    type: authorization.type,
  })
  const valid = await verifyHash(createClient({ chain: Tempo.chain, transport: http() }), {
    address: rootAddress,
    hash: KeyAuthorization.getSignPayload(unsigned),
    signature: SignatureEnvelope.serialize(authorization.signature, {
      magic: authorization.signature.type === 'webAuthn',
    }),
  })
  if (!valid) throw new Error('Key authorization signature is invalid.')

  return {
    authorization,
    rootAddress,
    serialized: JSON.stringify(input.keyAuthorization),
  }
}
