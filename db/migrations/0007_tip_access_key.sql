ALTER TABLE "tip"
ADD COLUMN "access_key_id" TEXT REFERENCES "access_key" ("id") ON DELETE SET NULL;

CREATE INDEX "tip_access_key_confirmed_idx" ON "tip" (
  "access_key_id",
  "confirmed_at"
) WHERE "access_key_id" IS NOT NULL;
