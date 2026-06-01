import { createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import * as React from 'react'
import * as z from 'zod/mini'
import * as DB from '#db/client.ts'
import { tipbotImagePath } from '#/lib/app.ts'
import { formatAmount, formatCurrencyAmount, formatTipAmount } from '#/lib/format.ts'
import * as Tempo from '#/lib/tempo.ts'

function Component() {
  const data = Route.useLoaderData()
  const [copied, setCopied] = React.useState(false)

  return (
    <main className="min-h-screen bg-bg2 px-6 pt-8 pb-12 text-gray10 sm:pt-16 lg:pt-24">
      <section className="mx-auto flex max-w-2xl flex-col gap-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <img
            alt="Tipbot"
            className="size-24 rounded-3xl object-cover shadow-lg sm:size-28"
            height={160}
            src={tipbotImagePath}
            width={160}
          />
          <div className="space-y-2">
            <p className="text-sm font-bold tracking-[0.2em] text-gray8 uppercase">
              Tipbot receipt
            </p>
            <h1 className="text-3xl font-bold tracking-[-0.03em] text-gray10 sm:text-4xl">
              {data.sender.label} {data.memo ? 'sent' : 'tipped'} {data.recipientSummary}
            </h1>
          </div>
        </div>

        <div className="rounded-2xl border border-gray5 bg-bg1 p-6 shadow-xl sm:p-8">
          <div className="border-b border-gray5 pb-6 text-center">
            <div className="text-4xl font-bold tracking-[-0.04em] text-gray10 sm:text-5xl">
              {data.totalDisplay}
            </div>
            {data.recipientCount > 1 ? (
              <p className="mt-2 text-base text-gray9">{data.amountEachDisplay} each</p>
            ) : null}
          </div>

          <dl className="divide-y divide-gray5">
            <ReceiptRow label="Status">
              <span className="inline-flex items-center rounded-full border border-green6 bg-green2 px-2.5 py-1 text-sm font-bold text-green10">
                Confirmed
              </span>
              {data.chain?.status === 'failed' ? (
                <span className="ms-2 text-sm text-red9">Chain reports failed</span>
              ) : null}
              {data.chain?.status === 'pending_indexing' ? (
                <span className="ms-2 text-sm text-gray8">Pending indexing</span>
              ) : null}
              {data.chain?.status === 'unavailable' ? (
                <span className="ms-2 text-sm text-gray8">Chain details unavailable</span>
              ) : null}
            </ReceiptRow>
            <ReceiptRow label="From">
              <Identity identity={data.sender} />
            </ReceiptRow>
            <ReceiptRow label="To">
              <div className="space-y-2">
                {data.recipients.map((recipient) => (
                  <div className="flex flex-col gap-1" key={recipient.id}>
                    <Identity identity={recipient} />
                    <span className="text-sm text-gray8">{recipient.amountDisplay}</span>
                  </div>
                ))}
              </div>
            </ReceiptRow>
            {data.memo ? <ReceiptRow label="Memo">{data.memo}</ReceiptRow> : null}
            <ReceiptRow label="Date">{data.dateDisplay}</ReceiptRow>
            <ReceiptRow label="Network">{data.network}</ReceiptRow>
            {data.feeDisplay ? <ReceiptRow label="Fee">{data.feeDisplay}</ReceiptRow> : null}
            <ReceiptRow label="Transaction">
              <button
                className="font-mono text-sm text-blue9 no-underline hover:underline"
                onClick={async () => {
                  await navigator.clipboard.writeText(data.hash)
                  setCopied(true)
                }}
                type="button"
              >
                {shortHash(data.hash)}
              </button>
              {copied ? <span className="ms-2 text-sm text-gray8">Copied</span> : null}
            </ReceiptRow>
          </dl>
        </div>

        <a
          className="self-center text-sm font-medium text-gray8 no-underline hover:text-gray10 hover:underline"
          href={data.explorerUrl}
          rel="noreferrer"
          target="_blank"
        >
          View on Tempo Explorer
        </a>
      </section>
    </main>
  )
}

export const Route = createFileRoute('/r/$hash')({
  component: Component,
  async loader(options) {
    const data = await getReceiptData({ data: options.params.hash })
    if (!data.ok) throw notFound()
    return data
  },
  notFoundComponent: ReceiptNotFound,
})

function ReceiptNotFound() {
  return (
    <main className="min-h-screen bg-bg2 px-6 pt-8 pb-12 text-gray10 sm:pt-16 lg:pt-24">
      <section className="mx-auto flex max-w-xl flex-col items-center gap-8">
        <img
          alt="Tipbot"
          className="size-28 rounded-3xl object-cover shadow-lg sm:size-36"
          height={160}
          src={tipbotImagePath}
          width={160}
        />
        <div className="max-w-sm space-y-3 text-center">
          <h1 className="text-3xl font-bold text-gray10">Receipt not found</h1>
          <p className="text-base text-gray9">This is not a confirmed Tipbot receipt.</p>
        </div>
      </section>
    </main>
  )
}

function Identity(props: { identity: { address: string | null; label: string } }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="font-semibold text-gray10">{props.identity.label}</span>
      {props.identity.address ? (
        <span className="font-mono text-sm text-gray8">{shortAddress(props.identity.address)}</span>
      ) : null}
    </span>
  )
}

