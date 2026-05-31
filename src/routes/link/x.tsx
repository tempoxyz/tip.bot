import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { parseUnits } from 'viem'
import * as React from 'react'
import { useConnect, useConnection, useConnectors } from 'wagmi'
import { WalletProviders } from '#/components/WalletProviders.tsx'
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
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<
    'idle' | 'signing' | 'tweeting' | 'checking' | 'connected'
  >('idle')
  const [tweetUrl, setTweetUrl] = React.useState('')

  useQuery({
    enabled: Boolean(challenge && status === 'checking'),
    queryFn: async () => {
      await verifyTweet()
      return null
    },
    queryKey: ['twitter-link-verify', challenge?.challengeId, challenge?.proof, tweetUrl.trim()],
    refetchInterval: 5 * 1000, // 5 seconds
    retry: false,
  })

  async function connectTwitter() {
    setError(null)
    setStatus('signing')
    try {
      const connector = connection.connector ?? connectors[0]
      if (!connector) throw new Error('Tempo Wallet is unavailable.')
      const address =
        connection.status === 'connected' && connection.address
          ? connection.address
          : await (async () => {
              const result = await connect.connectAsync({ connector })
              const account = (result as { accounts?: readonly (string | { address?: string })[] })
                .accounts?.[0]
              const address = typeof account === 'string' ? account : account?.address
              if (!address) throw new Error('Tempo Wallet did not return an account.')
              return address
            })()
      const challengeResponse = await rpc.api.link.twitter.challenge.$post({
        json: { address },
      })
      const challengeJson = (await challengeResponse.json()) as ChallengeResponse
      if (!challengeJson.ok)
        throw new Error(
          'message' in challengeJson
            ? challengeJson.message
            : 'Could not start Twitter connection.',
        )
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
      const proofJson = (await proofResponse.json()) as ProofResponse
      if (!proofJson.ok)
        throw new Error(
          'message' in proofJson ? proofJson.message : 'Could not prepare Twitter proof.',
        )
      setChallenge({
        challengeId: challengeJson.challengeId,
        intentUrl: proofJson.intentUrl,
        proof: proofJson.proof,
        tweetText: proofJson.tweetText,
      })
      setStatus('tweeting')
      window.open(proofJson.intentUrl, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setError(getErrorMessage(error, 'Could not connect Twitter.'))
      setStatus('idle')
    }
  }

  async function verifyTweet(options: { manual?: boolean } = {}) {
    if (!challenge) return
    if (options.manual) setError(null)
    setStatus('checking')
    try {
      const response = await rpc.api.link.twitter.verify.$post({
        json: {
          challengeId: challenge.challengeId,
          proof: challenge.proof,
          ...(tweetUrl.trim() ? { tweetUrl: tweetUrl.trim() } : {}),
        },
      })
      const json = (await response.json()) as VerifyResponse
      if (json.ok) {
        setStatus('connected')
        return
      }
      if (json.code === 'pending') return
      if (json.code === 'account_conflict')
        throw new Error(
          'This Twitter account or wallet is already connected. Disconnect it from the dashboard, then try again.',
        )
      throw new Error('Could not verify the proof tweet yet.')
    } catch (error) {
      if (options.manual) setError(getErrorMessage(error, 'Could not verify the proof tweet.'))
      setStatus('tweeting')
    }
  }

  return (
    <main className="min-h-screen bg-bg2 px-6 py-12 text-gray10">
      <section className="mx-auto flex max-w-xl flex-col gap-6 rounded-xl border border-gray4 bg-bg1 p-6 shadow-xl shadow-gray-a2">
        <div className="space-y-3">
          <p className="text-sm font-bold uppercase tracking-wide text-blue9">Twitter connection</p>
          <h1 className="text-3xl font-bold tracking-[-0.03em] text-gray10">Connect X to Tipbot</h1>
          <p className="leading-7 text-gray9">
            Connect your wallet, post a short verification tweet, and Tipbot will link your X
            account for tips.
          </p>
        </div>

        {status === 'connected' ? (
          <div className="rounded-lg border border-green6 bg-green1 p-4 text-gray10" role="status">
            <p className="font-bold">Connected</p>
            <p className="mt-1 text-sm text-gray9">You can now receive and send tips on X.</p>
          </div>
        ) : null}

        {challenge && status !== 'connected' ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-gray4 bg-bg2 p-4">
              <p className="mb-2 text-sm font-semibold text-gray10">Verification tweet</p>
              <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-gray9">
                {challenge.tweetText}
              </pre>
            </div>
            <a
              className="inline-flex h-11 items-center justify-center rounded-lg bg-blue9 px-4 text-sm font-bold text-white no-underline transition hover:bg-blue10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9"
              href={challenge.intentUrl}
              rel="noreferrer"
              target="_blank"
              onClick={() => setStatus('checking')}
            >
              Post connection tweet
            </a>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-gray10" htmlFor="tweet-url">
                Fallback: paste your tweet URL
              </label>
              <input
                className="h-11 w-full rounded-lg border border-gray5 bg-bg1 px-3 text-gray10 outline-none focus-visible:border-blue9 focus-visible:ring-2 focus-visible:ring-blue5"
                id="tweet-url"
                onChange={(event) => setTweetUrl(event.currentTarget.value)}
                placeholder="https://x.com/account/status/123"
                value={tweetUrl}
              />
              <button
                className="inline-flex h-11 items-center justify-center rounded-lg border border-gray5 bg-bg1 px-4 text-sm font-bold text-gray10 transition hover:bg-gray1 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9"
                disabled={status === 'checking'}
                onClick={() => verifyTweet({ manual: true })}
                type="button"
              >
                {status === 'checking' ? 'Checking' : 'Verify'}
              </button>
            </div>
          </div>
        ) : null}

        {!challenge ? (
          <button
            className="inline-flex h-12 items-center justify-center rounded-lg bg-blue9 px-5 text-base font-bold text-white transition hover:bg-blue10 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9"
            disabled={status === 'signing'}
            onClick={connectTwitter}
            type="button"
          >
            {status === 'signing' ? 'Connecting' : 'Connect wallet'}
          </button>
        ) : null}

        {error ? (
          <div
            className="rounded-lg border border-red6 bg-red1 p-4 text-sm text-red10"
            role="alert"
          >
            {error}
          </div>
        ) : null}
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

type ChallengeResponse =
  | {
      accessKeyExpiry: string
      accessKeyLimit: string
      accessKeyLimitPeriodSeconds: number
      accessKeyPublicKey: `0x${string}`
      chainId: number
      challengeId: string
      ok: true
      tokenAddress: string
    }
  | { message?: string; ok: false }

type ProofResponse =
  | { intentUrl: string; ok: true; proof: string; tweetText: string }
  | { message?: string; ok: false }

type VerifyResponse = { handle?: string; ok: true } | { code: string; message?: string; ok: false }
