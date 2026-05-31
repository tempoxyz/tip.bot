import { expect, test } from 'vitest'
import { parseWebhookTweets } from '#/lib/twitter.ts'

test('parses simple Twitter webhook test payload', () => {
  expect(
    parseWebhookTweets({
      authorHandle: 'bob',
      authorId: '100',
      conversationId: 'conversation-1',
      id: 'tweet-1',
      replyToAuthorId: '200',
      text: '@tipbotgg $5',
    }),
  ).toEqual([
    {
      authorHandle: 'bob',
      authorId: '100',
      conversationId: 'conversation-1',
      id: 'tweet-1',
      replyToAuthorId: '200',
      text: '@tipbotgg $5',
    },
  ])
})

test('parses Account Activity tweet_create_events payload', () => {
  expect(
    parseWebhookTweets({
      tweet_create_events: [
        {
          id_str: 'tweet-2',
          in_reply_to_status_id_str: 'parent-tweet',
          in_reply_to_user_id_str: '200',
          text: '@tipbotgg $5',
          user: { id_str: '100', screen_name: 'bob' },
        },
      ],
    }),
  ).toEqual([
    {
      authorHandle: 'bob',
      authorId: '100',
      conversationId: 'parent-tweet',
      id: 'tweet-2',
      replyToAuthorId: '200',
      text: '@tipbotgg $5',
    },
  ])
})

test('parses v2 tweet payload with includes', () => {
  expect(
    parseWebhookTweets({
      data: {
        author_id: '100',
        conversation_id: 'conversation-3',
        id: 'tweet-3',
        referenced_tweets: [{ id: 'parent-tweet', type: 'replied_to' }],
        text: '@tipbotgg $5',
      },
      includes: {
        tweets: [{ author_id: '200', id: 'parent-tweet' }],
        users: [{ id: '100', username: 'bob' }],
      },
    }),
  ).toEqual([
    {
      authorHandle: 'bob',
      authorId: '100',
      conversationId: 'conversation-3',
      id: 'tweet-3',
      replyToAuthorId: '200',
      text: '@tipbotgg $5',
    },
  ])
})
