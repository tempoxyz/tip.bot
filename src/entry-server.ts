import { RouterProvider } from '@tanstack/react-router'
import { renderRouterToStream } from '@tanstack/react-router/ssr/server'
import { jsx } from 'react/jsx-runtime'
import type { Register } from '@tanstack/react-start'
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
    return (await getStartHandler())(request, { context: { ctx, env, request } })
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

export { TipbotChatStateDO } from '#/objects/chatState.ts'

// TODO: Runtime import HMR workaround
// https://github.com/TanStack/router/issues/7285
let cachedStartHandler: Awaited<ReturnType<typeof buildStartHandler>> | null = null
if (import.meta.hot)
  import.meta.hot.accept(() => {
    cachedStartHandler = null
  })

async function getStartHandler() {
  if (cachedStartHandler) return cachedStartHandler
  cachedStartHandler = await buildStartHandler()
  return cachedStartHandler
}

async function buildStartHandler() {
  const mod = await import('@tanstack/react-start/server')
  return mod.createStartHandler<Register>(({ request, responseHeaders, router }) =>
    renderRouterToStream({
      request,
      responseHeaders,
      router,
      children: jsx(RouterProvider, { router }),
    }),
  )
}
