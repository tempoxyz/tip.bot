export { TipbotChatStateDO } from '#/objects/chatState.ts'

export default {
  fetch() {
    return new Response('ok')
  },
} satisfies ExportedHandler<Env>
