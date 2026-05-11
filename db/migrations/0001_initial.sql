CREATE TABLE "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "address" TEXT NOT NULL UNIQUE,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "access_key" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "account_id" TEXT NOT NULL REFERENCES "account" ("id"),
  "address" TEXT NOT NULL UNIQUE,
  "ciphertext" TEXT NOT NULL,
  "authorization" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "revoked_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "access_key_account_idx" ON "access_key" ("account_id");

CREATE TABLE "workspace" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'slack' CHECK ("provider" IN ('slack')),
  "provider_id" TEXT NOT NULL,
  "name" TEXT,
  "default_amount" INTEGER NOT NULL DEFAULT 1000 CHECK ("default_amount" > 0),
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "workspace_provider_idx" ON "workspace" ("provider", "provider_id");

CREATE TABLE "member" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "account_id" TEXT REFERENCES "account" ("id"),
  "provider_user_id" TEXT NOT NULL,
  "login" TEXT,
  "name" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "member_workspace_provider_user_idx" ON "member" ("workspace_id", "provider_user_id");
CREATE INDEX "member_account_idx" ON "member" ("account_id");

CREATE TABLE "account_link_token" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "account_id" TEXT NOT NULL REFERENCES "account" ("id"),
  "member_id" TEXT REFERENCES "member" ("id") ON DELETE SET NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "expires_at" TEXT NOT NULL,
  "used_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("used_at" IS NOT NULL OR "member_id" IS NULL)
);

CREATE INDEX "account_link_token_account_idx" ON "account_link_token" ("account_id");
CREATE INDEX "account_link_token_member_idx" ON "account_link_token" ("member_id");

CREATE TABLE "tip" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "sender_id" TEXT NOT NULL REFERENCES "account" ("id"),
  "recipient_id" TEXT NOT NULL REFERENCES "account" ("id"),
  "sender_member_id" TEXT NOT NULL REFERENCES "member" ("id"),
  "recipient_member_id" TEXT NOT NULL REFERENCES "member" ("id"),
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "token_address" TEXT NOT NULL,
  "memo" TEXT,
  "transaction_hash" TEXT UNIQUE,
  "confirmed_at" TEXT,
  "failed_at" TEXT,
  "failure_reason" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("confirmed_at" IS NULL OR "failed_at" IS NULL),
  CHECK ("failed_at" IS NOT NULL OR "failure_reason" IS NULL)
);

CREATE INDEX "tip_workspace_created_idx" ON "tip" ("workspace_id", "created_at");
CREATE INDEX "tip_sender_created_idx" ON "tip" ("sender_id", "created_at");
CREATE INDEX "tip_recipient_created_idx" ON "tip" ("recipient_id", "created_at");
