ALTER TABLE "access_key"
ADD COLUMN "token_address" TEXT;

CREATE INDEX "access_key_account_chain_token_idx" ON "access_key" ("account_id", "chain_id", "token_address");
