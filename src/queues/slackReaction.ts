import * as Chat from '#/chat.ts'
import * as Slack from '#/lib/slack.ts'

export async function processSlackReactionMessage(
  message: Message<processSlackReactionMessage.Body>,
) {
  await Chat.getChat().initialize()
  await Chat.processSlackReaction(message.body)
}

processSlackReactionMessage.queueName = 'tipbot-slack-reaction' as const

export namespace processSlackReactionMessage {
  export type Body = Slack.ReactionEvent
}
