import serverEntry from '@tanstack/react-start/server-entry'
import { api } from '#/api.ts'
import { rpc } from '#/lib/rpc.ts'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/install/slack')
      return Response.redirect(
        new URL(rpc.api.chat.slack.install.$url().pathname, url).toString(),
        302,
      )
    if (url.pathname.startsWith('/api/')) return api.fetch(new Request(url, request), env, ctx)
    return serverEntry.fetch(request, { context: { ctx, env, request } })
  },
} satisfies ExportedHandler<Env>

declare module '@tanstack/react-start' {
  interface Register {
    server: {
      requestContext: {
        ctx: ExecutionContext
        env: Env
        request: Request
      }
    }
  }
}

// TODO: Remove when TanStack Start server-entry imports Register from react-start.
// https://github.com/TanStack/router/issues/7353
import type {} from '@tanstack/react-start'
declare module '@tanstack/react-router' {
  interface Register {
    server: {
      requestContext: {
        ctx: ExecutionContext
        env: Env
        request: Request
      }
    }
  }
}

export { TipbotChatStateDO } from '#/objects/chatState.ts'
