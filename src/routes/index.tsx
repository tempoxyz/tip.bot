import { createFileRoute } from '@tanstack/react-router'
import { rpc } from '#/lib/rpc.ts'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      {
        content: __SLACK_APP_ID__,
        name: 'slack-app-id',
      },
      {
        title: 'Tipbot - Chat-native stablecoin micropayments',
      },
    ],
  }),
  component: Component,
})

function Component() {
  return (
    <main>
      <section>
        <img
          alt="Tipbot"
          className="size-32 rounded-[22px] object-cover shadow-[0_1px_0_#00000066] sm:size-40"
          height={160}
          src="/tipbot.png"
          width={160}
        />
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold leading-none tracking-[-0.04em]">Tipbot</h1>
          <span className="rounded px-1.5 py-1 text-base font-bold leading-none tracking-[-0.04em]">
            APP
          </span>
          <span aria-label="Online" className="size-4 rounded-full bg-[#25c489]" role="status" />
        </div>
        <a
          className="mt-4 inline-flex h-14 items-center gap-3 rounded-lg border-2 px-4 text-xl font-bold leading-none tracking-[-0.035em] no-underline transition focus-visible:outline-offset-4 focus-visible:outline-[#36c5f0] sm:h-16 sm:gap-3.5 sm:px-5 sm:text-2xl"
          href={rpc.api.chat.slack.install.$url().pathname}
        >
          <IconSimpleIconsSlack aria-hidden="true" className="size-8 sm:size-10" />
          Add to Slack
        </a>
      </section>
    </main>
  )
}
