import emojis from 'emoji-name-map/lib/datasource.json' with { type: 'json' }

const aliases: Record<string, string> = {
  thumbsdown: '-1',
  thumbsup: '+1',
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
        const emoji = getEmoji(name)
        const skinTone = getEmoji(skinToneName)
        if (!emoji || !skinTone) return match
        return applySkinTone(emoji, skinTone)
      },
    )
    .replace(/:([a-z0-9_+-]+):/g, (match, name: string) => getEmoji(name) ?? match)
}

function applySkinTone(emoji: string, skinTone: string) {
  const [base, ...rest] = Array.from(emoji)
  if (!base) return emoji
  if (rest[0] === '\uFE0F') rest.shift()
  return `${base}${skinTone}${rest.join('')}`
}

function getEmoji(name: string) {
  return (
    (emojis as Record<string, string>)[name] ??
    (emojis as Record<string, string>)[aliases[name] ?? '']
  )
}
