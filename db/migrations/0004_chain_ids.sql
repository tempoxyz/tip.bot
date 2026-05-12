ALTER TABLE "workspace"
ADD COLUMN "chain_id" INTEGER NOT NULL DEFAULT 4217;

ALTER TABLE "access_key"
ADD COLUMN "chain_id" INTEGER NOT NULL DEFAULT 4217;

ALTER TABLE "access_key"
ADD COLUMN "authorization_used_at" TEXT;

ALTER TABLE "tip"
ADD COLUMN "chain_id" INTEGER NOT NULL DEFAULT 4217;

ALTER TABLE "tip"
ADD COLUMN "sponsorship_memo" TEXT;

CREATE UNIQUE INDEX "tip_sponsorship_memo_idx" ON "tip" ("sponsorship_memo") WHERE "sponsorship_memo" IS NOT NULL;
