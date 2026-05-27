-- Track Slack receipt boost aggregate replies so threaded boosts update one summary message.
CREATE TABLE "receipt_boost_thread" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "channel_id" TEXT NOT NULL,
  "thread_ts" TEXT NOT NULL,
  "reply_ts" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "receipt_boost_thread_thread_idx" ON "receipt_boost_thread" (
  "workspace_id",
  "channel_id",
  "thread_ts"
);
