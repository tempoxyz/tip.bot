-- Allow Telegram group workspaces and tips alongside Slack provider rows.
PRAGMA foreign_keys = OFF;

ALTER TABLE "workspace" RENAME TO "workspace_old";
ALTER TABLE "provider_identity" RENAME TO "provider_identity_old";
ALTER TABLE "member" RENAME TO "member_old";
ALTER TABLE "tip_batch" RENAME TO "tip_batch_old";
ALTER TABLE "account_link_token" RENAME TO "account_link_token_old";
ALTER TABLE "tip" RENAME TO "tip_old";
ALTER TABLE "reaction_tip_thread" RENAME TO "reaction_tip_thread_old";
ALTER TABLE "reaction_tip_config" RENAME TO "reaction_tip_config_old";
ALTER TABLE "reaction_tip" RENAME TO "reaction_tip_old";
ALTER TABLE "tip_receipt_message" RENAME TO "tip_receipt_message_old";
ALTER TABLE "receipt_boost_thread" RENAME TO "receipt_boost_thread_old";
ALTER TABLE "pending_tip" RENAME TO "pending_tip_old";

CREATE TABLE "workspace" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'slack' CHECK ("provider" IN ('slack', 'telegram')),
  "provider_id" TEXT NOT NULL,
  "name" TEXT,
  "default_amount" INTEGER NOT NULL DEFAULT 1000 CHECK ("default_amount" > 0),
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, "default_token_address" TEXT, "chain_id" INTEGER NOT NULL DEFAULT 4217, "installed_at" TEXT, "uninstalled_at" TEXT);

CREATE TABLE "provider_identity" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "provider" TEXT NOT NULL CHECK ("provider" IN ('slack', 'telegram')),
  "provider_workspace_id" TEXT,
  "provider_user_id" TEXT NOT NULL,
  "provider_global_user_id" TEXT,
  "account_id" TEXT REFERENCES "account" ("id") ON DELETE SET NULL,
  "display_name" TEXT,
  "real_name" TEXT,
  "metadata" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "member" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "provider_identity_id" TEXT NOT NULL REFERENCES "provider_identity" ("id"),
  "provider_user_id" TEXT NOT NULL,
  "login" TEXT,
  "name" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "tip_batch" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "sender_member_id" TEXT NOT NULL REFERENCES "member" ("id"),
  "provider" TEXT NOT NULL DEFAULT 'slack' CHECK ("provider" IN ('slack', 'telegram')),
  "provider_id" TEXT NOT NULL,
  "provider_channel_id" TEXT NOT NULL,
  "provider_thread_id" TEXT,
  "source" TEXT NOT NULL DEFAULT 'command' CHECK ("source" IN ('command', 'mention', 'reaction', 'migration')),
  "amount_each" INTEGER NOT NULL CHECK ("amount_each" > 0),
  "total_amount" INTEGER NOT NULL CHECK ("total_amount" > 0),
  "recipient_count" INTEGER NOT NULL CHECK ("recipient_count" > 0),
  "token_address" TEXT NOT NULL,
  "memo" TEXT,
  "status" TEXT NOT NULL CHECK ("status" IN ('pending', 'needs_confirmation', 'submitting', 'confirmed', 'failed', 'canceled')),
  "transaction_hash" TEXT UNIQUE,
  "failure_reason" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("status" = 'confirmed' OR "transaction_hash" IS NULL),
  CHECK ("status" = 'failed' OR "failure_reason" IS NULL)
);

CREATE TABLE "account_link_token" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "account_id" TEXT REFERENCES "account" ("id"),
  "member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE,
  "access_key_address" TEXT NOT NULL,
  "access_key_public_key" TEXT NOT NULL,
  "access_key_ciphertext" TEXT NOT NULL,
  "access_key_expires_at" TEXT NOT NULL,
  "access_key_authorization" TEXT,
  "expires_at" TEXT NOT NULL,
  "used_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "provider_channel_id" TEXT, "channel_provider_id" TEXT,
  CHECK ("used_at" IS NULL OR ("account_id" IS NOT NULL AND "access_key_authorization" IS NOT NULL))
);

