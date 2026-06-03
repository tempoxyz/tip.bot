-- Track beneficiary tip jars and creator fees for jars opened on behalf of another Slack account.
ALTER TABLE "tip_ask" ADD COLUMN "beneficiary_provider_user_id" TEXT;
ALTER TABLE "tip_ask" ADD COLUMN "creator_fee_basis_points" INTEGER NOT NULL DEFAULT 0 CHECK ("creator_fee_basis_points" >= 0 AND "creator_fee_basis_points" <= 10000);
