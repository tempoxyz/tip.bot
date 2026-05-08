import { api } from '#/api.ts'

export { ChatStateDO } from '#/lib/chatState.ts'

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) return await api.fetch(request, env)
    return new Response('Not found.', { status: 404 })
  },
}
