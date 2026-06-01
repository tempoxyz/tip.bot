import { Popover } from '@base-ui/react/popover'
import { useMutation } from '@tanstack/react-query'
import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import * as React from 'react'
import { useDisconnect } from 'wagmi'
import { WalletProviders } from '#/components/WalletProviders.tsx'
import {
  disconnectDashboardAccount,
  getDashboardData,
  type DashboardAccount,
} from '#/function/dash.ts'
import { slackCommand, tipbotImagePath } from '#/lib/app.ts'
import { getErrorMessage } from '#/lib/error.ts'
import IconLogosSlackIcon from '~icons/logos/slack-icon.jsx'
import IconSimpleIconsX from '~icons/simple-icons/x.jsx'

function Component() {
  return (
    <WalletProviders.Root auth="/api/auth">
      <DashboardPanel />
    </WalletProviders.Root>
  )
}

export const Route = createFileRoute('/dash')({
  component: Component,
  head: () => ({ meta: [{ title: 'Dashboard - Tipbot' }] }),
  async loader() {
    const dashboard = await getDashboardData()
    if (!dashboard.ok) throw redirect({ to: '/' })
    return dashboard
  },
})

function DashboardPanel() {
  const loaderDashboard = Route.useLoaderData()
  const disconnectWallet = useDisconnect()
  const navigate = Route.useNavigate()
  const [dashboard, setDashboard] = React.useState(loaderDashboard)
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null)
  const disconnectAccount = useMutation({
    mutationFn: async (account: DashboardAccount) => {
      await disconnectDashboardAccount({ data: { identityId: account.id } })
      return account
    },
    onSuccess: (account) => {
      setStatusMessage(`${account.label} disconnected.`)
      setDashboard((value) =>
        value
          ? {
              ...value,
              accounts: {
                slack: value.accounts.slack.filter((item) => item.id !== account.id),
                x: value.accounts.x.filter((item) => item.id !== account.id),
              },
            }
          : value,
      )
    },
  })
  const error = disconnectAccount.error
    ? getErrorMessage(disconnectAccount.error, 'Could not disconnect account.')
    : disconnectWallet.error
      ? getErrorMessage(disconnectWallet.error, 'Could not sign out.')
      : null

  return (
    <main className="min-h-screen bg-bg2 px-6 py-10 text-gray10">
      <section className="mx-auto flex max-w-4xl flex-col gap-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Link className="block w-fit" to="/">
              <img
                alt="Tipbot"
                className="size-10 rounded-xl object-cover"
                height={40}
                src={tipbotImagePath}
                width={40}
              />
            </Link>
          </div>
        </div>
        {dashboard.walletAddress ? (
          <div className="flex flex-col gap-4 rounded-xl border border-gray4 bg-bg1 p-4 shadow-sm sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray10">Wallet</p>
              <a
                className="mt-1 block break-all font-mono text-sm text-gray8 transition hover:text-gray10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9"
                href={dashboard.walletExplorerUrl}
                rel="noreferrer"
                target="_blank"
              >
                {dashboard.walletAddress}
              </a>
            </div>
            <button
              className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-gray5 bg-bg1 px-4 text-sm font-bold text-gray10 shadow-sm transition hover:bg-gray1 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9"
              disabled={disconnectWallet.isPending}
              onClick={() => {
                setStatusMessage(null)
                void disconnectWallet.disconnectAsync().finally(() => void navigate({ to: '/' }))
              }}
              type="button"
            >
              {disconnectWallet.isPending ? 'Signing out' : 'Sign out'}
            </button>
          </div>
        ) : null}
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-gray4 bg-bg1 p-4 shadow-sm">
            <p className="text-sm font-bold text-gray10">Tips sent</p>
            <p className="mt-2 text-3xl font-bold tracking-[-0.04em] text-gray10">
              {dashboard.stats.sent.amount}
            </p>
            <p className="mt-1 text-sm text-gray8">
              {dashboard.stats.sent.tips} {dashboard.stats.sent.tips === 1 ? 'tip' : 'tips'}
            </p>
          </div>
          <div className="rounded-xl border border-gray4 bg-bg1 p-4 shadow-sm">
            <p className="text-sm font-bold text-gray10">Tips received</p>
            <p className="mt-2 text-3xl font-bold tracking-[-0.04em] text-gray10">
              {dashboard.stats.received.amount}
            </p>
            <p className="mt-1 text-sm text-gray8">
              {dashboard.stats.received.tips} {dashboard.stats.received.tips === 1 ? 'tip' : 'tips'}
            </p>
          </div>
        </section>
        {statusMessage ? (
          <div
            className="rounded-xl border border-green6 bg-green1 p-4 text-sm font-semibold text-green10"
            role="status"
          >
            {statusMessage}
          </div>
        ) : null}
        {error ? (
          <div
            className="rounded-xl border border-red6 bg-red1 p-4 text-sm font-semibold text-red10"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        <div className="grid gap-6">
          <AccountSection
            accounts={dashboard.accounts.slack}
            disconnectAccount={disconnectAccount}
            empty={<SlackEmptyState />}
            icon={<IconLogosSlackIcon aria-hidden="true" className="size-6" />}
            title="Slack"
          />
          <AccountSection
            accounts={dashboard.accounts.x}
            disconnectAccount={disconnectAccount}
            empty={<XEmptyState />}
            icon={<IconSimpleIconsX aria-hidden="true" className="size-5" />}
            title="X"
          />
        </div>
      </section>
    </main>
  )
}

function AccountSection(props: {
  accounts: DashboardAccount[]
  disconnectAccount: ReturnType<typeof useMutation<DashboardAccount, Error, DashboardAccount>>
  empty: React.ReactNode
  icon: React.ReactNode
  title: string
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-gray4 bg-bg1 shadow-sm">
      <div className="flex items-center gap-3 border-b border-gray4 px-5 py-4">
        {props.icon}
        <h2 className="text-xl font-bold text-gray10">{props.title}</h2>
      </div>
      {props.accounts.length ? (
        <ul className="divide-y divide-gray4">
          {props.accounts.map((account) => (
            <AccountRow
              account={account}
              disconnectAccount={props.disconnectAccount}
              key={account.id}
            />
          ))}
        </ul>
      ) : (
        props.empty
      )}
    </section>
  )
}

function AccountRow(props: {
  account: DashboardAccount
  disconnectAccount: ReturnType<typeof useMutation<DashboardAccount, Error, DashboardAccount>>
}) {
  const account = props.account
  return (
    <li className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-4">
        <AccountAvatar account={account} />
        <div className="min-w-0">
          <p className="truncate text-lg font-bold text-gray10">{account.label}</p>
          <p className="mt-1 truncate text-sm text-gray8">
            {account.provider === 'x' ? `@${account.username}` : account.username}
          </p>
          <p className="mt-1 text-sm text-gray8">
            {account.workspace ? `${account.workspace.name} · ` : ''}
            Connected{' '}
            {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
              new Date(account.connectedAt),
            )}
          </p>
        </div>
      </div>
      <Popover.Root>
        <Popover.Trigger
          className="inline-flex h-10 items-center justify-center rounded-lg border border-gray5 bg-bg1 px-4 text-sm font-semibold text-gray8 transition hover:border-red6 hover:bg-red1 hover:text-red10 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red9"
          disabled={props.disconnectAccount.isPending}
        >
          Disconnect
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner align="end" className="z-50 outline-none" side="top" sideOffset={8}>
            <Popover.Popup className="w-80 rounded-xl border border-gray5 bg-bg1 p-4 text-gray10 shadow-xl shadow-black/30 focus-visible:outline-none">
              <Popover.Description className="text-sm leading-6 text-gray8">
                Tipbot will no longer recognize this account. If this is your last connected
                account, Tipbot’s access key for this wallet will be removed.
              </Popover.Description>
              <div className="mt-4 flex justify-end gap-2">
                <Popover.Close
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-gray5 bg-bg1 px-4 text-sm font-bold text-gray10 transition hover:bg-gray1 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9"
                  disabled={props.disconnectAccount.isPending}
                >
                  Cancel
                </Popover.Close>
                <button
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-red6 bg-red8 px-4 text-sm font-bold text-white transition hover:bg-red7 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red9"
                  disabled={props.disconnectAccount.isPending}
                  onClick={() => props.disconnectAccount.mutate(account)}
                  type="button"
                >
                  {props.disconnectAccount.isPending ? 'Disconnecting' : 'Confirm disconnect'}
                </button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </li>
  )
}

