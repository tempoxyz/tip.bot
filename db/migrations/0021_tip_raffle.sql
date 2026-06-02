-- Store Slack raffles and pending ticket entries for timed winner draws.
CREATE TABLE "tip_raffle" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "creator_member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "provider_id" TEXT NOT NULL,
  "provider_channel_id" TEXT NOT NULL,
  "provider_message_ts" TEXT NOT NULL,
  "memo" TEXT NOT NULL,
  "ticket_amount" INTEGER NOT NULL CHECK ("ticket_amount" > 0),
  "token_address" TEXT NOT NULL,
  "chain_id" INTEGER NOT NULL,
  "ends_at" TEXT NOT NULL,
  "ended_at" TEXT,
  "status" TEXT NOT NULL CHECK ("status" IN ('open', 'settling', 'ended')),
  "winner_member_id" TEXT REFERENCES "member" ("id") ON DELETE SET NULL,
  "winning_ticket_number" INTEGER CHECK ("winning_ticket_number" IS NULL OR "winning_ticket_number" > 0),
  "settled_amount" INTEGER NOT NULL DEFAULT 0 CHECK ("settled_amount" >= 0),
  "failed_ticket_count" INTEGER NOT NULL DEFAULT 0 CHECK ("failed_ticket_count" >= 0),
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "tip_raffle_ticket" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "raffle_id" TEXT NOT NULL REFERENCES "tip_raffle" ("id") ON DELETE CASCADE,
  "buyer_member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "ticket_count" INTEGER NOT NULL CHECK ("ticket_count" > 0),
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "tip_raffle_status_ends_idx" ON "tip_raffle" ("status", "ends_at");
CREATE INDEX "tip_raffle_workspace_created_idx" ON "tip_raffle" ("workspace_id", "created_at");
CREATE INDEX "tip_raffle_message_idx" ON "tip_raffle" ("provider_channel_id", "provider_message_ts");
CREATE INDEX "tip_raffle_ticket_raffle_idx" ON "tip_raffle_ticket" ("raffle_id", "created_at");
CREATE INDEX "tip_raffle_ticket_buyer_idx" ON "tip_raffle_ticket" ("buyer_member_id", "created_at");