function ReceiptRow(props: React.PropsWithChildren<{ label: string }>) {
  return (
    <div className="grid gap-2 py-4 sm:grid-cols-[8rem_1fr] sm:gap-4">
      <dt className="text-sm font-bold text-gray8">{props.label}</dt>
      <dd className="min-w-0 text-base text-gray10">{props.children}</dd>
    </div>
  )
}

const getReceiptData = createServerFn({ method: 'GET' })
  .inputValidator(z.string().check(z.minLength(1)))
  .handler(async ({ data: rawHash }) => {
    const hash = rawHash.toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(hash)) return { ok: false as const }

    const batch = await DB.create(env.DB)
      .selectFrom('tip_batch')
      .innerJoin('workspace', 'workspace.id', 'tip_batch.workspace_id')
      .innerJoin('member as sender_member', 'sender_member.id', 'tip_batch.sender_member_id')
      .leftJoin(
        'provider_identity as sender_identity',
        'sender_identity.id',
        'sender_member.provider_identity_id',
      )
      .leftJoin('account as sender_account', 'sender_account.id', 'sender_identity.account_id')
      .select([
        'sender_account.address as sender_address',
        'sender_identity.display_name as sender_display_name',
        'sender_identity.real_name as sender_real_name',
        'sender_member.login as sender_login',
        'sender_member.name as sender_name',
        'sender_member.provider_user_id as sender_provider_user_id',
        'tip_batch.amount_each',
        'tip_batch.id',
        'tip_batch.memo',
        'tip_batch.recipient_count',
        'tip_batch.source',
        'tip_batch.token_address',
        'tip_batch.total_amount',
        'tip_batch.transaction_hash',
        'tip_batch.updated_at',
        'workspace.chain_id',
        'workspace.default_token_address',
        'workspace.id as workspace_id',
      ])
      .where('tip_batch.transaction_hash', '=', hash)
      .where('tip_batch.status', '=', 'confirmed')
      .executeTakeFirst()
    if (!batch || !batch.transaction_hash) return { ok: false as const }

    const tipRows = await DB.create(env.DB)
      .selectFrom('tip')
      .innerJoin('member as recipient_member', 'recipient_member.id', 'tip.recipient_member_id')
      .leftJoin(
        'provider_identity as recipient_identity',
        'recipient_identity.id',
        'recipient_member.provider_identity_id',
      )
      .innerJoin('account as recipient_account', 'recipient_account.id', 'tip.recipient_id')
      .select([
        'recipient_account.address as recipient_address',
        'recipient_identity.display_name as recipient_display_name',
        'recipient_identity.real_name as recipient_real_name',
        'recipient_member.id as recipient_member_id',
        'recipient_member.login as recipient_login',
        'recipient_member.name as recipient_name',
        'recipient_member.provider_user_id as recipient_provider_user_id',
        'tip.amount',
      ])
      .where('tip.batch_id', '=', batch.id)
      .execute()

    const token = await Tempo.getTokenMetadata(env, batch.chain_id, batch.token_address)
    const chain = await getChainReceipt(batch.chain_id, hash)
    const date = chain.timestamp ?? batch.updated_at
    const amountEach = formatAmount(Number(batch.amount_each))
    const total = formatAmount(Number(batch.total_amount))
    const isDefaultToken = batch.default_token_address
      ? batch.default_token_address.toLowerCase() === batch.token_address.toLowerCase()
      : batch.token_address.toLowerCase() === Tempo.addressLookup.pathUsd.toLowerCase()
    const formatDisplay = (amount: string) =>
      isDefaultToken
        ? formatCurrencyAmount(amount, token.currency)
        : formatTipAmount(amount, token.currency, token.symbol)

    return {
      amountEachDisplay: formatDisplay(amountEach),
      chain,
      dateDisplay: new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(date)),
      explorerUrl: Tempo.formatTxLink(batch.chain_id, hash),
      feeDisplay: chain?.feeDisplay ?? null,
      hash,
      memo: batch.memo,
      network: Tempo.getChainName(batch.chain_id),
      ok: true as const,
      recipientCount: batch.recipient_count,
      recipientSummary:
        tipRows.length === 1
          ? displayLabel({
              address: tipRows[0]!.recipient_address,
              fallback: tipRows[0]!.recipient_provider_user_id,
              login: tipRows[0]!.recipient_login,
              name: tipRows[0]!.recipient_name,
              providerDisplayName: tipRows[0]!.recipient_display_name,
              providerRealName: tipRows[0]!.recipient_real_name,
            })
          : `${batch.recipient_count} accounts`,
      recipients: tipRows.map((recipient) => ({
        address: recipient.recipient_address,
        amountDisplay: formatDisplay(formatAmount(Number(recipient.amount))),
        id: recipient.recipient_member_id,
        label: displayLabel({
          address: recipient.recipient_address,
          fallback: recipient.recipient_provider_user_id,
          login: recipient.recipient_login,
          name: recipient.recipient_name,
          providerDisplayName: recipient.recipient_display_name,
          providerRealName: recipient.recipient_real_name,
        }),
      })),
      sender: {
        address: batch.sender_address,
        label: displayLabel({
          address: batch.sender_address,
          fallback: batch.sender_provider_user_id,
          login: batch.sender_login,
          name: batch.sender_name,
          providerDisplayName: batch.sender_display_name,
          providerRealName: batch.sender_real_name,
        }),
      },
      totalDisplay: formatDisplay(total),
    }
  })

