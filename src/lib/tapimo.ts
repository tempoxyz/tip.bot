import '@tanstack/react-start/server-only'
import { env } from 'cloudflare:workers'
import { Client } from 'tapimo'

export const client = Client.create({
  apiKey: env.TEMPO_API_KEY,
})
