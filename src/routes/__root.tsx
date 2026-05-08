import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import type React from 'react'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Tip',
      },
    ],
    links: [
      {
        rel: 'icon',
        href: '/tipbot.png',
        type: 'image/png',
      },
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  component: Root,
  notFoundComponent: NotFound,
})

function Root() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function NotFound() {
  return (
    <main
      className="grid min-h-screen place-items-center bg-[var(--tipbot-bg)] p-8 text-[var(--tipbot-text)]"
      data-tipbot-home
    >
      <section className="grid w-[min(100%,28rem)] gap-4 rounded-2xl border border-[var(--tipbot-card-border)] bg-[var(--tipbot-card-bg)] p-6 shadow-[0_1px_0_#0000001f]">
        <p className="text-sm font-bold uppercase tracking-[0.12em] text-[var(--tipbot-muted)]">
          404
        </p>
        <h1 className="text-3xl font-bold leading-tight tracking-[-0.04em] text-[var(--tipbot-text)]">
          Page not found.
        </h1>
        <p className="text-[15px] leading-6 text-[var(--tipbot-muted)]">
          The page you’re looking for doesn’t exist.
        </p>
        <Link
          className="inline-flex h-10 w-fit items-center justify-center rounded-lg bg-[var(--tipbot-text)] px-4 text-sm font-bold leading-none text-[var(--tipbot-bg)] no-underline transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#36c5f0]"
          to="/"
        >
          Go home
        </Link>
      </section>
    </main>
  )
}

function RootDocument(props: React.PropsWithChildren) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  )
}
