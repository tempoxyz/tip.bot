import { handleSlackCommandRequest, handleSlackEventRequest } from '#/lib/slackHandlers.ts'

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/slack/commands') return await handleSlackCommandRequest(env, request)
    if (url.pathname === '/api/slack/events') return await handleSlackEventRequest(env, request)
    return new Response('Not found.', { status: 404 })
  },
}
