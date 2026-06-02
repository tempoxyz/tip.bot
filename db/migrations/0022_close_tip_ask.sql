-- Track closed Slack tip jars so creators can stop accepting preset tips.
ALTER TABLE "tip_ask" ADD COLUMN "closed_at" TEXT;
