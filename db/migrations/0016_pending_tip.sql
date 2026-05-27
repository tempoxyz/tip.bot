-- Store queued tips for recipients who have not connected a wallet yet.
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
  "provider" TEXT NOT NULL DEFAULT 'slack' CHECK ("provider" IN ('slack')),
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

CREATE INDEX "pending_tip_recipient_status_idx" ON "pending_tip" ("recipient_member_id", "status");
CREATE INDEX "pending_tip_sender_status_idx" ON "pending_tip" ("sender_id", "status");
CREATE INDEX "pending_tip_workspace_created_idx" ON "pending_tip" ("workspace_id", "created_at");
CREATE INDEX "pending_tip_status_expires_idx" ON "pending_tip" ("status", "expires_at");
