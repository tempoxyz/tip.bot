import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

test('0013 combines reaction tip thread rows across reaction emoji', () => {
  const [survivor, rows, columns, duplicateCount] = runSqlite(`
    ${migrationsSql({ before: '0013_combine_reaction_tip_threads.sql' })}

    INSERT INTO "workspace" ("id", "provider_id", "created_at", "updated_at")
    VALUES ('workspace', 'TWORKSPACE', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    INSERT INTO "reaction_tip_thread" ("id", "workspace_id", "channel_id", "message_ts", "reaction", "reply_ts", "created_at", "updated_at")
    VALUES
      ('b-survivor-tiebreak-loser', 'workspace', 'C123', '1000.000001', 'dollar', '2000.000002', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('a-survivor', 'workspace', 'C123', '1000.000001', 'money_with_wings', '2000.000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('c-created-loser', 'workspace', 'C123', '1000.000001', 'moneybag', '2000.000003', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
      ('different-message', 'workspace', 'C123', '1000.000002', 'moneybag', '2000.000004', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    ${migrationSql('0013_combine_reaction_tip_threads.sql')}

.mode list
SELECT group_concat("id" || ':' || "reply_ts", ',') FROM "reaction_tip_thread" WHERE "message_ts" = '1000.000001' ORDER BY "id";
SELECT group_concat("id", ',') FROM "reaction_tip_thread" ORDER BY "id";
SELECT SUM("name" = 'reaction') FROM pragma_table_info('reaction_tip_thread');
INSERT OR IGNORE INTO "reaction_tip_thread" ("id", "workspace_id", "channel_id", "message_ts", "reply_ts")
VALUES ('duplicate', 'workspace', 'C123', '1000.000001', '2000.999999');
SELECT COUNT(*) AS "count" FROM "reaction_tip_thread" WHERE "message_ts" = '1000.000001';
  `)

  expect(survivor).toBe('a-survivor:2000.000001')
  expect(rows).toBe('a-survivor,different-message')
  expect(columns).toBe('0')
  expect(duplicateCount).toBe('1')
})

function runSqlite(sql: string) {
  return execFileSync('sqlite3', [':memory:'], { encoding: 'utf8', input: sql })
    .trim()
    .split('\n')
    .filter(Boolean)
}

function migrationsSql(options: { before: string }) {
  let sql = ''
  for (const migration of fs.readdirSync(migrationsPath()).sort()) {
    if (migration === options.before) return sql
    if (migration.endsWith('.sql')) sql += `${migrationSql(migration)}\n`
  }
  return sql
}

function migrationSql(migration: string) {
  return fs.readFileSync(path.join(migrationsPath(), migration), 'utf8')
}

function migrationsPath() {
  return path.join(import.meta.dirname, '../../db/migrations')
}
