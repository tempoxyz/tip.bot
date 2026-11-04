import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { Address } from 'ox'
import { Accounts } from 'tempo-accounts'
import { DurableObject } from 'tempo-accounts/cloudflare'
import { backend } from 'tempo-accounts/plugins'

// Holds each Tempo ID session in its own Durable Object, so concurrent requests of a session share
// one refresh, and the refresh token never reaches the browser.
export const Sessions = DurableObject.sessions((env: Env) => ({
  clientSecret: env.TEMPO_ID_CLIENT_SECRET,
  url: env.TEMPO_ID_URL,
}))

export const cookieName = 'tempo_id'

export const cookieOptions = {
  httpOnly: true,
  path: '/',
  prefix: 'host',
  sameSite: 'Lax',
  secure: true,
} as const

export function create(env: Env) {
  return Accounts.create({
    clientId: env.TEMPO_ID_CLIENT_ID,
    clientSecret: env.TEMPO_ID_CLIENT_SECRET,
    plugins: [backend({ namespace: env.TEMPO_ID_SESSIONS })],
    url: env.TEMPO_ID_URL,
  })
}

export async function start(c: Context<{ Bindings: Env }>) {
  // The dashboard only needs the account's address, so the sign-in requests no access key.
  const started = await create(c.env).backend.start({
    accessKey: false,
    redirectUri: new URL('/api/auth/callback', c.req.url).toString(),
  })
  setCookie(c, cookieName, started.id, cookieOptions)
  return started.url
}

export async function complete(c: Context<{ Bindings: Env }>) {
  const id = getCookie(c, cookieName, 'host')
  if (!id) return false
  await create(c.env).backend.complete({ id, url: c.req.url })
  return true
}

export async function end(c: Context<{ Bindings: Env }>) {
  const id = getCookie(c, cookieName, 'host')
  if (id) await create(c.env).backend.end({ id })
  deleteCookie(c, cookieName, cookieOptions)
}

/** Returns the signed-in account's address, or `undefined` without a Tempo ID session. */
export async function getAddress(env: Env, request: Request) {
  const id = readCookie(request)
  if (!id) return undefined
  const accounts = create(env)
  const session = await accounts.backend.get({ id })
  if (!session) return undefined
  // A sign-in through a redirect reads no account, so the session's access token reads it.
  const account = await accounts.account.get({ accessToken: session.accessToken })
  return account ? Address.checksum(account.address) : undefined
}

function readCookie(request: Request) {
  const name = `__Host-${cookieName}=`
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const value = part.trim()
    if (value.startsWith(name)) return decodeURIComponent(value.slice(name.length))
  }
  return undefined
}
