// Keep this test entry wired with Worker exports/bindings that tests need.
// For example, add queue handlers, Durable Objects, or other exported classes here
// when worker tests rely on them. Avoid importing the frontend SSR entry unless needed.
export { TipbotChatStateDO } from '#/objects/chatState.ts'

export default {
  fetch() {
    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>
