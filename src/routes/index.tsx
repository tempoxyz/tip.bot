import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      {
        title: 'Tipbot - Chat-native stablecoin micropayments',
      },
    ],
  }),
  component: Component,
})

function Component() {
  return (
    <main
      className="grid min-h-screen place-items-center bg-[var(--tipbot-bg)] p-8 text-[color:var(--tipbot-text)]"
      data-tipbot-home
    >
      <section className="grid justify-items-center gap-5">
        <img
          alt="Tipbot"
          className="size-32 rounded-[22px] object-cover shadow-[0_1px_0_#00000066] sm:size-40"
          height={160}
          src="/tipbot.png"
          width={160}
        />
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold leading-none tracking-[-0.04em] text-[color:var(--tipbot-text)]">
            Tipbot
          </h1>
          <span className="rounded bg-[var(--tipbot-badge-bg)] px-1.5 py-1 text-base font-bold leading-none tracking-[-0.04em] text-[color:var(--tipbot-badge-text)]">
            APP
          </span>
          <span aria-label="Online" className="size-4 rounded-full bg-[#25c489]" role="status" />
        </div>
        <Link
          className="mt-4 inline-flex h-14 items-center gap-3 rounded-lg border-2 border-[var(--tipbot-button-border)] bg-[var(--tipbot-button-bg)] px-4 text-xl font-bold leading-none tracking-[-0.035em] text-[color:var(--tipbot-button-text)] no-underline transition hover:border-[var(--tipbot-button-border-hover)] hover:bg-[var(--tipbot-button-bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#36c5f0] sm:h-16 sm:gap-3.5 sm:px-5 sm:text-2xl"
          to="/slack/install"
        >
          <IconSimpleIconsSlack
            aria-hidden="true"
            className="size-8 text-[color:var(--tipbot-slack-icon)] sm:size-10"
          />
          Add to Slack
        </Link>
      </section>
    </main>
  )
}
