-- Store Slack tip jars so preset button clicks can update the original message.
CREATE TABLE "tip_ask" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "requester_member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "provider_id" TEXT NOT NULL,
  "provider_channel_id" TEXT NOT NULL,
  "provider_message_ts" TEXT NOT NULL,
  "memo" TEXT,
  "money_with_wings_amount" INTEGER NOT NULL CHECK ("money_with_wings_amount" > 0),
  "dollar_amount" INTEGER NOT NULL CHECK ("dollar_amount" > 0),
  "moneybag_amount" INTEGER NOT NULL CHECK ("moneybag_amount" > 0),
  "token_address" TEXT NOT NULL,
  "chain_id" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "tip_ask_workspace_created_idx" ON "tip_ask" ("workspace_id", "created_at");
CREATE INDEX "tip_ask_message_idx" ON "tip_ask" ("provider_channel_id", "provider_message_ts");
