# tip.bot

Slack-native stablecoin micropayments

## MVP

- Cloudflare Worker + D1 + TanStack Start.
- Single Slack workspace first; schema supports multiple workspaces.
- PathUSD tips on Tempo testnet, default chain `tempoModerato`.
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
POST /api/connect/complete
GET|POST /relay
GET /connect?token=...
```

## Environment

Cloudflare vars:

```text
SLACK_ADMIN_ACCOUNT_IDS=U...
TEMPO_CHAIN=tempoModerato
```

Cloudflare secrets:

```text
ACCESS_KEY_ENCRYPTION_SECRET=...
FEE_PAYER_PRIVATE_KEY=0x...
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

Local development reads the same names from `.env`; start with:

```bash
cp .env.example .env
```

Required local values:

```text
ACCESS_KEY_ENCRYPTION_SECRET=...random secret...
FEE_PAYER_PRIVATE_KEY=0x...
SLACK_ADMIN_ACCOUNT_IDS=U123...,U456...
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
TEMPO_CHAIN=tempoModerato
```

Notes:

- `SLACK_BOT_TOKEN` comes from Slack OAuth install.
- `SLACK_SIGNING_SECRET` comes from Slack app Basic Information.
- `SLACK_ADMIN_ACCOUNT_IDS` is optional, comma-separated Slack account IDs for `/tip config`.
- `ACCESS_KEY_ENCRYPTION_SECRET` and `FEE_PAYER_PRIVATE_KEY` are required for wallet connect and tip execution, not just Slack request verification.

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

## Slack Dev Setup

### 1. Start local dev

Run:

```bash
pnpm run dev
```

Portless prints both:

- local URL: `https://tip.localhost`
- public Funnel URL: `https://<node>.<tailnet>.ts.net`

Use the public Funnel URL below as `TS_URL`.

### 2. Create or configure the Slack app

Use `slackManifest.json` as the source of truth for app shape. The callback placeholders should be replaced with your current `TS_URL`.

Slash command:

- command: `/tip`
- request URL: `https://<TS_URL>/api/slack/commands`
- description: `Tip teammates`
- usage hint: `connect | @account | config`
- escape channels, users, and links: enabled

Event subscriptions:

- request URL: `https://<TS_URL>/api/slack/events`
- bot events:
  - `app_mention`
  - `reaction_added`

Bot scopes:

- `app_mentions:read`
- `channels:history`
- `chat:write`
- `commands`
- `groups:history`
- `reactions:read`
- `users:read`

Other Slack settings:

- bot user enabled
- socket mode disabled
- interactivity disabled
- token rotation disabled

### 3. Copy Slack credentials into `.env`

From Slack app settings:

- Basic Information -> Signing Secret -> `SLACK_SIGNING_SECRET`
- OAuth & Permissions -> Bot User OAuth Token -> `SLACK_BOT_TOKEN`

If you change scopes, slash commands, or event subscriptions, reinstall the app to the workspace.

### 4. Configure admins

Set Slack account IDs allowed to run `/tip config`:

```text
SLACK_ADMIN_ACCOUNT_IDS=U12345,U67890
```

These are Slack account IDs, not emails or display names.

### 5. Verify the flow

Try these in Slack:

```text
/tip connect
/tip @account
@tip tip @account for great debugging
reaction_added with configured emoji
```

The connect link and relay URL are derived from the incoming Slack request origin, so when Slack calls your `*.ts.net` URL the app automatically generates matching public `connect` and `relay` URLs.

### 6. Gotchas

- Restart `pnpm run dev` after editing `.env`.
- If the Funnel hostname changes after a restart, update the Slack request URLs.
- Testing `https://<TS_URL>` from the same machine can be misleading because local Portless routing and public Funnel routing are not the same path. You may see a Portless 404 page saying no app is registered for the `*.ts.net` hostname; this is expected on the dev machine. Prefer testing through Slack itself or from another device.

## Notes

The relay is public by necessity, so sponsorship validation is mandatory. It only sponsors a transaction if a matching, unexpired `tip_attempt` exists for the sender, recipient, token, and amount.
