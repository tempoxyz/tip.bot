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
  const previewPrNumber = getPreviewPrNumber(host)
  if (!previewPrNumber) return undefined
  return previewReactionTipEmojis[Number(previewPrNumber) % previewReactionTipEmojis.length]
}

const appHost = typeof __HOST__ === 'string' ? __HOST__ : ''

export const slackBotDisplayName = getSlackBotDisplayName(appHost)

export const slackCommand = getSlackCommand(appHost)

export const tipbotImagePath = getTipbotImagePath(appHost)

const previewReactionTipEmojis = [
  'bike',
  'camping',
  'cat',
  'deciduous_tree',
  'doughnut',
  'flying_saucer',
  'gift',
  'hamburger',
  'jack_o_lantern',
  'lemon',
  'rainbow',
  'rocket',
  'snail',
  'star2',
  'surfer',
  'dart',
  'turtle',
  'watermelon',
]

function getPreviewPrNumber(host: string) {
  return host.match(/^pr(\d+)\.tip\.bot$/)?.[1]
}
