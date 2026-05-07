import { RouterProvider } from '@tanstack/react-router'
import { renderRouterToStream } from '@tanstack/react-router/ssr/server'
import { jsx } from 'react/jsx-runtime'
import type { Register } from '@tanstack/react-start'

const virtualClientEntry = '/@id/virtual:tanstack-start-client-entry'
const explicitClientEntry = '/src/entry-client.tsx'

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

let cachedStartHandler: Awaited<ReturnType<typeof buildStartHandler>> | null = null

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    cachedStartHandler = null
  })
}

async function getStartHandler() {
  if (cachedStartHandler) return cachedStartHandler

  cachedStartHandler = await buildStartHandler()
  return cachedStartHandler
}

async function buildStartHandler() {
  const mod = await import('@tanstack/react-start/server')

  return mod.createStartHandler<Register>({
    handler: ({ request, responseHeaders, router }) =>
      renderRouterToStream({
        request,
        responseHeaders,
        router,
        children: jsx(RouterProvider, { router }),
      }),
    transformAssets: ({ kind, url }) =>
      kind === 'clientEntry' && url === virtualClientEntry ? explicitClientEntry : url,
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (await getStartHandler())(request, {
      context: { ctx, env, request },
    })
  },
}
