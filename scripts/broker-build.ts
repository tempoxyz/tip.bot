import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Builds what the Cloudflare Deploy Broker's trusted builder attests for the
// production Worker: dist/server (the Worker and its chunks), dist/client (the
// static assets) and dist/server/wrangler.json. It needs no Cloudflare
// credential. production.yml passes SLACK_APP_ID.
execFileSync('pnpm', ['build'], {
  env: { ...process.env, CLOUDFLARE_ENV: 'production' },
  stdio: 'inherit',
})

const configPath = 'dist/server/wrangler.json'
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
if (config.name !== 'tipbot') throw new Error(`Expected the tipbot Worker, got ${config.name}.`)

// The broker never replays Durable Object migrations. It checks the classes the
// live Worker exports, so this build declares them as exports instead: the
// classes that wrangler.jsonc's applied migrations leave, with the storage each
// was created with. wrangler.jsonc keeps the migrations for previews and local
// development. Deleting or transferring a class needs a broker policy change.
config.exports = (() => {
  const classes = new Map<string, 'legacy-kv' | 'sqlite'>()
  for (const migration of config.migrations ?? []) {
    const fields = Object.keys(migration).filter((field) => field !== 'tag')
    for (const field of fields)
      if (!['new_classes', 'new_sqlite_classes', 'renamed_classes'].includes(field))
        throw new Error(`Durable Object migration ${migration.tag} uses ${field}.`)
    for (const name of migration.new_sqlite_classes ?? []) classes.set(name, 'sqlite')
    for (const name of migration.new_classes ?? []) classes.set(name, 'legacy-kv')
    for (const rename of migration.renamed_classes ?? []) {
      const storage = classes.get(rename.from)
      if (!storage)
        throw new Error(`Durable Object migration ${migration.tag} renames ${rename.from}.`)
      classes.delete(rename.from)
      classes.set(rename.to, storage)
    }
  }
  return Object.fromEntries(
    [...classes]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, storage]) => [name, { storage, type: 'durable-object' }]),
  )
})()
delete config.migrations

// The Vite plugin copies migrations_dir from wrangler.jsonc unchanged, but the
// builder resolves it against this file's directory.
for (const database of config.d1_databases ?? [])
  if (database.migrations_dir)
    database.migrations_dir = path.relative(path.dirname(configPath), database.migrations_dir)

// The broker requires a named assets binding. Nothing reads it.
config.assets.binding = 'ASSETS'

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

// The broker rejects .assetsignore. The Vite plugin's lists only wrangler.json
// and .dev.vars, neither of which the client build writes.
const assetsIgnorePath = 'dist/client/.assetsignore'
if (fs.existsSync(assetsIgnorePath)) {
  const ignored = fs.readFileSync(assetsIgnorePath, 'utf8').split('\n').filter(Boolean)
  for (const name of ignored)
    if (!['.dev.vars', 'wrangler.json'].includes(name) || fs.existsSync(`dist/client/${name}`))
      throw new Error(`dist/client/.assetsignore ignores ${name}.`)
  fs.rmSync(assetsIgnorePath)
}
