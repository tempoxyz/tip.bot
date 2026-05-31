import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'
import { parseUnits } from 'viem'
import { useConnect, useConnection, useConnectors } from 'wagmi'
import { WalletProviders } from '#/components/WalletProviders.tsx'
import { tipbotImagePath } from '#/lib/app.ts'
import { getErrorMessage } from '#/lib/error.ts'
import { rpc } from '#/lib/rpc.ts'

export const Route = createFileRoute('/link/x')({
  component: Component,
  head: () => ({ meta: [{ title: 'Connect X - Tipbot' }] }),
})

function Component() {
  return (
    <WalletProviders.Root>
      <LinkPanel />
    </WalletProviders.Root>
  )
}

function LinkPanel() {
  const connect = useConnect()
  const connection = useConnection()
  const connectors = useConnectors()
  const [challenge, setChallenge] = React.useState<Challenge | null>(null)
  const [status, setStatus] = React.useState<
    'idle' | 'signing' | 'tweeting' | 'checking' | 'connected'
  >('idle')
  const [showManualVerification, setShowManualVerification] = React.useState(false)
  const [tweetUrl, setTweetUrl] = React.useState('')
  const connectMutation = useMutation({
    mutationFn: async () => {
      const connector = connection.connector ?? connectors[0]
      if (!connector) throw new Error('Tempo Wallet is unavailable.')
      const address =
        connection.status === 'connected' && connection.address
          ? connection.address
          : await (async () => {
              const result = await connect.mutateAsync({ connector })
              const account = (result as { accounts?: readonly (string | { address?: string })[] })
                .accounts?.[0]
              const address = typeof account === 'string' ? account : account?.address
              if (!address) throw new Error('Tempo Wallet did not return an account.')
              return address
            })()
      const challengeResponse = await rpc.api.link.twitter.challenge.$post({
        json: { address },
      })
      if (challengeResponse.status !== 200) {
        const challengeJson = await challengeResponse.json()
        throw new Error(
          'message' in challengeJson
            ? challengeJson.message
            : 'Could not start Twitter connection.',
        )
      }
      const challengeJson = await challengeResponse.json()
      const provider = (await connector.getProvider()) as {
        request: (parameters: { method: string; params: unknown[] }) => Promise<unknown>
      }
      const keyAuthorization = (await provider.request({
        method: 'wallet_authorizeAccessKey',
        params: [
          {
            chainId: BigInt(challengeJson.chainId),
            expiry: Math.floor(new Date(challengeJson.accessKeyExpiry).getTime() / 1000),
            keyType: 'secp256k1' as const,
            limits: [
              {
                limit: parseUnits(challengeJson.accessKeyLimit, 6),
                period: challengeJson.accessKeyLimitPeriodSeconds,
                token: challengeJson.tokenAddress,
              },
            ],
            publicKey: challengeJson.accessKeyPublicKey,
            scopes: [
              { address: challengeJson.tokenAddress, selector: 'transfer(address,uint256)' },
              {
                address: challengeJson.tokenAddress,
                selector: 'transferWithMemo(address,uint256,bytes32)',
              },
            ],
          },
        ],
      })) as { keyAuthorization: unknown; rootAddress: string }
      const proofResponse = await rpc.api.link.twitter.proof.$post({
        json: {
          address: keyAuthorization.rootAddress,
          challengeId: challengeJson.challengeId,
          keyAuthorization: keyAuthorization.keyAuthorization,
        },
      })
      if (proofResponse.status !== 200) {
        const proofJson = await proofResponse.json()
        throw new Error(
          'message' in proofJson ? proofJson.message : 'Could not prepare Twitter proof.',
        )
      }
      const proofJson = await proofResponse.json()
      return {
        challengeId: challengeJson.challengeId,
        intentUrl: proofJson.intentUrl,
        proof: proofJson.proof,
        tweetText: proofJson.tweetText,
      }
    },
    onError: () => setStatus('idle'),
    onMutate: () => setStatus('signing'),
    onSuccess: (value) => {
      setChallenge(value)
      setShowManualVerification(false)
      setStatus('tweeting')
    },
  })
  const verifyMutation = useMutation({
    mutationFn: async () => await verifyTweet(),
    onError: () => setStatus('tweeting'),
    onMutate: () => setStatus('checking'),
    onSuccess: (value) => {
      if (value === 'connected') setStatus('connected')
    },
  })
  const error = connectMutation.error
    ? getErrorMessage(connectMutation.error, 'Could not connect Twitter.')
    : verifyMutation.error
      ? getErrorMessage(verifyMutation.error, 'Could not verify the proof tweet.')
      : null

  useQuery({
    enabled: Boolean(challenge && status === 'checking'),
    queryFn: async () => {
      try {
        const result = await verifyTweet()
        if (result === 'connected') setStatus('connected')
        return result
      } catch {
        setStatus('tweeting')
        return null
      }
    },
    queryKey: ['twitter-link-verify', challenge?.challengeId, challenge?.proof, tweetUrl.trim()],
    refetchInterval: 5 * 1000, // 5 seconds
    retry: false,
  })

  async function verifyTweet() {
    if (!challenge) throw new Error('Could not verify the proof tweet yet.')
    const response = await rpc.api.link.twitter.verify.$post({
      json: {
        challengeId: challenge.challengeId,
        proof: challenge.proof,
        ...(tweetUrl.trim() ? { tweetUrl: tweetUrl.trim() } : {}),
      },
    })
    if (response.status !== 200) throw new Error('Could not verify the proof tweet yet.')
    const json = await response.json()
    if (json.ok) return 'connected' as const
    if (json.code === 'pending') return 'pending' as const
    throw new Error('Could not verify the proof tweet yet.')
  }

  return (
    <main className="min-h-screen bg-bg2 px-6 pt-8 pb-12 text-gray10 sm:pt-16 lg:pt-24">
      <section className="mx-auto flex max-w-xl flex-col items-center gap-8">
        <img
          alt="Tipbot"
          className="size-28 rounded-3xl object-cover shadow-lg sm:size-36"
          height={160}
          src={tipbotImagePath}
          width={160}
        />
        {status === 'connected' ? (
          <div className="space-y-3 text-center" role="status">
            <h1 className="text-3xl font-bold text-gray10">Connected to Tipbot</h1>
            <p className="text-base text-gray9">You can now receive and send tips on X.</p>
          </div>
        ) : (
          <div className="w-full space-y-8">
            <div className="space-y-3 text-center">
              <h1 className="text-3xl font-bold text-gray10 sm:text-4xl">
                Connect X to <span className="text-blue9">Tipbot</span>
              </h1>
              <p className="text-base text-gray9 sm:text-lg">
                Authorize Tipbot to connect your Tempo Wallet for X tips.
              </p>
            </div>
            <div className="rounded-2xl border border-gray5 bg-bg2 p-6 shadow-xl sm:p-8">
              <div className="border-b border-gray5 pb-6">
                <h2 className="text-xl font-bold text-gray10 sm:text-2xl">
                  Tipbot wants to connect to your X account
                </h2>
                <p className="mt-2 text-base text-gray9">
                  Review the steps below before continuing.
                </p>
              </div>
              {challenge ? (
                <div className="space-y-6 border-b border-gray5 py-6">
                  <div className="space-y-2">
                    <h3 className="text-lg font-bold text-gray10">Post your verification tweet</h3>
                    <p className="text-base text-gray9">
                      Tipbot prepared this tweet for you. Posting it proves which X account owns
                      this wallet, then Tipbot will finish the connection automatically.
                    </p>
                  </div>
                  <div className="rounded-2xl border border-gray5 bg-bg1 p-4">
                    <div className="flex gap-3">
                      <div className="size-10 shrink-0 rounded-full bg-gray5" />
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-baseline gap-x-1.5 text-[15px] leading-5">
                          <span className="font-bold text-gray10">You</span>
                          <span className="text-gray8">@yourhandle</span>
                          <span className="text-gray8">·</span>
                          <span className="text-gray8">now</span>
                        </div>
                        <pre className="whitespace-pre-wrap break-words text-[15px] leading-[1.15] text-gray10">
                          {challenge.tweetText}
                        </pre>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <button
                      className="inline-flex h-12 items-center justify-center rounded-lg bg-blue9 px-6 text-lg font-bold text-white no-underline transition-colors outline-none hover:bg-blue8 focus-visible:ring-2 focus-visible:ring-blue9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                      onClick={() => {
                        openTweetComposer(challenge.intentUrl)
                        setStatus('checking')
                      }}
                      type="button"
                    >
                      Post connection tweet
                    </button>
                    <button
                      className="inline-flex h-12 min-h-12 items-center justify-center rounded-lg border border-transparent px-6 text-lg font-bold text-gray8 transition-colors outline-none hover:bg-gray3 hover:text-gray10 focus-visible:ring-2 focus-visible:ring-gray8 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                      onClick={() => setShowManualVerification((value) => !value)}
                      type="button"
                    >
                      Manual verification
                    </button>
                  </div>
                  {showManualVerification ? (
                    <div className="space-y-3">
                      <label className="text-base font-bold text-gray10" htmlFor="tweet-url">
                        Paste your tweet URL
                      </label>
                      <input
                        className="h-12 w-full rounded-lg border border-gray5 bg-bg1 px-3 text-gray10 outline-none focus-visible:border-blue9 focus-visible:ring-2 focus-visible:ring-blue5 focus-visible:outline-none"
                        id="tweet-url"
                        onChange={(event) => setTweetUrl(event.currentTarget.value)}
                        placeholder="https://x.com/account/status/123"
                        value={tweetUrl}
                      />
                      <button
                        className="inline-flex h-12 items-center justify-center rounded-lg border border-gray5 bg-bg1 px-6 text-lg font-bold text-gray10 transition-colors outline-none hover:bg-gray1 disabled:cursor-not-allowed disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-blue9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                        disabled={status === 'checking' && !tweetUrl.trim()}
                        onClick={() => {
                          connectMutation.reset()
                          verifyMutation.reset()
                          verifyMutation.mutate()
                        }}
                        type="button"
                      >
                        {status === 'checking' && !tweetUrl.trim() ? 'Checking' : 'Verify'}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-6 border-b border-gray5 py-6">
                  <h3 className="text-lg font-bold text-gray10">
                    With this connection, Tipbot can:
                  </h3>
                  <div className="flex gap-4">
                    <IconLucideCheck
                      aria-hidden="true"
                      className="mt-1 size-5 shrink-0 text-green9"
                    />
                    <div className="space-y-1">
                      <p className="text-lg font-bold text-gray10">Read your wallet address</p>
                      <p className="text-base text-gray9">
                        Tipbot uses your wallet address to show who is connected on X.
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
                        Tipbot can send X tips only within the approved wallet limits.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <IconLucideCheck
                      aria-hidden="true"
                      className="mt-1 size-5 shrink-0 text-green9"
                    />
                    <div className="space-y-1">
                      <p className="text-lg font-bold text-gray10">Verify your X account</p>
                      <p className="text-base text-gray9">
                        You’ll post a short connection tweet so Tipbot can link the right account.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              <div className="space-y-4 pt-6">
                {!challenge ? (
                  <button
                    className="inline-flex h-12 items-center justify-center rounded-lg bg-green8 px-6 text-lg font-bold text-white transition-colors outline-none hover:bg-green7 disabled:cursor-not-allowed disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-green9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                    disabled={status === 'signing'}
                    onClick={() => {
                      connectMutation.reset()
                      verifyMutation.reset()
                      connectMutation.mutate()
                    }}
                    type="button"
                  >
                    {status === 'signing' ? 'Connecting' : 'Connect wallet'}
                  </button>
                ) : null}
                <p className="text-base text-gray9">
                  {challenge
                    ? 'Next: post the tweet, then verify the connection.'
                    : 'Next: you’ll be asked to approve this connection in Tempo Wallet.'}
                </p>
                {error ? (
                  <p className="text-sm font-medium text-red9" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

type Challenge = {
  challengeId: string
  intentUrl: string
  proof: string
  tweetText: string
}

function openTweetComposer(intentUrl: string) {
  const width = 560
  const height = 420
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2)
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2)
  const popup = window.open(
    intentUrl,
    'tipbot_x_connection_tweet',
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
  )

  popup?.focus()
}
