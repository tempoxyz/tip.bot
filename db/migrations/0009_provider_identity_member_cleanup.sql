-- Move account links fully to provider_identity and make member identities required.
INSERT OR IGNORE INTO "provider_identity" (
  "id",
  "provider",
  "provider_workspace_id",
  "provider_user_id",
  "account_id",
  "display_name",
  "real_name",
  "created_at",
  "updated_at"
)
SELECT
  lower(hex(randomblob(16))),
  "workspace"."provider",
  "workspace"."provider_id",
  "member"."provider_user_id",
  "member"."account_id",
  "member"."login",
  "member"."name",
  "member"."created_at",
  "member"."updated_at"
FROM "member"
INNER JOIN "workspace" ON "workspace"."id" = "member"."workspace_id"
WHERE "member"."provider_identity_id" IS NULL;

UPDATE "member"
SET "provider_identity_id" = (
  SELECT "provider_identity"."id"
  FROM "provider_identity"
  INNER JOIN "workspace" ON "workspace"."id" = "member"."workspace_id"
  WHERE "provider_identity"."provider" = "workspace"."provider"
    AND coalesce("provider_identity"."provider_workspace_id", '') = coalesce("workspace"."provider_id", '')
    AND "provider_identity"."provider_user_id" = "member"."provider_user_id"
  LIMIT 1
)
WHERE "provider_identity_id" IS NULL;

ALTER TABLE "member" RENAME TO "member_old";
ALTER TABLE "tip_batch" RENAME TO "tip_batch_old";
ALTER TABLE "tip" RENAME TO "tip_old";
ALTER TABLE "reaction_tip" RENAME TO "reaction_tip_old";
ALTER TABLE "account_link_token" RENAME TO "account_link_token_old";

DROP INDEX "member_workspace_provider_user_idx";
DROP INDEX "member_account_idx";
DROP INDEX "member_provider_identity_idx";
DROP INDEX "tip_batch_workspace_created_idx";
DROP INDEX "tip_batch_sender_created_idx";
DROP INDEX "tip_batch_status_idx";
DROP INDEX "tip_batch_transaction_hash_idx";
DROP INDEX "tip_workspace_created_idx";
DROP INDEX "tip_sender_created_idx";
DROP INDEX "tip_recipient_created_idx";
DROP INDEX "tip_access_key_confirmed_idx";
DROP INDEX "tip_batch_tip_idx";
DROP INDEX "reaction_tip_message_sender_idx";
DROP INDEX "reaction_tip_message_idx";
DROP INDEX "reaction_tip_tip_idx";
DROP INDEX "account_link_token_account_idx";
DROP INDEX "account_link_token_member_idx";

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
  "provider" TEXT NOT NULL DEFAULT 'slack' CHECK ("provider" IN ('slack')),
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
  "transaction_hash" TEXT UNIQUE,
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
  "provider_channel_id" TEXT,
  CHECK ("used_at" IS NULL OR ("account_id" IS NOT NULL AND "access_key_authorization" IS NOT NULL))
);

