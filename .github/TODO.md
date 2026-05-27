# TODO

- Use Workers AI to parse more flexible natural-language tip commands after explicit amount/token syntax is stable.
- Support queued tips for group/usergroup recipients after explicit multi-recipient pending tips roll out.
- Production setup guide (see below)

## Production

### Cloudflare API token

Create or update the deployment token in the [Cloudflare API Tokens dashboard](https://dash.cloudflare.com/profile/api-tokens).

This API token will affect the below accounts and zones, along with their respective permissions:

- All accounts — Workers Observability:Edit, Workers Builds Configuration:Edit, Workers AI:Edit, D1:Edit, Workers Tail:Read, Workers Scripts:Edit, Account Settings:Read
- Tempo Production Resources
  - tip.bot — Workers Routes:Edit
