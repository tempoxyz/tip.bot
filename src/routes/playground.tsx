import { Select } from '@base-ui/react/select'
import { Tabs } from '@base-ui/react/tabs'
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import * as React from 'react'
import * as z from 'zod/mini'
import * as DB from '#db/client.ts'
import { api } from '#/api.ts'
import * as Chat from '#/chat.ts'
import { createSlackHeaders } from '#/lib/slack.ts'

export const Route = createFileRoute('/playground')({
  component: Component,
  head: () => ({ meta: [{ title: 'Playground - Tipbot' }] }),
  async loader(options) {
    if (__ENV__ !== 'development') return null
    return await getEmulateWorkspaceState({ data: options.deps })
  },
  loaderDeps(options) {
    const search = withSearchDefaults(options.search)
    return {
      actor: search.actor,
      channel: search.channel,
      provider: search.provider,
      workspace: search.workspace,
    }
  },
  validateSearch: z.object({
    actor: z.optional(z.string()),
    channel: z.optional(z.string()),
    provider: z.optional(z.literal('slack')),
    workspace: z.optional(z.string()),
  }),
})

const defaultActors: EmulateActor[] = [
  { id: 'U000000001', label: 'admin' },
  { id: 'U000000002', label: 'member' },
]

const slackDefaults = {
  adminUserId: 'U000000001',
  botToken: 'xoxb-test',
  botUserId: 'B000000001',
  channelId: 'C000000001',
  teamId: 'T000000001',
  teamName: 'Emulate',
} as const

const defaultChannels = [
  { description: 'General discussion', id: slackDefaults.channelId, label: 'general' },
  { description: 'Random discussion', id: 'C000000002', label: 'random' },
]

const defaultProviders: readonly { id: 'slack'; label: string }[] = [
  { id: 'slack', label: 'Slack' },
]

