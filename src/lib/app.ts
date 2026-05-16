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

export const slackBotDisplayName = getSlackBotDisplayName(__HOST__)

export const slackCommand = getSlackCommand(__HOST__)

export const tipbotImagePath = getTipbotImagePath(__HOST__)

function getPreviewPrNumber(host: string) {
  return host.match(/^pr(\d+)\.tip\.bot$/)?.[1]
}
