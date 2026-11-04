import { Accounts } from 'accounts'
import { DurableObject } from 'accounts/cloudflare'
import { backend } from 'accounts/plugins'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { AbiFunction, Address, Base64, PublicKey, Secp256k1 } from 'ox'
import { z } from 'zod'
import * as AccessKey from '#/lib/accessKey.ts'
import * as Tempo from '#/lib/tempo.ts'

// Holds each Tempo ID session in its own Durable Object, so concurrent requests of a session share
// one refresh, and the refresh token and access key never reach the browser.
export const Sessions = DurableObject.sessions((env: Env) => ({
  clientSecret: env.TEMPO_ID_CLIENT_SECRET,
  url: env.TEMPO_ID_URL,
}))

const cookieOptions = {
  httpOnly: true,
  path: '/',
  prefix: 'host',
  sameSite: 'Lax',
  secure: true,
} as const

const sessionCookie = 'tempo_id'
const intentCookie = 'tempo_id_intent'

// What the callback does once Tempo ID returns, set at the start of each sign-in.
const intentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('confirm'), token: z.string().min(1) }),
  z.object({ kind: z.literal('dash') }),
  z.object({ kind: z.literal('link'), token: z.string().min(1) }),
  z.object({ challengeId: z.string().min(1), kind: z.literal('x_oauth') }),
  z.object({ challengeId: z.string().min(1), kind: z.literal('x_proof') }),
])

export type Intent = z.infer<typeof intentSchema>

export function create(env: Env) {
  return Accounts.create({
    clientId: env.TEMPO_ID_CLIENT_ID,
    clientSecret: env.TEMPO_ID_CLIENT_SECRET,
    plugins: [backend({ namespace: env.TEMPO_ID_SESSIONS })],
    url: env.TEMPO_ID_URL,
  })
}

/**
 * Returns the permissions of a Tipbot access key: a limit on one token, with `transfer` and
 * `transferWithMemo` on it, to `recipients` alone when it names them.
 */
export function permissions(input: {
  chainId: number
  expiresAt: string
  limit: bigint
  periodSeconds: number
  recipients?: readonly string[] | undefined
  tokenAddress: string
}) {
  const token = Address.checksum(input.tokenAddress)
  const recipients = input.recipients?.map((recipient) => Address.checksum(recipient))
  return {
    chainId: input.chainId,
    expiry: Math.floor(new Date(input.expiresAt).getTime() / 1000),
    limits: [{ limit: input.limit, period: input.periodSeconds, token }],
    // Named scopes replace the defaults, which also allow the MPP channel reserve.
    scopes: ['transfer(address,uint256)', 'transferWithMemo(address,uint256,bytes32)'].map(
      (signature) => ({
        address: token,
        selector: AbiFunction.getSelector(signature),
        ...(recipients ? { recipients } : {}),
      }),
    ),
  }
}

/**
 * Returns the funding hint of a sign-in: $1, in USDC.e on mainnet. Other chains list no USDC.e, so
 * any US dollar token counts there.
 */
export function funding(chainId: number) {
  return chainId === Tempo.chainLookup.mainnet
    ? { amount: '1', token: 'USDC.e' }
    : { amount: '1', currency: 'USD' }
}

/** Starts a Tempo ID sign-in, and returns the URL of Tempo ID's page. */
export async function start<env extends { Bindings: Env }>(
  c: Context<env>,
  input: {
    accessKey?: ReturnType<typeof permissions> | undefined
    funding?: ReturnType<typeof funding> | undefined
    intent: Intent
  },
) {
  const started = await create(c.env).backend.start({
    accessKey: input.accessKey ?? false,
    ...(input.funding ? { funding: input.funding } : {}),
    redirectUri: new URL('/api/auth/callback', c.req.url).toString(),
  })
  setCookie(c, sessionCookie, started.id, cookieOptions)
  setCookie(
    c,
    intentCookie,
    Base64.fromString(JSON.stringify(input.intent), { url: true }),
    cookieOptions,
  )
  return started.url
}

/**
 * Redeems Tempo ID's callback, and returns its intent and session. Returns `undefined` without a
 * sign-in in progress, such as for a callback that arrives twice.
 */
export async function complete<env extends { Bindings: Env }>(c: Context<env>) {
  const id = getCookie(c, sessionCookie, 'host')
  const intent = readIntent(getCookie(c, intentCookie, 'host'))
  deleteCookie(c, intentCookie, cookieOptions)
  if (!id || !intent) return undefined
  const session = await create(c.env).backend.complete({ id, url: c.req.url })
  return { intent, session }
}

/** Returns the session of the request's cookie, or `undefined` without one. */
export async function get<env extends { Bindings: Env }>(c: Context<env>) {
  const id = getCookie(c, sessionCookie, 'host')
  if (!id) return undefined
  return await create(c.env).backend.get({ id })
}

/** Signs out: revokes the session's refresh token, and deletes the cookie. */
export async function end<env extends { Bindings: Env }>(c: Context<env>) {
  const id = getCookie(c, sessionCookie, 'host')
  if (id) await create(c.env).backend.end({ id }).catch(() => undefined)
  deleteCookie(c, sessionCookie, cookieOptions)
}

/**
 * Returns the session's access key as Tipbot stores it: its address, public key, encrypted private
 * key, signed key authorization, and the Tempo Account it acts for.
 */
export async function adopt(env: Pick<Env, 'SECRET_KEY'>, session: { key?: Key | undefined }) {
  const key = session.key
  if (!key?.privateKey) throw new Error('Tempo ID did not authorize an access key.')
  const publicKey = Secp256k1.getPublicKey({ privateKey: key.privateKey })
  return {
    address: Address.checksum(Address.fromPublicKey(publicKey)),
    ciphertext: await AccessKey.encrypt(env, key.privateKey),
    keyAuthorization: key.keyAuthorization as unknown,
    privateKey: key.privateKey,
    publicKey: PublicKey.toHex(publicKey),
    rootAddress: Address.checksum(key.account),
  }
}

type Key = { account: string; keyAuthorization: unknown; privateKey?: `0x${string}` | undefined }

/** Returns the signed-in account's address, or `undefined` without a Tempo ID session. */
export async function getAddress(env: Env, request: Request) {
  const id = readCookie(request, sessionCookie)
  if (!id) return undefined
  const accounts = create(env)
  const session = await accounts.backend.get({ id }).catch(() => undefined)
  if (!session) return undefined
  if (session.key) return Address.checksum(session.key.account)
  // A sign-in without an access key reads no account, so the session's access token reads it.
  const account = await accounts.account.get({ accessToken: session.accessToken })
  return account ? Address.checksum(account.address) : undefined
}

function readIntent(value: string | undefined) {
  if (!value) return undefined
  try {
    return intentSchema.parse(JSON.parse(Base64.toString(value)))
  } catch {
    return undefined
  }
}

function readCookie(request: Request, name: string) {
  const prefix = `__Host-${name}=`
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const value = part.trim()
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length))
  }
  return undefined
}
