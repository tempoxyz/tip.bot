import data from '@emoji-mart/data/sets/15/native.json' with { type: 'json' }

const emojis = data.emojis as Record<string, { skins: { native: string }[] }>
const aliases = data.aliases as Record<string, string | undefined>
const skinToneIndexes: Record<string, number> = {
  'skin-tone-2': 1,
  'skin-tone-3': 2,
  'skin-tone-4': 3,
  'skin-tone-5': 4,
  'skin-tone-6': 5,
}

/**
 * Replaces Slack-style emoji shortcodes (e.g. `:wine_glass:`) with their
 * unicode equivalents. Unknown or custom shortcodes are left unchanged.
 */
export function replaceEmojiShortcodes(text: string): string {
  return text
    .replace(
      /:([a-z0-9_+-]+)::(skin-tone-[2-6]):/g,
      (match, name: string, skinToneName: string) => {
        return getEmoji(name, skinToneName) ?? match
      },
    )
    .replace(/:([a-z0-9_+-]+):/g, (match, name: string) => getEmoji(name) ?? match)
}

function getEmoji(name: string, skinToneName?: string) {
  const emoji = emojis[name] ?? emojis[aliases[name] ?? '']
  if (!emoji) return undefined
  return emoji.skins[skinToneName ? skinToneIndexes[skinToneName] : 0]?.native
}
