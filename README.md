# tip.bot

Slack-native stablecoin micropayments

## MVP

- Cloudflare Worker + D1 + TanStack Start.
- Hosted Slack OAuth install supports multiple workspaces.
- PathUSD tips on Tempo testnet, default chain `testnet`.
- Default workspace amount: `0.0001` PathUSD.
- Default reaction emoji: `money_with_wings`.
- Default sender cap: `1` PathUSD/day.
- Sender and recipient must connect Tempo Wallet before a tip can execute.
- Connect flow authorizes a 7-day exportable access key scoped to PathUSD transfers.
- Server stores encrypted access key material for slash command, mention, and reaction execution.
- Fee payer relay sponsors gas only, validated against short-lived tip attempts.

## Slack surfaces

```text
/tip connect
/tip @account
/tip @account for great debugging
/tip config
/tip config emoji money_with_wings
/tip config amount 0.0001
/tip config cap 1
@tip tip @account for great debugging
reaction_added with configured emoji
```

## Endpoints

```text
POST /api/slack/commands
POST /api/slack/events
GET /api/slack/install
GET /api/slack/oauth/callback
POST /api/connect/complete
GET|POST /relay
GET /connect?token=...
```

## Environment

Cloudflare vars:

```text
SLACK_APP_BASE_URL=https://tip.bot
TEMPO_CHAIN=testnet
```

Cloudflare secrets:

```text
ACCESS_KEY_ENCRYPTION_SECRET=...
FEE_PAYER_PRIVATE_KEY=0x...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
```

Local development uses environment variables. Use direnv, shell exports, or copy `.env.example` to `.env` for the Cloudflare dev server. Required local values:

```text
ACCESS_KEY_ENCRYPTION_SECRET=...random secret...
FEE_PAYER_PRIVATE_KEY=0x...
SLACK_APP_BASE_URL=https://your-node.tailnet.ts.net
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
TEMPO_CHAIN=testnet
```

Notes:

- `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` come from Slack app Basic Information.
- `SLACK_SIGNING_SECRET` comes from Slack app Basic Information.
- `ACCESS_KEY_ENCRYPTION_SECRET` encrypts Tempo access keys and installed Slack bot tokens.
- `FEE_PAYER_PRIVATE_KEY` is required for tip execution.
- `TEMPO_CHAIN` must be `testnet` or `mainnet`.

## Dev

```bash
pnpm install
pnpm run db:migrate
pnpm run db:codegen
pnpm run cf-typegen
pnpm run dev
```

Local URL:

```text
https://tip.localhost
```

`pnpm run dev` also starts a Tailscale Funnel by default through Portless and prints a public URL like:

```text
https://your-node.tailnet.ts.net
```

Use that printed `*.ts.net` URL for Slack callbacks. Do not use `tip.localhost` in Slack.

## Public Slack install setup

This is the intended hosted flow: deploy once, configure one distributable Slack app, then workspace admins install from the website's **Add to Slack** button.

### 1. Deploy the Worker

Export `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, create a Cloudflare D1 database, then put its UUID in `wrangler.jsonc`:

```bash
pnpm exec wrangler d1 create tip
```

Set GitHub environment secrets in the `production` environment:

```text
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
ACCESS_KEY_ENCRYPTION_SECRET=...
FEE_PAYER_PRIVATE_KEY=0x...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
```

Push to `main` to deploy. The production workflow runs checks, applies remote D1 migrations, builds with `CLOUDFLARE_ENV=production`, then deploys the `production` Wrangler environment.

Manual deploy:

```bash
pnpm exec wrangler d1 migrations apply tip --env production --remote
pnpm run deploy
```

Production deploys the `production` Wrangler environment to `https://tip.bot`. The deploy script sets `CLOUDFLARE_ENV=production` for the Vite build so Cloudflare's generated deploy config includes the production bindings and domain.

### 2. Configure the Slack app

Create or update the Slack app from the generated manifest in `scripts/slackApp.ts`.

Required URLs:

