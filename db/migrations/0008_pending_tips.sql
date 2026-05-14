CREATE TABLE "pending_tip" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "sender_member_id" TEXT NOT NULL REFERENCES "member" ("id"),
  "recipient_provider_user_id" TEXT NOT NULL,
  "recipient_provider_label" TEXT,
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "token_address" TEXT NOT NULL,
  "memo" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'slack' CHECK ("provider" IN ('slack')),
  "provider_id" TEXT NOT NULL,
  "provider_channel_id" TEXT NOT NULL,
  "provider_thread_id" TEXT,
  "claimed_at" TEXT,
  "expired_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("claimed_at" IS NULL OR "expired_at" IS NULL)
);

CREATE INDEX "pending_tip_recipient_idx" ON "pending_tip" ("workspace_id", "recipient_provider_user_id");
CREATE INDEX "pending_tip_sender_idx" ON "pending_tip" ("sender_member_id");