async function getChainReceipt(
  chainId: number,
  hash: string,
): Promise<{
  feeDisplay: string | null
  status: 'confirmed' | 'failed' | 'pending_indexing' | 'unavailable'
  timestamp: string | null
}> {
  const endpoint = getTidxEndpoint(chainId)
  if (!endpoint) return { feeDisplay: null, status: 'unavailable' as const, timestamp: null }
  try {
    const url = new URL('/query', endpoint)
    url.searchParams.set('chainId', String(chainId))
    url.searchParams.set(
      'sql',
      `SELECT block_timestamp, status FROM receipts WHERE tx_hash = decode('${hash.slice(2)}', 'hex') LIMIT 1`,
    )
    const tidxTimeoutMs = 2_000 // 2 seconds
    const response = await fetch(url, { signal: AbortSignal.timeout(tidxTimeoutMs) })
    if (!response.ok) return { feeDisplay: null, status: 'unavailable' as const, timestamp: null }
    const json = (await response.json()) as {
      columns?: string[]
      rows?: unknown[][]
    }
    const row = json.rows?.[0]
    if (!row) return { feeDisplay: null, status: 'pending_indexing' as const, timestamp: null }
    const value = (column: string) => row[json.columns?.indexOf(column) ?? -1]
    const timestamp = value('block_timestamp')
    return {
      feeDisplay: null,
      status: Number(value('status')) === 1 ? ('confirmed' as const) : ('failed' as const),
      timestamp: typeof timestamp === 'string' ? timestamp : null,
    }
  } catch {
    return { feeDisplay: null, status: 'unavailable' as const, timestamp: null }
  }
}

function displayLabel(input: {
  address: string | null
  fallback: string
  login: string | null
  name: string | null
  providerDisplayName: string | null
  providerRealName: string | null
}) {
  const label = input.login || input.name || input.providerDisplayName || input.providerRealName
  if (label) return label.startsWith('@') ? label : `@${label}`
  if (input.address) return shortAddress(input.address)
  return input.fallback
}

function getTidxEndpoint(chainId: number) {
  if (chainId === Tempo.chainLookup.mainnet) return 'https://indexer.tempo.xyz'
  if (chainId === Tempo.chainLookup.testnet) return 'https://indexer.testnet.tempo.xyz'
  return null
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function shortHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`
}
