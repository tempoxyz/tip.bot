-- Track Slack receipt messages so a boost reaction can repeat the original payment.
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

CREATE UNIQUE INDEX "tip_receipt_message_message_idx" ON "tip_receipt_message" (
  "workspace_id",
  "channel_id",
  "message_ts"
);

CREATE INDEX "tip_receipt_message_tip_batch_idx" ON "tip_receipt_message" ("tip_batch_id");
