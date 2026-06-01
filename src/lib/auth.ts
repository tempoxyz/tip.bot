import { Handler, Kv } from 'accounts/server'
import { env } from 'cloudflare:workers'

export const auth = Handler.auth({
  domain: env.HOST,
  path: '/api/auth',
  store: Kv.durableObject(env.AUTH_NONCE as unknown as Kv.durableObject.Namespace),
})
