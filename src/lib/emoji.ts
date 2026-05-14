import data from '@emoji-mart/data/sets/15/native.json' with { type: 'json' }

const emojis = data.emojis as Record<string, { skins: { native: string }[] }>
const aliases = data.aliases as Record<string, string>

/**
 * Replaces Slack-style emoji shortcodes (e.g. `:wine_glass:`) with their
 * unicode equivalents. Unknown or custom shortcodes are left unchanged.
 */
export function replaceEmojiShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/g, (match, name: string) => {
    const emoji = emojis[name] ?? emojis[aliases[name]]
    return emoji?.skins[0]?.native ?? match
  })
}
