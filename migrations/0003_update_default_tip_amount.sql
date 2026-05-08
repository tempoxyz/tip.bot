UPDATE "workspace"
SET "tip_amount" = '0.001', "updated_at" = CURRENT_TIMESTAMP
WHERE "tip_amount" = '0.0001';
