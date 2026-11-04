import { createFileRoute } from '@tanstack/react-router'
import * as z from 'zod/mini'
import { slackCommand, tipbotImagePath } from '#/lib/app.ts'
import * as Tempo from '#/lib/tempo.ts'

// Slack links to the Tempo ID sign-in, which authorizes the payment's access key, and the callback
// pays. This page shows only where that ends: sent, an error, or an expired link.
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
          if (search.status === 'sent')
            return (
              <div className="space-y-3 text-center" role="status">
                <h1 className="text-3xl font-bold text-gray10">Payment sent</h1>
                <p className="text-base text-gray9">You can close this tab and return to Slack.</p>
                {search.tx && search.chain ? (
                  <a
                    className="inline-flex text-base font-bold text-blue9 no-underline hover:underline"
                    href={Tempo.formatTxLink(search.chain, search.tx)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    View receipt
                  </a>
                ) : null}
              </div>
            )
          if (search.error)
            return (
              <div className="max-w-sm space-y-4 text-center">
                <h1 className="text-3xl font-bold text-gray10">Payment not sent</h1>
                <p aria-live="polite" className="text-base text-red9">
                  {search.error}
                </p>
                <a
                  className="inline-flex h-12 items-center justify-center rounded-lg bg-green8 px-6 text-lg font-bold text-white no-underline transition-colors outline-none hover:bg-green7 focus-visible:ring-2 focus-visible:ring-green9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                  href={`/api/confirm/${params.token}/start`}
                >
                  Try again
                </a>
              </div>
            )
          return (
            <div className="max-w-sm space-y-3 text-center">
              <h1 className="text-3xl font-bold text-gray10">Confirmation link expired</h1>
              <p className="text-base text-gray9">Run `{slackCommand}` again in Slack.</p>
            </div>
          )
        })()}
      </section>
    </main>
  )
}

export const Route = createFileRoute('/confirm/$token')({
  component: Component,
  head: () => ({ meta: [{ title: 'Confirm payment - Tipbot' }] }),
  validateSearch: z.object({
    chain: z.optional(z.coerce.number()),
    error: z.optional(z.string()),
    status: z.optional(z.literal('sent')),
    tx: z.optional(z.string()),
  }),
})
