import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'

import { api } from '#/lib/api.ts'

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      DELETE: ({ request }) => serveApi(request),
      GET: ({ request }) => serveApi(request),
      HEAD: ({ request }) => serveApi(request),
      OPTIONS: ({ request }) => serveApi(request),
      PATCH: ({ request }) => serveApi(request),
      POST: ({ request }) => serveApi(request),
      PUT: ({ request }) => serveApi(request),
    },
  },
})

function serveApi(request: Request) {
  return api.fetch(request, env)
}
