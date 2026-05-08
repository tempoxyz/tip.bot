CREATE TABLE "slack_installation" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "enterprise_id" TEXT,
  "team_id" TEXT NOT NULL,
  "team_name" TEXT,
  "bot_user_id" TEXT,
  "bot_token_ciphertext" TEXT NOT NULL,
  "scopes" TEXT,
  "installed_by" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "slack_installation_team_idx" ON "slack_installation" ("team_id");
