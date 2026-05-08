# tip.bot

Chat-native stablecoin micropayments

## Development

```sh
pnpm install          # Install dependencies
cp .env.example .env  # Setup environment
pnpm db:migrate       # Run D1 migrations
pnpm db:codegen       # Generate types from database
pnpm cf-typegen       # Generate worker types
pnpm dev              # Start https://tip.localhost
```

## Production

After changing Slack App, run the following to update:

```sh
pnpm run slack:app:update -- production https://tip.bot A0B29MACHQV
```

All other changes deployed via CI.
