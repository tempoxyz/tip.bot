import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'
import { parseUnits } from 'viem'
import { useConnect, useConnection, useConnectors, useDisconnect } from 'wagmi'
import * as z from 'zod/mini'
import { WalletProviders } from '#/components/WalletProviders.tsx'
import { tipbotImagePath } from '#/lib/app.ts'
import { getErrorMessage } from '#/lib/error.ts'
import { rpc } from '#/lib/rpc.ts'

export const Route = createFileRoute('/link/x')({
  component: Component,
  head: () => ({ meta: [{ title: 'Connect X - Tipbot' }] }),
  validateSearch: z.object({
    error: z.optional(z.literal('oauth_failed')),
    status: z.optional(z.literal('connected')),
  }),
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
  const disconnectWallet = useDisconnect()
  const search = Route.useSearch()
  const [challenge, setChallenge] = React.useState<Challenge | null>(null)
  const [connectedWalletAddress, setConnectedWalletAddress] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<
    'idle' | 'connecting' | 'signing' | 'oauthing' | 'tweeting' | 'checking' | 'connected'
  >(search.status === 'connected' ? 'connected' : 'idle')
  const [showManualVerification, setShowManualVerification] = React.useState(false)
  const [showTweetFallback, setShowTweetFallback] = React.useState(false)
  const [tweetUrl, setTweetUrl] = React.useState('')
  const [xUsername, setXUsername] = React.useState('')
  const walletAddress =
    connection.status === 'connected' && connection.address
      ? connection.address
      : connectedWalletAddress
  const step = challenge ? 3 : walletAddress ? 2 : 1
  const stepDescription = challenge
    ? 'Post the prepared verification tweet from this X account. Tipbot will finish the connection automatically.'
    : walletAddress
      ? showTweetFallback
        ? 'Enter the X username to connect, then approve a limited access key in Tempo Wallet.'
        : 'Approve a limited access key, then sign in with X to verify your account privately.'
      : 'Connect the Tempo Wallet you want to use for X tips.'
  const stepTitle = challenge
    ? 'Post verification tweet'
    : walletAddress
      ? showTweetFallback
        ? 'Verify with proof tweet'
        : 'Connect X'
      : 'Connect wallet'
  const connectWalletMutation = useMutation({
    mutationFn: async () => {
      const connector = connection.connector ?? connectors[0]
      if (!connector) throw new Error('Tempo Wallet is unavailable.')
      const result = await connect.mutateAsync({ connector })
      const account = (result as { accounts?: readonly (string | { address?: string })[] })
        .accounts?.[0]
      const address = typeof account === 'string' ? account : account?.address
      if (!address) throw new Error('Tempo Wallet did not return an account.')
      return address
    },
    onError: () => setStatus('idle'),
    onMutate: () => setStatus('connecting'),
    onSuccess: (address) => {
      setConnectedWalletAddress(address)
      setStatus('idle')
    },
  })
  const oauthMutation = useMutation({
    mutationFn: async () => {
      if (!walletAddress) throw new Error('Connect your wallet first.')
      const challengeResponse = await rpc.api.link.twitter.oauth.challenge.$post({
        json: { address: walletAddress },
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
      const keyAuthorization = await authorizeAccessKey(challengeJson)
      const startResponse = await rpc.api.link.twitter.oauth.start.$post({
        json: {
          address: keyAuthorization.rootAddress,
          challengeId: challengeJson.challengeId,
          keyAuthorization: keyAuthorization.keyAuthorization,
        },
      })
      if (startResponse.status !== 200) {
        const startJson = await startResponse.json()
        throw new Error('message' in startJson ? startJson.message : 'Could not connect Twitter.')
      }
      const startJson = await startResponse.json()
      window.location.assign(startJson.authorizationUrl)
    },
    onError: () => setStatus('idle'),
    onMutate: () => setStatus('oauthing'),
  })
  const signMutation = useMutation({
    mutationFn: async () => {
      const username = xUsername.trim().replace(/^@+/, '')
      if (!username) throw new Error('Enter your X username first.')
      if (!walletAddress) throw new Error('Connect your wallet first.')
      const challengeResponse = await rpc.api.link.twitter.challenge.$post({
        json: { address: walletAddress, username },
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
      const keyAuthorization = await authorizeAccessKey(challengeJson)
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
        avatarUrl: challengeJson.avatarUrl,
        challengeId: challengeJson.challengeId,
        intentUrl: proofJson.intentUrl,
        name: challengeJson.name,
        proof: proofJson.proof,
        tweetText: proofJson.tweetText,
        username: challengeJson.username,
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
  const error = connectWalletMutation.error
    ? getErrorMessage(connectWalletMutation.error, 'Could not connect wallet.')
    : disconnectWallet.error
      ? getErrorMessage(disconnectWallet.error, 'Could not disconnect wallet.')
      : oauthMutation.error
        ? getErrorMessage(oauthMutation.error, 'Could not connect Twitter.')
        : signMutation.error
          ? getErrorMessage(signMutation.error, 'Could not connect Twitter.')
          : verifyMutation.error
            ? getErrorMessage(verifyMutation.error, 'Could not verify the proof tweet.')
            : search.error === 'oauth_failed'
              ? 'Could not connect Twitter. Try again or use proof tweet verification.'
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

  async function authorizeAccessKey(challengeJson: AccessKeyChallenge) {
    const connector = connection.connector ?? connectors[0]
    if (!connector) throw new Error('Tempo Wallet is unavailable.')
    const provider = (await connector.getProvider()) as {
      request: (parameters: { method: string; params: unknown[] }) => Promise<unknown>
    }
    return (await provider.request({
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
  }

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
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-full border border-blue6 bg-blue3 px-3 py-1 text-sm font-bold text-blue11">
                    Step {step}/3
                  </span>
                  <p className="text-xl font-bold text-gray10 sm:text-2xl">{stepTitle}</p>
                </div>
                <p className="mt-2 text-base text-gray9">{stepDescription}</p>
              </div>
              {challenge ? (
                <div className="space-y-6 border-b border-gray5 py-6">
                  <div className="space-y-2">
                    <h3 className="text-lg font-bold text-gray10">Post your verification tweet</h3>
                    <p className="text-base text-gray9">
                      Tipbot prepared this tweet for @{challenge.username}. It must be posted from
                      that X account, then Tipbot will finish the connection automatically.
                    </p>
                  </div>
                  <div className="rounded-2xl border border-gray5 bg-bg1 p-4">
                    <div className="flex gap-3">
                      {challenge.avatarUrl ? (
                        <img
                          alt={`${challenge.name} avatar`}
                          className="size-10 shrink-0 rounded-full object-cover"
                          height={40}
                          src={challenge.avatarUrl}
                          width={40}
                        />
                      ) : (
                        <div className="size-10 shrink-0 rounded-full bg-gray5" />
                      )}
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-baseline gap-x-1.5 text-[15px] leading-5">
                          <span className="font-bold text-gray10">{challenge.name}</span>
                          <span className="text-gray8">@{challenge.username}</span>
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
                  {status === 'checking' ? (
                    <p className="text-sm text-gray8" role="status">
                      Checking for your proof tweet automatically. This can take a few seconds.
                    </p>
                  ) : null}
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
                        disabled={!tweetUrl.trim() || verifyMutation.isPending}
                        onClick={() => {
                          signMutation.reset()
                          verifyMutation.reset()
                          verifyMutation.mutate()
                        }}
                        type="button"
                      >
                        {verifyMutation.isPending ? 'Checking' : 'Verify'}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-6 border-b border-gray5 py-6">
                  {walletAddress ? (
                    <div className="space-y-3">
                      {showTweetFallback ? (
                        <>
                          <label className="text-base font-bold text-gray10" htmlFor="x-username">
                            X username
                          </label>
                          <div className="relative">
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-gray8"
                            >
                              @
                            </span>
                            <input
                              autoComplete="username"
                              className="h-12 w-full rounded-lg border border-gray5 bg-bg1 ps-7 pe-3 text-gray10 outline-none focus-visible:border-blue9 focus-visible:ring-2 focus-visible:ring-blue5 focus-visible:outline-none"
                              id="x-username"
                              onChange={(event) => setXUsername(event.currentTarget.value)}
                              placeholder="yourhandle"
                              value={xUsername}
                            />
                          </div>
                          <p className="text-sm text-gray8">
                            The proof tweet must come from this X account.
                          </p>
                        </>
                      ) : (
                        <>
                          <h3 className="text-lg font-bold text-gray10">
                            With X OAuth, Tipbot can:
                          </h3>
                          <div className="flex gap-4">
                            <IconLucideCheck
                              aria-hidden="true"
                              className="mt-1 size-5 shrink-0 text-green9"
                            />
                            <div className="space-y-1">
                              <p className="text-lg font-bold text-gray10">Read your X profile</p>
                              <p className="text-base text-gray9">
                                Tipbot uses your X id, username, and display name to link the right
                                account.
                              </p>
                            </div>
                          </div>
                          <h3 className="text-lg font-bold text-gray10">
                            With X OAuth, Tipbot cannot:
                          </h3>
                          <div className="flex gap-4">
                            <IconLucideX
                              aria-hidden="true"
                              className="mt-1 size-5 shrink-0 text-red9"
                            />
                            <div className="space-y-1">
                              <p className="text-lg font-bold text-gray10">Post tweets for you</p>
                              <p className="text-base text-gray9">
                                Tipbot only requests profile access for account verification.
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-4">
                            <IconLucideX
                              aria-hidden="true"
                              className="mt-1 size-5 shrink-0 text-red9"
                            />
                            <div className="space-y-1">
                              <p className="text-lg font-bold text-gray10">Read your DMs</p>
                              <p className="text-base text-gray9">
                                Direct message access is not requested or stored.
                              </p>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                  {!walletAddress ? (
                    <>
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
                          <p className="text-lg font-bold text-gray10">
                            Create a limited access key
                          </p>
                          <p className="text-base text-gray9">
                            Tipbot can send X tips only within the approved wallet limits.
                          </p>
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
              )}
              <div className="space-y-4 pt-6">
                {!challenge ? (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <button
                      className="inline-flex h-12 items-center justify-center rounded-lg bg-green8 px-6 text-lg font-bold text-white transition-colors outline-none hover:bg-green7 disabled:cursor-not-allowed disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-green9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                      disabled={
                        status === 'connecting' ||
                        status === 'signing' ||
                        status === 'oauthing' ||
                        Boolean(walletAddress && showTweetFallback && !xUsername.trim())
                      }
                      onClick={() => {
                        connectWalletMutation.reset()
                        oauthMutation.reset()
                        signMutation.reset()
                        verifyMutation.reset()
                        if (!walletAddress) connectWalletMutation.mutate()
                        else if (showTweetFallback) signMutation.mutate()
                        else oauthMutation.mutate()
                      }}
                      type="button"
                    >
                      {status === 'connecting'
                        ? 'Connecting'
                        : status === 'signing'
                          ? 'Signing'
                          : status === 'oauthing'
                            ? 'Connecting X'
                            : walletAddress
                              ? showTweetFallback
                                ? 'Prepare proof tweet'
                                : 'Connect X'
                              : 'Connect wallet'}
                    </button>
                    {walletAddress ? (
                      <button
                        className="inline-flex h-12 items-center justify-center rounded-lg border border-transparent px-6 text-lg font-bold text-gray8 transition-colors outline-none hover:bg-gray3 hover:text-gray10 focus-visible:ring-2 focus-visible:ring-gray8 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                        onClick={() => setShowTweetFallback((value) => !value)}
                        type="button"
                      >
                        {showTweetFallback
                          ? 'Use X OAuth instead'
                          : 'Verify with proof tweet instead'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {error ? (
                  <p className="text-sm font-medium text-red9" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
            </div>
            {walletAddress ? (
              <div className="flex flex-col gap-3 rounded-xl border border-gray5 bg-bg2 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-bold text-gray10">Wallet connected</p>
                  <p className="font-mono text-sm text-gray8">{formatAddress(walletAddress)}</p>
                </div>
                <button
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-gray5 bg-bg2 px-4 text-sm font-bold text-gray10 transition-colors outline-none hover:bg-gray3 disabled:cursor-not-allowed disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-blue9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                  disabled={
                    disconnectWallet.isPending || status === 'signing' || status === 'oauthing'
                  }
                  onClick={() => {
                    disconnectWallet.reset()
                    disconnectWallet.disconnect(undefined, {
                      onSuccess: () => {
                        setConnectedWalletAddress(null)
                        setShowTweetFallback(false)
                        setXUsername('')
                      },
                    })
                  }}
                  type="button"
                >
                  {disconnectWallet.isPending ? 'Disconnecting' : 'Disconnect wallet'}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </main>
  )
}

type AccessKeyChallenge = {
  accessKeyAddress: string
  accessKeyExpiry: string
  accessKeyLimit: string
  accessKeyLimitPeriodSeconds: number
  accessKeyPublicKey: `0x${string}`
  chainId: number
  challengeId: string
  tokenAddress: `0x${string}`
}

type Challenge = {
  avatarUrl?: string | undefined
  challengeId: string
  intentUrl: string
  name: string
  proof: string
  tweetText: string
  username: string
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

function formatAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
