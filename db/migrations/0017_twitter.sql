-- Add Twitter identity proof challenges for wallet-to-X linking.
CREATE TABLE "provider_link_challenge" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "provider" TEXT NOT NULL CHECK ("provider" IN ('twitter')),
  "wallet_address" TEXT NOT NULL,
  "account_id" TEXT REFERENCES "account" ("id") ON DELETE SET NULL,
  "access_key_address" TEXT NOT NULL,
  "access_key_public_key" TEXT NOT NULL,
  "access_key_ciphertext" TEXT NOT NULL,
  "access_key_expires_at" TEXT NOT NULL,
  "access_key_authorization" TEXT,
  "proof_hash" TEXT UNIQUE,
  "provider_user_id" TEXT,
  "provider_handle" TEXT,
  "tweet_id" TEXT,
  "expires_at" TEXT NOT NULL,
  "used_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("used_at" IS NULL OR ("account_id" IS NOT NULL AND "access_key_authorization" IS NOT NULL AND "provider_user_id" IS NOT NULL))
);

CREATE INDEX "provider_link_challenge_provider_user_idx" ON "provider_link_challenge" ("provider", "provider_user_id");
CREATE INDEX "provider_link_challenge_wallet_idx" ON "provider_link_challenge" ("wallet_address");
CREATE INDEX "provider_link_challenge_expires_idx" ON "provider_link_challenge" ("expires_at");
