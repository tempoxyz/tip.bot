/**
 * Thin client for the djbox jukebox app (https://djbox.tempo.xyz).
 *
 * Used by the `/tip dj` Slack command to enqueue tracks into a djbox
 * party room. Search is unauthenticated; enqueue uses a shared bearer
 * secret (PARTYKIT_SECRET on the djbox side).
 */

export type Track = {
  artist: string
  duration: number
  id: string
  thumbnail?: string
  title: string
  url: string
}

export async function search(options: { djboxUrl: string; query: string }): Promise<Track[]> {
  const url = new URL('/api/search', options.djboxUrl)
  url.searchParams.set('q', options.query)
  const res = await fetch(url, { method: 'GET' })
  if (!res.ok) return []
  const body = (await res.json().catch(() => null)) as { tracks?: Track[] } | null
  return body?.tracks ?? []
}

export async function enqueue(options: {
  djboxUrl: string
  partyId: string
  requesterName?: string
  secret: string
  track: Track
}): Promise<{ ok: boolean; status: number }> {
  const url = new URL(`/api/parties/${encodeURIComponent(options.partyId)}/queue`, options.djboxUrl)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      requesterName: options.requesterName,
      track: options.track,
    }),
  })
  return { ok: res.ok, status: res.status }
}

export async function skip(options: {
  amountUsd: number
  bidderName?: string
  djboxUrl: string
  partyId: string
  secret: string
}): Promise<{
  cleared?: boolean
  ok: boolean
  potUsd?: number
  status: number
  thresholdUsd?: number
}> {
  const url = new URL(`/api/parties/${encodeURIComponent(options.partyId)}/skip`, options.djboxUrl)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      amountUsd: options.amountUsd,
      bidderName: options.bidderName,
    }),
  })
  if (!res.ok) return { ok: false, status: res.status }
  const json = (await res.json().catch(() => null)) as {
    cleared?: boolean
    potUsd?: number
    thresholdUsd?: number
  } | null
  return { ...json, ok: true, status: res.status }
}

const youtubeIdPattern =
  /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/))([\w-]{11})/

export function parseYouTubeId(input: string): string | null {
  const match = input.match(youtubeIdPattern)
  return match?.[1] ?? null
}

const spotifyPattern = /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/|spotify:track:)([\w]{22})/

export function parseSpotifyTrackId(input: string): string | null {
  const match = input.match(spotifyPattern)
  return match?.[1] ?? null
}

/**
 * Use Spotify's public oEmbed endpoint (no auth required) to resolve a
 * Spotify track URL into a "Title Artist" string we can search YouTube
 * with. Actual playback in djbox remains YouTube.
 */
export async function spotifyTrackToYouTubeQuery(id: string): Promise<string | null> {
  const res = await fetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`,
  )
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as {
    author_name?: string
    title?: string
  } | null
  if (!body?.title) return null
  return [body.title, body.author_name].filter(Boolean).join(' ')
}

export async function trackFromYouTubeId(id: string): Promise<Track | null> {
  // YouTube oEmbed: no API key required. Duration is not returned;
  // default to 0 (djbox falls back to client onEnded for advancement).
  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`,
  )
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as {
    author_name?: string
    thumbnail_url?: string
    title?: string
  } | null
  if (!body?.title) return null
  return {
    artist: body.author_name ?? '',
    duration: 0,
    id,
    thumbnail: body.thumbnail_url,
    title: body.title,
    url: `https://www.youtube.com/watch?v=${id}`,
  }
}
