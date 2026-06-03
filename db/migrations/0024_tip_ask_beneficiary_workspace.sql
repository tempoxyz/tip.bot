-- Track Slack Connect beneficiary workspaces for jars opened on behalf of external accounts.
ALTER TABLE "tip_ask" ADD COLUMN "beneficiary_provider_workspace_id" TEXT;
