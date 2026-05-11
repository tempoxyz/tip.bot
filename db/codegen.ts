import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { loadEnvFile } from 'node:process'
import { z } from 'zod'

const isRemote = process.argv.includes('--remote')
const envPath = path.resolve(import.meta.dirname, '..', '.env')
if (fs.existsSync(envPath)) loadEnvFile(envPath)

const env = z.parse(
  z.object({
    CLOUDFLARE_ACCOUNT_ID: isRemote ? z.string() : z.string().optional(),
    CLOUDFLARE_API_TOKEN: isRemote ? z.string() : z.string().optional(),
  }),
  process.env,
)

const databaseName = 'tipbot'
const schemaResult = JSON.parse(
  execFileSync(
    'pnpm',
    (() => {
      const args = [
        'exec',
        'wrangler',
        'd1',
        'execute',
        databaseName,
        isRemote ? '--remote' : '--local',
        '--command',
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name",
        '--json',
      ]
      const wranglerEnv = process.argv.includes('--env')
        ? process.argv[process.argv.indexOf('--env') + 1]
        : undefined
      if (wranglerEnv) args.splice(6, 0, '--env', wranglerEnv)
      return args
    })(),
    {
      encoding: 'utf-8',
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, ...env },
    },
  ),
)

const tables = schemaResult[0].results as { name: string; sql: string }[]

let output = '// Auto-generated from D1 database schema. Do not edit.\n\n'
output += "import type * as k from 'kysely'\n\n"

let schemaOutput = '// Auto-generated from D1 database schema. Do not edit.\n\n'
schemaOutput += "import { z } from 'zod'\n\n"

output += 'export interface DB {\n'
for (const { name } of tables) {
  output += `  ${JSON.stringify(name)}: ${tableTypeName(name)}\n`
}
output += '}\n\n'

for (const { name, sql } of tables) {
  const columns = parseCreateTable(sql).sort((a, b) => a.name.localeCompare(b.name))

  output += `type ${tableTypeName(name)} = {\n`
  schemaOutput += `export const ${name} = z.object({\n`
  for (const col of columns) {
    const baseType = sqliteToTs(col)
    const type = isGeneratedColumn(col) ? `k.Generated<${baseType}>` : baseType
    output += `  ${JSON.stringify(col.name)}: ${type}\n`
    schemaOutput += `  ${JSON.stringify(col.name)}: ${sqliteToZod(col)}${col.notnull ? '' : '.nullable()'},\n`
  }
  output += '}\n\n'
  schemaOutput += '})\n\n'
}

output += 'export declare namespace DB {\n'
for (const { name } of tables) {
  output += `  type ${tableTypeName(name)} = k.Selectable<DB[${JSON.stringify(name)}]>\n`
}
output += '\n  export namespace Insertable {\n'
for (const { name } of tables) {
  output += `    type ${tableTypeName(name)} = k.Insertable<DB[${JSON.stringify(name)}]>\n`
}
output += '  }\n\n  export namespace Selectable {\n'
for (const { name } of tables) {
  output += `    type ${tableTypeName(name)} = k.Selectable<DB[${JSON.stringify(name)}]>\n`
}
output += '  }\n\n  export namespace Updateable {\n'
for (const { name } of tables) {
  output += `    type ${tableTypeName(name)} = k.Updateable<DB[${JSON.stringify(name)}]>\n`
}
output += '  }\n}\n'

schemaOutput += 'export const db = {\n'
for (const { name } of tables) {
  schemaOutput += `  ${JSON.stringify(name)}: ${name},\n`
}
schemaOutput += '}\n'

writeGeneratedFile('db/types.gen.ts', output)
writeGeneratedFile('db/schemas.gen.ts', schemaOutput)

//////////////////////////////////////////////////////////////////////////

type Column = {
  enumValues: string[] | null
  hasDefaultValue: boolean
  name: string
  notnull: boolean
  type: string
}

function parseCreateTable(sql: string): Column[] {
  const columns: Column[] = []
  const match = sql.match(/\(([\s\S]*)\)/)
  if (!match) return columns

  const body = match[1]
  let depth = 0
  let current = ''
  const parts: string[] = []

  for (const char of body) {
    if (char === '(') depth++
    else if (char === ')') depth--
    else if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  if (current.trim()) parts.push(current.trim())

  for (const part of parts) {
    if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)/i.test(part)) continue

    const colMatch = part.match(/^["'`]?([\w$]+)["'`]?\s+([\w]+)/i)
    if (!colMatch) continue

    const [, name, type] = colMatch
    const enumValues = parseCheckInValues(part, name)
    const hasDefaultValue = /\bDEFAULT\b/i.test(part)
    const notnull = /NOT\s+NULL/i.test(part) || /PRIMARY\s+KEY/i.test(part)
    columns.push({ enumValues, hasDefaultValue, name, notnull, type })
  }

  return columns
}

function sqliteToTs(col: Column): string {
  const type = col.type.toUpperCase()
  const tsType = (() => {
    if (col.enumValues?.length && type.includes('TEXT'))
      return col.enumValues.map((value) => JSON.stringify(value)).join(' | ')
    if (type.includes('INT')) return 'number'
    if (
      type.includes('TEXT') ||
      type.includes('CHAR') ||
      type.includes('DATE') ||
      type.includes('TIME')
    ) {
      return 'string'
    }
    if (type.includes('REAL') || type.includes('FLOAT') || type.includes('DOUBLE')) {
      return 'number'
    }
    if (type.includes('BLOB')) return 'Uint8Array'
    return 'unknown'
  })()

  return col.notnull ? tsType : `${tsType} | null`
}

function isGeneratedColumn(col: Column): boolean {
  return col.hasDefaultValue || col.name === 'createdAt' || col.name === 'updatedAt'
}

function tableTypeName(table: string): string {
  return table
}

function sqliteToZod(col: Column): string {
  const type = col.type.toUpperCase()

  if (col.enumValues?.length && type.includes('TEXT')) {
    if (col.enumValues.length === 1) return `z.literal(${JSON.stringify(col.enumValues[0])})`
    return `z.enum([${col.enumValues.map((value) => JSON.stringify(value)).join(', ')}])`
  }
  if (type.includes('INT')) return 'z.number()'
  if (
    type.includes('TEXT') ||
    type.includes('CHAR') ||
    type.includes('DATE') ||
    type.includes('TIME')
  ) {
    return 'z.string()'
  }
  if (type.includes('REAL') || type.includes('FLOAT') || type.includes('DOUBLE')) {
    return 'z.number()'
  }
  if (type.includes('BLOB')) return 'z.instanceof(Uint8Array)'
  return 'z.unknown()'
}

function parseCheckInValues(part: string, column: string) {
  const match = part.match(
    new RegExp(
      `\\bCHECK\\s*\\(\\s*["'\`]??${escapeRegex(column)}["'\`]??\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`,
      'i',
    ),
  )
  if (!match) return null

  const values = [...match[1]!.matchAll(/'((?:''|[^'])*)'/g)].map((value) =>
    value[1]!.replaceAll("''", "'"),
  )
  return values.length ? values : null
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function writeGeneratedFile(filePath: string, output: string) {
  const outputPath = path.resolve(import.meta.dirname, '..', filePath)
  fs.writeFileSync(outputPath, `${output.trimEnd()}\n`)
  execFileSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, '..', 'node_modules/vite-plus/bin/vp'),
      'fmt',
      '--write',
      outputPath,
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  )
  console.log(`Generated ${filePath}`)
}
