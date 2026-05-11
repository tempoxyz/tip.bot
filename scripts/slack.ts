const args = process.argv.slice(2).filter((arg) => arg !== '--')
const command = args[0]
const appEnv = args[1] ?? process.env.SLACK_APP_ENV
const host = normalizeHost(
  args[2] ?? process.env.HOST ?? (appEnv === 'production' ? 'tip.bot' : undefined),
)
const baseUrl = host ? `https://${host}` : undefined
const appId = args[3] ?? appIdFromEnv()

if (!command || !['create', 'manifest', 'update', 'validate'].includes(command)) usage()
if (!appEnv || !['local', 'production'].includes(appEnv))
  usage('Expected app env: local or production')
if (!baseUrl) usage('Expected a host')
if (['update'].includes(command) && !appId) usage('Expected Slack app ID')

const manifest = createManifest()

if (command === 'manifest') {
  console.log(JSON.stringify(manifest, null, 2))
} else {
  const result = await slackApi(`apps.manifest.${command}`, {
    app_id: appId,
    manifest: JSON.stringify(manifest),
  })

  if (command === 'create') printCreateResult(result)
  else console.log(JSON.stringify(result, null, 2))
}

function createManifest() {
  const appName = process.env.SLACK_APP_NAME ?? (appEnv === 'production' ? 'Tipbot' : 'Tipbot tmm')
  const botDisplayName = process.env.SLACK_BOT_DISPLAY_NAME ?? 'Tipbot'

  return {
    display_information: {
      background_color: '#111111',
      description: 'Sometime tipper, sometime messenger, always bot.',
      name: appName,
    },
    features: {
      bot_user: {
        always_online: true,
        display_name: botDisplayName,
      },
      slash_commands: [
        {
          command: '/tip',
          description: 'Tip teammates',
          should_escape: true,
          usage_hint: '@account',
          url: `${baseUrl}/api/chat/slack`,
        },
        {
          command: '/tip-connect',
          description: 'Connect your wallet',
          should_escape: true,
          usage_hint: '',
          url: `${baseUrl}/api/chat/slack`,
        },
        {
          command: '/tip-config',
          description: 'Configure Tipbot',
          should_escape: true,
          usage_hint: 'amount 0.001',
          url: `${baseUrl}/api/chat/slack`,
        },
        {
          command: '/tip-help',
          description: 'Show Tipbot help',
          should_escape: true,
          usage_hint: '',
          url: `${baseUrl}/api/chat/slack`,
        },
      ],
    },
    oauth_config: {
      redirect_urls: [`${baseUrl}/api/chat/slack/oauth/callback`],
      scopes: {
        bot: ['chat:write', 'commands', 'users:read'],
      },
    },
    settings: {
      interactivity: {
        is_enabled: true,
        request_url: `${baseUrl}/api/chat/slack`,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
}

function appIdFromEnv() {
  if (process.env.SLACK_APP_ID) return process.env.SLACK_APP_ID
  if (appEnv === 'local') return process.env.SLACK_LOCAL_APP_ID
  if (appEnv === 'production') return process.env.SLACK_PRODUCTION_APP_ID
  return undefined
}

function printCreateResult(result: Record<string, unknown>) {
  console.log(JSON.stringify(result, null, 2))

  const credentials = result.credentials as Record<string, string> | undefined
  if (!credentials) return

  console.log('\nEnvironment values:')
  console.log(`SLACK_CLIENT_ID=${credentials.client_id}`)
  console.log(`SLACK_CLIENT_SECRET=${credentials.client_secret}`)
  console.log(`SLACK_SIGNING_SECRET=${credentials.signing_secret}`)
  console.log(`HOST=${host}`)
  console.log(`SLACK_${appEnv.toUpperCase()}_APP_ID=${String(result.app_id)}`)
}

async function slackApi(method: string, body: Record<string, unknown>) {
  const token = requiredConfigToken()
  const response = await fetch(`https://slack.com/api/${method}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    method: 'POST',
  })
  const result = (await response.json()) as Record<string, unknown>

  if (result.ok) return result

  console.error(JSON.stringify(result, null, 2))
  process.exit(1)
}

function requiredEnv(name: string) {
  const value = process.env[name]
  if (value) return value

  console.error(`Missing ${name}`)
  process.exit(1)
}

function requiredConfigToken() {
  const token = requiredEnv('SLACK_CONFIG_TOKEN').trim()
  if (token.startsWith('xoxe.')) return token

  console.error('SLACK_CONFIG_TOKEN must be a Slack app configuration token starting with xoxe.')
  process.exit(1)
}

function normalizeHost(value?: string) {
  return value?.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

function usage(message?: string): never {
  if (message) console.error(message)

  console.error(`
Usage:
  pnpm slack:app manifest <local|production> <host>
  pnpm slack:app validate <local|production> <host>
  pnpm slack:app create <local|production> <host>
  pnpm slack:app update <local|production> <host> <appId>

Environment:
  SLACK_CONFIG_TOKEN     Slack app configuration token from https://api.slack.com/apps
  SLACK_APP_NAME         Optional manifest app name override
  SLACK_BOT_DISPLAY_NAME Optional bot mention display name override
  SLACK_APP_ID           Optional app ID for updates
  SLACK_LOCAL_APP_ID     Optional local app ID for updates
  SLACK_PRODUCTION_APP_ID Optional production app ID for updates
`)
  process.exit(1)
}

export {}
