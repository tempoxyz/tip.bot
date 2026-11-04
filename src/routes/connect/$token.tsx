import { createFileRoute } from '@tanstack/react-router'
import * as z from 'zod/mini'
import { slackCommand, tipbotImagePath } from '#/lib/app.ts'

// Slack links to the Tempo ID sign-in, whose approval page names the access key's limits. This page
// shows only where the sign-in ends: connected, a conflict to resolve, an error, or a used link.
function Component() {
  const params = Route.useParams()
  const search = Route.useSearch()

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
        {(() => {
          if (search.status === 'connected')
            return (
              <div className="space-y-3 text-center" role="status">
                <h1 className="text-3xl font-bold text-gray10">Connected to Tipbot</h1>
                <p className="text-base text-gray9">You can close this tab and return to Slack.</p>
              </div>
            )
          if (search.status === 'conflict')
            return (
              <form
                action={`/api/account/link/${params.token}/resolve`}
                className="max-w-sm space-y-4 text-center"
                method="post"
              >
                <h1 className="text-3xl font-bold text-gray10">Wallet already connected</h1>
                <p aria-live="polite" className="text-base text-gray9">
                  This wallet is already connected to another Slack account in this workspace.
                </p>
                <button
                  className="inline-flex h-12 items-center justify-center rounded-lg bg-red8 px-6 text-lg font-bold text-white transition-colors outline-none hover:bg-red7 focus-visible:ring-2 focus-visible:ring-red9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                  type="submit"
                >
                  Disconnect existing account and connect
                </button>
              </form>
            )
          if (search.error)
            return (
              <div className="max-w-sm space-y-4 text-center">
                <h1 className="text-3xl font-bold text-gray10">Could not connect Tipbot</h1>
                <p aria-live="polite" className="text-base text-red9">
                  {search.error}
                </p>
                <a
                  className="inline-flex h-12 items-center justify-center rounded-lg bg-green8 px-6 text-lg font-bold text-white no-underline transition-colors outline-none hover:bg-green7 focus-visible:ring-2 focus-visible:ring-green9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                  href={`/api/account/link/${params.token}/start`}
                >
                  Try again
                </a>
              </div>
            )
          return (
            <div className="max-w-sm space-y-3 text-center">
              <h1 className="text-3xl font-bold text-gray10">Connection link unavailable</h1>
              <p className="text-base text-gray9">This connection link is invalid or expired.</p>
              <p className="text-base text-gray9">
                Run `{slackCommand} connect` in Slack to get a new link.
              </p>
            </div>
          )
        })()}
      </section>
    </main>
  )
}

export const Route = createFileRoute('/connect/$token')({
  component: Component,
  head: () => ({ meta: [{ title: 'Connect - Tipbot' }] }),
  validateSearch: z.object({
    error: z.optional(z.string()),
    status: z.optional(z.enum(['conflict', 'connected'])),
  }),
})
