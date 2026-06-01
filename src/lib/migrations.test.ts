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

test('0020 allows Telegram provider rows while preserving Slack rows', () => {
  const [
    slackWorkspaceCount,
    workspaceSettings,
    channelProviderId,
    telegramWorkspaceCount,
    telegramIdentityCount,
    telegramBatchCount,
  ] = runSqlite(`
    ${migrationsSql({ before: '0020_telegram_provider.sql' })}

    INSERT INTO "account" ("id", "address", "created_at", "updated_at")
    VALUES ('account', '0x0000000000000000000000000000000000000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    INSERT INTO "workspace" ("id", "provider", "provider_id", "created_at", "updated_at", "default_token_address", "chain_id", "installed_at", "uninstalled_at")
    VALUES ('slack-workspace', 'slack', 'TWORKSPACE', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '0x0000000000000000000000000000000000000002', 42161, '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z');

    INSERT INTO "provider_identity" ("id", "provider", "provider_workspace_id", "provider_user_id", "created_at", "updated_at")
    VALUES ('slack-identity', 'slack', 'TWORKSPACE', 'U123', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    INSERT INTO "member" ("id", "workspace_id", "provider_identity_id", "provider_user_id", "created_at", "updated_at")
    VALUES ('slack-member', 'slack-workspace', 'slack-identity', 'U123', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    INSERT INTO "account_link_token" ("id", "account_id", "member_id", "token_hash", "access_key_address", "access_key_public_key", "access_key_ciphertext", "access_key_expires_at", "expires_at", "created_at", "channel_provider_id")
    VALUES ('token', 'account', 'slack-member', 'hash', '0x0000000000000000000000000000000000000003', 'public', 'ciphertext', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'slack');

    ${migrationSql('0020_telegram_provider.sql')}

    INSERT INTO "workspace" ("id", "provider", "provider_id", "created_at", "updated_at")
    VALUES ('telegram-workspace', 'telegram', '-100123', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    INSERT INTO "provider_identity" ("id", "provider", "provider_workspace_id", "provider_user_id", "created_at", "updated_at")
    VALUES ('telegram-identity', 'telegram', '-100123', '456', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    INSERT INTO "member" ("id", "workspace_id", "provider_identity_id", "provider_user_id", "created_at", "updated_at")
    VALUES ('telegram-member', 'telegram-workspace', 'telegram-identity', '456', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    INSERT INTO "tip_batch" ("id", "workspace_id", "idempotency_key", "sender_member_id", "provider", "provider_id", "provider_channel_id", "amount_each", "total_amount", "recipient_count", "token_address", "status", "created_at", "updated_at")
    VALUES ('telegram-batch', 'telegram-workspace', 'telegram-batch-key', 'telegram-member', 'telegram', '-100123', 'telegram:-100123', 1000, 1000, 1, '0x0000000000000000000000000000000000000001', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

.mode list
SELECT COUNT(*) FROM "workspace" WHERE "provider" = 'slack' AND "provider_id" = 'TWORKSPACE';
SELECT "default_token_address" || '|' || "chain_id" || '|' || "installed_at" || '|' || "uninstalled_at" FROM "workspace" WHERE "id" = 'slack-workspace';
SELECT "channel_provider_id" FROM "account_link_token" WHERE "id" = 'token';
SELECT COUNT(*) FROM "workspace" WHERE "provider" = 'telegram' AND "provider_id" = '-100123';
SELECT COUNT(*) FROM "provider_identity" WHERE "provider" = 'telegram' AND "provider_user_id" = '456';
SELECT COUNT(*) FROM "tip_batch" WHERE "provider" = 'telegram' AND "id" = 'telegram-batch';
  `)

  expect(slackWorkspaceCount).toBe('1')
  expect(workspaceSettings).toBe(
    '0x0000000000000000000000000000000000000002|42161|2026-01-02T00:00:00.000Z|2026-01-03T00:00:00.000Z',
  )
  expect(channelProviderId).toBe('slack')
  expect(telegramWorkspaceCount).toBe('1')
  expect(telegramIdentityCount).toBe('1')
  expect(telegramBatchCount).toBe('1')
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
