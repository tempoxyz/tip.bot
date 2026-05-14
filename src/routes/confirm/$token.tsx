import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import type { InferResponseType } from 'hono/client'
import * as React from 'react'
import { parseUnits, toHex } from 'viem'
import { useConnect, useConnection, useConnectors } from 'wagmi'
import * as z from 'zod/mini'
import { api } from '#/api.ts'
import { WalletProviders } from '#/components/WalletProviders.tsx'
import { formatCurrencyAmount } from '#/lib/format.ts'
import { rpc } from '#/lib/rpc.ts'
import * as Tempo from '#/lib/tempo.ts'

export const Route = createFileRoute('/confirm/$token')({
  component: Component,
  async loader(options) {
    return await getConfirmData({ data: options.params.token })
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
            <h1 className="text-3xl font-bold text-gray10">Confirmation link expired</h1>
            <p className="text-base text-gray9">{data.message}</p>
            <p className="text-base text-gray9">Run `/tip` again in Slack.</p>
          </div>
        </section>
      </main>
    )

  return (
    <WalletProviders.Root>
      <ConfirmPanel data={data} token={params.token} />
    </WalletProviders.Root>
  )
}

function ConfirmPanel(props: {
  data: Extract<ReturnType<typeof Route.useLoaderData>, { ok: true }>
  token: string
}) {
  const connect = useConnect()
  const connection = useConnection()
  const connectors = useConnectors()
  const data = props.data
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<'idle' | 'confirming' | 'sent'>('idle')
  const [transactionHash, setTransactionHash] = React.useState<string | null>(null)
  const recipient = data.recipientProviderLabel
    ? `@${data.recipientProviderLabel}`
    : data.recipientProviderUserId

  async function confirm() {
    setError(null)
    setTransactionHash(null)
    setStatus('confirming')
    try {
      const connector = connection.connector ?? connectors[0]
      if (!connector) throw new Error('Tempo Wallet is unavailable.')
      const account = await (async () => {
        if (data.kind === 'reusable_access_key' && connection.status === 'connected') {
          const result = await authorizeAccessKey(connector, data)
          return {
            address: result.rootAddress,
            capabilities: { keyAuthorization: result.keyAuthorization },
          }
        }
        if (
          data.kind === 'onetime_payment' &&
          connection.status === 'connected' &&
          connection.address
        )
          return { address: connection.address, capabilities: {} }

        const result = (await connect.connectAsync({
          capabilities:
            data.kind === 'reusable_access_key'
              ? { authorizeAccessKey: getAuthorizeAccessKey(data) }
              : { method: 'register' },
          chainId: data.chainId,
          connector,
          withCapabilities: true,
        } as never)) as unknown as {
          accounts: readonly [
            { address: string; capabilities: Record<string, unknown> },
            ...{ address: string; capabilities: Record<string, unknown> }[],
          ]
        }
        return result.accounts[0]
      })()
      if (
        data.kind === 'onetime_payment' &&
        account.address.toLowerCase() !== data.transactionRequest?.from.toLowerCase()
      )
        throw new Error('Reconnect Tipbot and try again.')
      const signedTransaction = await (async () => {
        if (data.kind !== 'onetime_payment') return undefined
        if (!data.transactionRequest) throw new Error('Payment request is unavailable.')
        const provider = (await connector.getProvider()) as {
          request: (parameters: { method: string; params: unknown[] }) => Promise<unknown>
        }
        return (await provider.request({
          method: 'eth_signTransaction',
          params: [
            {
              ...data.transactionRequest,
              chainId: toHex(data.chainId),
            } as never,
          ],
        })) as string
      })()
      const keyAuthorization = account.capabilities.keyAuthorization
      if (data.kind === 'reusable_access_key' && !keyAuthorization)
        throw new Error('Tempo Wallet did not approve this payment.')
      const response = await rpc.api.confirm[':token'].$post({
        json: {
          address: account.address,
          ...(data.kind === 'reusable_access_key' ? { keyAuthorization } : { signedTransaction }),
        },
        param: { token: props.token },
      })
      if (!response.ok) {
        const json = await response.json().catch(() => null)
        throw new Error(json && 'message' in json ? json.message : 'Payment failed.')
      }
      const json = await response.json()
      setTransactionHash(json.transactionHash)
      setStatus('sent')
    } catch (error) {
      setStatus('idle')
      setError(error instanceof Error ? error.message : 'Payment failed.')
    }
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
        {status === 'sent' ? (
          <div className="space-y-3 text-center">
            <h1 className="text-3xl font-bold text-gray10">Payment sent</h1>
            <p className="text-base text-gray9">You can close this tab and return to Slack.</p>
            {transactionHash ? (
              <a
                className="inline-flex text-base font-bold text-blue9 no-underline hover:underline"
                href={Tempo.formatTxLink(data.chainId, transactionHash)}
                rel="noreferrer"
                target="_blank"
              >
                View receipt
              </a>
            ) : null}
          </div>
        ) : (
          <div className="w-full space-y-8">
            <div className="space-y-3 text-center">
              <h1 className="text-3xl font-bold text-gray10 sm:text-4xl">Confirm payment</h1>
              <p className="text-base text-gray9 sm:text-lg">
                Approve this payment in Tempo Wallet.
              </p>
            </div>
            <div className="rounded-2xl border border-gray5 bg-bg2 p-6 shadow-xl sm:p-8">
              <div className="border-b border-gray5 pb-6">
                <h2 className="text-xl font-bold text-gray10 sm:text-2xl">
                  Tipbot wants to send a payment
                </h2>
                <p className="mt-2 text-base text-gray9">
                  Review the payment details below before continuing.
                </p>
              </div>
              <div className="space-y-5 border-b border-gray5 py-6">
                <h3 className="text-lg font-bold text-gray10">Payment details</h3>
                <div className="flex flex-col gap-2 rounded-xl border border-gray5 bg-bg1 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                  <span className="text-sm font-medium text-gray8">Amount</span>
                  <span className="text-xl font-bold text-gray10 sm:text-2xl">
                    {formatCurrencyAmount(data.amount, data.tokenCurrency)} {data.tokenSymbol}
                  </span>
                </div>
                <div className="flex flex-col gap-2 rounded-xl border border-gray5 bg-bg1 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                  <span className="text-sm font-medium text-gray8">To</span>
                  <span className="text-xl font-bold text-gray10 sm:text-2xl">{recipient}</span>
                </div>
                {data.memo ? (
                  <div className="flex flex-col gap-2 rounded-xl border border-gray5 bg-bg1 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                    <span className="text-sm font-medium text-gray8">For</span>
                    <span className="text-xl font-bold text-gray10 sm:text-2xl">{data.memo}</span>
                  </div>
                ) : null}
              </div>
              <div className="space-y-4 pt-6">
                <p className="text-base text-gray9">
                  {data.kind === 'reusable_access_key'
                    ? `Tipbot can send future ${data.tokenSymbol} tips from Slack, up to ${formatCurrencyAmount(data.accessKeyLimit, data.tokenCurrency)} per day. You can disconnect anytime.`
                    : 'Tipbot will use this approval once and won’t save a new access key.'}
                </p>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <button
                    className="inline-flex h-12 items-center justify-center rounded-lg bg-green8 px-6 text-lg font-bold text-white transition-colors outline-none hover:bg-green7 disabled:cursor-not-allowed disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-green9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                    disabled={status === 'confirming'}
                    onClick={confirm}
                    type="button"
                  >
                    {status === 'confirming' ? 'Confirming' : 'Confirm payment'}
                  </button>
                  <a
                    className="inline-flex h-12 items-center justify-center rounded-lg px-6 text-lg font-bold text-blue9 no-underline transition-colors outline-none hover:bg-blue1 focus-visible:ring-2 focus-visible:ring-blue9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                    href="/"
                  >
                    Cancel
                  </a>
                </div>
                {error ? <p className="text-sm font-medium text-red9">{error}</p> : null}
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

const getConfirmData = createServerFn({ method: 'GET' })
  .inputValidator(z.string().check(z.minLength(1)))
  .handler(async ({ data }) => {
    const endpoint = rpc.api.confirm[':token']
    const response = await api.fetch(new Request(endpoint.$url({ param: { token: data } })), env)
    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as InferResponseType<
        typeof endpoint.$get,
        404
      > | null
      return {
        message: json && 'message' in json ? json.message : 'Confirmation link expired.',
        ok: false as const,
      }
    }

    return (await response.json()) as InferResponseType<typeof endpoint.$get, 200>
  })

async function authorizeAccessKey(
  connector: ReturnType<typeof useConnectors>[number],
  data: Extract<ReturnType<typeof Route.useLoaderData>, { ok: true }>,
) {
  const provider = (await connector.getProvider()) as {
    request: (parameters: { method: string; params: unknown[] }) => Promise<unknown>
  }
  return (await provider.request({
    method: 'wallet_authorizeAccessKey',
    params: [getAuthorizeAccessKey(data)],
  })) as { keyAuthorization: unknown; rootAddress: string }
}

function getAuthorizeAccessKey(
  data: Extract<ReturnType<typeof Route.useLoaderData>, { ok: true }>,
) {
  return {
    chainId: BigInt(data.chainId),
    expiry: Math.floor(new Date(data.accessKeyExpiry).getTime() / 1000),
    keyType: 'secp256k1' as const,
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
  }
}
