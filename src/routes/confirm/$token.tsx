import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import type { InferResponseType } from 'hono/client'
import * as z from 'zod/mini'
import { api } from '#/api.ts'
import { slackCommand, tipbotImagePath } from '#/lib/app.ts'
import { formatCurrencyAmount } from '#/lib/format.ts'
import { rpc } from '#/lib/rpc.ts'
import * as Tempo from '#/lib/tempo.ts'

export const Route = createFileRoute('/confirm/$token')({
  component: Component,
  async loader(options) {
    return await getConfirmData({ data: options.params.token })
  },
  validateSearch: z.object({
    error: z.optional(z.string()),
    status: z.optional(z.literal('sent')),
    tx: z.optional(z.string()),
  }),
})

function Component() {
  const data = Route.useLoaderData()
  const params = Route.useParams()
  const search = Route.useSearch()

  // A sent payment's link can expire, so the callback's result shows first.
  if (search.status === 'sent')
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
          <div className="space-y-3 text-center">
            <h1 className="text-3xl font-bold text-gray10">Payment sent</h1>
            <p className="text-base text-gray9">You can close this tab and return to Slack.</p>
            {search.tx && data.ok ? (
              <a
                className="inline-flex text-base font-bold text-blue9 no-underline hover:underline"
                href={Tempo.formatTxLink(data.chainId, search.tx)}
                rel="noreferrer"
                target="_blank"
              >
                View receipt
              </a>
            ) : null}
          </div>
        </section>
      </main>
    )
  if (!data.ok)
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
          <div className="max-w-sm space-y-3 text-center">
            <h1 className="text-3xl font-bold text-gray10">Confirmation link expired</h1>
            <p className="text-base text-gray9">{data.message}</p>
            <p className="text-base text-gray9">Run `{slackCommand}` again in Slack.</p>
          </div>
        </section>
      </main>
    )

  return <ConfirmPanel data={data} error={search.error} token={params.token} />
}

function ConfirmPanel(props: {
  data: Extract<ReturnType<typeof Route.useLoaderData>, { ok: true }>
  error?: string | undefined
  token: string
}) {
  const data = props.data
  const error = props.error
  const recipients: Array<{
    recipientAvatarUrl?: string | null
    recipientProviderLabel?: string | null
    recipientProviderUserId: string
  }> = data.recipients ?? [
    {
      recipientAvatarUrl: data.recipientAvatarUrl,
      recipientProviderLabel: data.recipientProviderLabel,
      recipientProviderUserId: data.recipientProviderUserId,
    },
  ]
  const skippedRecipients: Array<{
    reason: 'not_connected' | 'you'
    recipientProviderLabel?: string | null
    recipientProviderUserId: string
  }> = data.skippedRecipients ?? []
  const totalAmount = String(Number(data.amount) * recipients.length)

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
        <div className="w-full space-y-8">
          <div className="space-y-3 text-center">
            <h1 className="text-3xl font-bold text-gray10 sm:text-4xl">Confirm payment</h1>
            <p className="text-base text-gray9 sm:text-lg">Approve this payment with Tempo ID.</p>
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
              <div className="divide-y divide-gray5 rounded-xl border border-gray5 bg-bg1">
                {data.groupLabel ? (
                  <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-5">
                    <span className="text-base font-bold text-gray8 sm:text-lg">Group</span>
                    <span className="text-lg font-bold text-gray10 sm:text-end sm:text-xl">
                      @{data.groupLabel}
                    </span>
                  </div>
                ) : null}
                <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-5">
                  <span className="text-base font-bold text-gray8 sm:text-lg">Amount</span>
                  <span className="text-lg font-bold text-gray10 sm:text-end sm:text-xl">
                    {formatCurrencyAmount(data.amount, data.tokenCurrency)} {data.tokenSymbol}
                    {recipients.length > 1 ? ' each' : ''}
                  </span>
                </div>
                {recipients.length > 1 ? (
                  <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-5">
                    <span className="text-base font-bold text-gray8 sm:text-lg">Total</span>
                    <span className="text-lg font-bold text-gray10 sm:text-end sm:text-xl">
                      {formatCurrencyAmount(totalAmount, data.tokenCurrency)} {data.tokenSymbol}
                    </span>
                  </div>
                ) : null}
                <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6 sm:p-5">
                  <span className="text-base font-bold text-gray8 sm:text-lg">To</span>
                  <div className="flex flex-col gap-3 text-lg font-bold text-gray10 sm:items-end sm:text-end sm:text-xl">
                    {recipients.map((recipient) => (
                      <div
                        className="flex items-center gap-3 sm:flex-row-reverse"
                        key={recipient.recipientProviderUserId}
                      >
                        {recipient.recipientAvatarUrl ? (
                          <img
                            alt={`${formatProviderLabel(recipient)} avatar`}
                            className="size-8 rounded-lg object-cover"
                            height={32}
                            src={recipient.recipientAvatarUrl}
                            width={32}
                          />
                        ) : null}
                        <span>{formatProviderLabel(recipient)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {data.memo ? (
                  <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-5">
                    <span className="text-base font-bold text-gray8 sm:text-lg">For</span>
                    <span className="text-lg font-bold text-gray10 sm:text-end sm:text-xl">
                      {data.memo}
                    </span>
                  </div>
                ) : null}
                {skippedRecipients.length ? (
                  <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6 sm:p-5">
                    <span className="text-base font-bold text-gray8 sm:text-lg">Skipped</span>
                    <div className="text-lg font-bold text-gray10 sm:text-end sm:text-xl">
                      {skippedRecipients.map((recipient) => (
                        <div key={recipient.recipientProviderUserId}>
                          {formatProviderLabel(recipient)}{' '}
                          <span className="text-gray8">
                            ({recipient.reason === 'you' ? 'you' : 'not connected yet'})
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="space-y-4 pt-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <a
                  className="inline-flex h-12 items-center justify-center rounded-lg bg-green8 px-6 text-lg font-bold text-white no-underline transition-colors outline-none hover:bg-green7 focus-visible:ring-2 focus-visible:ring-green9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                  href={`/api/confirm/${props.token}/start`}
                >
                  Confirm payment
                </a>
                <a
                  className="inline-flex h-12 items-center justify-center rounded-lg px-6 text-lg font-bold text-blue9 no-underline transition-colors outline-none hover:bg-blue1 focus-visible:ring-2 focus-visible:ring-blue9 focus-visible:ring-offset-2 focus-visible:ring-offset-bg2 focus-visible:outline-none"
                  href="/"
                >
                  Cancel
                </a>
              </div>
              <p className="text-base text-gray9">
                {data.kind === 'reusable_access_key'
                  ? `Tipbot can send future ${data.tokenSymbol} tips from ${data.providerLabel}, up to ${formatCurrencyAmount(data.accessKeyLimit, data.tokenCurrency)} per day. You can disconnect anytime.`
                  : 'Tipbot uses this approval for this payment only, and keeps no access key.'}
              </p>
              {error ? (
                <p aria-live="polite" className="text-sm font-medium text-red9">
                  {error}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}

const getConfirmData = createServerFn({ method: 'GET' })
  .validator(z.string().check(z.minLength(1)))
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

function formatProviderLabel(input: {
  recipientProviderLabel?: string | null
  recipientProviderUserId: string
}) {
  if (!input.recipientProviderLabel) return input.recipientProviderUserId
  return `@${input.recipientProviderLabel.replace(/^@+/, '')}`
}
