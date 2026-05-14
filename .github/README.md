<img src="../public/tipbot.png" alt="tip.bot" width="240" />

# tip.bot

Chat-native stablecoin micropayments

## Development

```sh
pnpm install          # Install dependencies
pnpm db:migrate       # Run D1 migrations
pnpm db:codegen       # Generate types from database
pnpm gen:types        # Generate worker types
pnpm dev              # Start https://tipbot.localhost
```

## Production

After changing Slack App, run the following to update:

```sh
pnpm slack:app update production tip.bot
```

To allow any Slack workspace to install the app, enable unlisted distribution manually:

1. Go to https://api.slack.com/apps
2. Select the production app
3. Go to **Manage Distribution**
4. Under **Share Your App with Other Workspaces**, complete the checklist
5. Click **Activate Public Distribution**

All other changes deployed via CI.

### Cloudflare API token

Create or update the deployment token in the [Cloudflare API Tokens dashboard](https://dash.cloudflare.com/profile/api-tokens).

This API token will affect the below accounts and zones, along with their respective permissions:

- All accounts — Workers Observability:Edit, Workers Builds Configuration:Edit, Workers AI:Edit, D1:Edit, Workers Tail:Read, Workers Scripts:Edit, Account Settings:Read
- Tempo Production Resources
  - tip.bot — Workers Routes:Edit
