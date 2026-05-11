import { createFileRoute } from '@tanstack/react-router'
import IconLogosSlackIcon from '~icons/logos/slack-icon.jsx'

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
    <main className="min-h-screen bg-bg2 px-6 py-12 text-gray10">
      <section className="mx-auto flex min-h-[calc(100vh-6rem)] max-w-sm flex-col items-center justify-center gap-6 text-center">
        <img
          alt="Tipbot"
          className="size-28 rounded-3xl object-cover shadow-lg sm:size-36"
          height={160}
          src="/tipbot.png"
          width={160}
        />
        <div className="flex items-center justify-center gap-2">
          <h1 className="text-3xl font-bold leading-none text-gray10 sm:text-4xl">Tipbot</h1>
          <span className="rounded bg-gray2 px-1.5 py-1 text-xl font-medium leading-none text-gray9 sm:text-2xl">
            APP
          </span>
          <span
            aria-label="Online"
            className="ms-1.5 size-4 rounded-full bg-green9"
            role="status"
          />
        </div>
        <a
          className="inline-flex h-14 items-center justify-center gap-3 rounded-xl border-2 border-gray5 px-4 text-xl font-bold leading-none no-underline transition hover:bg-gray1 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9 sm:h-16 sm:px-5 sm:text-2xl"
          href="/install/slack"
        >
          <IconLogosSlackIcon aria-hidden="true" className="size-8 sm:size-10" />
          Add to Slack
        </a>
      </section>
    </main>
  )
}
