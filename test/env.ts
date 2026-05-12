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
  HOST: z.string(),
  SECRET_KEY: z.string(),
  SLACK_API_URL: z.string(),
  SLACK_APP_ID: z.string(),
  SLACK_CLIENT_ID: z.string(),
  SLACK_CLIENT_SECRET: z.string(),
  SLACK_SIGNING_SECRET: z.string(),
  FEE_PAYER_PRIVATE_KEY_MAINNET: privateKey,
  FEE_PAYER_PRIVATE_KEY_TESTNET: privateKey,
  RPC_URL_MAINNET: z.string().optional(),
  RPC_URL_TESTNET: z.string().optional(),
})

type Input = z.infer<typeof schema>

export const Env = {
  get(overrides: Partial<Input> = {}) {
    return {
      HOST: 'tip.bot',
      SECRET_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      SLACK_API_URL: 'https://slack.com/api',
      SLACK_APP_ID: 'A000000001',
      SLACK_CLIENT_ID: '123.456',
      SLACK_CLIENT_SECRET: 'test-client-secret',
      SLACK_SIGNING_SECRET: 'test-signing-secret',
      FEE_PAYER_PRIVATE_KEY_MAINNET:
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      FEE_PAYER_PRIVATE_KEY_TESTNET:
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      ...overrides,
    } satisfies Input
  },
  parse(env: unknown) {
    return schema.parse(typeof env === 'string' ? JSON.parse(env) : env)
  },
  schema,
}
