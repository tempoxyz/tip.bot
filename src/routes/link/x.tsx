import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import * as React from 'react'
import * as z from 'zod/mini'
import { tipbotImagePath } from '#/lib/app.ts'
import { getErrorMessage } from '#/lib/error.ts'
import { rpc } from '#/lib/rpc.ts'

function Component() {
  const proof = Route.useLoaderData()
  const search = Route.useSearch()
  const [connected, setConnected] = React.useState(search.status === 'connected')
  const [showProofForm, setShowProofForm] = React.useState(search.error === 'link_failed')
  const [showManualVerification, setShowManualVerification] = React.useState(false)
  const [checking, setChecking] = React.useState(false)
  const [tweetUrl, setTweetUrl] = React.useState('')
  const [copiedExampleTweet, setCopiedExampleTweet] = React.useState(false)
  const exampleTweet = '@tipbotgg @awkweb $0.01 for building tipbot'
  const step = connected ? 3 : proof ? 2 : 1

  async function verifyTweet() {
    if (!proof) throw new Error('Could not verify the proof tweet yet.')
    const response = await rpc.api.link.twitter.verify.$post({
      json: {
        challengeId: proof.challengeId,
        proof: proof.proof,
        ...(tweetUrl.trim() ? { tweetUrl: tweetUrl.trim() } : {}),
      },
    })
    if (response.status !== 200) throw new Error('Could not verify the proof tweet yet.')
    const json = await response.json()
    if (json.ok) return 'connected' as const
    if (json.code === 'pending') return 'pending' as const
    throw new Error('Could not verify the proof tweet yet.')
  }

  const verifyMutation = useMutation({
    mutationFn: verifyTweet,
    onSuccess: (value) => {
      if (value === 'connected') setConnected(true)
    },
  })

  useQuery({
    enabled: Boolean(proof && checking && !connected),
    queryFn: async () => {
      const result = await verifyTweet().catch(() => 'pending' as const)
      if (result === 'connected') setConnected(true)
      return result
    },
    queryKey: ['twitter-link-verify', proof?.challengeId, proof?.proof, tweetUrl.trim()],
    refetchInterval: 5 * 1000, // 5 seconds
    retry: false,
  })

  const error = verifyMutation.error
    ? getErrorMessage(verifyMutation.error, 'Could not verify the proof tweet.')
    : search.error === 'oauth_failed'
      ? 'Could not connect X. Try again, or verify with a proof tweet.'
      : search.error === 'link_failed'
        ? 'Could not prepare the proof tweet. Check the username and try again.'
        : search.challenge && !proof
          ? 'This proof tweet expired. Start again.'
          : null

  async function copyExampleTweet() {
    await navigator.clipboard.writeText(`.${exampleTweet}`)
    setCopiedExampleTweet(true)
    window.setTimeout(() => setCopiedExampleTweet(false), 2_000) // 2 seconds
  }

  function composeExampleTweet() {
    const intentUrl = new URL('/intent/tweet', 'https://twitter.com')
    intentUrl.searchParams.set('text', `.${exampleTweet}`)
    openTweetComposer(intentUrl.toString())
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
        {connected ? (
          <div className="w-full space-y-8 text-center" role="status">
            <div className="space-y-3">
              <h1 className="text-3xl font-bold text-gray10">Connected to Tipbot</h1>
              <p className="text-base text-gray9">You can now receive and send tips on X.</p>
            </div>
            <div className="mx-auto max-w-md rounded-2xl border border-gray5 bg-bg2 p-5 text-start shadow-lg">
              <div className="space-y-2">
                <p className="text-sm font-bold text-gray10">Try your first tip</p>
                <p className="text-sm text-gray8">Post this on X to tip @awkweb.</p>
              </div>
              <div className="mt-4 rounded-xl border border-gray5 bg-bg1 p-4">
                <p className="break-words font-mono text-sm text-gray10">{exampleTweet}</p>
              </div>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                <button
                  className="inline-flex h-10 items-center justify-center rounded-lg bg-green8 px-4 text-sm font-bold whitespace-nowrap text-white transition-colors outline-none hover:bg-green7 focus-visible:ring-2 focus-visible:ring-green9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                  onClick={composeExampleTweet}
                  type="button"
                >
                  Open in X
                </button>
                <button
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-gray5 bg-bg2 px-4 text-sm font-bold whitespace-nowrap text-gray10 transition-colors outline-none hover:bg-gray3 focus-visible:ring-2 focus-visible:ring-blue9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                  onClick={() => void copyExampleTweet()}
                  type="button"
                >
                  {copiedExampleTweet ? 'Copied' : 'Copy tweet'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full space-y-8">
            <div className="space-y-3 text-center">
              <h1 className="text-3xl font-bold text-gray10 sm:text-4xl">
                Connect X to <span className="text-blue9">Tipbot</span>
              </h1>
              <p className="text-base text-gray9 sm:text-lg">
                Sign in with Tempo ID, then verify your X account.
              </p>
            </div>
            <div className="rounded-2xl border border-gray5 bg-bg2 p-6 shadow-xl sm:p-8">
              <div className="border-b border-gray5 pb-6">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-full border border-blue6 bg-blue3 px-3 py-1 text-sm font-bold text-blue11">
                    Step {step}/2
                  </span>
                  <p className="text-xl font-bold text-gray10 sm:text-2xl">
                    {proof ? 'Post verification tweet' : 'Connect X'}
                  </p>
                </div>
                <p className="mt-2 text-base text-gray9">
                  {proof
                    ? 'Post the prepared verification tweet from this X account. Tipbot finishes the connection automatically.'
                    : 'Approve a limited access key with Tempo ID, then sign in with X to verify your account.'}
                </p>
              </div>
              {proof ? (
                <div className="space-y-6 border-b border-gray5 py-6">
                  <div className="rounded-2xl border border-gray5 bg-bg1 p-4">
                    <div className="min-w-0 space-y-2">
                      <p className="text-[15px] leading-5 text-gray8">@{proof.username}</p>
                      <pre className="whitespace-pre-wrap break-words text-[15px] leading-[1.15] text-gray10">
                        {proof.tweetText}
                      </pre>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <button
                      className="inline-flex h-12 items-center justify-center rounded-lg bg-blue9 px-6 text-lg font-bold text-white transition-colors outline-none hover:bg-blue8 focus-visible:ring-2 focus-visible:ring-blue9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                      onClick={() => {
                        openTweetComposer(proof.intentUrl)
                        setChecking(true)
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
                  {checking ? (
                    <p aria-live="polite" className="text-sm text-gray8">
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
                        onClick={() => verifyMutation.mutate()}
                        type="button"
                      >
                        {verifyMutation.isPending ? 'Checking' : 'Verify'}
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
                      <p className="text-lg font-bold text-gray10">Read your X profile</p>
                      <p className="text-base text-gray9">
                        Tipbot only uses your id, username, and display name.
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
                        Tipbot can send X tips only within the limits that you approve.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <IconLucideX aria-hidden="true" className="mt-1 size-5 shrink-0 text-red9" />
                    <div className="space-y-1">
                      <p className="text-lg font-bold text-gray10">Post tweets or read your DMs</p>
                      <p className="text-base text-gray9">
                        Tipbot requests read-only access for account verification.
                      </p>
                    </div>
                  </div>
                  {showProofForm ? (
                    // A proof tweet verifies the account without X sign-in.
                    <form action="/api/link/twitter/proof/begin" className="space-y-3" method="get">
                      <label className="text-base font-bold text-gray10" htmlFor="x-username">
                        X username
                      </label>
                      <input
                        autoComplete="username"
                        className="h-12 w-full rounded-lg border border-gray5 bg-bg1 px-3 text-gray10 outline-none focus-visible:border-blue9 focus-visible:ring-2 focus-visible:ring-blue5 focus-visible:outline-none"
                        id="x-username"
                        name="username"
                        pattern="@?[A-Za-z0-9_]{1,15}"
                        placeholder="yourhandle"
                        required
                      />
                      <button
                        className="inline-flex h-12 items-center justify-center rounded-lg bg-green8 px-6 text-lg font-bold text-white transition-colors outline-none hover:bg-green7 focus-visible:ring-2 focus-visible:ring-green9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                        type="submit"
                      >
                        Prepare proof tweet
                      </button>
                    </form>
                  ) : null}
                </div>
              )}
              <div className="space-y-4 pt-6">
                {!proof ? (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    {!showProofForm ? (
                      <a
                        className="inline-flex h-12 shrink-0 items-center justify-center rounded-lg bg-green8 px-6 text-lg font-bold whitespace-nowrap text-white no-underline transition-colors outline-none hover:bg-green7 focus-visible:ring-2 focus-visible:ring-green9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                        href="/api/link/twitter/oauth/begin"
                      >
                        Connect X
                      </a>
                    ) : null}
                    <button
                      className="inline-flex h-12 shrink-0 items-center justify-center rounded-lg border border-transparent px-6 text-lg font-bold whitespace-nowrap text-gray8 transition-colors outline-none hover:bg-gray3 hover:text-gray10 focus-visible:ring-2 focus-visible:ring-gray8 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                      onClick={() => setShowProofForm((value) => !value)}
                      type="button"
                    >
                      {showProofForm ? 'Use X sign-in' : 'Verify with proof tweet'}
                    </button>
                  </div>
                ) : null}
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

export const Route = createFileRoute('/link/x')({
  component: Component,
  head: () => ({ meta: [{ title: 'Connect X - Tipbot' }] }),
  loaderDeps: (options) => ({ challenge: options.search.challenge, proof: options.search.proof }),
  async loader(options) {
    const deps = options.deps
    if (!deps.challenge || !deps.proof) return null
    return await getProofData({ data: { challengeId: deps.challenge, proof: deps.proof } })
  },
  validateSearch: z.object({
    challenge: z.optional(z.string()),
    error: z.optional(z.enum(['link_failed', 'oauth_failed'])),
    proof: z.optional(z.string()),
    status: z.optional(z.literal('connected')),
  }),
})

const getProofData = createServerFn({ method: 'GET' })
  .validator(z.object({ challengeId: z.string(), proof: z.string() }))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers')
    const Twitter = await import('#/lib/twitter.ts')
    const proof = await Twitter.getProof(env, data)
    return proof ? { ...proof, challengeId: data.challengeId, proof: data.proof } : null
  })

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
