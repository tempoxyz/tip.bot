/**
 * One-time Spotify OAuth setup. Captures a refresh token for the
 * laptop's Premium account, which tip.bot then uses to queue and skip
 * tracks via the Web API.
 *
 * Usage (in this repo):
 *
 *   SPOTIFY_CLIENT_ID=... \
 *   SPOTIFY_CLIENT_SECRET=... \
 *     node scripts/spotify:setup.ts
 *
 * Walks you through:
 *   1. Open a Spotify authorize URL in your browser
 *   2. Sign in with the venue's Premium account, click Allow
 *   3. Captures the callback on http://localhost:8765/callback
 *   4. Exchanges the auth code for a long-lived refresh token
 *   5. Prints the token + the wrangler command to store it
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const clientId = process.env.SPOTIFY_CLIENT_ID
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error('Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET.')
  console.error('Set both env vars (from your Spotify Developer dashboard) and rerun.')
  process.exit(1)
}

const redirectUri = 'http://localhost:8765/callback'
const scopes = [
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-playback-state',
].join(' ')
const state = randomBytes(16).toString('hex')

const authorizeUrl = new URL('https://accounts.spotify.com/authorize')
authorizeUrl.searchParams.set('client_id', clientId)
authorizeUrl.searchParams.set('redirect_uri', redirectUri)
authorizeUrl.searchParams.set('response_type', 'code')
authorizeUrl.searchParams.set('scope', scopes)
authorizeUrl.searchParams.set('state', state)

console.log('')
console.log('Open this URL in the browser logged into the venue Spotify account:')
console.log('')
console.log(`  ${authorizeUrl.toString()}`)
console.log('')
console.log('Waiting for callback on http://localhost:8765/callback ...')

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404).end()
    return
  }

  const url = new URL(req.url, redirectUri)
  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end(`Spotify error: ${error}`)
    console.error(`Spotify returned error: ${error}`)
    server.close()
    process.exit(1)
  }

  if (returnedState !== state) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('State mismatch')
    console.error('State mismatch — possible CSRF, aborting.')
    server.close()
    process.exit(1)
  }

  if (!code) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing code')
    server.close()
    process.exit(1)
  }

  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })

  if (!tokenRes.ok) {
    const text = await tokenRes.text()
    res.writeHead(500, { 'content-type': 'text/plain' }).end(`Token exchange failed: ${text}`)
    console.error(`Token exchange failed: HTTP ${tokenRes.status} ${text}`)
    server.close()
    process.exit(1)
  }

  const body = (await tokenRes.json()) as {
    access_token: string
    expires_in: number
    refresh_token: string
    scope: string
  }

  res
    .writeHead(200, { 'content-type': 'text/html' })
    .end('<h1>All set. You can close this tab.</h1>')

  console.log('')
  console.log('Got refresh token. Store it as a wrangler secret:')
  console.log('')
  console.log('  pnpm wrangler secret put SPOTIFY_REFRESH_TOKEN')
  console.log('  # paste this when prompted:')
  console.log('')
  console.log(`  ${body.refresh_token}`)
  console.log('')
  console.log("Also store the client id/secret if you haven't:")
  console.log('  pnpm wrangler secret put SPOTIFY_CLIENT_ID')
  console.log('  pnpm wrangler secret put SPOTIFY_CLIENT_SECRET')
  console.log('')

  server.close()
})

server.listen(8765, '127.0.0.1')
