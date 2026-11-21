# TODO

- Use Workers AI to parse more flexible natural-language tip commands after explicit amount/token syntax is stable.
- Production setup guide (see below)
- Rename the Slack-shaped `workspace`/`member` core model to provider-neutral `provider_scope`/`scope_identity` so global providers like X do not need synthetic workspaces.

## Production

### Deploys

`production.yml` deploys the `tipbot` Worker through the [Cloudflare Deploy Broker](https://github.com/tempoxyz/cloudflare-deploy-broker). It holds no Cloudflare credential: the broker applies pending D1 migrations, then uploads and promotes the version. `tempoxyz/cloudflare-deploy-policies` authorizes its bindings, so a new binding or Durable Object class needs a policy change first. The Worker keeps its secrets; add or change them in the broker dashboard (https://cf.tehq.net/, Workers tab).

### Previews

No workflow holds a long-lived Cloudflare token. Previews get short-lived tokens from [Cloudflare STS](https://github.com/tempoxyz/cloudflare-sts), under tip.bot's `preview-deploy`, `preview-seed`, `preview-destroy` and `preview-sweep` policies there. Each admits only its own workflow on `main`, in the `preview` environment.

- `pull_request.yml`'s Preview Build job builds the pull request with no secrets, and uploads the Worker, static assets, D1 migrations and Slack manifests as the `preview` artifact. Pull requests from forks and drafts get no preview.
- `preview.yml` runs main's code on `workflow_run` and calls `preview_deploy.yml`, which checks out main, checks the artifact (`scripts/preview-artifact.ts`), configures the Slack preview app, and only then fetches the token. It creates the D1 database and queues, applies the pull request's migrations, and deploys the Worker unbundled with main's `wrangler.jsonc` and the preview secrets. A second, D1-only token then seeds the database with main's `scripts/preview-seed.ts`. No pull request code runs where either token is. So a pull request's change to `wrangler.jsonc`, `scripts/preview-seed.ts` or the Wrangler version reaches its preview only after it merges.
- `preview_destroy.yml` and `preview_sweep.yml` delete previews with their own tokens.

The deploy token holds D1, Queues and Workers Scripts write on the whole production account, and Zone Read and Workers Routes write on `tip.bot`. The seed token holds D1 write on the whole account. So the deploy job must never run pull request code. A preview still runs the pull request's code with the preview secrets and a copy of one production Slack workspace's members.
