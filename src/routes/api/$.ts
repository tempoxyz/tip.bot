import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'

import { api } from '#/lib/api.ts'

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      DELETE: ({ context, request }) => serveApi(request, context.ctx),
      GET: ({ context, request }) => serveApi(request, context.ctx),
      HEAD: ({ context, request }) => serveApi(request, context.ctx),
      OPTIONS: ({ context, request }) => serveApi(request, context.ctx),
      PATCH: ({ context, request }) => serveApi(request, context.ctx),
      POST: ({ context, request }) => serveApi(request, context.ctx),
      PUT: ({ context, request }) => serveApi(request, context.ctx),
    },
  },
})

function serveApi(request: Request, ctx: ExecutionContext) {
  return api.fetch(request, env, ctx)
}
