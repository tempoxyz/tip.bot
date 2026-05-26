export function getSlackBotDisplayName(host: string) {
  const previewPrNumber = getPreviewPrNumber(host)
  return previewPrNumber ? `Tipbot PR ${previewPrNumber}` : 'Tipbot'
}

export function getSlackCommand(host: string) {
  const previewPrNumber = getPreviewPrNumber(host)
  return previewPrNumber ? `/tippr${previewPrNumber}` : '/tip'
}

export function getTipbotImagePath(host: string) {
  return getPreviewPrNumber(host) ? '/tipbot-preview.png' : '/tipbot.png'
}

export function getPreviewReactionTipEmoji(host: string) {
  return getPreviewReactionTipEmojis(host)?.[0]
}

export function getPreviewReactionTipEmojis(host: string) {
  const previewPrNumber = getPreviewPrNumber(host)
  if (!previewPrNumber) return undefined
  const startIndex = Number(previewPrNumber) % previewReactionTipEmojis.length
  return Array.from(
    { length: 3 },
    (_value, index) =>
      previewReactionTipEmojis[(startIndex + index) % previewReactionTipEmojis.length]!,
  )
}

const appHost = typeof __HOST__ === 'string' ? __HOST__ : ''

export const slackBotDisplayName = getSlackBotDisplayName(appHost)

export const slackCommand = getSlackCommand(appHost)

export const tipbotImagePath = getTipbotImagePath(appHost)

const previewReactionTipEmojis = [
  'eyes',
  'rocket',
  'tada',
  'white_check_mark',
  'heart',
  'fire',
  'wave',
  'clap',
  'pray',
  'raised_hands',
  'thinking_face',
  'dart',
  'coffee',
  'pizza',
  'cake',
  'cookie',
  'memo',
  'bell',
]

function getPreviewPrNumber(host: string) {
  return host.match(/^pr(\d+)\.tip\.bot$/)?.[1]
}
