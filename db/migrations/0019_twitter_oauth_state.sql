-- Store single-use X OAuth state for account link callbacks.
CREATE TABLE "provider_link_oauth_state" (
  "id" TEXT PRIMARY KEY,
  "challenge_id" TEXT NOT NULL REFERENCES "provider_link_challenge" ("id"),
  "state_hash" TEXT NOT NULL UNIQUE,
  "code_verifier_ciphertext" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "used_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE INDEX "provider_link_oauth_state_challenge_idx" ON "provider_link_oauth_state" ("challenge_id");
CREATE INDEX "provider_link_oauth_state_expires_idx" ON "provider_link_oauth_state" ("expires_at");
