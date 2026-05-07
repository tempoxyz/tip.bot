import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'

import { handleSlackCommandRequest } from '#/lib/slackHandlers.ts'
import type { TipEnv } from '#/lib/tipEngine.ts'

export const Route = createFileRoute('/api/slack/commands')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return await handleSlackCommandRequest(env as TipEnv, request)
      },
    },
  },
})
