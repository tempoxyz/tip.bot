import { AbiFunction, Address, Hex } from 'ox'
import { KeyAuthorization, SignatureEnvelope } from 'ox/tempo'
import { createClient, http, parseUnits } from 'viem'
import { verifyHash } from 'viem/actions'
import { Account as TempoAccount } from 'viem/tempo'
import * as Tempo from './tempo.ts'

export const reusableAccessKeyLimit = 10_000_000
export const reusableAccessKeyLimitText = '10'
export const reusableAccessKeyPeriodSeconds = 24 * 60 * 60 // 1 day
export const reusableAccessKeyTtlMs = 30 * 24 * 60 * 60 * 1000 // 30 days
export const confirmationLinkTtlMs = 10 * 60 * 1000 // 10 minutes

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
  input: {
    accessKeyAddress: string
    chainId: number
    expiresAt: string
    limit?: bigint
    periodSeconds?: number
    tokenAddress: string
  },
) {
  const tokenAddress = Address.checksum(input.tokenAddress)
  const policy = (() => {
    return {
      chainId: BigInt(input.chainId),
      expiry: Math.floor(new Date(input.expiresAt).getTime() / 1000),
      limits: [
        {
          limit: input.limit ?? parseUnits(reusableAccessKeyLimitText, 6),
          period: input.periodSeconds ?? reusableAccessKeyPeriodSeconds,
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
  chainId: number
  env: Pick<Env, 'RPC_URL_MAINNET' | 'RPC_URL_TESTNET'>
  expiresAt: string
  keyAuthorization: unknown
  limit?: bigint
  periodSeconds?: number
  rootAddress: string
  tokenAddress: string
}) {
  const rootAddress = Address.checksum(input.rootAddress)
  const accessKeyAddress = Address.checksum(input.accessKeyAddress)
  const tokenAddress = Address.checksum(input.tokenAddress)
  const authorization = KeyAuthorization.fromRpc(input.keyAuthorization as never)
  const policy = (() => {
    return {
      chainId: BigInt(input.chainId),
      expiry: Math.floor(new Date(input.expiresAt).getTime() / 1000),
      limits: [
        {
          limit: input.limit ?? parseUnits(reusableAccessKeyLimitText, 6),
          period: input.periodSeconds ?? reusableAccessKeyPeriodSeconds,
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
  if (!authorization.expiry) throw new Error('Key authorization expiry is required.')
  if (authorization.expiry <= Math.floor(Date.now() / 1000))
    throw new Error('Key authorization has expired.')
  if (
    !authorization.limits ||
    authorization.limits.length < 1 ||
    !authorization.limits.every((actualLimit) => {
      return Boolean(
        actualLimit.limit > 0n &&
        actualLimit.period &&
        actualLimit.period > 0 &&
        policy.limits.some((limit) =>
          Address.isEqual(actualLimit.token as Address.Address, limit.token as Address.Address),
        ),
      )
    })
  )
    throw new Error('Key authorization limits must apply to the Tipbot token.')
  if (
    !authorization.scopes ||
    authorization.scopes.length < 1 ||
    !authorization.scopes.every((actualScope) => {
      return Boolean(
        policy.scopes.some(
          (scope) =>
            Address.isEqual(
              actualScope.address as Address.Address,
              scope.address as Address.Address,
            ) && actualScope.selector?.toLowerCase() === scope.selector.toLowerCase(),
        ),
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
  const valid = await verifyHash(
    createClient({
      chain: Tempo.getChain(input.chainId),
      transport: http(Tempo.getRpcUrl(input.env, input.chainId)),
    }),
    {
      address: rootAddress,
      hash: KeyAuthorization.getSignPayload(unsigned),
      signature: SignatureEnvelope.serialize(authorization.signature, {
        magic: authorization.signature.type === 'webAuthn',
      }),
    },
  )
  if (!valid) throw new Error('Key authorization signature is invalid.')

  return {
    authorization,
    expiresAt: new Date(Number(authorization.expiry) * 1000).toISOString(),
    rootAddress,
    serialized: JSON.stringify(input.keyAuthorization),
  }
}
