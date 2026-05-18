import { defineConfig, lazyPlugins, type Plugin, type ViteDevServer } from 'vite-plus'

const isCheck = ['check', 'fmt', 'lint'].includes(process.env.VP_COMMAND ?? '')
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined

export default defineConfig({
  fmt: {
    ignorePatterns: [
      'src/auto-imports.d.ts',
      'src/routeTree.gen.ts',
      'src/worker-configuration.d.ts',
    ],
    singleQuote: true,
    semi: false,
  },
  lint: {
    ignorePatterns: [
      'db/schemas.gen.ts',
      'db/types.gen.ts',
      'dist/**',
      'src/auto-imports.d.ts',
      'src/routeTree.gen.ts',
      'src/worker-configuration.d.ts',
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  staged: {
    '*': 'vp check --fix',
    '*.{ts,tsx}': "bash -c 'pnpm check:types'",
  },
  define: !isCheck
    ? await (async () => {
        const { getWranglerVar } = await import('./config/wrangler.ts')
        const host =
          (() => {
            if (!process.env.PORTLESS_URL) return undefined
            return new URL(process.env.PORTLESS_URL).host
          })() ?? getWranglerVar('HOST')
        const environment = (() => {
          if (host === 'tip.bot') return 'production'
          if (/^pr\d+\.tip\.bot$/.test(host)) return 'preview'
          if (host === 'tipbot.localhost') return 'development'
          return 'development'
        })()
        return {
          __PLAYWRIGHT_ACCOUNT_PRIVATE_KEY__: JSON.stringify(
            process.env.PLAYWRIGHT ? process.env.PLAYWRIGHT_ACCOUNT_PRIVATE_KEY : undefined,
          ),
          __ENV__: JSON.stringify(environment),
          __HOST__: JSON.stringify(host),
          __ORIGIN__: process.env.PLAYWRIGHT
            ? `(typeof window !== 'undefined' ? window.location.origin : 'https://${host}')`
            : JSON.stringify(`https://${host}`),
          __SLACK_APP_ID__: JSON.stringify(process.env.SLACK_APP_ID ?? ''),
        }
      })()
    : {},
  plugins: lazyPlugins(async () => {
    const autoImport = await import('unplugin-auto-import/vite')
    const devtools = await import('@tanstack/devtools-vite')
    const icons = await import('unplugin-icons/vite')
    const iconsResolver = await import('unplugin-icons/resolver')
    const tailwindcss = await import('@tailwindcss/vite')
    const viteReact = await import('@vitejs/plugin-react')
    const vite = await import('./config/vite.ts')
    const { cloudflare } = await import('@cloudflare/vite-plugin')
    const { tanstackStart } = await import('@tanstack/react-start/plugin/vite')
    const shouldEmulateSlack =
      !isTest && process.env.CLOUDFLARE_ENV !== 'production' && process.env.EMULATE_SLACK !== '0'
    return [
      shouldEmulateSlack && vite.emulate({ type: 'slack' }),
      tanstackStartVirtualEntryCompat(),
      devtools.devtools({ consolePiping: { enabled: false } }),
      !isTest &&
        cloudflare({
          inspectorPort: process.env.CLOUDFLARE_INSPECTOR_PORT
            ? Number(process.env.CLOUDFLARE_INSPECTOR_PORT)
            : undefined,
          viteEnvironment: { name: 'ssr' },
          persistState: { path: process.env.CLOUDFLARE_PERSIST_STATE_PATH ?? '.wrangler/state' },
          ...(process.env.PLAYWRIGHT
            ? {
                remoteBindings: false,
              }
            : {}),
          config(config) {
            config.vars = {
              ...config.vars,
              HOST: process.env.PLAYWRIGHT
                ? (process.env.HOST ?? config.vars?.HOST)
                : ((() => {
                    if (!process.env.PORTLESS_URL) return undefined
                    return new URL(process.env.PORTLESS_URL).host
                  })() ?? config.vars?.HOST),
              ...(process.env.PLAYWRIGHT
                ? {
                    SECRET_KEY: process.env.SECRET_KEY ?? '',
                    SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID ?? '',
                    SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET ?? '',
                    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET ?? '',
                  }
                : {}),
              SLACK_API_URL: process.env.SLACK_API_URL ?? config.vars?.SLACK_API_URL,
            }
            if (process.env.PLAYWRIGHT)
              // In Playwright, use explicit test vars above instead of loading real .env secrets.
              config.secrets = { required: [] }
          },
        }),
      tailwindcss.default(),
      icons.default({
        compiler: 'jsx',
        jsx: 'react',
      }),
      autoImport.default({
        dts: 'src/auto-imports.d.ts',
        include: [/\.[jt]sx?$/, /\.[jt]sx?\?tsr-/],
        resolvers: [
          iconsResolver.default({
            prefix: 'Icon',
            extension: 'jsx',
          }),
        ],
      }),
      tanstackStart(),
      viteReact.default(),
    ]
  }),
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    allowedHosts: !isCheck
      ? (() => {
          try {
            return [new URL(process.env.PORTLESS_TAILSCALE_URL ?? '').hostname]
          } catch {
            return []
          }
        })()
      : [],
    fs: { allow: [process.cwd()] },
  },
  test: {
    onConsoleLog(log) {
      if (log.includes('[chat-sdk')) return false
    },
    projects: [
      {
        test: {
          exclude: ['src/**/*.workers.test.ts'],
          include: ['src/**/*.test.ts'],
          name: 'unit',
        },
      },
      {
        define: {
          __ENV__: JSON.stringify('development'),
          __HOST__: JSON.stringify('tip.bot'),
          __ORIGIN__: JSON.stringify('https://tip.bot'),
          __PLAYWRIGHT_ACCOUNT_PRIVATE_KEY__: 'undefined',
          __SLACK_APP_ID__: JSON.stringify(''),
        },
        plugins: lazyPlugins(async () => {
          const workers = await import('@cloudflare/vitest-pool-workers')
          const path = await import('node:path')
          const { setupVitestOutputFilter } = await import('./config/vitest.ts')
          const envMod = await import('./test/env.ts')
          setupVitestOutputFilter()
          return [
            workers.cloudflareTest(async (config) => {
              const env = envMod.Env.parse(config.inject('env'))
              return {
                main: 'test/workers.entry.ts',
                remoteBindings: false,
                wrangler: { configPath: 'wrangler.jsonc' },
                miniflare: {
                  bindings: {
                    ...env,
                    TEST_MIGRATIONS: await workers.readD1Migrations(
                      path.join(process.cwd(), 'db/migrations'),
                    ),
                  },
                  compatibilityDate: '2026-05-07',
                  // TODO: Remove once configurable log level is supported
                  // https://github.com/cloudflare/workers-sdk/issues/12014
                  compatibilityFlags: ['nodejs_compat'],
                  d1Databases: ['DB'],
                  durableObjects: {
                    CHAT_STATE: {
                      className: 'TipbotChatStateDO',
                      useSQLite: true,
                    },
                  },
                },
              }
            }),
          ]
        }),
        test: {
          fileParallelism: false,
          include: ['src/**/*.workers.test.ts'],
          name: 'workers',
          globalSetup: ['test/workers.global.setup.ts'],
          setupFiles: ['test/workers.setup.ts'],
        },
      },
    ],
  },
})

// TODO: Remove when TanStack Start emits a Vite-resolvable client entry URL.
// https://github.com/TanStack/router/issues/7227
function tanstackStartVirtualEntryCompat(): Plugin {
  return {
    name: 'tanstack-start-virtual-entry-compat',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith('/@id/virtual:tanstack-start-client-entry'))
          req.url = req.url.replace('/@id/virtual:', '/@id/__x00__virtual:')
        next()
      })
    },
  }
}
