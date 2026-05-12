import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import * as React from 'react'
import { parseUnits } from 'viem'
import { api } from '#/api.ts'
import { rpc } from '#/lib/rpc.ts'

export const Route = createFileRoute('/connect/$token')({
  component: Component,
  loader: async ({ params }) => await getConnectData({ data: params.token }),
})

function Component() {
  const data = Route.useLoaderData()
  const params = Route.useParams()
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<'idle' | 'connecting' | 'connected'>('idle')

  async function connect() {
    if (!data.ok) return
    setError(null)
    setStatus('connecting')
    try {
      const result = await connectWallet(data)
      const response = await rpc.api.account.link[':token'].$post({
        json: {
          address: result.address,
          keyAuthorization: result.keyAuthorization,
        },
        param: { token: params.token },
      })
      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as { message?: string } | null
        throw new Error(json?.message ?? 'Could not connect to Tipbot.')
      }
      setStatus('connected')
    } catch (error) {
      setStatus('idle')
      setError(error instanceof Error ? error.message : 'Could not connect to Tipbot.')
    }
  }

  return (
    <main className="min-h-screen bg-bg2 px-6 py-12 text-gray10">
      <section className="mx-auto flex min-h-[calc(100vh-6rem)] max-w-sm flex-col items-center justify-center gap-6 text-center">
        <img
          alt="Tipbot"
          className="size-28 rounded-3xl object-cover shadow-lg"
          height={160}
          src="/tipbot.png"
          width={160}
        />
        {data.ok ? (
          status === 'connected' ? (
            <div className="space-y-3">
              <h1 className="text-3xl font-bold text-gray10">Connected to Tipbot</h1>
              <p className="text-base text-gray9">You can close this tab and return to Slack.</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="space-y-2">
                <h1 className="text-3xl font-bold text-gray10">Connect to Tipbot</h1>
                <p className="text-base text-gray9">
                  Authorize Tipbot to connect your Tempo Wallet for Slack tips.
                </p>
              </div>
              <button
                className="inline-flex h-14 items-center justify-center rounded-xl bg-blue9 px-5 text-lg font-bold text-white transition hover:bg-blue10 disabled:cursor-not-allowed disabled:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9"
                disabled={status === 'connecting'}
                onClick={connect}
                type="button"
              >
                {status === 'connecting' ? 'Connecting' : 'Connect to Tipbot'}
              </button>
              {error ? <p className="text-sm font-medium text-red9">{error}</p> : null}
            </div>
          )
        ) : (
          <div className="space-y-3">
            <h1 className="text-3xl font-bold text-gray10">Connection link unavailable</h1>
            <p className="text-base text-gray9">{data.message}</p>
            <p className="text-base text-gray9">Run `/tip connect` in Slack to get a new link.</p>
          </div>
        )}
      </section>
    </main>
  )
}

async function connectWallet(data: Extract<ConnectLoaderData, { ok: true }>) {
  const { Provider, dangerous_secp256k1 } = await import('accounts')
  const provider = Provider.create({
    ...(__PLAYWRIGHT_ACCOUNT_PRIVATE_KEY__
      ? {
          adapter: dangerous_secp256k1({
            privateKey: __PLAYWRIGHT_ACCOUNT_PRIVATE_KEY__ as `0x${string}`,
          }),
        }
      : {}),
    testnet: true,
  })
  const result = (await provider.request({
    method: 'wallet_connect',
    params: [
      {
        capabilities: {
          authorizeAccessKey: {
            expiry: Math.floor(new Date(data.accessKeyExpiry).getTime() / 1000),
            keyType: 'secp256k1',
            limits: [
              {
                limit: parseUnits(data.accessKeyLimit, 6),
                period: data.accessKeyLimitPeriodSeconds,
                token: data.tokenAddress,
              },
            ],
            publicKey: data.accessKeyPublicKey,
            scopes: [
              { address: data.tokenAddress, selector: 'transfer(address,uint256)' },
              { address: data.tokenAddress, selector: 'transferWithMemo(address,uint256,bytes32)' },
            ],
          },
        },
      },
    ],
  } as never)) as {
    accounts: { address: string; capabilities?: { keyAuthorization?: unknown } }[]
  }

  const account = result.accounts[0]
  if (!account?.capabilities?.keyAuthorization)
    throw new Error('Tempo Wallet did not authorize Tipbot.')
  return { address: account.address, keyAuthorization: account.capabilities.keyAuthorization }
}

const getConnectData = createServerFn({ method: 'GET' })
  .inputValidator((token: string) => token)
  .handler(async ({ data }) => {
    const response = await api.fetch(
      new Request(`https://${env.HOST}/api/account/link/${data}`),
      env,
    )
    if (!response.ok)
      return {
        message: 'This connection link is invalid or expired.',
        ok: false as const,
      }

    return (await response.json()) as ConnectLoaderData
  })

type ConnectLoaderData =
  | {
      accessKeyAddress: string
      accessKeyExpiry: string
      accessKeyLimit: string
      accessKeyLimitPeriodSeconds: number
      accessKeyPublicKey: string
      expiresAt: string
      ok: true
      tokenAddress: string
    }
  | {
      message: string
      ok: false
    }
