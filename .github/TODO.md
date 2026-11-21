# TODO

- Use Workers AI to parse more flexible natural-language tip commands after explicit amount/token syntax is stable.
- Production setup guide (see below)
- Rename the Slack-shaped `workspace`/`member` core model to provider-neutral `provider_scope`/`scope_identity` so global providers like X do not need synthetic workspaces.

## Production

### Deploys

`production.yml` deploys the `tipbot` Worker through the [Cloudflare Deploy Broker](https://github.com/tempoxyz/cloudflare-deploy-broker). It holds no Cloudflare credential: the broker applies pending D1 migrations, then uploads and promotes the version. `tempoxyz/cloudflare-deploy-policies` authorizes its bindings, so a new binding or Durable Object class needs a policy change first. The Worker keeps its secrets; add or change them in the broker dashboard (https://cf.tehq.net/, Workers tab).

### Cloudflare API token

Previews (`preview_deploy.yml`, `preview_destroy.yml`, `preview_sweep.yml`) still use the `preview` environment's `CLOUDFLARE_API_TOKEN`. Create or update it in the [Cloudflare API Tokens dashboard](https://dash.cloudflare.com/profile/api-tokens).

This API token will affect the below accounts and zones, along with their respective permissions:

- All accounts — Workers Observability:Edit, Workers Builds Configuration:Edit, Workers AI:Edit, D1:Edit, Workers Tail:Read, Workers Scripts:Edit, Account Settings:Read
- Tempo Production Resources
  - tip.bot — Workers Routes:Edit
