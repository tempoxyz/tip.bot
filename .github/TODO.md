# TODO

- Add `@Tipbot` message support for sending payments.
- Show a realtime Tipbot indicator while a tip transaction is in progress.
- Validate configured reaction tip emoji exists in the Slack workspace.
- Use Workers AI to parse more flexible natural-language tip commands after explicit amount/token syntax is stable.
- Remove `tip.transaction_hash` after single-tip compatibility writes/assertions are no longer needed.
- After the provider identity backfill has run in production, make `provider_identity.account_id` the only account link source of truth:
  - Run sanity queries for `member.provider_identity_id IS NULL` and for `provider_identity.account_id IS NULL` while `member.account_id IS NOT NULL`.
  - Stop writing `member.account_id` in connect/disconnect flows and test setup.
  - Rebuild `member` without `account_id` and drop `member_account_idx`.
  - Rebuild `member` with `provider_identity_id NOT NULL`, then regenerate DB types/schemas.
  - Remove `ConnectedMember.member.account_id` if no callers need it.