- OAuth redirect URL: `https://tip.bot/api/slack/oauth/callback`
- Slash command URL: `https://tip.bot/api/slack/commands`
- Event request URL: `https://tip.bot/api/slack/events`

Enable distribution in Slack app settings if this app should be installable outside your development workspace.

### 3. Install from the website

Open `https://tip.bot` and click **Add to Slack**. The install callback stores the workspace bot token in D1 encrypted with `ACCESS_KEY_ENCRYPTION_SECRET`.

If scopes, slash commands, redirect URLs, or event subscriptions change, reinstall the app.

## Slack Dev Setup

### Programmatic app setup

Slack apps can be created and updated from the manifest template in `scripts/slackApp.ts`.

First generate a Slack app configuration token at <https://api.slack.com/apps> under **Your App Configuration Tokens**. Then use it as `SLACK_CONFIG_TOKEN`.

Create a local app from the current Tailscale Funnel URL. Use the exact public origin printed by Portless, including `https://` and any port:

```bash
SLACK_CONFIG_TOKEN=xoxe... pnpm run slack:app:create -- local https://your-node.tailnet.ts.net:12345
```

The command prints `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, and `SLACK_LOCAL_APP_ID` for your environment.

When the Funnel URL changes, update the existing local app:

```bash
SLACK_CONFIG_TOKEN=xoxe... pnpm run slack:app:update -- local https://new-node.tailnet.ts.net:12345 A123...
```

Create or update production with the production domain:

```bash
SLACK_CONFIG_TOKEN=xoxe... pnpm run slack:app:create -- production https://tip.bot
SLACK_CONFIG_TOKEN=xoxe... pnpm run slack:app:update -- production https://tip.bot A456...
```

Preview or validate the generated manifest without changing Slack:

```bash
pnpm run slack:app:manifest -- local https://your-node.tailnet.ts.net:12345
SLACK_CONFIG_TOKEN=xoxe... pnpm run slack:app:validate -- local https://your-node.tailnet.ts.net:12345
```

### 1. Start local dev

Run:

```bash
pnpm run dev
```

Portless prints both:

- local URL: `https://tip.localhost`
- public Funnel URL: `https://<node>.<tailnet>.ts.net` or `https://<node>.<tailnet>.ts.net:<port>`

Use the exact public Funnel URL below as `SLACK_APP_BASE_URL`.

### 2. Create or update the Slack app

Use the programmatic setup above with `SLACK_APP_BASE_URL`:

```bash
SLACK_CONFIG_TOKEN=xoxe... pnpm run slack:app:create -- local <SLACK_APP_BASE_URL>
```

If the local app already exists, update it instead:

```bash
SLACK_CONFIG_TOKEN=xoxe... pnpm run slack:app:update -- local <SLACK_APP_BASE_URL> A123...
```

The create command prints values to export in your environment:

```text
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
SLACK_APP_BASE_URL=...
SLACK_LOCAL_APP_ID=...
```

If you change scopes, slash commands, or event subscriptions, reinstall the app to the workspace.

### 3. Verify the flow

Open the website, click **Add to Slack**, then try these in Slack:

```text
/tip connect
/tip @account
@tip tip @account for great debugging
reaction_added with configured emoji
```

The connect link and relay URL are derived from the incoming Slack request origin, so when Slack calls your `*.ts.net` URL the app automatically generates matching public `connect` and `relay` URLs.

### 4. Gotchas

- Restart `pnpm run dev` after changing environment variables.
- If the Funnel hostname or port changes after a restart, update the Slack app and `SLACK_APP_BASE_URL`.
- Testing `SLACK_APP_BASE_URL` from the same machine can be misleading because local Portless routing and public Funnel routing are not the same path. You may see a Portless 404 page saying no app is registered for the `*.ts.net` hostname; this is expected on the dev machine. Prefer testing through Slack itself or from another device.

## Notes

The relay is public by necessity, so sponsorship validation is mandatory. It only sponsors a transaction if a matching, unexpired `tip_attempt` exists for the sender, recipient, token, and amount.
