# Tip

Slack-native Tempo tipping app.

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

## Notes

The relay is public by necessity, so sponsorship validation is mandatory. It only sponsors a transaction if a matching, unexpired `tip_attempt` exists for the sender, recipient, token, and amount.
