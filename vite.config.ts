import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import regen from 'regen-ui/vite'
import autoImport from 'unplugin-auto-import/vite'
import iconsResolver from 'unplugin-icons/resolver'
import icons from 'unplugin-icons/vite'
import { defineConfig, lazyPlugins } from 'vite-plus'

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined
if (isTest) {
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
}

const eventemitter3Entry = path.resolve('node_modules/.pnpm/node_modules/eventemitter3/index.mjs')
const portlessTailscaleHost = getPortlessTailscaleHost()

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  fmt: {
    ignorePatterns: ['src/auto-imports.d.ts', 'src/routeTree.gen.ts'],
    singleQuote: true,
    semi: false,
  },
  lint: {
    ignorePatterns: [
      'dist/**',
      'scripts/**',
      'test/**',
      'src/auto-imports.d.ts',
      'src/lib/db.gen.ts',
      'src/routeTree.gen.ts',
      'worker-configuration.d.ts',
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
          exclude: ['test/e2e/**', 'test/**/*.workers.test.{ts,tsx}'],
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
          const { cloudflareTest } = await import('@cloudflare/vitest-pool-workers')
          return [
            cloudflareTest({
              main: 'test/worker.ts',
              miniflare: {
                bindings: {
                  ACCESS_KEY_ENCRYPTION_SECRET: 'test-access-key-encryption-secret',
                  FEE_PAYER_PRIVATE_KEY:
                    '0x0000000000000000000000000000000000000000000000000000000000000001',
                  SLACK_BOT_TOKEN: 'xoxb-test',
                  SLACK_SIGNING_SECRET: 'test-signing-secret',
                  TEMPO_CHAIN: 'tempoModerato',
                },
                compatibilityDate: '2026-05-07',
                compatibilityFlags: ['nodejs_compat'],
                d1Databases: ['DB'],
              },
            }),
          ]
        }),
        test: {
          include: ['test/**/*.workers.test.{ts,tsx}'],
          name: 'workers',
          setupFiles: ['test/workers.setup.ts'],
        },
      },
    ],
  },
  resolve: {
    alias: { eventemitter3: eventemitter3Entry },
    tsconfigPaths: true,
  },
  server: {
    allowedHosts: portlessTailscaleHost ? [portlessTailscaleHost] : [],
    fs: { allow: [process.cwd()] },
  },
  plugins: [
    devtools(),
    regen({ tailwindPlugin: false }),
    !isTest &&
      cloudflare({
        viteEnvironment: { name: 'ssr' },
        persistState: { path: process.env.CLOUDFLARE_PERSIST_STATE_PATH ?? '.wrangler/state' },
      }),
    tailwindcss(),
    icons({
      compiler: 'jsx',
      jsx: 'react',
    }),
    autoImport({
      dts: 'src/auto-imports.d.ts',
      include: [/\.[jt]sx?$/, /\.[jt]sx?\?tsr-/],
      resolvers: [
        iconsResolver({
          prefix: 'Icon',
          extension: 'jsx',
        }),
      ],
    }),
    tanstackStart({
      client: { entry: 'entry-client.tsx' },
    }),
    viteReact(),
  ],
})

function getPortlessTailscaleHost() {
  const url = process.env.PORTLESS_TAILSCALE_URL
  if (!url) return null

  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}
