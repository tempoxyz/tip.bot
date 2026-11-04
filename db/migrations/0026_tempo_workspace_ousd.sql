-- Make OUSD the default tip token for Tempo's own Slack workspace (T098H03GGE6) on mainnet.
UPDATE "workspace"
SET
  "default_token_address" = '0x20c0000000000000000000006a37DA5C996874BE',
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE "provider" = 'slack'
  AND "provider_id" = 'T098H03GGE6'
  AND "chain_id" = 4217;
