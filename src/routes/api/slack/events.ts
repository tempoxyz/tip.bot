import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'

import { handleSlackEventRequest } from '#/lib/slackHandlers.ts'
import type { TipEnv } from '#/lib/tipEngine.ts'

export const Route = createFileRoute('/api/slack/events')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return await handleSlackEventRequest(env as TipEnv, request)
      },
    },
  },
})
