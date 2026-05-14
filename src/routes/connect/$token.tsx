import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import type { InferResponseType } from 'hono/client'
import * as React from 'react'
import { createClient, http, parseUnits } from 'viem'
import { Actions } from 'viem/tempo'
import { useConnect, useConnectors } from 'wagmi'
import * as z from 'zod/mini'
import { api } from '#/api.ts'
import { WalletProviders } from '#/components/WalletProviders.tsx'
import { formatCurrencyAmount, formatPeriod } from '#/lib/format.ts'
import { rpc } from '#/lib/rpc.ts'
import * as Tempo from '#/lib/tempo.ts'

export const Route = createFileRoute('/connect/$token')({
  component: Component,
  async loader(options) {
    return await getConnectData({ data: options.params.token })
  },
})

function Component() {
  const data = Route.useLoaderData()
  const params = Route.useParams()

  if (!data.ok)
    return (
      <main className="min-h-screen bg-bg2 px-6 pt-8 pb-12 text-gray10 sm:pt-16 lg:pt-24">
        <section className="mx-auto flex max-w-xl flex-col items-center gap-8">
          <img
            alt="Tipbot"
            className="size-28 rounded-3xl object-cover shadow-lg sm:size-36"
            height={160}
            src="/tipbot.png"
            width={160}
          />
          <div className="max-w-sm space-y-3 text-center">
            <h1 className="text-3xl font-bold text-gray10">Connection link unavailable</h1>
            <p className="text-base text-gray9">{data.message}</p>
            <p className="text-base text-gray9">Run `/tip connect` in Slack to get a new link.</p>
          </div>
        </section>
      </main>
    )

  return (
    <WalletProviders.Root>
      <ConnectPanel data={data} token={params.token} />
    </WalletProviders.Root>
  )
}

