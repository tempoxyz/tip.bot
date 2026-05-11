<img src="../public/tipbot.png" alt="tip.bot" width="240" />

# tip.bot

Chat-native stablecoin micropayments

## Development

```sh
pnpm install          # Install dependencies
pnpm db:migrate       # Run D1 migrations
pnpm db:codegen       # Generate types from database
pnpm gen:types        # Generate worker types
pnpm dev              # Start https://tip.localhost
```

## Production

After changing Slack App, run the following to update:

```sh
SLACK_APP_ID=<app-id> pnpm slack:app update production tip.bot
```

To allow any Slack workspace to install the app, enable unlisted distribution manually:

1. Go to https://api.slack.com/apps
2. Select the production app
3. Go to **Manage Distribution**
4. Under **Share Your App with Other Workspaces**, complete the checklist
5. Click **Activate Public Distribution**

All other changes deployed via CI.
