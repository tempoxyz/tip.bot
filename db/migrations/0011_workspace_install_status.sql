-- Track whether a workspace has installed Tipbot or only exists from pre-install Slack Connect usage.
ALTER TABLE "workspace"
ADD COLUMN "installed_at" TEXT;

ALTER TABLE "workspace"
ADD COLUMN "uninstalled_at" TEXT;

UPDATE "workspace"
SET "installed_at" = "created_at"
WHERE "installed_at" IS NULL;
