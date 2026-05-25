declare namespace Cloudflare {
  // Adding stronger types to Cloudflare.Env.
  // https://github.com/cloudflare/workers-sdk/issues/7112
  interface Env {
    DJBOX_PARTY_ID?: string | undefined
    DJBOX_SECRET?: string | undefined
    DJBOX_URL?: string | undefined
    DJ_HOUSE_PROVIDER_USER_ID?: string | undefined
    DJ_QUEUE_PRICE_USD?: string | undefined
    DJ_SKIP_PRICE_USD?: string | undefined
    FEE_PAYER_PRIVATE_KEY_MAINNET: `0x${string}`
    FEE_PAYER_PRIVATE_KEY_TESTNET: `0x${string}`
    RPC_URL_MAINNET?: string | undefined
    RPC_URL_TESTNET?: string | undefined
    SPOTIFY_CLIENT_ID?: string | undefined
    SPOTIFY_CLIENT_SECRET?: string | undefined
    SPOTIFY_REFRESH_TOKEN?: string | undefined
  }
}
