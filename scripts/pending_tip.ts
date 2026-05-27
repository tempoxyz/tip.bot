const args = process.argv.slice(2).filter((arg) => arg !== '--')
const command = args[0]

if (command !== 'requeue') usage()

const queueName = args[2] ? args[1] : (process.env.PENDING_TIP_QUEUE_NAME ?? 'tipbot-pending-tip')
const pendingTipId = args[2] ?? args[1]
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN

if (!queueName) usage('Expected queue name')
if (!pendingTipId) usage('Expected pending tip id')
if (!accountId) usage('Expected CLOUDFLARE_ACCOUNT_ID')
if (!token) usage('Expected CLOUDFLARE_API_TOKEN with Queues Edit')

const queueListResponse = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues?name=${encodeURIComponent(queueName)}`,
  { headers: { authorization: `Bearer ${token}` } },
)
const queueListText = await queueListResponse.text()
if (!queueListResponse.ok) fail(queueListText)

const queueId = (
  JSON.parse(queueListText) as {
    result?: { id: string; queue_name: string }[]
  }
).result?.find((queue) => queue.queue_name === queueName)?.id
if (!queueId) fail(`Queue not found: ${queueName}`)

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}/messages`,
  {
    body: JSON.stringify({ body: { pendingTipId } }),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  },
)
const text = await response.text()
if (!response.ok) fail(text)
if (!(JSON.parse(text) as { success?: boolean }).success) fail(text)
console.log(JSON.stringify({ ok: true, pendingTipId, queueName }))

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function usage(message?: string): never {
  if (message) console.error(message)
  console.error(
    'Usage: CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm pending_tip:requeue [queue_name] <pending_tip_id>',
  )
  process.exit(1)
}
