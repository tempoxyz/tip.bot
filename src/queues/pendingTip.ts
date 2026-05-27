import * as Chat from '#/chat.ts'
import * as Tip from '#/lib/tip.ts'
import * as DB from '#db/client.ts'
import { env } from 'cloudflare:workers'

export async function processPendingTipMessage(message: Message<processPendingTipMessage.Body>) {
  const result = await Tip.claimPendingTip(env, { pendingTipId: message.body.pendingTipId })
  if (!result) return
  await Chat.getChat().initialize()
  await Chat.updateSlackPendingTipMessage(DB.create(env.DB), result)
}

processPendingTipMessage.queueName = 'tipbot-pending-tip' as const

export namespace processPendingTipMessage {
  export type Body = {
    pendingTipId: string
  }
}
