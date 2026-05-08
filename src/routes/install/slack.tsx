import { createFileRoute } from '@tanstack/react-router'
import { rpc } from '#/lib/rpc.ts'

export const Route = createFileRoute('/install/slack')({
  server: {
    handlers: {
      GET: () => Response.redirect(rpc.api.chat.slack.install.$url().pathname, 302),
    },
  },
})
