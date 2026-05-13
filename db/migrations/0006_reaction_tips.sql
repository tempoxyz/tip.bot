ALTER TABLE "workspace"
ADD COLUMN "reaction_tip_emoji" TEXT NOT NULL DEFAULT 'money_with_wings' CHECK ("reaction_tip_emoji" <> '');

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

CREATE TABLE "reaction_tip_thread" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "channel_id" TEXT NOT NULL,
  "message_ts" TEXT NOT NULL,
  "reaction" TEXT NOT NULL CHECK ("reaction" <> ''),
  "reply_ts" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "reaction_tip_thread_message_idx" ON "reaction_tip_thread" (
  "workspace_id",
  "channel_id",
  "message_ts",
  "reaction"
);
