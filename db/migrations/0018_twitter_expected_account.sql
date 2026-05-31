-- Bind Twitter proof challenges to the intended X account before wallet signing.
ALTER TABLE "provider_link_challenge" ADD COLUMN "expected_provider_user_id" TEXT;
ALTER TABLE "provider_link_challenge" ADD COLUMN "expected_provider_handle" TEXT;

CREATE INDEX "provider_link_challenge_expected_provider_user_idx" ON "provider_link_challenge" ("provider", "expected_provider_user_id");
