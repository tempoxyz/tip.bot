-- Store Slack airdrops with a creator-funded claim pot.
CREATE TABLE "tip_airdrop" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "creator_member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "provider_id" TEXT NOT NULL,
  "provider_channel_id" TEXT NOT NULL,
  "provider_message_ts" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "total_amount" INTEGER NOT NULL CHECK ("total_amount" > 0),
  "claimed_amount" INTEGER NOT NULL DEFAULT 0 CHECK ("claimed_amount" >= 0),
  "claim_amount" INTEGER NOT NULL CHECK ("claim_amount" > 0),
  "token_address" TEXT NOT NULL,
  "chain_id" INTEGER NOT NULL,
  "ends_at" TEXT NOT NULL,
  "ended_at" TEXT,
  "status" TEXT NOT NULL CHECK ("status" IN ('open', 'ended')),
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "tip_airdrop_claim" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "airdrop_id" TEXT NOT NULL REFERENCES "tip_airdrop" ("id") ON DELETE CASCADE,
  "recipient_member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "tip_airdrop_status_ends_idx" ON "tip_airdrop" ("status", "ends_at");
CREATE INDEX "tip_airdrop_workspace_created_idx" ON "tip_airdrop" ("workspace_id", "created_at");
CREATE INDEX "tip_airdrop_message_idx" ON "tip_airdrop" ("provider_channel_id", "provider_message_ts");
CREATE INDEX "tip_airdrop_claim_airdrop_idx" ON "tip_airdrop_claim" ("airdrop_id", "created_at");
CREATE INDEX "tip_airdrop_claim_recipient_idx" ON "tip_airdrop_claim" ("recipient_member_id", "created_at");