function Component() {
  const loaderData = Route.useLoaderData()
  const navigate = Route.useNavigate()
  const search = withSearchDefaults(Route.useSearch())
  const [data, setData] = React.useState<EmulateWorkspaceState | null>(loaderData)
  const [error, setError] = React.useState<string | null>(null)
  const [text, setText] = React.useState('')
  const [status, setStatus] = React.useState<'idle' | 'installing' | 'loading' | 'sending'>('idle')

  React.useEffect(() => {
    setData(loaderData)
    setError(null)
  }, [loaderData])

  const provider = defaultProviders.find((item) => item.id === search.provider)?.id ?? 'slack'
  const workspace =
    search.workspace === slackDefaults.teamId ? search.workspace : slackDefaults.teamId
  const channelItems = defaultChannels
  const channel =
    channelItems.find((item) => item.id === search.channel)?.id ??
    channelItems[0]?.id ??
    slackDefaults.channelId
  const availableActors = data?.actors ?? defaultActors
  const actor = availableActors.some((item) => item.id === search.actor)
    ? search.actor
    : (availableActors[0]?.id ?? slackDefaults.adminUserId)
  const actorItems = availableActors

  React.useEffect(() => {
    const next: Partial<EmulateSearch> = {}
    if (actor !== search.actor) next.actor = actor
    if (channel !== search.channel) next.channel = channel
    if (provider !== search.provider) next.provider = provider
    if (workspace !== search.workspace) next.workspace = workspace
    if (Object.keys(next).length > 0) updateSearch(next)
  }, [
    actor,
    channel,
    provider,
    search.actor,
    search.channel,
    search.provider,
    search.workspace,
    workspace,
  ])

  React.useEffect(() => {
    async function refresh() {
      if (document.visibilityState !== 'visible') return
      setData(await getEmulateWorkspaceState({ data: { actor, channel, provider, workspace } }))
    }

    function onFocus() {
      void refresh().catch(() => {})
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') void refresh().catch(() => {})
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [actor, channel, provider, workspace])

  if (__ENV__ !== 'development')
    return (
      <main className="min-h-screen bg-background-2 px-6 py-12 text-gray10">
        <section className="mx-auto max-w-3xl rounded-xl border border-gray-alpha3 p-6">
          <p className="font-medium text-gray9">Development only</p>
          <h1 className="mt-2 font-bold">Workspace emulator unavailable</h1>
          <p className="mt-3 text-gray9">This page is not available in production.</p>
        </section>
      </main>
    )

  async function install() {
    setStatus('installing')
    setError(null)
    try {
      setData(
        await installEmulateWorkspace({ data: { ...search, actor, channel, provider, workspace } }),
      )
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not install emulator workspace.')
    } finally {
      setStatus('idle')
    }
  }

  async function send() {
    const trimmedText = text.trim()
    if (!trimmedText) return

    setStatus('sending')
    setError(null)
    try {
      const requestSearch = { ...search, actor, channel, provider, workspace }
      setData(
        await (isTipCommand(trimmedText)
          ? sendEmulateCommand({
              data: { ...requestSearch, text: trimmedText.replace(/^\/tip(?:\s+|$)/, '') },
            })
          : isTipbotMention(trimmedText)
            ? sendEmulateMention({ data: { ...requestSearch, text: trimmedText } })
            : sendEmulateMessage({ data: { ...requestSearch, text: trimmedText } })),
      )
      setText('')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not send message.')
    } finally {
      setStatus('idle')
    }
  }

  function updateSearch(next: Partial<EmulateSearch>) {
    void navigate({
      search: (previous) => ({ ...previous, ...next }),
    })
  }

  const channelName = getOptionLabel(channelItems, channel)
  const channelDescription =
    defaultChannels.find((item) => item.id === channel)?.description ?? `${channelName} channel`
  const showProviderSelect = defaultProviders.length > 1
  const shortcutCommands = getShortcutCommands(
    actor,
    actorItems.find((item) => item.id !== actor)?.id ?? actor,
  )
  const messageGroups = (data?.transcript ?? []).reduceRight<
    {
      actor: string
      id: string
      isBot: boolean
      kind: EmulateMessage['kind']
      messages: EmulateMessage[]
      time: string
    }[]
  >((groups, message) => {
    const previous = groups.at(-1)
    if (
      previous?.actor === message.actor &&
      previous.isBot === message.isBot &&
      previous.kind === message.kind
    ) {
      previous.messages.push(message)
      return groups
    }
    groups.push({
      actor: message.actor,
      id: message.id,
      isBot: message.isBot,
      kind: message.kind,
      messages: [message],
      time: message.time,
    })
    return groups
  }, [])

  return (
    <main className="h-screen bg-background-2 text-gray10">
      <div className="mx-auto grid h-full w-full max-w-6xl gap-12 px-8 py-10 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <aside className="hidden min-h-0 flex-col bg-background-2 lg:flex">
          {showProviderSelect ? (
            <div>
              <BaseSelect
                label="Provider"
                onValueChange={(value) => updateSearch({ provider: value as 'slack' })}
                options={defaultProviders}
                value={provider}
              />
            </div>
          ) : null}

          <div
            className="min-h-0 flex-1 overflow-auto data-[has-provider]:mt-5"
            data-has-provider={showProviderSelect ? '' : undefined}
          >
            <SidebarList
              label="Channels"
              onValueChange={(value) => updateSearch({ channel: value })}
              options={channelItems}
              value={channel}
            />
          </div>
        </aside>

        <section className="flex min-h-0 flex-col bg-background-2">
          <header className="pb-3">
            <div>
              <div className="flex min-w-0 items-center">
                <div className="min-w-0">
                  <h2 className="hidden truncate text-2xl font-bold tracking-tight lg:block">
                    {channelName}
                  </h2>
                  <MobileChannelSelect
                    onValueChange={(value) => updateSearch({ channel: value })}
                    options={channelItems}
                    value={channel}
                  />
                  <p className="text-sm font-medium text-gray9">
                    {channelDescription} - {data?.app.members.length ?? actorItems.length} members
                  </p>
                </div>
              </div>
            </div>
          </header>

          {error ? (
            <p className="m-4 rounded-lg border border-amber6 bg-amber1 px-4 py-3 font-medium text-amber9">
              {error}
            </p>
          ) : null}

          <div className="minimal-scrollbar min-h-0 flex-1 overflow-auto">
            {(data?.transcript ?? []).length === 0 ? (
              <div className="flex justify-center pt-8 text-gray9">
                <div className="grid justify-items-center gap-3 text-center">
                  <p>
                    {data?.app.workspace
                      ? 'No messages yet. Send a command.'
                      : 'No messages yet. Install, then send a command.'}
                  </p>
                  {data?.app.workspace ? null : (
                    <button
                      className="h-9 rounded-md bg-gray10 px-4 font-medium text-bg2 disabled:opacity-60"
                      disabled={status === 'installing'}
                      onClick={install}
                      type="button"
                    >
                      {status === 'installing' ? 'Installing' : 'Install'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col">
                {messageGroups.map((group) => (
                  <article
                    className="flex gap-3 px-3 py-2 data-[ephemeral]:bg-gray-alpha1"
                    data-ephemeral={group.kind === 'ephemeral' ? '' : undefined}
                    key={group.id}
                  >
                    {group.isBot ? (
                      <img
                        alt="Tipbot"
                        className="size-9 shrink-0 rounded-md object-cover"
                        height={32}
                        src="/tipbot.png"
                        width={32}
                      />
                    ) : (
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-gray1 font-medium text-gray10">
                        {getActorInitial(group.actor, actorItems)}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold">{getActorName(group.actor, actorItems)}</span>
                        {group.isBot ? (
                          <span className="rounded bg-gray1 px-1 text-xs font-medium text-gray9">
                            APP
                          </span>
                        ) : null}
                        <span className="text-sm text-gray9">{group.time}</span>
                      </div>
                      {group.messages.map((message) => (
                        <div className="mt-1" key={message.id}>
                          {group.kind === 'ephemeral' ? (
                            <div className="mb-1 flex items-center gap-2 text-sm font-medium text-gray9">
                              <IconLucideEye aria-hidden="true" className="size-4" />
                              <span>Only visible to you</span>
                            </div>
                          ) : null}
                          <p className="whitespace-pre-wrap break-words leading-6 text-gray10">
                            <LinkedText actorItems={actorItems} text={message.text} />
                          </p>
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          <form
            className="bg-background-2"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <div className="relative rounded-xl border border-gray-alpha3 bg-background-2 p-2">
              <div className="absolute end-2 top-2 z-10">
                <ActorSelect
                  onValueChange={(value) => updateSearch({ actor: value })}
                  options={actorItems}
                  value={actor}
                />
              </div>
              <textarea
                className="min-h-20 w-full resize-none bg-transparent p-1 pe-28 font-mono text-gray10 outline-none placeholder:text-gray8"
                onChange={(event) => setText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (!event.metaKey || event.key !== 'Enter') return
                  event.preventDefault()
                  if (status !== 'sending') void send()
                }}
                placeholder={`Message #${channelName}`}
                value={text}
              />
              <div className="mt-3 flex items-end gap-3">
                <div className="flex min-w-0 max-w-[72rem] flex-1 flex-wrap items-center gap-2">
                  {shortcutCommands.map((shortcut) => (
                    <button
                      className="shrink-0 rounded-full bg-gray1 px-3 py-1.5 text-sm font-medium text-gray10 hover:bg-gray2"
                      key={shortcut.text}
                      onClick={() => setText(shortcut.text)}
                      type="button"
                    >
                      {shortcut.label}
                    </button>
                  ))}
                </div>
                <button
                  className="shrink-0 rounded-md bg-gray10 px-3 py-1.5 text-sm font-medium text-bg2 disabled:opacity-60"
                  disabled={status === 'sending'}
                  type="submit"
                >
                  Send
                </button>
              </div>
            </div>
          </form>
        </section>
      </div>
    </main>
  )
}

const getEmulateWorkspaceState = createServerFn({ method: 'GET' })
  .inputValidator((input: EmulateSearch) => withSearchDefaults(input))
  .handler(async ({ data }) => {
    const [actors, app, transcript] = await Promise.all([
      getSlackActors(),
      getAppState(data),
      getSlackTranscript(data),
    ])
    return {
      actors,
      app,
      diagnostics: getDiagnostics(),
      lastCommand: null,
      transcript,
    } satisfies EmulateWorkspaceState
  })

function BaseSelect(props: {
  label: string
  onValueChange: (value: string) => void
  options: readonly { id: string; label: string }[]
  value: string
}) {
  return (
    <Select.Root
      items={props.options.map((option) => ({ label: option.label, value: option.id }))}
      onValueChange={(value) => {
        if (typeof value === 'string') props.onValueChange(value)
      }}
      value={props.value}
    >
      <Select.Trigger
        aria-label={props.label}
        className="inline-flex h-9 items-center gap-2 rounded-md bg-background-2 px-1 text-start font-medium text-gray10 hover:text-gray9"
      >
        <Select.Value />
        <Select.Icon className="text-gray9">
          <IconLucideChevronsUpDown aria-hidden="true" className="size-4" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="z-50" sideOffset={6}>
          <Select.Popup className="min-w-(--anchor-width) rounded-md border border-gray-alpha3 bg-background-2 p-1 shadow-lg outline-none">
            {props.options.map((option) => (
              <Select.Item
                className="cursor-default rounded px-3 py-2 text-gray10 outline-none data-[highlighted]:bg-gray1 data-[selected]:font-medium"
                key={option.id}
                value={option.id}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

function ActorSelect(props: {
  onValueChange: (value: string) => void
  options: readonly { id: string; label: string }[]
  value: string
}) {
  const selected = props.options.find((option) => option.id === props.value) ?? {
    id: props.value,
    label: props.value,
  }
  return (
    <Select.Root
      items={props.options.map((option) => ({ label: option.label, value: option.id }))}
      modal={false}
      onValueChange={(value) => {
        if (typeof value === 'string') props.onValueChange(value)
      }}
      value={props.value}
    >
      <Select.Trigger
        aria-label="Actor"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-gray-alpha2 px-2 pe-2.5 text-sm font-medium text-gray10 hover:bg-gray-alpha3"
      >
        <span className="flex size-5 items-center justify-center rounded-full bg-gray-alpha3 text-xs">
          {getActorInitial(selected.id, props.options)}
        </span>
        <span>{selected.label}</span>
        <Select.Icon className="text-gray9">
          <IconLucideChevronDown aria-hidden="true" className="size-3.5" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          align="end"
          alignItemWithTrigger={false}
          className="z-50"
          positionMethod="fixed"
          sideOffset={6}
        >
          <Select.Popup className="min-w-(--anchor-width) rounded-md border border-gray-alpha3 bg-background-2 p-1 shadow-lg outline-none">
            {props.options.map((option) => (
              <Select.Item
                className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm text-gray10 outline-none data-[highlighted]:bg-gray1 data-[selected]:font-medium"
                key={option.id}
                value={option.id}
              >
                <span className="flex size-5 items-center justify-center rounded-full bg-gray1 text-xs">
                  {getActorInitial(option.id, props.options)}
                </span>
                <Select.ItemText>{option.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

function MobileChannelSelect(props: {
  onValueChange: (value: string) => void
  options: readonly { id: string; label: string }[]
  value: string
}) {
  const selected = props.options.find((option) => option.id === props.value) ?? {
    id: props.value,
    label: props.value,
  }
  return (
    <Select.Root
      items={props.options.map((option) => ({ label: option.label, value: option.id }))}
      modal={false}
      onValueChange={(value) => {
        if (typeof value === 'string') props.onValueChange(value)
      }}
      value={props.value}
    >
      <Select.Trigger
        aria-label="Channel"
        className="inline-flex items-center gap-2 rounded-md bg-background-2 font-bold tracking-tight hover:text-gray9 lg:hidden"
      >
        <span># {selected.label}</span>
        <Select.Icon className="text-gray9">
          <IconLucideChevronDown aria-hidden="true" className="size-4" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          align="start"
          alignItemWithTrigger={false}
          className="z-50"
          positionMethod="fixed"
          sideOffset={8}
        >
          <Select.Popup className="min-w-(--anchor-width) rounded-md border border-gray-alpha3 bg-background-2 p-1 shadow-lg outline-none">
            {props.options.map((option) => (
              <Select.Item
                className="cursor-default rounded px-3 py-2 text-gray10 outline-none data-[highlighted]:bg-gray1 data-[selected]:font-bold"
                key={option.id}
                value={option.id}
              >
                <Select.ItemText># {option.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

function SidebarList(props: {
  label: string
  onValueChange: (value: string) => void
  options: readonly { id: string; label: string }[]
  value: string
}) {
  return (
    <Tabs.Root
      onValueChange={(value) => {
        if (typeof value === 'string') props.onValueChange(value)
      }}
      orientation="vertical"
      value={props.value}
    >
      <Tabs.List activateOnFocus className="grid px-1">
        {props.options.map((option) => (
          <Tabs.Tab
            className="bg-transparent px-1 py-1 text-start font-normal text-gray9 hover:text-gray10 data-[active]:bg-transparent data-[active]:font-medium data-[active]:text-gray10 data-[selected]:bg-transparent"
            key={option.id}
            value={option.id}
          >
            <span>{props.label === 'Channels' ? '# ' : ''}</span>
            <span>{option.label}</span>
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  )
}

const installEmulateWorkspace = createServerFn({ method: 'POST' })
  .inputValidator((input: EmulateSearch) => withSearchDefaults(input))
  .handler(async ({ data }) => {
    await Chat.getChat().initialize()
    await Chat.getSlack().setInstallation(data.workspace, {
      botToken: slackDefaults.botToken,
      botUserId: slackDefaults.botUserId,
      teamName: slackDefaults.teamName,
    })
    const db = DB.create(env.DB)
    const workspace = await db
      .selectFrom('workspace')
      .selectAll()
      .where('provider', '=', data.provider)
      .where('provider_id', '=', data.workspace)
      .executeTakeFirst()
    const now = new Date().toISOString()
    if (workspace)
      await db
        .updateTable('workspace')
        .set({ name: slackDefaults.teamName, updated_at: now })
        .where('id', '=', workspace.id)
        .execute()
    else
      await db
        .insertInto('workspace')
        .values({
          created_at: now,
          default_amount: 1000,
          id: crypto.randomUUID(),
          name: slackDefaults.teamName,
          provider: data.provider,
          provider_id: data.workspace,
          updated_at: now,
        })
        .execute()
    const [actors, app, transcript] = await Promise.all([
      getSlackActors(),
      getAppState(data),
      getSlackTranscript(data),
    ])
    return {
      actors,
      app,
      diagnostics: getDiagnostics(),
      lastCommand: null,
      transcript,
    } satisfies EmulateWorkspaceState
  })

const sendEmulateCommand = createServerFn({ method: 'POST' })
  .inputValidator((input: EmulateRequest) => withRequestDefaults(input))
  .handler(async ({ data }) => {
    const triggerId = `emulate-${Date.now()}`
    const waitUntilPromises: Promise<unknown>[] = []
    const body = new URLSearchParams({
      channel_id: data.channel,
      command: '/tip',
      team_id: data.workspace,
      text: data.text,
      trigger_id: triggerId,
      user_id: data.actor,
    }).toString()
    const response = await api.fetch(
      new Request(`https://${env.HOST}/api/chat/slack`, {
        body,
        headers: {
          ...(await createSlackHeaders(body, env.SLACK_SIGNING_SECRET)),
          'content-type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      }),
      env,
      {
        passThroughOnException() {},
        props: undefined,
        waitUntil(promise) {
          waitUntilPromises.push(promise)
        },
      },
    )
    await Promise.allSettled(waitUntilPromises)
    await new Promise((resolve) => setTimeout(resolve, 100)) // 100 milliseconds
    const [actors, app, transcript] = await Promise.all([
      getSlackActors(),
      getAppState(data),
      getSlackTranscript(data),
    ])
    return {
      actors,
      app,
      diagnostics: getDiagnostics(),
      lastCommand: { status: response.status, triggerId },
      transcript,
    } satisfies EmulateWorkspaceState
  })

const sendEmulateMention = createServerFn({ method: 'POST' })
  .inputValidator((input: EmulateRequest) => withRequestDefaults(input))
  .handler(async ({ data }) => {
    const messageTs = `${Date.now() / 1000}`
    const waitUntilPromises: Promise<unknown>[] = []
    const body = JSON.stringify({
      event: {
        channel: data.channel,
        channel_type: 'channel',
        event_ts: messageTs,
        team: data.workspace,
        text: data.text,
        ts: messageTs,
        type: 'app_mention',
        user: data.actor,
      },
      event_id: `Ev${Date.now()}`,
      team_id: data.workspace,
      type: 'event_callback',
    })
    const response = await api.fetch(
      new Request(`https://${env.HOST}/api/chat/slack`, {
        body,
        headers: {
          ...(await createSlackHeaders(body, env.SLACK_SIGNING_SECRET)),
          'content-type': 'application/json',
        },
        method: 'POST',
      }),
      env,
      {
        passThroughOnException() {},
        props: undefined,
        waitUntil(promise) {
          waitUntilPromises.push(promise)
        },
      },
    )
    await Promise.allSettled(waitUntilPromises)
    await new Promise((resolve) => setTimeout(resolve, 100)) // 100 milliseconds
    const [actors, app, transcript] = await Promise.all([
      getSlackActors(),
      getAppState(data),
      getSlackTranscript(data),
    ])
    return {
      actors,
      app,
      diagnostics: getDiagnostics(),
      lastCommand: { status: response.status, triggerId: messageTs },
      transcript,
    } satisfies EmulateWorkspaceState
  })

const sendEmulateMessage = createServerFn({ method: 'POST' })
  .inputValidator((input: EmulateRequest) => withRequestDefaults(input))
  .handler(async ({ data }) => {
    const triggerId = `message-${Date.now()}`
    const actors = await getSlackActors()
    const actor = actors.find((actor) => actor.id === data.actor)
    const body = new URLSearchParams({
      channel: data.channel,
      text: data.text,
    }).toString()
    const response = await fetch(new URL('/api/chat.postMessage', env.SLACK_API_URL), {
      body,
      headers: {
        authorization: `Bearer ${actor?.label ?? data.actor}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    })
    const [app, transcript] = await Promise.all([getAppState(data), getSlackTranscript(data)])
    return {
      actors,
      app,
      diagnostics: getDiagnostics(),
      lastCommand: { status: response.status, triggerId },
      transcript,
    } satisfies EmulateWorkspaceState
  })

function LinkedText(props: { actorItems: readonly EmulateActor[]; text: string }) {
  const parts = props.text.split(/(https?:\/\/\S+|<@[^>]+>)/g)
  return parts.map((part, index) => {
    if (part.startsWith('<@') && part.endsWith('>'))
      return (
        <span className="rounded bg-blue2 px-1 font-medium text-blue9" key={index}>
          @{getActorName(part.slice(2, -1), props.actorItems)}
        </span>
      )

    if (!part.startsWith('http')) return <React.Fragment key={index}>{part}</React.Fragment>

    const href = part.replace(/[).,]+$/, '')
    const suffix = part.slice(href.length)
    return (
      <React.Fragment key={index}>
        <a className="text-blue9 underline" href={href} rel="noreferrer" target="_blank">
          {href}
        </a>
        {suffix}
      </React.Fragment>
    )
  })
}

async function getAppState(search: Required<EmulateSearch>) {
  const db = DB.create(env.DB)
  const workspace = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', search.provider)
    .where('provider_id', '=', search.workspace)
    .executeTakeFirst()
  if (!workspace)
    return {
      accountLinkTokens: [],
      members: [],
      recentTips: [],
      workspace: null,
    }

  const members = await db
    .selectFrom('member')
    .leftJoin('provider_identity', 'provider_identity.id', 'member.provider_identity_id')
    .leftJoin('account', 'account.id', 'provider_identity.account_id')
    .select([
      'account.address as account_address',
      'provider_identity.account_id',
      'member.login',
      'member.name',
      'member.provider_user_id',
    ])
    .where('member.workspace_id', '=', workspace.id)
    .orderBy('member.created_at', 'asc')
    .execute()
  const accountLinkTokens = await db
    .selectFrom('account_link_token')
    .innerJoin('member', 'member.id', 'account_link_token.member_id')
    .select([
      'account_link_token.expires_at',
      'account_link_token.id',
      'account_link_token.used_at',
      'member.provider_user_id',
    ])
    .where('member.workspace_id', '=', workspace.id)
    .orderBy('account_link_token.created_at', 'desc')
    .limit(10)
    .execute()
  const recentTips = await db
    .selectFrom('tip')
    .innerJoin('tip_batch', 'tip_batch.id', 'tip.batch_id')
    .innerJoin('member as sender', 'sender.id', 'tip.sender_member_id')
    .innerJoin('member as recipient', 'recipient.id', 'tip.recipient_member_id')
    .select([
      'recipient.provider_user_id as recipient_provider_user_id',
      'sender.provider_user_id as sender_provider_user_id',
      'tip.amount',
      'tip.created_at',
      'tip.memo',
      'tip_batch.transaction_hash as batch_transaction_hash',
    ])
    .where('tip.workspace_id', '=', workspace.id)
    .orderBy('tip.created_at', 'desc')
    .limit(10)
    .execute()

  return {
    accountLinkTokens: accountLinkTokens.map(
      (token) =>
        ({
          expiresAt: token.expires_at,
          id: token.id,
          providerUserId: token.provider_user_id,
          usedAt: token.used_at,
        }) as const,
    ),
    members: members.map(
      (member) =>
        ({
          accountAddress: member.account_address,
          accountId: member.account_id,
          login: member.login,
          name: member.name,
          providerUserId: member.provider_user_id,
        }) as const,
    ),
    recentTips: recentTips.map(
      (tip) =>
        ({
          amount: tip.amount,
          createdAt: tip.created_at,
          memo: tip.memo,
          recipientProviderUserId: tip.recipient_provider_user_id,
          senderProviderUserId: tip.sender_provider_user_id,
          transactionHash: tip.batch_transaction_hash,
        }) as const,
    ),
    workspace: {
      defaultAmount: workspace.default_amount,
      id: workspace.id,
      name: workspace.name,
      provider: workspace.provider,
      providerId: workspace.provider_id,
    },
  } as const
}

async function getSlackActors() {
  try {
    const response = await fetch(new URL('/api/users.list', env.SLACK_API_URL), {
      headers: { authorization: `Bearer ${slackDefaults.botToken}` },
      method: 'POST',
    })
    const json = (await response.json()) as {
      members?: {
        deleted?: boolean
        id?: string
        is_bot?: boolean
        name?: string
        profile?: { display_name?: string; real_name?: string }
      }[]
      ok?: boolean
    }
    if (!json.ok) return defaultActors
    const actors = (json.members ?? [])
      .filter((member) => member.id && !member.deleted && !member.is_bot)
      .map((member) => ({
        id: member.id!,
        label:
          member.profile?.display_name || member.name || member.profile?.real_name || member.id!,
      }))
    return actors.length ? actors : defaultActors
  } catch {
    return defaultActors
  }
}

async function getSlackTranscript(search: Required<EmulateSearch>) {
  try {
    const url = new URL('/api/conversations.history', env.SLACK_API_URL)
    const response = await fetch(url, {
      body: new URLSearchParams({ channel: search.channel }),
      headers: { authorization: `Bearer ${slackDefaults.botToken}` },
      method: 'POST',
    })
    const json = (await response.json()) as {
      messages?: {
        bot_id?: string
        subtype?: string
        text?: string
        ts?: string
        user?: string
      }[]
      ok?: boolean
    }
    if (!json.ok) return []
    const now = Date.now()
    return (json.messages ?? []).map(
      (message, index) =>
        ({
          actor:
            message.subtype === 'ephemeral'
              ? slackDefaults.botUserId
              : (message.bot_id ?? message.user ?? 'unknown'),
          id: message.ts ?? String(index),
          isBot:
            message.subtype === 'ephemeral' || Boolean(message.bot_id) || message.user === 'tipbot',
          kind: message.subtype === 'ephemeral' ? 'ephemeral' : 'public',
          text: message.text ?? '',
          time: message.ts ? formatTimeAgo(Number(message.ts.split('.')[0]) * 1000, now) : '',
        }) as const satisfies EmulateMessage,
    )
  } catch {
    return []
  }
}

function formatTimeAgo(value: number, now: number) {
  const minuteMs = 60 * 1000 // 1 minute
  const hourMs = 60 * minuteMs // 1 hour
  const dayMs = 24 * hourMs // 1 day
  const elapsedMs = Math.max(0, now - value)
  if (elapsedMs < minuteMs) return 'just now'
  if (elapsedMs < hourMs) return `${Math.floor(elapsedMs / minuteMs)}m ago`
  if (elapsedMs < dayMs) return `${Math.floor(elapsedMs / hourMs)}h ago`
  return `${Math.floor(elapsedMs / dayMs)}d ago`
}

function getActorInitial(id: string, actors: readonly EmulateActor[] = defaultActors) {
  return getActorName(id, actors).slice(0, 1).toUpperCase()
}

function getActorName(id: string, actors: readonly EmulateActor[] = defaultActors) {
  if (id === slackDefaults.botUserId || id === 'tipbot') return 'tipbot'
  return getOptionLabel(actors, id)
}

function getDiagnostics() {
  return {
    appOrigin: `https://${env.HOST}`,
    providerApiUrl: env.SLACK_API_URL,
  }
}

function getOptionLabel(options: readonly { id: string; label: string }[], id: string) {
  return options.find((option) => option.id === id)?.label ?? id
}

function getShortcutCommands(actorId: string, targetActorId: string) {
  return [
    { label: 'config', text: '/tip config' },
    { label: 'config amount 0.005', text: '/tip config amount 0.005' },
    { label: 'connect', text: '/tip connect' },
    { label: 'disconnect', text: '/tip disconnect' },
    { label: 'help', text: '/tip help' },
    { label: 'mention tip member', text: `<@${slackDefaults.botUserId}> <@${targetActorId}>` },
    { label: 'self tip', text: `/tip <@${actorId}>` },
    { label: 'status', text: '/tip status' },
    { label: 'tip member', text: `/tip <@${targetActorId}> for coffee` },
  ]
}

function isTipCommand(text: string) {
  return /^\/tip(?:\s|$)/.test(text)
}

function isTipbotMention(text: string) {
  return new RegExp(`<@${slackDefaults.botUserId}(?:\\|[^>]+)?>`).test(text)
}

function withSearchDefaults(search: EmulateSearch): Required<EmulateSearch> {
  const channel =
    defaultChannels.find((item) => item.id === search.channel)?.id ??
    defaultChannels[0]?.id ??
    slackDefaults.channelId
  const provider = defaultProviders.find((item) => item.id === search.provider)?.id ?? 'slack'

  return {
    actor: search.actor ?? slackDefaults.adminUserId,
    channel,
    provider,
    workspace: search.workspace === slackDefaults.teamId ? search.workspace : slackDefaults.teamId,
  }
}

function withRequestDefaults(request: EmulateRequest): Required<EmulateRequest> {
  return { ...withSearchDefaults(request), text: request.text ?? '' }
}

type EmulateWorkspaceState = {
  actors: EmulateActor[]
  app: Awaited<ReturnType<typeof getAppState>>
  diagnostics: {
    appOrigin: string
    providerApiUrl: string
  }
  lastCommand: null | {
    status: number
    triggerId: string
  }
  transcript: EmulateMessage[]
}

type EmulateMessage = {
  actor: string
  id: string
  isBot: boolean
  kind: 'ephemeral' | 'public'
  text: string
  time: string
}

type EmulateActor = {
  id: string
  label: string
}

type EmulateSearch = {
  actor?: string
  channel?: string
  provider?: 'slack'
  workspace?: string
}

type EmulateRequest = EmulateSearch & {
  text?: string
}
