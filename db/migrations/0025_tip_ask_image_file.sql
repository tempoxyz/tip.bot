-- Store Slack image file references attached to tip jars.
CREATE TABLE "tip_ask_image_file" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "tip_ask_id" TEXT NOT NULL REFERENCES "tip_ask" ("id") ON DELETE CASCADE,
  "provider_file_id" TEXT NOT NULL,
  "alt_text" TEXT NOT NULL,
  "position" INTEGER NOT NULL CHECK ("position" >= 0),
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "tip_ask_image_file_position_idx" ON "tip_ask_image_file" ("tip_ask_id", "position");
