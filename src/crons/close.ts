import * as Chat from '#/chat.ts'

export async function closeExpired(_env: Env, _ctx: ExecutionContext) {
  await Chat.getChat().initialize()
  await Promise.all([Chat.closeExpiredTipAirdrops(), Chat.closeExpiredTipRaffles()])
}
