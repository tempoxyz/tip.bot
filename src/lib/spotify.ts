/**
 * Thin client for the Spotify Web API, used by the `/dj` Slack command
 * to queue and skip tracks on the offsite venue laptop's Spotify Jam.
 *
 * Auth: we hold a refresh_token (one-time OAuth flow via
 * `scripts/spotify:setup.ts`) and exchange it for a short-lived access
 * token on every request. No caching yet — fine for offsite volume.
 *
 * The laptop must be:
 *   - signed into a Spotify Premium account
 *   - actively playing something (so /me/player/queue has a target)
 *   - optionally hosting a Jam (queued tracks land in the shared queue)
 */

const tokenUrl = 'https://accounts.spotify.com/api/token'
const apiBase = 'https://api.spotify.com/v1'

export type Track = {
  artist: string
  durationMs: number
  id: string
  title: string
  uri: string
  url: string
}

export type NowPlaying = {
  isPlaying: boolean
  progressMs: number
  track: Track | null
}

export async function getAccessToken(options: {
  clientId: string
  clientSecret: string
  refreshToken: string
}): Promise<string> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
    }),
  })
  if (!res.ok) throw new Error(`spotify token refresh failed: HTTP ${res.status}`)
  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) throw new Error('spotify token refresh missing access_token')
  return body.access_token
}

export async function search(options: { accessToken: string; query: string }): Promise<Track[]> {
  const url = new URL(`${apiBase}/search`)
  url.searchParams.set('q', options.query)
  url.searchParams.set('type', 'track')
  url.searchParams.set('limit', '5')
  const res = await fetch(url, { headers: { authorization: `Bearer ${options.accessToken}` } })
  if (!res.ok) return []
  const body = (await res.json()) as {
    tracks?: {
      items?: Array<{
        artists?: Array<{ name: string }>
        duration_ms?: number
        external_urls?: { spotify?: string }
        id: string
        name: string
        uri: string
      }>
    }
  }
  return (body.tracks?.items ?? []).map((item) => ({
    artist: (item.artists ?? []).map((a) => a.name).join(', '),
    durationMs: item.duration_ms ?? 0,
    id: item.id,
    title: item.name,
    uri: item.uri,
    url: item.external_urls?.spotify ?? `https://open.spotify.com/track/${item.id}`,
  }))
}

export async function trackFromUri(options: {
  accessToken: string
  uri: string
}): Promise<Track | null> {
  const id = options.uri.replace(/^spotify:track:/, '')
  const res = await fetch(`${apiBase}/tracks/${id}`, {
    headers: { authorization: `Bearer ${options.accessToken}` },
  })
  if (!res.ok) return null
  const item = (await res.json()) as {
    artists?: Array<{ name: string }>
    duration_ms?: number
    external_urls?: { spotify?: string }
    id: string
    name: string
    uri: string
  }
  return {
    artist: (item.artists ?? []).map((a) => a.name).join(', '),
    durationMs: item.duration_ms ?? 0,
    id: item.id,
    title: item.name,
    uri: item.uri,
    url: item.external_urls?.spotify ?? `https://open.spotify.com/track/${item.id}`,
  }
}

export async function addToQueue(options: {
  accessToken: string
  uri: string
}): Promise<{ ok: boolean; status: number }> {
  const url = new URL(`${apiBase}/me/player/queue`)
  url.searchParams.set('uri', options.uri)
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.accessToken}` },
  })
  return { ok: res.ok, status: res.status }
}

export async function skip(options: {
  accessToken: string
}): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${apiBase}/me/player/next`, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.accessToken}` },
  })
  return { ok: res.ok, status: res.status }
}

export async function nowPlaying(options: { accessToken: string }): Promise<NowPlaying | null> {
  const res = await fetch(`${apiBase}/me/player/currently-playing`, {
    headers: { authorization: `Bearer ${options.accessToken}` },
  })
  if (res.status === 204) return { isPlaying: false, progressMs: 0, track: null }
  if (!res.ok) return null
  const body = (await res.json()) as {
    is_playing?: boolean
    progress_ms?: number
    item?: {
      artists?: Array<{ name: string }>
      duration_ms?: number
      external_urls?: { spotify?: string }
      id: string
      name: string
      uri: string
    } | null
  }
  const item = body.item
  return {
    isPlaying: body.is_playing ?? false,
    progressMs: body.progress_ms ?? 0,
    track: item
      ? {
          artist: (item.artists ?? []).map((a) => a.name).join(', '),
          durationMs: item.duration_ms ?? 0,
          id: item.id,
          title: item.name,
          uri: item.uri,
          url: item.external_urls?.spotify ?? `https://open.spotify.com/track/${item.id}`,
        }
      : null,
  }
}

const spotifyUrlPattern =
  /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/|spotify:track:)([\w]{22})/

export function parseTrackId(input: string): string | null {
  const match = input.match(spotifyUrlPattern)
  return match?.[1] ?? null
}
