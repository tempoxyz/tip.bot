/// <reference path="../src/worker-configuration.d.ts" />

import type {} from 'vitest'
import { z } from 'zod'

declare module 'vitest' {
  export interface ProvidedContext {
    env: string
  }
}

const schema = z.object({
  HOST: z.string(),
  SECRET_KEY: z.string(),
  SLACK_API_URL: z.string(),
  SLACK_CLIENT_ID: z.string(),
  SLACK_CLIENT_SECRET: z.string(),
  SLACK_SIGNING_SECRET: z.string(),
})

type Input = z.infer<typeof schema>
export const Env = {
  get(overrides: Partial<Input> = {}) {
    return {
      HOST: 'tip.bot',
      SECRET_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      SLACK_API_URL: 'https://slack.com/api/',
      SLACK_CLIENT_ID: '123.456',
      SLACK_CLIENT_SECRET: 'test-client-secret',
      SLACK_SIGNING_SECRET: 'test-signing-secret',
      ...overrides,
    } satisfies Input
  },
  parse(env: unknown) {
    return schema.parse(typeof env === 'string' ? JSON.parse(env) : env)
  },
  schema,
}

export type TestEnv = Omit<Cloudflare.Env, keyof Input> & Input
