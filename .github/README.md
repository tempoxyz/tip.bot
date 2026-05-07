# tip.bot

Chat-native stablecoin micropayments

## Dev

```sh
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm db:codegen
pnpm cf-typegen
pnpm dev
```

### Create or update a local Slack app

Slack apps can be created and updated from the manifest template in `scripts/slackApp.ts`.

First generate a Slack app configuration token at <https://api.slack.com/apps> under **Your App Configuration Tokens**. Then use it as `SLACK_CONFIG_TOKEN`.

Create a local app from the current Funnel URL:

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

Preview or validate the generated manifest without changing Slack:

```bash
pnpm run slack:app:manifest -- local <SLACK_APP_BASE_URL>
SLACK_CONFIG_TOKEN=xoxe... pnpm run slack:app:validate -- local <SLACK_APP_BASE_URL>
```

<details>
<summary>Deployment and public Slack install</summary>

## Deployment

This is the intended hosted flow: deploy once, configure one distributable Slack app, then workspace admins install from the website's **Add to Slack** button.

### 1. Deploy the Worker

Export `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, create a Cloudflare D1 database, then put its UUID in `wrangler.jsonc`:

```bash
pnpm exec wrangler d1 create tip
```

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

```bash
SLACK_CONFIG_TOKEN=xoxe... pnpm run slack:app:create -- production https://tip.bot
SLACK_CONFIG_TOKEN=xoxe... pnpm run slack:app:update -- production https://tip.bot A456...
```

Required URLs:

- OAuth redirect URL: `https://tip.bot/api/slack/oauth/callback`
- Slash command URL: `https://tip.bot/api/slack/commands`
- Event request URL: `https://tip.bot/api/slack/events`

Enable distribution in Slack app settings if this app should be installable outside your development workspace.

### 3. Install from the website

Open `https://tip.bot` and click **Add to Slack**. The install callback stores the workspace bot token in D1 encrypted with `ACCESS_KEY_ENCRYPTION_SECRET`.

If scopes, slash commands, redirect URLs, or event subscriptions change, reinstall the app.

</details>