CREATE TABLE "tip" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "sender_id" TEXT NOT NULL REFERENCES "account" ("id"),
  "recipient_id" TEXT NOT NULL REFERENCES "account" ("id"),
  "sender_member_id" TEXT NOT NULL REFERENCES "member" ("id"),
  "recipient_member_id" TEXT NOT NULL REFERENCES "member" ("id"),
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "token_address" TEXT NOT NULL,
  "memo" TEXT,
  "confirmed_at" TEXT,
  "failed_at" TEXT,
  "failure_reason" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "chain_id" INTEGER NOT NULL DEFAULT 4217,
  "sponsorship_memo" TEXT,
  "access_key_id" TEXT REFERENCES "access_key" ("id") ON DELETE SET NULL,
  "batch_id" TEXT REFERENCES "tip_batch" ("id") ON DELETE SET NULL,
  "transfer_log_index" INTEGER,
  CHECK ("confirmed_at" IS NULL OR "failed_at" IS NULL),
  CHECK ("failed_at" IS NOT NULL OR "failure_reason" IS NULL)
);

CREATE TABLE "reaction_tip_thread" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "channel_id" TEXT NOT NULL,
  "message_ts" TEXT NOT NULL,
  "reply_ts" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "reaction_tip_config" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "emoji" TEXT NOT NULL CHECK ("emoji" <> ''),
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "reaction_tip" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "channel_id" TEXT NOT NULL,
  "message_ts" TEXT NOT NULL,
  "thread_ts" TEXT NOT NULL,
  "reaction" TEXT NOT NULL CHECK ("reaction" <> ''),
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "sender_member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "recipient_member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "tip_id" TEXT REFERENCES "tip" ("id") ON DELETE SET NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "tip_receipt_message" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "tip_batch_id" TEXT NOT NULL REFERENCES "tip_batch" ("id") ON DELETE CASCADE,
  "channel_id" TEXT NOT NULL,
  "message_ts" TEXT NOT NULL,
  "thread_ts" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "receipt_boost_thread" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "channel_id" TEXT NOT NULL,
  "thread_ts" TEXT NOT NULL,
  "reply_ts" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "pending_tip" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "sender_id" TEXT NOT NULL REFERENCES "account" ("id"),
  "sender_member_id" TEXT NOT NULL REFERENCES "member" ("id"),
  "sender_provider_user_id" TEXT NOT NULL,
  "access_key_id" TEXT REFERENCES "access_key" ("id") ON DELETE SET NULL,
  "recipient_member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "recipient_provider_user_id" TEXT NOT NULL,
  "chain_id" INTEGER NOT NULL,
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "token_address" TEXT NOT NULL,
  "memo" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'slack' CHECK ("provider" IN ('slack', 'telegram')),
  "provider_id" TEXT NOT NULL,
  "provider_channel_id" TEXT NOT NULL,
  "provider_thread_id" TEXT,
  "provider_message_ts" TEXT,
  "source" TEXT NOT NULL CHECK ("source" IN ('command', 'mention', 'reaction')),
  "status" TEXT NOT NULL CHECK ("status" IN ('pending', 'sending', 'sent', 'failed', 'expired')),
  "tip_id" TEXT REFERENCES "tip" ("id") ON DELETE SET NULL,
  "failure_reason" TEXT,
  "expires_at" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("status" = 'sent' OR "tip_id" IS NULL),
  CHECK ("status" IN ('failed', 'expired') OR "failure_reason" IS NULL)
);

