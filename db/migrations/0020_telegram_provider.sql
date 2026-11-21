-- Placeholder with no effect. Production applied an earlier 0020_telegram_provider.sql
-- (327ef065, Production run 26782816327) before 954bf9bd reverted it, so the production
-- d1_migrations table still records this name. The Cloudflare Deploy Broker applies D1
-- migrations only when every recorded name is one of the repository's, so the name stays.
UPDATE "workspace" SET "updated_at" = "updated_at" WHERE 0;
