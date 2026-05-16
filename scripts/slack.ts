const args = process.argv.slice(2).filter((arg) => arg !== '--')
const command = args[0]
const appEnv = args[1] ?? process.env.SLACK_APP_ENV
const host = normalizeHost(
  args[2] ?? process.env.HOST ?? (appEnv === 'production' ? 'tip.bot' : undefined),
)
const baseUrl = host ? `https://${host}` : undefined
const appId = args[3] ?? appIdFromEnv()

const scopeReasons = {
  'app_mentions:read': 'Detect @Tipbot messages so members can send tips by mentioning Tipbot.',
  'assistant:write':
    'Show a temporary sending payment status while Tipbot processes a mentioned tip.',
  'channels:history':
    'Read messages Tipbot is asked to act on in public channels, including reaction and mention tips.',
  'channels:read': 'Check public channel metadata and respond in the correct conversation.',
  'chat:write': 'Send tip receipts, connection prompts, confirmation prompts, and error messages.',
  commands: 'Register and handle the /tip slash command.',
  'groups:history':
    'Read messages Tipbot is asked to act on in private channels where Tipbot has been added.',
  'groups:read': 'Check private channel metadata where Tipbot has been added.',
  'reactions:read': 'Detect configured tip reaction emoji and identify the message being tipped.',
  'users:read': 'Resolve Slack users for mentions, admin checks, and connected account status.',
} as const

if (!command || !['create', 'export', 'manifest', 'update', 'validate'].includes(command)) usage()
if (!appEnv || !['local', 'preview', 'production'].includes(appEnv))
  usage('Expected app env: local, preview, or production')
if (!baseUrl) usage('Expected a host')
if (['export', 'update'].includes(command) && !appId) usage('Expected Slack app ID')

const manifest = createManifest()

if (command === 'manifest') {
  console.log(JSON.stringify(manifest, null, 2))
} else if (command === 'export') {
  console.log(JSON.stringify(await slackApi('apps.manifest.export', { app_id: appId }), null, 2))
} else {
  const result = await slackApi(`apps.manifest.${command}`, {
    app_id: appId,
    manifest: JSON.stringify(manifest),
  })

  if (command === 'create') printCreateResult(result)
  else {
    console.log(JSON.stringify(result, null, 2))
    if (command === 'update')
      printManifestSummary(await slackApi('apps.manifest.export', { app_id: appId }))
  }
  printScopeReasons()
}

function createManifest() {
  const appName =
    process.env.SLACK_APP_NAME ??
    (appEnv === 'production' ? 'Tipbot' : appEnv === 'preview' ? 'Tipbot Preview' : 'Tipbot (dev)')
  const botDisplayName = process.env.SLACK_BOT_DISPLAY_NAME ?? 'Tipbot'
  const slackCommand = process.env.SLACK_COMMAND ?? '/tip'
  const eventSubscriptions =
    process.env.SLACK_EVENT_SUBSCRIPTIONS === '0'
      ? undefined
      : {
          bot_events: ['app_mention', 'reaction_added', 'reaction_removed'],
          request_url: `${baseUrl}/api/chat/slack`,
        }

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
          command: slackCommand,
          description: 'Tip teammates and manage Tipbot',
          should_escape: true,
          usage_hint: '@account, connect, disconnect, help, leaderboard, status',
          url: `${baseUrl}/api/chat/slack`,
        },
      ],
    },
    oauth_config: {
      redirect_urls: [`${baseUrl}/api/chat/slack/oauth/callback`],
      scopes: {
        bot: [
          'app_mentions:read',
          'assistant:write',
          'channels:history',
          'channels:read',
          'chat:write',
          'commands',
          'groups:history',
          'groups:read',
          'reactions:read',
          'users:read',
        ],
      },
    },
    settings: {
      ...(eventSubscriptions ? { event_subscriptions: eventSubscriptions } : {}),
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
  return process.env.SLACK_APP_ID
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
  console.log(`SLACK_APP_ID=${String(result.app_id)}`)
}

function printManifestSummary(result: Record<string, unknown>) {
  const manifest = result.manifest as
    | {
        oauth_config?: { scopes?: { bot?: string[] } }
        settings?: { event_subscriptions?: { bot_events?: string[] } }
      }
    | undefined
  console.log('\nCurrent Slack manifest summary:')
  console.log(
    JSON.stringify(
      {
        bot_events: manifest?.settings?.event_subscriptions?.bot_events ?? [],
        bot_scopes: manifest?.oauth_config?.scopes?.bot ?? [],
      },
      null,
      2,
    ),
  )
}

function printScopeReasons() {
  console.log(
    '\nSlack OAuth scope reasons to add manually in OAuth & Permissions > Manage Reasons:',
  )
  for (const [scope, reason] of Object.entries(scopeReasons)) console.log(`- ${scope}: ${reason}`)
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
  if (result.error === 'token_expired')
    console.error(
      '\nSLACK_CONFIG_TOKEN expired. Generate a new app configuration token at https://api.slack.com/apps, then rerun with `export SLACK_CONFIG_TOKEN=xoxe...`.',
    )
  if (result.error === 'no_permission')
    console.error(
      '\nSLACK_CONFIG_TOKEN does not have permission to update this app. Generate a new app configuration token at https://api.slack.com/apps while signed into the workspace/account that owns the app, and confirm SLACK_APP_ID points to that app.',
    )
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
  pnpm slack:app manifest <local|preview|production> <host>
  pnpm slack:app export <local|preview|production> <host> <appId>
  pnpm slack:app validate <local|preview|production> <host>
  pnpm slack:app create <local|preview|production> <host>
  pnpm slack:app update <local|preview|production> <host> <appId>

Environment:
  SLACK_CONFIG_TOKEN     Slack app configuration token from https://api.slack.com/apps
  SLACK_APP_NAME         Optional manifest app name override
  SLACK_BOT_DISPLAY_NAME Optional bot mention display name override
  SLACK_COMMAND          Optional slash command override
  SLACK_EVENT_SUBSCRIPTIONS Set to 0 to omit event subscriptions
  SLACK_APP_ID           Optional app ID for updates
`)
  process.exit(1)
}

export {}
