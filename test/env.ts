import type {} from 'vitest'
import { Hex } from 'ox'
import { z } from 'zod'

declare module 'vitest' {
  export interface ProvidedContext {
    env: string
  }
}

const privateKey = z.string().transform((value, ctx): `0x${string}` => {
  if (Hex.validate(value, { strict: true }) && value.length === 66) return value
  ctx.addIssue({ code: 'custom', message: 'Expected 32-byte hex private key.' })
  return z.NEVER
})

const schema = z.object({
  FEE_PAYER_PRIVATE_KEY_MAINNET: privateKey,
  FEE_PAYER_PRIVATE_KEY_TESTNET: privateKey,
  HOST: z.string(),
  RPC_CREDENTIALS: z.string().optional(),
  RPC_URL_MAINNET: z.string().optional(),
  RPC_URL_TESTNET: z.string().optional(),
  SECRET_KEY: z.string(),
  SLACK_API_URL: z.string(),
  SLACK_APP_ID: z.string(),
  SLACK_CLIENT_ID: z.string(),
  SLACK_CLIENT_SECRET: z.string(),
  SLACK_SIGNING_SECRET: z.string(),
  TWITTER_ACCESS_TOKEN: z.string(),
  TWITTER_ACCESS_TOKEN_SECRET: z.string(),
  TWITTER_API_URL: z.string(),
  TWITTER_BEARER_TOKEN: z.string(),
  TWITTER_BOT_HANDLE: z.string(),
  TWITTER_CONSUMER_KEY: z.string(),
  TWITTER_CONSUMER_SECRET: z.string(),
  TWITTER_OAUTH_CLIENT_ID: z.string(),
  TWITTER_OAUTH_CLIENT_SECRET: z.string(),
})

type Input = z.infer<typeof schema>

export const Env = {
  get(overrides: Partial<Input> = {}) {
    return {
      FEE_PAYER_PRIVATE_KEY_MAINNET:
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      FEE_PAYER_PRIVATE_KEY_TESTNET:
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      HOST: 'tip.bot',
      SECRET_KEY: 'testMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      SLACK_API_URL: 'https://slack.com/api',
      SLACK_APP_ID: 'A000000001',
      SLACK_CLIENT_ID: '123.456',
      SLACK_CLIENT_SECRET: 'test-client-secret',
      SLACK_SIGNING_SECRET: 'test-signing-secret',
      TWITTER_ACCESS_TOKEN: 'twitter-access-token',
      TWITTER_ACCESS_TOKEN_SECRET: 'twitter-access-token-secret',
      TWITTER_API_URL: 'https://api.twitter.com',
      TWITTER_BEARER_TOKEN: 'twitter-bearer-token',
      TWITTER_BOT_HANDLE: 'tipbotgg',
      TWITTER_CONSUMER_KEY: 'twitter-consumer-key',
      TWITTER_CONSUMER_SECRET: 'twitter-consumer-secret',
      TWITTER_OAUTH_CLIENT_ID: 'twitter-oauth-client-id',
      TWITTER_OAUTH_CLIENT_SECRET: 'twitter-oauth-client-secret',
      ...overrides,
    } satisfies Input
  },
  parse(env: unknown) {
    return z.parse(schema, typeof env === 'string' ? JSON.parse(env) : env)
  },
  schema,
}
