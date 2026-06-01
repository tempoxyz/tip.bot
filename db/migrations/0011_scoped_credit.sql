-- Adds merchant-scoped credit records for the first Slack MVP.
CREATE TABLE "scoped_credit" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "provider_channel_id" TEXT NOT NULL,
  "provider_thread_id" TEXT,
  "sender_member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "recipient_member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "sender_provider_user_id" TEXT NOT NULL,
  "recipient_provider_user_id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "merchant_name" TEXT NOT NULL,
  "merchant_address" TEXT NOT NULL,
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "token_address" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('pending', 'issued', 'spent', 'canceled', 'expired', 'failed')),
  "tempo_transaction_hash" TEXT UNIQUE,
  "mpp_receipt_id" TEXT UNIQUE,
  "expires_at" TEXT NOT NULL,
  "failed_at" TEXT,
  "failure_reason" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("status" = 'failed' OR "failed_at" IS NULL),
  CHECK ("status" = 'failed' OR "failure_reason" IS NULL)
);

CREATE INDEX "scoped_credit_recipient_status_idx" ON "scoped_credit" (
  "recipient_member_id",
  "status",
  "created_at"
);
CREATE INDEX "scoped_credit_sender_created_idx" ON "scoped_credit" (
  "sender_member_id",
  "created_at"
);
CREATE INDEX "scoped_credit_workspace_created_idx" ON "scoped_credit" (
  "workspace_id",
  "created_at"
);

CREATE TABLE "scoped_credit_event" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "scoped_credit_id" TEXT NOT NULL REFERENCES "scoped_credit" ("id") ON DELETE CASCADE,
  "event_type" TEXT NOT NULL CHECK ("event_type" IN ('created', 'sender_confirmed', 'issued', 'recipient_notified', 'spend_started', 'paid', 'canceled', 'expired', 'failed')),
  "details_json" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "scoped_credit_event_credit_created_idx" ON "scoped_credit_event" (
  "scoped_credit_id",
  "created_at"
);
