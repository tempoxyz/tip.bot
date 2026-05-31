# TODO

- Use Workers AI to parse more flexible natural-language tip commands after explicit amount/token syntax is stable.
- Production setup guide (see below)
- Rename the Slack-shaped `workspace`/`member` core model to provider-neutral `provider_scope`/`scope_identity` so global providers like X do not need synthetic workspaces.

## Production

### Cloudflare API token

Create or update the deployment token in the [Cloudflare API Tokens dashboard](https://dash.cloudflare.com/profile/api-tokens).

This API token will affect the below accounts and zones, along with their respective permissions:

- All accounts — Workers Observability:Edit, Workers Builds Configuration:Edit, Workers AI:Edit, D1:Edit, Workers Tail:Read, Workers Scripts:Edit, Account Settings:Read
- Tempo Production Resources
  - tip.bot — Workers Routes:Edit
