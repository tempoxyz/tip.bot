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
        const { getWranglerVar } = await import('./config/wrangler')
        const host = getWranglerVar('HOST')
        const sentryEnvironment = (() => {
          if (host === 'curl.local') return 'development'
          if (host === 'curl.md') return 'production'
          return 'preview'
        })()
        return {
          __ENV__: JSON.stringify(sentryEnvironment),
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
          const url = process.env.PORTLESS_TAILSCALE_URL
          if (!url) return []
          try {
            return [new URL(url).hostname]
          } catch {
            return []
          }
        })()
      : [],
    fs: { allow: [process.cwd()] },
  },
  test: {
    projects: [
      {
        plugins: lazyPlugins(async () => {
          if (!isTest) return []

          // @cloudflare/vitest-pool-workers currently forwards this harmless workerd shutdown log.
          const writeStdout = process.stdout.write.bind(process.stdout)
          process.stdout.write = (chunk, ...args) => {
            if (String(chunk).includes('disconnected: WebSocket peer disconnected')) return true
            return writeStdout(chunk, ...(args as [BufferEncoding?, (() => void)?]))
          }
          const writeStderr = process.stderr.write.bind(process.stderr)
          process.stderr.write = (chunk, ...args) => {
            if (String(chunk).includes('disconnected: WebSocket peer disconnected')) return true
            return writeStderr(chunk, ...(args as [BufferEncoding?, (() => void)?]))
          }

          const { cloudflareTest } = await import('@cloudflare/vitest-pool-workers')
          const envMod = await import('./test/env.ts')
          return [
            cloudflareTest(async (config) => {
              const env = envMod.Env.parse(config.inject('env'))
              return {
                main: 'test/worker.ts',
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
                      className: 'ChatStateDO',
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