function AccountAvatar(props: { account: DashboardAccount }) {
  if (props.account.avatarUrl)
    return (
      <img
        alt={`${props.account.label} avatar`}
        className="size-12 shrink-0 rounded-xl object-cover"
        height={48}
        src={props.account.avatarUrl}
        width={48}
      />
    )

  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-gray3 text-sm font-bold text-gray9">
      {props.account.label.slice(0, 2).toUpperCase()}
    </div>
  )
}

function SlackEmptyState() {
  return (
    <div className="p-6">
      <p className="text-lg font-bold text-gray10">No Slack accounts connected</p>
      <p className="mt-2 text-sm leading-6 text-gray8">
        Add Tipbot to Slack, then connect your wallet from Slack.
      </p>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <a
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-gray5 bg-bg1 px-4 text-sm font-bold text-gray10 shadow-sm transition hover:bg-gray1 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9"
          href="/install/slack"
        >
          <IconLogosSlackIcon aria-hidden="true" className="size-5" />
          Add to Slack
        </a>
        <p className="text-sm text-gray8">Already installed? Run `{slackCommand} connect`.</p>
      </div>
    </div>
  )
}

function XEmptyState() {
  return (
    <div className="p-6">
      <p className="text-lg font-bold text-gray10">No X account connected</p>
      <p className="mt-2 text-sm leading-6 text-gray8">
        Connect X to send and receive tips from posts.
      </p>
      <Link
        className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-gray5 bg-bg1 px-4 text-sm font-bold text-gray10 shadow-sm transition hover:bg-gray1 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue9"
        to="/link/x"
      >
        <IconSimpleIconsX aria-hidden="true" className="size-4" />
        Connect X
      </Link>
    </div>
  )
}
