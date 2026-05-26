import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import type * as React from 'react'
import { tipbotImagePath } from '#/lib/app.ts'
import '../styles.css'

export const Route = createRootRoute({
  head() {
    return {
      links: [{ rel: 'icon', href: tipbotImagePath, type: 'image/png' }],
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { title: 'Tipbot' },
      ],
    }
  },
  component: Component,
  notFoundComponent: NotFound,
})

function Component() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function NotFound() {
  return (
    <main>
      <section>
        <p>404</p>
        <h1>Page not found.</h1>
        <Link to="/">Go home</Link>
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
