const args = process.argv.slice(2)
const command = args[0]
const apiUrl = process.env.TELEGRAM_API_URL ?? 'https://api.telegram.org'
const token = process.env.TELEGRAM_BOT_TOKEN
const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN
const host = args[1] ?? process.env.HOST

if (!token) usage('TELEGRAM_BOT_TOKEN is required.')
if (!secretToken) usage('TELEGRAM_WEBHOOK_SECRET_TOKEN is required.')

if (command === 'set') {
  if (!host) usage('host is required.')
  const response = await fetch(`${apiUrl}/bot${token}/setWebhook`, {
    body: JSON.stringify({
      allowed_updates: ['message', 'callback_query'],
      secret_token: secretToken,
      url: `https://${host}/api/chat/telegram`,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const json = await response.json()
  console.log(JSON.stringify(json, null, 2))
  if (!response.ok) process.exit(1)
} else if (command === 'info') {
  const response = await fetch(`${apiUrl}/bot${token}/getWebhookInfo`)
  console.log(JSON.stringify(await response.json(), null, 2))
  if (!response.ok) process.exit(1)
} else usage()

function usage(message?: string): never {
  if (message) console.error(message)
  console.error(`
Usage:
  pnpm telegram:app set <host>
  pnpm telegram:app info

Environment:
  TELEGRAM_API_URL Defaults to https://api.telegram.org
  TELEGRAM_BOT_TOKEN Bot token from BotFather
  TELEGRAM_WEBHOOK_SECRET_TOKEN Secret token for webhook verification
`)
  process.exit(1)
}
