CREATE TABLE "reaction_tip_config" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "emoji" TEXT NOT NULL CHECK ("emoji" <> ''),
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "reaction_tip_config_workspace_emoji_idx" ON "reaction_tip_config" (
  "workspace_id",
  "emoji"
);

INSERT INTO "reaction_tip_config" (
  "id",
  "workspace_id",
  "emoji",
  "amount"
)
SELECT lower(hex(randomblob(16))), "id", 'money_with_wings', 1000
FROM "workspace";

INSERT INTO "reaction_tip_config" (
  "id",
  "workspace_id",
  "emoji",
  "amount"
)
SELECT lower(hex(randomblob(16))), "id", 'dollar', 10000
FROM "workspace";

INSERT INTO "reaction_tip_config" (
  "id",
  "workspace_id",
  "emoji",
  "amount"
)
SELECT lower(hex(randomblob(16))), "id", 'moneybag', 100000
FROM "workspace";

INSERT INTO "reaction_tip_config" (
  "id",
  "workspace_id",
  "emoji",
  "amount"
)
SELECT lower(hex(randomblob(16))), "id", "reaction_tip_emoji", "default_amount"
FROM "workspace"
WHERE "reaction_tip_emoji" NOT IN ('money_with_wings', 'dollar', 'moneybag');
