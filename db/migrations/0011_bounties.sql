CREATE TABLE "bounty" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "provider_channel_id" TEXT NOT NULL,
  "provider_thread_id" TEXT,
  "creator_member_id" TEXT NOT NULL REFERENCES "member" ("id"),
  "oracle_member_id" TEXT NOT NULL REFERENCES "member" ("id"),
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "token_address" TEXT NOT NULL,
  "memo" TEXT,
  "deadline_at" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'resolved', 'refunded', 'canceled')),
  "resolution_batch_id" TEXT REFERENCES "tip_batch" ("id") ON DELETE SET NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TEXT,
  "refunded_at" TEXT,
  CHECK ("resolved_at" IS NULL OR "refunded_at" IS NULL)
);

CREATE INDEX "bounty_workspace_status_deadline_idx" ON "bounty" ("workspace_id", "status", "deadline_at");
CREATE INDEX "bounty_creator_idx" ON "bounty" ("creator_member_id", "created_at");
CREATE INDEX "bounty_oracle_idx" ON "bounty" ("oracle_member_id", "created_at");
