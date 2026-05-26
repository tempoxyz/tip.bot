CREATE TABLE "provider_identity" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "provider" TEXT NOT NULL CHECK ("provider" IN ('slack')),
  "provider_workspace_id" TEXT,
  "provider_user_id" TEXT NOT NULL,
  "provider_global_user_id" TEXT,
  "account_id" TEXT REFERENCES "account" ("id") ON DELETE SET NULL,
  "display_name" TEXT,
  "real_name" TEXT,
  "metadata" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "provider_identity_provider_user_idx" ON "provider_identity" (
  "provider",
  coalesce("provider_workspace_id", ''),
  "provider_user_id"
);

CREATE INDEX "provider_identity_account_idx" ON "provider_identity" ("account_id");
CREATE INDEX "provider_identity_global_user_idx" ON "provider_identity" (
  "provider",
  "provider_global_user_id"
) WHERE "provider_global_user_id" IS NOT NULL;

ALTER TABLE "member"
ADD COLUMN "provider_identity_id" TEXT REFERENCES "provider_identity" ("id") ON DELETE SET NULL;

INSERT INTO "provider_identity" (
  "id",
  "provider",
  "provider_workspace_id",
  "provider_user_id",
  "account_id",
  "display_name",
  "real_name",
  "created_at",
  "updated_at"
)
SELECT
  lower(hex(randomblob(16))),
  "workspace"."provider",
  "workspace"."provider_id",
  "member"."provider_user_id",
  "member"."account_id",
  "member"."login",
  "member"."name",
  "member"."created_at",
  "member"."updated_at"
FROM "member"
INNER JOIN "workspace" ON "workspace"."id" = "member"."workspace_id";

UPDATE "member"
SET "provider_identity_id" = (
  SELECT "provider_identity"."id"
  FROM "provider_identity"
  INNER JOIN "workspace" ON "workspace"."id" = "member"."workspace_id"
  WHERE "provider_identity"."provider" = "workspace"."provider"
    AND coalesce("provider_identity"."provider_workspace_id", '') = coalesce("workspace"."provider_id", '')
    AND "provider_identity"."provider_user_id" = "member"."provider_user_id"
  LIMIT 1
);

CREATE INDEX "member_provider_identity_idx" ON "member" ("provider_identity_id");