INSERT INTO "workspace" ("id", "provider", "provider_id", "name", "default_amount", "created_at", "updated_at", "default_token_address", "chain_id", "installed_at", "uninstalled_at") SELECT "id", "provider", "provider_id", "name", "default_amount", "created_at", "updated_at", "default_token_address", "chain_id", "installed_at", "uninstalled_at" FROM "workspace_old";
INSERT INTO "provider_identity" ("id", "provider", "provider_workspace_id", "provider_user_id", "provider_global_user_id", "account_id", "display_name", "real_name", "metadata", "created_at", "updated_at") SELECT "id", "provider", "provider_workspace_id", "provider_user_id", "provider_global_user_id", "account_id", "display_name", "real_name", "metadata", "created_at", "updated_at" FROM "provider_identity_old";
INSERT INTO "member" ("id", "workspace_id", "provider_identity_id", "provider_user_id", "login", "name", "created_at", "updated_at") SELECT "id", "workspace_id", "provider_identity_id", "provider_user_id", "login", "name", "created_at", "updated_at" FROM "member_old";
INSERT INTO "tip_batch" ("id", "workspace_id", "idempotency_key", "sender_member_id", "provider", "provider_id", "provider_channel_id", "provider_thread_id", "source", "amount_each", "total_amount", "recipient_count", "token_address", "memo", "status", "transaction_hash", "failure_reason", "created_at", "updated_at") SELECT "id", "workspace_id", "idempotency_key", "sender_member_id", "provider", "provider_id", "provider_channel_id", "provider_thread_id", "source", "amount_each", "total_amount", "recipient_count", "token_address", "memo", "status", "transaction_hash", "failure_reason", "created_at", "updated_at" FROM "tip_batch_old";
INSERT INTO "account_link_token" ("id", "account_id", "member_id", "token_hash", "access_key_address", "access_key_public_key", "access_key_ciphertext", "access_key_expires_at", "access_key_authorization", "expires_at", "used_at", "created_at", "provider_channel_id", "channel_provider_id") SELECT "id", "account_id", "member_id", "token_hash", "access_key_address", "access_key_public_key", "access_key_ciphertext", "access_key_expires_at", "access_key_authorization", "expires_at", "used_at", "created_at", "provider_channel_id", "channel_provider_id" FROM "account_link_token_old";
INSERT INTO "tip" ("id", "workspace_id", "idempotency_key", "sender_id", "recipient_id", "sender_member_id", "recipient_member_id", "amount", "token_address", "memo", "confirmed_at", "failed_at", "failure_reason", "created_at", "updated_at", "chain_id", "sponsorship_memo", "access_key_id", "batch_id", "transfer_log_index") SELECT "id", "workspace_id", "idempotency_key", "sender_id", "recipient_id", "sender_member_id", "recipient_member_id", "amount", "token_address", "memo", "confirmed_at", "failed_at", "failure_reason", "created_at", "updated_at", "chain_id", "sponsorship_memo", "access_key_id", "batch_id", "transfer_log_index" FROM "tip_old";
INSERT INTO "reaction_tip_thread" ("id", "workspace_id", "channel_id", "message_ts", "reply_ts", "created_at", "updated_at") SELECT "id", "workspace_id", "channel_id", "message_ts", "reply_ts", "created_at", "updated_at" FROM "reaction_tip_thread_old";
INSERT INTO "reaction_tip_config" ("id", "workspace_id", "emoji", "amount", "created_at", "updated_at") SELECT "id", "workspace_id", "emoji", "amount", "created_at", "updated_at" FROM "reaction_tip_config_old";
INSERT INTO "reaction_tip" ("id", "workspace_id", "channel_id", "message_ts", "thread_ts", "reaction", "idempotency_key", "sender_member_id", "recipient_member_id", "tip_id", "created_at", "updated_at") SELECT "id", "workspace_id", "channel_id", "message_ts", "thread_ts", "reaction", "idempotency_key", "sender_member_id", "recipient_member_id", "tip_id", "created_at", "updated_at" FROM "reaction_tip_old";
INSERT INTO "tip_receipt_message" ("id", "workspace_id", "tip_batch_id", "channel_id", "message_ts", "thread_ts", "created_at", "updated_at") SELECT "id", "workspace_id", "tip_batch_id", "channel_id", "message_ts", "thread_ts", "created_at", "updated_at" FROM "tip_receipt_message_old";
INSERT INTO "receipt_boost_thread" ("id", "workspace_id", "channel_id", "thread_ts", "reply_ts", "created_at", "updated_at") SELECT "id", "workspace_id", "channel_id", "thread_ts", "reply_ts", "created_at", "updated_at" FROM "receipt_boost_thread_old";
INSERT INTO "pending_tip" ("id", "workspace_id", "idempotency_key", "sender_id", "sender_member_id", "sender_provider_user_id", "access_key_id", "recipient_member_id", "recipient_provider_user_id", "chain_id", "amount", "token_address", "memo", "provider", "provider_id", "provider_channel_id", "provider_thread_id", "provider_message_ts", "source", "status", "tip_id", "failure_reason", "expires_at", "created_at", "updated_at") SELECT "id", "workspace_id", "idempotency_key", "sender_id", "sender_member_id", "sender_provider_user_id", "access_key_id", "recipient_member_id", "recipient_provider_user_id", "chain_id", "amount", "token_address", "memo", "provider", "provider_id", "provider_channel_id", "provider_thread_id", "provider_message_ts", "source", "status", "tip_id", "failure_reason", "expires_at", "created_at", "updated_at" FROM "pending_tip_old";

