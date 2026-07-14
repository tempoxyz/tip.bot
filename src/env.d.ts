declare namespace Cloudflare {
  // Adding stronger types to Cloudflare.Env.
  // https://github.com/cloudflare/workers-sdk/issues/7112
  interface Env {
    FEE_PAYER_PRIVATE_KEY_MAINNET: `0x${string}`
    FEE_PAYER_PRIVATE_KEY_TESTNET: `0x${string}`
    RPC_CREDENTIALS?: string | undefined
    RPC_URL_MAINNET?: string | undefined
    RPC_URL_TESTNET?: string | undefined
    TEMPO_API_URL?: string | undefined
  }
}
