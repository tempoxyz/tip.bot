import { createEmulator, type Emulator, type EmulatorOptions, type ServiceName } from 'emulate'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseHostname, RouteStore } from 'portless'
import type { Plugin } from 'vite-plus'

export function emulate(options: { type: EmulateServiceName }): Plugin {
  const config = emulatorConfig[options.type]
  const alias = `${options.type}.emulate`
  const hostname = parseHostname(alias)
  const origin = getPortlessOrigin(hostname)
  if (config?.envName)
    (process.env as Record<string, string | undefined>)[config.envName] ??= `${origin}/api`

  let emulator: Emulator | null = null
  return {
    name: `${options.type}-emulate`,
    apply: 'serve',
    async configureServer(server) {
      const portlessStore = new RouteStore(
        process.env.PORTLESS_STATE_DIR ?? path.join(os.homedir(), '.portless'),
      )
      const port = await new Promise<number>((resolve, reject) => {
        const server = net.createServer()
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          server.close(() => {
            if (typeof address === 'object' && address) resolve(address.port)
            else reject(new Error('Could not find an available port.'))
          })
        })
      })
      portlessStore.addRoute(hostname, port, 0, true)
      emulator = await createEmulator({
        baseUrl: origin,
        port,
        ...(config?.seed ? { seed: config.seed } : {}),
        service: options.type,
      })
      server.config.logger.info(`${options.type} emulator started at ${origin}`)

      async function stop() {
        await emulator?.close()
        emulator = null
        portlessStore.removeRoute(hostname)
      }
      server.httpServer?.once('close', () => {
        void stop()
      })
      process.once('SIGINT', () => {
        void stop().finally(() => process.exit(130))
      })
      process.once('SIGTERM', () => {
        void stop().finally(() => process.exit(143))
      })
    },
  }
}

function getPortlessOrigin(hostname: string) {
  if (!process.env.PORTLESS_URL) return `https://${hostname}`

  const url = new URL(process.env.PORTLESS_URL)
  url.hash = ''
  url.hostname = hostname
  url.pathname = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

const slackScopes = [
  'channels:history',
  'channels:read',
  'chat:write',
  'groups:history',
  'groups:read',
  'im:write',
  'reactions:read',
  'reactions:write',
  'users:read',
]

const emulatorConfig = {
  slack: {
    envName: 'SLACK_API_URL',
    seed: {
      slack: {
        team: {
          domain: 'emulate',
          name: 'Emulate',
        },
        users: [
          {
            email: 'member@example.com',
            name: 'member',
          },
        ],
      },
      tokens: {
        admin: {
          login: 'U000000001',
          scopes: slackScopes,
        },
        member: {
          login: 'member',
          scopes: slackScopes,
        },
        U000000001: {
          login: 'U000000001',
          scopes: slackScopes,
        },
        U000000002: {
          login: 'U000000002',
          scopes: slackScopes,
        },
        'xoxb-test': {
          login: 'tipbot',
          scopes: slackScopes,
        },
      },
    },
  },
} satisfies Partial<
  Record<
    EmulateServiceName,
    Pick<EmulatorOptions, 'seed'> & {
      envName?: string
    }
  >
>

type EmulateServiceName = Extract<ServiceName, 'slack'>
