/// <reference path="../src/worker-configuration.d.ts" />

import type {} from 'vitest'
import { z } from 'zod'

declare module 'vitest' {
  export interface ProvidedContext {
    env: string
  }
}

const schema = z.object({
  ACCESS_KEY_ENCRYPTION_SECRET: z.string(),
  FEE_PAYER_PRIVATE_KEY: z.string(),
  SLACK_APP_BASE_URL: z.string(),
  SLACK_CLIENT_ID: z.string(),
  SLACK_CLIENT_SECRET: z.string(),
  SLACK_SIGNING_SECRET: z.string(),
  TEMPO_CHAIN: z.literal('testnet'),
})

type Input = z.infer<typeof schema>
export const Env = {
  get(overrides: Partial<Input> = {}) {
    return {
      ACCESS_KEY_ENCRYPTION_SECRET: 'test-encryption-secret',
      FEE_PAYER_PRIVATE_KEY: '0x0000000000000000000000000000000000000000000000000000000000000001',
      SLACK_APP_BASE_URL: 'https://tip.bot',
      SLACK_CLIENT_ID: '123.456',
      SLACK_CLIENT_SECRET: 'test-client-secret',
      SLACK_SIGNING_SECRET: 'test-signing-secret',
      TEMPO_CHAIN: 'testnet',
      ...overrides,
    } satisfies Input
  },
  parse(env: unknown) {
    return schema.parse(typeof env === 'string' ? JSON.parse(env) : env)
  },
  schema,
}

export type TestEnv = Omit<Cloudflare.Env, keyof Input> &
  Input & {
    SLACK_API_URL?: string
  }
