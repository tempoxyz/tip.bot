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
      data-regen-color="blue"
      data-regen-radius="large"
      className="grid min-h-screen place-items-center bg-background p-[24px] text-foreground"
    >
      <section className="grid w-[min(100%,28rem)] gap-[14px] rounded-body border border-border bg-surface p-[24px]">
        <p className="label-13 text-foreground-secondary">404</p>
        <h1 className="heading-32 text-foreground">Page not found.</h1>
        <p className="copy-14 text-foreground-secondary">
          The page you’re looking for doesn’t exist.
        </p>
        <Link
          className="button-14 inline-flex h-[40px] w-fit items-center justify-center rounded-button bg-accent px-[16px] text-on-accent no-underline hover:bg-accent-hover active:bg-accent-active focus-visible:outline focus-visible:outline-[2px] focus-visible:outline-offset-[2px] focus-visible:outline-focus"
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
    <html data-regen-color="blue" data-regen-radius="large" lang="en" suppressHydrationWarning>
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
