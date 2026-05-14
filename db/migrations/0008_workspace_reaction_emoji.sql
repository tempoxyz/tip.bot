CREATE TABLE "workspace_reaction_emoji" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "emoji" TEXT NOT NULL CHECK ("emoji" <> ''),
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "workspace_reaction_emoji_workspace_emoji_idx" ON "workspace_reaction_emoji" (
  "workspace_id",
  "emoji"
);
CREATE INDEX "workspace_reaction_emoji_workspace_idx" ON "workspace_reaction_emoji" ("workspace_id");
