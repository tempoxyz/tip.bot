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

ALTER TABLE "tip"
ADD COLUMN "batch_id" TEXT REFERENCES "tip_batch" ("id") ON DELETE SET NULL;

ALTER TABLE "tip"
ADD COLUMN "transfer_log_index" INTEGER;

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
  'batch_' || "tip"."id",
  "tip"."workspace_id",
  'migration:' || "tip"."idempotency_key",
  "tip"."sender_member_id",
  "workspace"."provider",
  "workspace"."provider_id",
  '',
  NULL,
  'migration',
  "tip"."amount",
  "tip"."amount",
  1,
  "tip"."token_address",
  "tip"."memo",
  CASE
    WHEN "tip"."confirmed_at" IS NOT NULL THEN 'confirmed'
    WHEN "tip"."failed_at" IS NOT NULL THEN 'failed'
    ELSE 'pending'
  END,
  "tip"."transaction_hash",
  "tip"."failure_reason",
  "tip"."created_at",
  "tip"."updated_at"
FROM "tip"
INNER JOIN "workspace" ON "workspace"."id" = "tip"."workspace_id";

UPDATE "tip"
SET "batch_id" = 'batch_' || "id";

CREATE INDEX "tip_batch_workspace_created_idx" ON "tip_batch" ("workspace_id", "created_at");
CREATE INDEX "tip_batch_sender_created_idx" ON "tip_batch" ("sender_member_id", "created_at");
CREATE INDEX "tip_batch_status_idx" ON "tip_batch" ("status", "updated_at");
CREATE INDEX "tip_batch_transaction_hash_idx" ON "tip_batch" ("transaction_hash") WHERE "transaction_hash" IS NOT NULL;
CREATE INDEX "tip_batch_tip_idx" ON "tip" ("batch_id");
