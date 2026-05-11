import { defineConfig, lazyPlugins } from 'vite-plus'

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
        const host = getWranglerVar('HOST')
        const environment = (() => {
          if (host === 'tip.bot') return 'production'
          if (host === 'tip.localhost') return 'development'
          return 'development'
        })()
        return {
          __ENV__: JSON.stringify(environment),
          __HOST__: JSON.stringify(host),
          __ORIGIN__: process.env.PLAYWRIGHT
            ? `(typeof window !== 'undefined' ? window.location.origin : 'https://${host}')`
            : JSON.stringify(`https://${host}`),
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
    const { cloudflare } = await import('@cloudflare/vite-plugin')
    const { tanstackStart } = await import('@tanstack/react-start/plugin/vite')
    return [
      devtools.devtools(),
      !isTest &&
        cloudflare({
          viteEnvironment: { name: 'ssr' },
          persistState: { path: process.env.CLOUDFLARE_PERSIST_STATE_PATH ?? '.wrangler/state' },
          ...(process.env.PLAYWRIGHT
            ? {
                remoteBindings: false,
                config(config) {
                  config.vars = {
                    ...config.vars,
                    HOST: process.env.HOST ?? config.vars?.HOST,
                    SECRET_KEY: process.env.SECRET_KEY ?? '',
                    SLACK_API_URL: process.env.SLACK_API_URL ?? config.vars?.SLACK_API_URL,
                    SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID ?? '',
                    SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET ?? '',
                    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET ?? '',
                  }
                  delete config.secrets
                },
              }
            : {}),
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
    passWithNoTests: true,
    projects: [
      {
        plugins: lazyPlugins(async () => {
          if (!isTest) return []
          const { cloudflareTest } = await import('@cloudflare/vitest-pool-workers')
          const { setupVitestOutputFilter } = await import('./config/vitest.ts')
          const envMod = await import('./test/env.ts')
          setupVitestOutputFilter()
          return [
            cloudflareTest(async (config) => {
              const env = envMod.Env.parse(config.inject('env'))
              return {
                main: 'src/entry-server.ts',
                wrangler: { configPath: 'wrangler.jsonc' },
                miniflare: {
                  bindings: env,
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
          include: ['src/**/*.workers.test.ts'],
          name: 'workers',
          globalSetup: ['test/workers.global.setup.ts'],
          setupFiles: ['test/workers.setup.ts'],
        },
      },
    ],
  },
})
