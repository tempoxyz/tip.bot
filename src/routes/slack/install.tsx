import { createFileRoute, redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'

import { createSlackInstallUrl } from '#/lib/slack.ts'

export const Route = createFileRoute('/slack/install')({
  async beforeLoad() {
    throw redirect({ href: await getSlackInstallUrl() })
  },
})

const getSlackInstallUrl = createServerFn({ method: 'GET' }).handler(async () => {
  return await createSlackInstallUrl(getRequest(), env)
})