DROP TABLE "pending_tip_old";
DROP TABLE "receipt_boost_thread_old";
DROP TABLE "tip_receipt_message_old";
DROP TABLE "reaction_tip_old";
DROP TABLE "reaction_tip_config_old";
DROP TABLE "reaction_tip_thread_old";
DROP TABLE "tip_old";
DROP TABLE "account_link_token_old";
DROP TABLE "tip_batch_old";
DROP TABLE "member_old";
DROP TABLE "provider_identity_old";
DROP TABLE "workspace_old";

CREATE UNIQUE INDEX "workspace_provider_idx" ON "workspace" ("provider", "provider_id");
CREATE UNIQUE INDEX "provider_identity_provider_user_idx" ON "provider_identity" (
  "provider",
  coalesce("provider_workspace_id", ''),
  "provider_user_id"
);
CREATE INDEX "provider_identity_account_idx" ON "provider_identity" ("account_id");
CREATE INDEX "provider_identity_global_user_idx" ON "provider_identity" (
  "provider",
  "provider_global_user_id"
) WHERE "provider_global_user_id" IS NOT NULL;
CREATE UNIQUE INDEX "member_workspace_provider_user_idx" ON "member" ("workspace_id", "provider_user_id");
CREATE INDEX "member_provider_identity_idx" ON "member" ("provider_identity_id");
CREATE INDEX "tip_batch_workspace_created_idx" ON "tip_batch" ("workspace_id", "created_at");
CREATE INDEX "tip_batch_sender_created_idx" ON "tip_batch" ("sender_member_id", "created_at");
CREATE INDEX "tip_batch_status_idx" ON "tip_batch" ("status", "updated_at");
CREATE INDEX "tip_batch_transaction_hash_idx" ON "tip_batch" ("transaction_hash") WHERE "transaction_hash" IS NOT NULL;
CREATE INDEX "account_link_token_account_idx" ON "account_link_token" ("account_id");
CREATE INDEX "account_link_token_member_idx" ON "account_link_token" ("member_id");
CREATE INDEX "tip_workspace_created_idx" ON "tip" ("workspace_id", "created_at");
CREATE INDEX "tip_sender_created_idx" ON "tip" ("sender_id", "created_at");
CREATE INDEX "tip_recipient_created_idx" ON "tip" ("recipient_id", "created_at");
CREATE INDEX "tip_batch_tip_idx" ON "tip" ("batch_id");
CREATE UNIQUE INDEX "reaction_tip_thread_message_idx" ON "reaction_tip_thread" (
  "workspace_id",
  "channel_id",
  "message_ts"
);
CREATE UNIQUE INDEX "reaction_tip_config_workspace_emoji_idx" ON "reaction_tip_config" (
  "workspace_id",
  "emoji"
);
CREATE UNIQUE INDEX "reaction_tip_message_sender_idx" ON "reaction_tip" (
  "workspace_id",
  "channel_id",
  "message_ts",
  "reaction",
  "sender_member_id"
);
CREATE INDEX "reaction_tip_message_idx" ON "reaction_tip" (
  "workspace_id",
  "channel_id",
  "message_ts",
  "reaction",
  "created_at"
);
CREATE UNIQUE INDEX "reaction_tip_tip_idx" ON "reaction_tip" ("tip_id") WHERE "tip_id" IS NOT NULL;
CREATE UNIQUE INDEX "tip_receipt_message_message_idx" ON "tip_receipt_message" (
  "workspace_id",
  "channel_id",
  "message_ts"
);
CREATE INDEX "tip_receipt_message_tip_batch_idx" ON "tip_receipt_message" ("tip_batch_id");
CREATE UNIQUE INDEX "receipt_boost_thread_thread_idx" ON "receipt_boost_thread" (
  "workspace_id",
  "channel_id",
  "thread_ts"
);
CREATE INDEX "pending_tip_recipient_status_idx" ON "pending_tip" ("recipient_member_id", "status");
CREATE INDEX "pending_tip_sender_status_idx" ON "pending_tip" ("sender_id", "status");
CREATE INDEX "pending_tip_workspace_created_idx" ON "pending_tip" ("workspace_id", "created_at");
CREATE INDEX "pending_tip_status_expires_idx" ON "pending_tip" ("status", "expires_at");

PRAGMA foreign_keys = ON;
