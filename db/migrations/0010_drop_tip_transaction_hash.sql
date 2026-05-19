-- Drop single-tip transaction hashes now that receipts use tip_batch transaction hashes.
ALTER TABLE "tip" RENAME TO "tip_old";
ALTER TABLE "reaction_tip" RENAME TO "reaction_tip_old";

DROP INDEX "tip_workspace_created_idx";
DROP INDEX "tip_sender_created_idx";
DROP INDEX "tip_recipient_created_idx";
DROP INDEX "tip_access_key_confirmed_idx";
DROP INDEX "tip_batch_tip_idx";
DROP INDEX "reaction_tip_message_sender_idx";
DROP INDEX "reaction_tip_message_idx";
DROP INDEX "reaction_tip_tip_idx";

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

DROP TABLE "reaction_tip_old";
DROP TABLE "tip_old";

CREATE INDEX "tip_workspace_created_idx" ON "tip" ("workspace_id", "created_at");
CREATE INDEX "tip_sender_created_idx" ON "tip" ("sender_id", "created_at");
CREATE INDEX "tip_recipient_created_idx" ON "tip" ("recipient_id", "created_at");
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
