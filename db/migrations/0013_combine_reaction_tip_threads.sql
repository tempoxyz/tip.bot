-- Combine reaction tip aggregate replies across all reaction emoji in a thread.
DELETE FROM "reaction_tip_thread" AS "candidate"
WHERE EXISTS (
  SELECT 1
  FROM "reaction_tip_thread" AS "survivor"
  WHERE "survivor"."workspace_id" = "candidate"."workspace_id"
    AND "survivor"."channel_id" = "candidate"."channel_id"
    AND "survivor"."message_ts" = "candidate"."message_ts"
    AND (
      "survivor"."created_at" < "candidate"."created_at"
      OR (
        "survivor"."created_at" = "candidate"."created_at"
        AND "survivor"."id" < "candidate"."id"
      )
    )
);

DROP INDEX "reaction_tip_thread_message_idx";

ALTER TABLE "reaction_tip_thread" DROP COLUMN "reaction";

CREATE UNIQUE INDEX "reaction_tip_thread_message_idx" ON "reaction_tip_thread" (
  "workspace_id",
  "channel_id",
  "message_ts"
);
