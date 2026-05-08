CREATE TABLE "workspace" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "platform" TEXT NOT NULL DEFAULT 'slack',
  "platform_team_id" TEXT NOT NULL,
  "name" TEXT,
  "tip_emoji" TEXT NOT NULL DEFAULT 'money_with_wings',
  "tip_amount" TEXT NOT NULL DEFAULT '0.0001',
  "daily_cap" TEXT NOT NULL DEFAULT '1',
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "workspace_platform_team_idx" ON "workspace" ("platform", "platform_team_id");

CREATE TABLE "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "platform" TEXT NOT NULL DEFAULT 'slack',
  "platform_account_id" TEXT NOT NULL,
  "display_name" TEXT,
  "tempo_address" TEXT,
  "access_key_address" TEXT,
  "access_key_ciphertext" TEXT,
  "access_key_authorization" TEXT,
  "access_key_expires_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "account_platform_idx" ON "account" ("workspace_id", "platform", "platform_account_id");
CREATE INDEX "account_tempo_address_idx" ON "account" ("tempo_address");

CREATE TABLE "connect_token" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "platform" TEXT NOT NULL DEFAULT 'slack',
  "platform_account_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "expires_at" TEXT NOT NULL,
  "used_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "connect_token_account_idx" ON "connect_token" ("workspace_id", "platform_account_id");

CREATE TABLE "tip" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "source_type" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "sender_account_id" TEXT NOT NULL REFERENCES "account" ("id") ON DELETE CASCADE,
  "recipient_account_id" TEXT NOT NULL REFERENCES "account" ("id") ON DELETE CASCADE,
  "amount" TEXT NOT NULL,
  "token_address" TEXT NOT NULL,
  "reason" TEXT,
  "status" TEXT NOT NULL,
  "tx_hash" TEXT,
  "error" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "tip_workspace_created_idx" ON "tip" ("workspace_id", "created_at");
CREATE INDEX "tip_sender_created_idx" ON "tip" ("sender_account_id", "created_at");

CREATE TABLE "tip_attempt" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "tip_id" TEXT NOT NULL REFERENCES "tip" ("id") ON DELETE CASCADE,
  "sender_address" TEXT NOT NULL,
  "recipient_address" TEXT NOT NULL,
  "amount" TEXT NOT NULL,
  "token_address" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "tip_attempt_tip_idx" ON "tip_attempt" ("tip_id");
