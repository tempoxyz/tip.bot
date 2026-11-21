// Adding stronger types to Env and Cloudflare.Env.
// https://github.com/cloudflare/workers-sdk/issues/7112
// `wrangler types` declares both as extensions of a generated base interface,
// so each needs the same additions.
declare namespace Cloudflare {
  interface Env {
    FEE_PAYER_PRIVATE_KEY_MAINNET: `0x${string}`
    FEE_PAYER_PRIVATE_KEY_TESTNET: `0x${string}`
    RPC_CREDENTIALS?: string | undefined
    RPC_URL_MAINNET?: string | undefined
    RPC_URL_TESTNET?: string | undefined
  }
}

interface Env {
  FEE_PAYER_PRIVATE_KEY_MAINNET: `0x${string}`
  FEE_PAYER_PRIVATE_KEY_TESTNET: `0x${string}`
  RPC_CREDENTIALS?: string | undefined
  RPC_URL_MAINNET?: string | undefined
  RPC_URL_TESTNET?: string | undefined
}
