-- Track the Slack installation that can post account link completion notifications.
ALTER TABLE "account_link_token"
ADD COLUMN "channel_provider_id" TEXT;
