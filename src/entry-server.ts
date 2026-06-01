import serverEntry from '@tanstack/react-start/server-entry'
import { Kv as AccountsKv } from 'accounts/server'
import { api } from '#/api.ts'
import { rpc } from '#/lib/rpc.ts'
import { processPendingTipMessage } from '#/queues/pendingTip.ts'
import { z } from 'zod'

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
  async queue(batch, env) {
    const queueName = (() => {
      const previewApex = env.HOST.endsWith('.tip.bot') ? env.HOST.replace('.tip.bot', '') : ''
      if (previewApex) return batch.queue.replace(`-${previewApex}`, '')
      return batch.queue
    })()
    const queue = z.parse(z.enum([processPendingTipMessage.queueName]), queueName)
    const handler = { [processPendingTipMessage.queueName]: processPendingTipMessage }[queue]
    for (const message of batch.messages) {
      try {
        await handler(message as never)
        message.ack()
      } catch (error) {
        if (queue === processPendingTipMessage.queueName && message.attempts >= 3)
          console.error('Pending tip queue message reached DLQ threshold:', message.body)
        console.error(`Queue message ${message.id} failed:`, error)
        message.retry()
      }
    }
  },
} satisfies ExportedHandler<Env, processPendingTipMessage.Body>

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
export class NonceStorage extends AccountsKv.NonceStorage {}