function ConnectPanel(props: {
  data: Extract<ReturnType<typeof Route.useLoaderData>, { ok: true }>
  token: string
}) {
  const connect = useConnect()
  const connectors = useConnectors()
  const data = props.data
  const [error, setError] = React.useState<string | null>(null)
  const [errorCode, setErrorCode] = React.useState<string | null>(null)
  const [pendingConnection, setPendingConnection] = React.useState<{
    address: string
    keyAuthorization: unknown
  } | null>(null)
  const [status, setStatus] = React.useState<'idle' | 'connecting' | 'connected'>('idle')

  async function connectTipbot() {
    setError(null)
    setErrorCode(null)
    setPendingConnection(null)
    setStatus('connecting')
    try {
      const connector = connectors[0]
      if (!connector) throw new Error('Tempo Wallet is unavailable.')
      const result = (await connect.connectAsync({
        capabilities: {
          authorizeAccessKey: {
            chainId: BigInt(data.chainId),
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
              {
                address: data.tokenAddress,
                selector: 'transferWithMemo(address,uint256,bytes32)',
              },
            ],
          },
        },
        chainId: data.chainId,
        connector,
        withCapabilities: true,
      } as never)) as unknown as {
        accounts: readonly [
          { address: string; capabilities: Record<string, unknown> },
          ...{ address: string; capabilities: Record<string, unknown> }[],
        ]
      }
      const account = result.accounts[0]
      const keyAuthorization = account.capabilities.keyAuthorization
      if (!keyAuthorization) throw new Error('Tempo Wallet did not authorize Tipbot.')
      await linkAccount({ address: account.address, keyAuthorization })
      setStatus('connected')
    } catch (error) {
      setStatus('idle')
      setError(error instanceof Error ? error.message : 'Could not connect to Tipbot.')
    }
  }

  async function disconnectExistingAccount() {
    if (!pendingConnection) return
    setError(null)
    setErrorCode(null)
    setStatus('connecting')
    try {
      await linkAccount({ ...pendingConnection, disconnectExistingAccount: true })
      setPendingConnection(null)
      setStatus('connected')
    } catch (error) {
      setStatus('idle')
      setError(error instanceof Error ? error.message : 'Could not connect to Tipbot.')
    }
  }

  async function linkAccount(connection: {
    address: string
    keyAuthorization: unknown
    disconnectExistingAccount?: boolean
  }) {
    const response = await rpc.api.account.link[':token'].$post({
      json: connection,
      param: { token: props.token },
    })
    if (response.ok) return

    const json = await response.json().catch(() => null)
    if (json && 'code' in json && json.code === 'account_already_connected') {
      setErrorCode(json.code)
      setPendingConnection(connection)
    }
    throw new Error(json && 'message' in json ? json.message : 'Could not connect to Tipbot.')
  }

  return (
    <main className="min-h-screen bg-bg2 px-6 pt-8 pb-12 text-gray10 sm:pt-16 lg:pt-24">
      <section className="mx-auto flex max-w-xl flex-col items-center gap-8">
        <img
          alt="Tipbot"
          className="size-28 rounded-3xl object-cover shadow-lg sm:size-36"
          height={160}
          src="/tipbot.png"
          width={160}
        />
        {status === 'connected' ? (
          <div className="space-y-3 text-center">
            <h1 className="text-3xl font-bold text-gray10">Connected to Tipbot</h1>
            <p className="text-base text-gray9">You can close this tab and return to Slack.</p>
          </div>
        ) : (
          <div className="w-full space-y-8">
            <div className="space-y-3 text-center">
              <h1 className="text-3xl font-bold text-gray10 sm:text-4xl">
                Connect <span className="text-blue9">Tipbot</span>
              </h1>
              <p className="text-base text-gray9 sm:text-lg">
                Authorize Tipbot to connect your Tempo Wallet for Slack tips.
              </p>
            </div>
            <div className="rounded-2xl border border-gray5 bg-bg2 p-6 shadow-xl sm:p-8">
              <div className="border-b border-gray5 pb-6">
                <h2 className="text-xl font-bold text-gray10 sm:text-2xl">
                  Tipbot wants to connect to your Tempo Wallet
                </h2>
                <p className="mt-2 text-base text-gray9">
                  Review the permissions below before continuing.
                </p>
              </div>
              <div className="space-y-6 border-b border-gray5 py-6">
                <h3 className="text-lg font-bold text-gray10">With this connection, Tipbot can:</h3>
                <div className="flex gap-4">
                  <IconLucideCheck
                    aria-hidden="true"
                    className="mt-1 size-5 shrink-0 text-green9"
                  />
                  <div className="space-y-1">
                    <p className="text-lg font-bold text-gray10">Read your wallet address</p>
                    <p className="text-base text-gray9">
                      Tipbot uses your wallet address to show who is connected in Slack.
                    </p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <IconLucideCheck
                    aria-hidden="true"
                    className="mt-1 size-5 shrink-0 text-green9"
                  />
                  <div className="space-y-1">
                    <p className="text-lg font-bold text-gray10">Create a limited access key</p>
                    <p className="text-base text-gray9">
                      Tipbot can send tips up to{' '}
                      <a
                        className="font-medium text-blue9 no-underline underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                        href={`${Tempo.getChain(data.chainId).blockExplorers?.default.url ?? Tempo.getChain(data.chainId).rpcUrls.default.http[0]}/address/${data.tokenAddress}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {formatCurrencyAmount(data.accessKeyLimit, data.tokenCurrency)}{' '}
                        {data.tokenSymbol}
                      </a>{' '}
                      every {formatPeriod(data.accessKeyLimitPeriodSeconds)} until this link
                      expires.
                    </p>
                  </div>
                </div>
              </div>
              <div className="space-y-4 pt-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <button
                    className="inline-flex h-12 items-center justify-center rounded-lg bg-green8 px-6 text-lg font-bold text-white transition-colors outline-none hover:bg-green7 disabled:cursor-not-allowed disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-green9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                    disabled={status === 'connecting'}
                    onClick={connectTipbot}
                    type="button"
                  >
                    {status === 'connecting' ? 'Connecting' : 'Connect'}
                  </button>
                  <a
                    className="inline-flex h-12 items-center justify-center rounded-lg px-6 text-lg font-bold text-blue9 no-underline transition-colors outline-none hover:bg-blue1 focus-visible:ring-2 focus-visible:ring-blue9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                    href="/"
                  >
                    Cancel
                  </a>
                </div>
                <p className="text-base text-gray9">
                  Next: you’ll be asked to approve this connection in Tempo Wallet.
                </p>
                {error ? (
                  <div className="space-y-3">
                    <p className="text-sm font-medium text-red9">{error}</p>
                    {errorCode === 'account_already_connected' && pendingConnection ? (
                      <button
                        className="inline-flex h-10 items-center justify-center rounded-lg bg-red8 px-4 text-sm font-bold text-white transition-colors outline-none hover:bg-red7 disabled:cursor-not-allowed disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-red9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                        disabled={status === 'connecting'}
                        onClick={disconnectExistingAccount}
                        type="button"
                      >
                        {status === 'connecting'
                          ? 'Disconnecting'
                          : 'Disconnect existing account and connect'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

const getConnectData = createServerFn({ method: 'GET' })
  .inputValidator(z.string().check(z.minLength(1)))
  .handler(async ({ data }) => {
    const endpoint = rpc.api.account.link[':token']
    const response = await api.fetch(new Request(endpoint.$url({ param: { token: data } })), env)
    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as InferResponseType<
        typeof endpoint.$get,
        404
      > | null
      return {
        message:
          json && 'message' in json ? json.message : 'This connection link is invalid or expired.',
        ok: false as const,
      }
    }

    const json = (await response.json()) as InferResponseType<typeof endpoint.$get, 200>
    try {
      const tokenMetadataTimeoutMs = 1_000 // 1 second
      const metadata = await Actions.token.getMetadata(
        createClient({
          chain: Tempo.getChain(json.chainId),
          transport: http(Tempo.getRpcUrl(env, json.chainId), {
            retryCount: 0,
            timeout: tokenMetadataTimeoutMs,
          }),
        }),
        { token: json.tokenAddress },
      )
      return {
        ...json,
        tokenCurrency: metadata.currency,
        tokenSymbol: metadata.symbol,
      }
    } catch {
      return {
        ...json,
        tokenCurrency: 'USD',
        tokenSymbol:
          json.tokenAddress.toLowerCase() === Tempo.addressLookup.pathUsd.toLowerCase()
            ? 'USD'
            : `${json.tokenAddress.slice(0, 6)}…${json.tokenAddress.slice(-4)}`,
      }
    }
  })
