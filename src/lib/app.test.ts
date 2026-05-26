import * as App from '#/lib/app.ts'
import { expect, test } from 'vitest'

test('returns undefined preview reaction tip emojis for production host', () => {
  expect(App.getPreviewReactionTipEmojis('tip.bot')).toBe(undefined)
  expect(App.getPreviewReactionTipEmojis('tipbot.localhost')).toBe(undefined)
})

test('returns deterministic preview reaction tip emojis by PR host', () => {
  expect(App.getPreviewReactionTipEmojis('pr18.tip.bot')).toEqual(['eyes', 'rocket', 'tada'])
  expect(App.getPreviewReactionTipEmojis('pr19.tip.bot')).toEqual([
    'rocket',
    'tada',
    'white_check_mark',
  ])
})