INSERT INTO "member" (
  "id",
  "workspace_id",
  "provider_identity_id",
  "provider_user_id",
  "login",
  "name",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  "workspace_id",
  "provider_identity_id",
  "provider_user_id",
  "login",
  "name",
  "created_at",
  "updated_at"
FROM "member_old";

INSERT INTO "tip_batch" (
  "id",
  "workspace_id",
  "idempotency_key",
  "sender_member_id",
  "provider",
  "provider_id",
  "provider_channel_id",
  "provider_thread_id",
  "source",
  "amount_each",
  "total_amount",
  "recipient_count",
  "token_address",
  "memo",
  "status",
  "transaction_hash",
  "failure_reason",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  "workspace_id",
  "idempotency_key",
  "sender_member_id",
  "provider",
  "provider_id",
  "provider_channel_id",
  "provider_thread_id",
  "source",
  "amount_each",
  "total_amount",
  "recipient_count",
  "token_address",
  "memo",
  "status",
  "transaction_hash",
  "failure_reason",
  "created_at",
  "updated_at"
FROM "tip_batch_old";

INSERT INTO "tip" (
  "id",
  "workspace_id",
  "idempotency_key",
  "sender_id",
  "recipient_id",
  "sender_member_id",
  "recipient_member_id",
  "amount",
  "token_address",
  "memo",
  "transaction_hash",
  "confirmed_at",
  "failed_at",
  "failure_reason",
  "created_at",
  "updated_at",
  "chain_id",
  "sponsorship_memo",
  "access_key_id",
  "batch_id",
  "transfer_log_index"
)
SELECT
  "id",
  "workspace_id",
  "idempotency_key",
  "sender_id",
  "recipient_id",
  "sender_member_id",
  "recipient_member_id",
  "amount",
  "token_address",
  "memo",
  "transaction_hash",
  "confirmed_at",
  "failed_at",
  "failure_reason",
  "created_at",
  "updated_at",
  "chain_id",
  "sponsorship_memo",
  "access_key_id",
  "batch_id",
  "transfer_log_index"
FROM "tip_old";

INSERT INTO "reaction_tip" (
  "id",
  "workspace_id",
  "channel_id",
  "message_ts",
  "thread_ts",
  "reaction",
  "idempotency_key",
  "sender_member_id",
  "recipient_member_id",
  "tip_id",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  "workspace_id",
  "channel_id",
  "message_ts",
  "thread_ts",
  "reaction",
  "idempotency_key",
  "sender_member_id",
  "recipient_member_id",
  "tip_id",
  "created_at",
  "updated_at"
FROM "reaction_tip_old";

INSERT INTO "account_link_token" (
  "id",
  "account_id",
  "member_id",
  "token_hash",
  "access_key_address",
  "access_key_public_key",
  "access_key_ciphertext",
  "access_key_expires_at",
  "access_key_authorization",
  "expires_at",
  "used_at",
  "created_at",
  "provider_channel_id"
)
SELECT
  "id",
  "account_id",
  "member_id",
  "token_hash",
  "access_key_address",
  "access_key_public_key",
  "access_key_ciphertext",
  "access_key_expires_at",
  "access_key_authorization",
  "expires_at",
  "used_at",
  "created_at",
  "provider_channel_id"
FROM "account_link_token_old";

DROP TABLE "reaction_tip_old";
DROP TABLE "tip_old";
DROP TABLE "tip_batch_old";
DROP TABLE "account_link_token_old";
DROP TABLE "member_old";

CREATE UNIQUE INDEX "member_workspace_provider_user_idx" ON "member" ("workspace_id", "provider_user_id");
CREATE INDEX "member_provider_identity_idx" ON "member" ("provider_identity_id");
CREATE INDEX "tip_batch_workspace_created_idx" ON "tip_batch" ("workspace_id", "created_at");
CREATE INDEX "tip_batch_sender_created_idx" ON "tip_batch" ("sender_member_id", "created_at");
CREATE INDEX "tip_batch_status_idx" ON "tip_batch" ("status", "updated_at");
CREATE INDEX "tip_batch_transaction_hash_idx" ON "tip_batch" ("transaction_hash") WHERE "transaction_hash" IS NOT NULL;
CREATE INDEX "tip_workspace_created_idx" ON "tip" ("workspace_id", "created_at");
CREATE INDEX "tip_sender_created_idx" ON "tip" ("sender_id", "created_at");
CREATE INDEX "tip_recipient_created_idx" ON "tip" ("recipient_id", "created_at");
CREATE INDEX "tip_access_key_confirmed_idx" ON "tip" (
  "access_key_id",
  "confirmed_at"
) WHERE "access_key_id" IS NOT NULL;
CREATE INDEX "tip_batch_tip_idx" ON "tip" ("batch_id");
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
CREATE INDEX "account_link_token_account_idx" ON "account_link_token" ("account_id");
CREATE INDEX "account_link_token_member_idx" ON "account_link_token" ("member_id");
