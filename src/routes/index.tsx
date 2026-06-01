import { Link, createFileRoute } from '@tanstack/react-router'
import * as z from 'zod/mini'
import { slackBotDisplayName, tipbotImagePath } from '#/lib/app.ts'
import IconLogosSlackIcon from '~icons/logos/slack-icon.jsx'
import IconSimpleIconsX from '~icons/simple-icons/x.jsx'

function Component() {
  const search = Route.useSearch()
  return (
    <main className="min-h-screen bg-bg2 px-6 py-12 text-gray10">
      <section className="mx-auto flex max-w-6xl flex-col gap-10 lg:min-h-[calc(100vh-6rem)] lg:justify-center">
        <div className="mx-auto max-w-3xl space-y-4 text-center">
          <h1 className="text-5xl font-bold tracking-[-0.04em] text-gray10 sm:text-6xl">Tipbot</h1>
          <p className="text-2xl font-semibold leading-tight tracking-[-0.03em] text-gray10 sm:text-3xl">
            Chat-native stablecoin micropayments.
          </p>
          <p className="text-lg leading-8 text-gray9">
            Mention <span className="font-semibold text-gray10">@{slackBotDisplayName}</span> in
            Slack or{' '}
            <a
              className="font-semibold text-gray10 transition hover:text-blue9"
              href="https://x.com/tipbotgg"
              rel="noreferrer"
              target="_blank"
            >
              @tipbotgg
            </a>{' '}
            on X to tip someone.
            <br className="hidden sm:block" /> The payment status and receipt stay right in the
            conversation.
          </p>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col items-center gap-4">
            {search.slack === 'installed' ? (
              <p
                className="inline-flex h-12 items-center gap-2 rounded-lg border border-green6 bg-green1 px-4 text-base font-semibold text-gray10"
                role="status"
              >
                <IconLucideCheck aria-hidden="true" className="size-5 shrink-0" />
                Installed{search.team ? ` for ${search.team}` : ''}
              </p>
            ) : (
              <a
                className="inline-flex h-12 items-center justify-center gap-3 rounded-lg border border-gray5 bg-bg1 px-4 text-base font-semibold leading-none text-gray10 no-underline shadow-sm transition hover:bg-gray1 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9"
                href="/install/slack"
              >
                <IconLogosSlackIcon aria-hidden="true" className="size-7" />
                Add to Slack
              </a>
            )}
            <p className="text-center text-sm font-medium text-gray8">
              Slack: `@{slackBotDisplayName} @account $5 for coffee`
            </p>
            <div className="h-[23.5rem] w-full overflow-hidden rounded-xl border border-gray4 bg-bg1 shadow-xl shadow-gray-a2">
              <div className="grid h-full grid-cols-[7rem_1fr] sm:grid-cols-[10rem_1fr]">
                <aside className="bg-purple3 p-4 text-purple10">
                  <div className="mb-5 font-bold">tipbot</div>
                  <div className="space-y-1 text-sm font-medium text-purple10/70">
                    <div className="rounded bg-purple5 px-2 py-1.5 text-purple10"># general</div>
                    <div className="px-2 py-1.5"># wins</div>
                    <div className="px-2 py-1.5"># coffee</div>
                  </div>
                </aside>
                <div className="flex min-w-0 flex-col">
                  <header className="border-b border-gray4 px-5 py-4">
                    <div className="font-bold text-gray10"># general</div>
                    <div className="text-sm text-gray8">Stablecoin tips in Slack</div>
                  </header>
                  <div className="flex-1 space-y-5 p-5">
                    <div className="flex gap-3">
                      <img
                        alt="gakonst"
                        className="size-10 shrink-0 rounded-md object-cover"
                        height={40}
                        src="/slack-user.jpg"
                        width={40}
                      />
                      <div>
                        <div className="font-semibold text-gray10">
                          gakonst <span className="font-normal text-gray8">10:28 AM</span>
                        </div>
                        <p className="text-gray10">
                          <span className="rounded bg-blue2 px-1 font-medium text-blue10">
                            @{slackBotDisplayName}
                          </span>{' '}
                          <span className="rounded bg-blue2 px-1 font-medium text-blue10">
                            @jxom
                          </span>{' '}
                          $5 for coffee
                        </p>
                      </div>
                    </div>
                    <div className="ms-8 flex gap-3 rounded-lg border border-gray4 bg-bg2 p-4 sm:ms-12">
                      <img
                        alt="Tipbot"
                        className="size-10 shrink-0 rounded-md object-cover"
                        height={40}
                        src={tipbotImagePath}
                        width={40}
                      />
                      <div className="min-w-0">
                        <div className="font-semibold text-gray10">
                          {slackBotDisplayName}{' '}
                          <span className="rounded bg-gray2 px-1 text-xs text-gray8">APP</span>
                        </div>
                        <p className="text-gray9">
                          <span className="rounded bg-blue2 px-1 font-medium text-blue10">
                            @gakonst
                          </span>{' '}
                          sent{' '}
                          <span className="rounded bg-blue2 px-1 font-medium text-blue10">
                            @jxom
                          </span>{' '}
                          $5 for coffee
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="border-t border-gray4 p-4">
                    <div className="rounded-lg border border-gray5 px-4 py-3 text-gray8">
                      Message #general
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-col items-center gap-4">
            <Link
              className="inline-flex h-12 items-center justify-center gap-3 rounded-lg border border-gray5 bg-bg1 px-4 text-base font-semibold leading-none text-gray10 no-underline shadow-sm transition hover:bg-gray1 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9"
              to="/link/x"
            >
              <IconSimpleIconsX aria-hidden="true" className="size-5" />
              Connect X
            </Link>
            <p className="text-center text-sm font-medium text-gray8">
              X: `@tipbotgg @account $5 for coffee`
            </p>
            <div className="h-[23.5rem] w-full overflow-hidden rounded-xl border border-gray4 bg-bg1 shadow-xl shadow-gray-a2">
              <div className="space-y-0 divide-y divide-gray4">
                <div className="flex gap-3 p-5">
                  <img
                    alt="awkweb"
                    className="size-10 shrink-0 rounded-full object-cover"
                    height={40}
                    src="/awkweb.jpg"
                    width={40}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-gray10">awkweb</span>
                      <span className="truncate text-gray8">@awkweb</span>
                      <span className="text-gray8">· now</span>
                    </div>
                    <p className="mt-1 text-gray10">
                      <span className="text-blue9">@tipbotgg</span>{' '}
                      <span className="text-blue9">@jxom</span> $5 for coffee
                    </p>
                  </div>
                </div>
                <div className="flex gap-3 p-5">
                  <img
                    alt="Tipbot"
                    className="size-10 shrink-0 rounded-full object-cover"
                    height={40}
                    src={tipbotImagePath}
                    width={40}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-gray10">Tipbot</span>
                      <span className="truncate text-gray8">@tipbotgg</span>
                      <span className="text-gray8">· now</span>
                    </div>
                    <p className="mt-1 text-gray10">
                      <span className="text-blue9">@jxom</span> got $5 from{' '}
                      <span className="text-blue9">@awkweb</span> for coffee
                    </p>
                  </div>
                </div>
                <div className="flex gap-3 p-5">
                  <img
                    alt="jxom"
                    className="size-10 shrink-0 rounded-full object-cover"
                    height={40}
                    src="/jxom.jpg"
                    width={40}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-gray10">jxom</span>
                      <span className="truncate text-gray8">@_jxom</span>
                      <span className="text-gray8">· 2m</span>
                    </div>
                    <p className="mt-1 text-gray10">
                      <span className="text-blue9">@tipbotgg</span>{' '}
                      <span className="text-blue9">@awkweb</span> $0.01 for shipping
                    </p>
                  </div>
                </div>
                <div className="flex gap-3 p-5">
                  <img
                    alt="Tipbot"
                    className="size-10 shrink-0 rounded-full object-cover"
                    height={40}
                    src={tipbotImagePath}
                    width={40}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-gray10">Tipbot</span>
                      <span className="truncate text-gray8">@tipbotgg</span>
                      <span className="text-gray8">· 2m</span>
                    </div>
                    <p className="mt-1 text-gray10">
                      <span className="text-blue9">@awkweb</span> got $0.01 from{' '}
                      <span className="text-blue9">@_jxom</span> for shipping
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <footer className="mx-auto mt-10 max-w-6xl text-center text-sm font-medium text-gray8">
        <a
          className="transition hover:text-blue9"
          href="https://x.com/tipbotgg"
          rel="noreferrer"
          target="_blank"
        >
          Follow @tipbotgg
        </a>
      </footer>
    </main>
  )
}

export const Route = createFileRoute('/')({
  component: Component,
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
  validateSearch: z.object({
    slack: z.optional(z.literal('installed')),
    team: z.optional(z.string()),
  }),
})
