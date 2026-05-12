ALTER TABLE "workspace"
ADD COLUMN "default_token_address" TEXT;

DROP INDEX "account_link_token_account_idx";
DROP INDEX "account_link_token_member_idx";

CREATE TABLE "account_link_token_next" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "account_id" TEXT REFERENCES "account" ("id"),
  "member_id" TEXT NOT NULL REFERENCES "member" ("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE,
  "access_key_address" TEXT NOT NULL,
  "access_key_public_key" TEXT NOT NULL,
  "access_key_ciphertext" TEXT NOT NULL,
  "access_key_expires_at" TEXT NOT NULL,
  "access_key_authorization" TEXT,
  "expires_at" TEXT NOT NULL,
  "used_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("used_at" IS NULL OR ("account_id" IS NOT NULL AND "access_key_authorization" IS NOT NULL))
);

DROP TABLE "account_link_token";
ALTER TABLE "account_link_token_next" RENAME TO "account_link_token";

CREATE INDEX "account_link_token_account_idx" ON "account_link_token" ("account_id");
CREATE INDEX "account_link_token_member_idx" ON "account_link_token" ("member_id");
