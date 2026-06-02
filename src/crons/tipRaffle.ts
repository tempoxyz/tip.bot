import * as Chat from '#/chat.ts'

export async function closeExpiredRaffles(_env: Env, _ctx: ExecutionContext) {
  await Chat.getChat().initialize()
  await Chat.closeExpiredTipRaffles()
}
