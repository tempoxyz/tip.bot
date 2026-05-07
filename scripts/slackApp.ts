const args = process.argv.slice(2).filter((arg) => arg !== '--')
const command = args[0]
const appEnv = args[1] ?? process.env.SLACK_APP_ENV
const baseUrl = trimTrailingSlash(
  args[2] ??
    process.env.SLACK_APP_BASE_URL ??
    (appEnv === 'production' ? 'https://tip.bot' : undefined),
)
const appId = args[3] ?? appIdFromEnv()

if (!command || !['create', 'manifest', 'update', 'validate'].includes(command)) usage()
if (!appEnv || !['local', 'production'].includes(appEnv))
  usage('Expected app env: local or production')
if (!baseUrl?.startsWith('https://')) usage('Expected an https base URL')
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
  const appName =
    process.env.SLACK_APP_NAME ?? (appEnv === 'production' ? 'tip.bot' : 'tip.bot tmm')

  return {
    display_information: {
      background_color: '#111111',
      description: 'Slack-native stablecoin micropayments',
      name: appName,
    },
    features: {
      bot_user: {
        always_online: false,
        display_name: appName,
      },
      slash_commands: [
        {
          command: '/tip',
          description: 'Tip teammates',
          should_escape: true,
          usage_hint: 'connect | @account | config',
          url: `${baseUrl}/api/slack/commands`,
        },
      ],
    },
    oauth_config: {
      redirect_urls: [`${baseUrl}/api/slack/oauth/callback`],
      scopes: {
        bot: [
          'app_mentions:read',
          'channels:history',
          'chat:write',
          'commands',
          'groups:history',
          'reactions:read',
          'users:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ['app_mention', 'reaction_added'],
        request_url: `${baseUrl}/api/slack/events`,
      },
      interactivity: {
        is_enabled: false,
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
  console.log(`SLACK_APP_BASE_URL=${baseUrl}`)
  console.log(`SLACK_${appEnv.toUpperCase()}_APP_ID=${result.app_id}`)
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

function trimTrailingSlash(value?: string) {
  return value?.replace(/\/+$/, '')
}

function usage(message?: string): never {
  if (message) console.error(message)

  console.error(`
Usage:
  pnpm run slack:app:manifest -- <local|production> <baseUrl>
  pnpm run slack:app:validate -- <local|production> <baseUrl>
  pnpm run slack:app:create -- <local|production> <baseUrl>
  pnpm run slack:app:update -- <local|production> <baseUrl> <appId>

Environment:
  SLACK_CONFIG_TOKEN     Slack app configuration token from https://api.slack.com/apps
  SLACK_APP_NAME         Optional manifest app name override
  SLACK_APP_ID           Optional app ID for update
  SLACK_LOCAL_APP_ID     Optional local app ID for update
  SLACK_PRODUCTION_APP_ID Optional production app ID for update
`)
  process.exit(1)
}

export {}
