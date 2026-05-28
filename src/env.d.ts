declare namespace Cloudflare {
  // Adding stronger types to Cloudflare.Env.
  // https://github.com/cloudflare/workers-sdk/issues/7112
  interface Env {
    FEE_PAYER_PRIVATE_KEY_MAINNET: `0x${string}`
    FEE_PAYER_PRIVATE_KEY_TESTNET: `0x${string}`
    RPC_URL_MAINNET?: string | undefined
    RPC_URL_TESTNET?: string | undefined
    TWITTER_ACCESS_TOKEN?: string | undefined
    TWITTER_ACCESS_TOKEN_SECRET?: string | undefined
    TWITTER_API_URL?: string | undefined
    TWITTER_BEARER_TOKEN?: string | undefined
    TWITTER_BOT_HANDLE?: string | undefined
    TWITTER_CONSUMER_KEY?: string | undefined
    TWITTER_CONSUMER_SECRET?: string | undefined
  }
}
