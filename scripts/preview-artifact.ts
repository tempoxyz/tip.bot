import fs from 'node:fs'
import path from 'node:path'
import JSONC from 'tiny-jsonc'

// preview_deploy.yml runs this from main, never from a pull request. The pull
// request's Preview Build job builds the Worker with no Cloudflare token and
// uploads it as the `preview` artifact. That artifact is data: this script
// checks it, then writes the Wrangler config that uploads it, from main's
// wrangler.jsonc. Everything that names the Worker or grants access (name,
// bindings, D1 database, queues, routes, vars) comes from main's config. Only
// the module, asset and migration paths point at the artifact, and Wrangler
// bundles and runs none of it.
//
//   check <artifact>             Fails unless the artifact holds only what a
//                                preview needs, as regular files.
//   config <artifact> <output>   Writes the deploy config. Reads D1_ID,
//                                PREVIEW_APEX, PREVIEW_NAME, PR_NUMBER and
//                                TWITTER_BOT_HANDLE.
const [command, artifact, output] = process.argv.slice(2)
if (!artifact || (command !== 'check' && command !== 'config') || (command === 'config' && !output))
  throw new Error('Usage: preview-artifact.ts check <artifact> | config <artifact> <output>')
const root = path.resolve(artifact)

if (command === 'check') check()
else writeConfig()

function check() {
  // Wrangler follows symbolic links when it reads modules, assets and
  // migrations, so a link could upload or run this runner's files. Accept only
  // directories and regular files.
  ;(function walk(directory: string) {
    for (const entry of fs.readdirSync(directory)) {
      const file = path.join(directory, entry)
      const stat = fs.lstatSync(file)
      if (stat.isDirectory()) walk(file)
      else if (!stat.isFile()) throw new Error(`The artifact holds a link or special file: ${file}`)
    }
  })(root)

  const entries = fs.readdirSync(root).sort()
  const expected = [
    'client',
    'migrations',
    'server',
    'slack-manifest-bootstrap.json',
    'slack-manifest.json',
  ]
  if (JSON.stringify(entries) !== JSON.stringify(expected))
    throw new Error(
      `Expected the artifact to hold ${expected.join(', ')}, got ${entries.join(', ')}.`,
    )
  if (!fs.lstatSync(path.join(root, 'server/index.js')).isFile())
    throw new Error('The artifact has no server/index.js.')

  // Wrangler applies each *.sql file of migrations_dir in name order, and
  // records it by name. The SQL runs only against the preview's own database.
  for (const name of fs.readdirSync(path.join(root, 'migrations')))
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      throw new Error(`Unexpected migration file name: ${name}`)

  // The Slack step sends these manifests as they are, so each URL in them must
  // be on the pull request's own preview host.
  const origin = `https://${requiredEnv('PREVIEW_HOST')}/`
  for (const name of ['slack-manifest-bootstrap.json', 'slack-manifest.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
    if (manifest?.display_information?.name !== requiredEnv('SLACK_APP_NAME'))
      throw new Error(`${name} does not name the app ${requiredEnv('SLACK_APP_NAME')}.`)
    ;(function walk(value: unknown, at: string) {
      if (typeof value === 'string') {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith(origin))
          throw new Error(`${name} ${at} is not a URL on ${origin}: ${value}`)
      } else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${at}[${index}]`))
      else if (value && typeof value === 'object')
        for (const [key, item] of Object.entries(value)) walk(item, `${at}.${key}`)
    })(manifest, '$')
  }
}

function writeConfig() {
  const d1Id = requiredEnv('D1_ID')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d1Id))
    throw new Error(`Expected a D1 database ID, got ${d1Id}.`)
  const name = requiredEnv('PREVIEW_NAME')
  const apex = requiredEnv('PREVIEW_APEX')
  const handle = requiredEnv('TWITTER_BOT_HANDLE')
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error(`Expected an X handle, got ${handle}.`)

  // The same placeholders the preview build replaced in the pull request's copy.
  const text = fs
    .readFileSync('wrangler.jsonc', 'utf8')
    .replaceAll('"tipbot-preview-name"', JSON.stringify(name))
    .replaceAll('__PREVIEW_APEX__', apex)
    .replaceAll('__PREVIEW_PR_NUMBER__', requiredEnv('PR_NUMBER'))
    .replaceAll('__PREVIEW_TWITTER_BOT_HANDLE__', handle)
    .replaceAll('__PREVIEW_D1_ID__', d1Id)
  const config = JSONC.parse(text)
  const preview = config.env.preview

  // Only the preview environment deploys from this file.
  delete config.$schema
  config.env = { preview }

  // Pointed at the build the way the Cloudflare Vite plugin points the config
  // it generates: the server's modules uploaded unbundled, and the client's
  // files as assets. Wrangler resolves a module's sourceMappingURL comment and
  // uploads the file it names unless upload_source_maps is false, and the
  // build writes no source maps.
  const buildKeys = [
    'alias',
    'assets',
    'base_dir',
    'build',
    'define',
    'find_additional_modules',
    'main',
    'minify',
    'no_bundle',
    'rules',
    'tsconfig',
    'upload_source_maps',
  ]
  for (const key of buildKeys) delete preview[key]
  config.assets = { directory: path.join(root, 'client') }
  config.base_dir = path.join(root, 'server')
  config.find_additional_modules = true
  config.main = path.join(root, 'server/index.js')
  config.no_bundle = true
  config.rules = [{ globs: ['**/*.js', '**/*.mjs'], type: 'ESModule' }]
  config.upload_source_maps = false

  // The pull request's migrations, applied to the preview's own database only.
  for (const database of preview.d1_databases)
    database.migrations_dir = path.join(root, 'migrations')

  const host = `${apex}.tip.bot`
  const databases = preview.d1_databases.map((database: Record<string, string>) => [
    database.binding,
    database.database_name,
    database.database_id,
  ])
  if (preview.name !== name) throw new Error(`Expected the Worker ${name}, got ${preview.name}.`)
  if (JSON.stringify(databases) !== JSON.stringify([['DB', name, d1Id]]))
    throw new Error(`Expected one D1 binding to ${name}, got ${JSON.stringify(databases)}.`)
  const routes = JSON.stringify(preview.routes)
  if (routes !== JSON.stringify([{ pattern: host, custom_domain: true }]))
    throw new Error(`Expected only the custom domain ${host}, got ${routes}.`)
  if (preview.vars?.HOST !== host)
    throw new Error(`Expected HOST ${host}, got ${preview.vars?.HOST}.`)

  fs.mkdirSync(path.dirname(output!), { recursive: true })
  fs.writeFileSync(output!, `${JSON.stringify(config, null, 2)}\n`)
}

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}
