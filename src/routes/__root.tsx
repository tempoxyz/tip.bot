import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import type * as React from 'react'
import { tipbotImagePath } from '#/lib/app.ts'
import '../styles.css'

const siteDescription = 'Chat-native stablecoin micropayments for Slack and X.'
const siteImageUrl = new URL('/og.png', __ORIGIN__).toString()
const siteName = 'Tipbot'
const siteUrl = new URL('/', __ORIGIN__).toString()
const twitterBotHandle = `@${__TWITTER_BOT_HANDLE__.replace(/^@+/, '')}`

export const Route = createRootRoute({
  head() {
    return {
      links: [
        { href: '/tipbot-app-icon.png', rel: 'apple-touch-icon' },
        { href: tipbotImagePath, rel: 'icon', type: 'image/png' },
      ],
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { content: siteDescription, name: 'description' },
        {
          content: __ENV__ === 'production' ? 'index, follow' : 'noindex, nofollow',
          name: 'robots',
        },
        { content: '#111111', name: 'theme-color' },
        { content: siteDescription, property: 'og:description' },
        { content: siteImageUrl, property: 'og:image' },
        { content: '630', property: 'og:image:height' },
        { content: '1200', property: 'og:image:width' },
        { content: siteName, property: 'og:site_name' },
        { content: siteName, property: 'og:title' },
        { content: 'website', property: 'og:type' },
        { content: siteUrl, property: 'og:url' },
        { content: 'summary_large_image', name: 'twitter:card' },
        { content: twitterBotHandle, name: 'twitter:creator' },
        { content: siteDescription, name: 'twitter:description' },
        { content: siteImageUrl, name: 'twitter:image' },
        { content: twitterBotHandle, name: 'twitter:site' },
        { content: siteName, name: 'twitter:title' },
        { title: siteName },
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
