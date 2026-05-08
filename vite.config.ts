import path from 'node:path'
import { defineConfig, lazyPlugins } from 'vite-plus'

const isStaticCheck = ['check', 'fmt', 'lint'].includes(process.env.VP_COMMAND ?? '')
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
    '*.{ts,tsx}': "bash -c 'pnpm check:types'",
  },
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
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'test/**',
      'src/auto-imports.d.ts',
      'src/routeTree.gen.ts',
      'src/worker-configuration.d.ts',
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          exclude: [
            'src/**/*.workers.test.{ts,tsx}',
            'test/e2e/**',
            'test/**/*.workers.test.{ts,tsx}',
          ],
          include: [
            'src/**/*.test.{ts,tsx}',
            'src/**/*.spec.{ts,tsx}',
            'test/**/*.test.{ts,tsx}',
            'test/**/*.spec.{ts,tsx}',
          ],
          name: 'unit',
        },
      },
      {
        plugins: lazyPlugins(async () => {
          if (!isTest) return []
          // @cloudflare/vitest-pool-workers currently forwards this harmless workerd shutdown log.
          const writeStdout = process.stdout.write.bind(process.stdout)
          const writeStderr = process.stderr.write.bind(process.stderr)
          process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
            if (String(chunk).includes('disconnected: WebSocket peer disconnected')) return true
            return writeStdout(chunk, ...(args as [BufferEncoding?, (() => void)?]))
          }) as typeof process.stdout.write
          process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
            if (String(chunk).includes('disconnected: WebSocket peer disconnected')) return true
            return writeStderr(chunk, ...(args as [BufferEncoding?, (() => void)?]))
          }) as typeof process.stderr.write

          const envModule = await import('./test/env.ts')
          const { cloudflareTest } = await import('@cloudflare/vitest-pool-workers')
          return [
            cloudflareTest({
              main: 'test/worker.ts',
              miniflare: {
                bindings: envModule.Env.get(),
                compatibilityDate: '2026-05-07',
                compatibilityFlags: ['nodejs_compat'],
                d1Databases: ['DB'],
              },
            }),
          ]
        }),
        test: {
          include: ['src/**/*.workers.test.{ts,tsx}', 'test/**/*.workers.test.{ts,tsx}'],
          name: 'workers',
          setupFiles: ['test/workers.setup.ts'],
        },
      },
    ],
  },
  resolve: {
    alias: {
      eventemitter3: path.resolve('node_modules/.pnpm/node_modules/eventemitter3/index.mjs'),
    },
    tsconfigPaths: true,
  },
  server: {
    allowedHosts: isStaticCheck
      ? []
      : (() => {
          const url = process.env.PORTLESS_TAILSCALE_URL
          if (!url) return []
          try {
            return [new URL(url).hostname]
          } catch {
            return []
          }
        })(),
    fs: { allow: [process.cwd()] },
  },
  plugins: lazyPlugins(async () => {
    const [
      autoImportModule,
      devtoolsModule,
      iconsModule,
      iconsResolverModule,
      tailwindcssModule,
      tanstackStartModule,
      viteReactModule,
    ] = await Promise.all([
      import('unplugin-auto-import/vite'),
      import('@tanstack/devtools-vite'),
      import('unplugin-icons/vite'),
      import('unplugin-icons/resolver'),
      import('@tailwindcss/vite'),
      import('@tanstack/react-start/plugin/vite'),
      import('@vitejs/plugin-react'),
    ])

    return [
      devtoolsModule.devtools(),
      !isTest &&
        (await import('@cloudflare/vite-plugin')).cloudflare({
          viteEnvironment: { name: 'ssr' },
          persistState: { path: process.env.CLOUDFLARE_PERSIST_STATE_PATH ?? '.wrangler/state' },
        }),
      tailwindcssModule.default(),
      iconsModule.default({
        compiler: 'jsx',
        jsx: 'react',
      }),
      autoImportModule.default({
        dts: 'src/auto-imports.d.ts',
        include: [/\.[jt]sx?$/, /\.[jt]sx?\?tsr-/],
        resolvers: [
          iconsResolverModule.default({
            prefix: 'Icon',
            extension: 'jsx',
          }),
        ],
      }),
      tanstackStartModule.tanstackStart(),
      viteReactModule.default(),
    ]
  }),
})
