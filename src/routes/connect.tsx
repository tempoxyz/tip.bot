import { createClient } from '#db/client.ts'
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'
import { KeyAuthorization } from 'ox/tempo'
import { useEffect, useState } from 'react'
import { parseUnits, toHex } from 'viem'
import { Account as TempoAccount, Secp256k1 } from 'viem/tempo'
import { z } from 'zod'

import { encryptSecret, hashValue } from '#/lib/crypto.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import { getTempoChain, getTempoProvider, pathUsd, pathUsdDecimals } from '#/lib/tempo.ts'
import type { TempoChain } from '#/lib/tempoConstants.ts'

export const Route = createFileRoute('/connect')({
  component: Connect,
})

function Connect() {
  const [connected, setConnected] = useState(false)
  const [message, setMessage] = useState('Checking Slack connect link.')
  const [tempoChain, setTempoChain] = useState<TempoChain>('testnet')
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    const url = new URL(window.location.href)
    setTempoChain(url.searchParams.get('chain') === 'mainnet' ? 'mainnet' : 'testnet')
    setToken(url.searchParams.get('token'))
  }, [])

  async function connect() {
    if (!token) {
      setMessage('Missing connect token. Run /tip connect in Slack.')
      return
    }

    setMessage('Opening Tempo Wallet.')
    const chain = getTempoChain(tempoChain)
    const provider = getTempoProvider(tempoChain)
    const privateKey = Secp256k1.randomPrivateKey()
    const accessKey = TempoAccount.fromSecp256k1(privateKey)
    const expiry = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 // 7 days
    const period = 24 * 60 * 60 // 1 day
    const result = await provider.request({
      method: 'wallet_connect',
      params: [
        {
          chainId: toHex(chain.id),
          capabilities: {
            authorizeAccessKey: {
              chainId: toHex(chain.id),
              expiry,
              keyType: 'secp256k1',
              limits: [{ limit: toHex(parseUnits('1', pathUsdDecimals)), period, token: pathUsd }],
              publicKey: accessKey.publicKey,
              scopes: [
                { address: pathUsd, selector: 'transfer(address,uint256)' },
                { address: pathUsd, selector: 'transferWithMemo(address,uint256,bytes32)' },
              ],
            },
          },
        },
      ],
    })
    const address = result.accounts[0]?.address
    const keyAuthorization = result.accounts[0]?.capabilities.keyAuthorization
    if (!address || !keyAuthorization) throw new Error('Tempo Wallet did not authorize key.')
    if (KeyAuthorization.fromRpc(keyAuthorization).chainId !== BigInt(chain.id))
      throw new Error(`Tempo Wallet must authorize ${chain.name}.`)

    setMessage('Saving encrypted tipping key.')
    await completeConnect({
      data: {
        accessKeyAddress: accessKey.address,
        accessKeyAuthorization: keyAuthorization,
        accessKeyExpiresAt: new Date(expiry * 1000).toISOString(),
        accessKeyPrivateKey: privateKey,
        tempoAddress: address,
        token,
      },
    })
    setConnected(true)
    setMessage('Connected. You can close this tab and tip from Slack.')
  }

  return (
    <main
      className="grid min-h-screen place-items-center bg-[var(--tipbot-bg)] p-8 text-[var(--tipbot-text)]"
      data-tipbot-home
    >
      <section className="grid w-[min(100%,28rem)] justify-items-center gap-5">
        <header className="grid justify-items-center gap-5 text-center">
          <img
            alt="Tipbot"
            className="size-24 rounded-[18px] object-cover shadow-[0_1px_0_#00000066]"
            height={96}
            src="/tipbot.png"
            width={96}
          />
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold leading-none tracking-[-0.04em] text-[var(--tipbot-text)]">
              Tipbot
            </h1>
            <span className="rounded bg-[var(--tipbot-badge-bg)] px-1.5 py-1 text-base font-bold leading-none tracking-[-0.04em] text-[var(--tipbot-badge-text)]">
              APP
            </span>
            <span aria-label="Online" className="size-4 rounded-full bg-[#25c489]" role="status" />
          </div>
        </header>

        <section className="grid w-full gap-5 rounded-2xl border border-[var(--tipbot-card-border)] bg-[var(--tipbot-card-bg)] p-5 shadow-[0_1px_0_#0000001f]">
          {connected ? (
            <SuccessPanel />
          ) : (
            <>
              <div className="grid gap-2 text-center">
                <p className="text-sm font-bold uppercase tracking-[0.12em] text-[var(--tipbot-muted)]">
                  Slack wallet binding
                </p>
                <h2 className="text-2xl font-bold leading-tight tracking-[-0.04em] text-[var(--tipbot-text)]">
                  Connect Tempo Wallet
                </h2>
                <p className="text-[15px] leading-6 text-[var(--tipbot-muted)]">
                  Authorize a scoped server key so Slack commands and reactions can submit
                  stablecoin tips.
                </p>
              </div>

              <div className="grid overflow-hidden rounded-xl border border-[var(--tipbot-card-border)]">
                <Row label="Access key" value="7 days" />
                <Row label="Daily limit" value="1 stablecoin" />
                <Row label="Scope" value="Stablecoin transfers only" />
              </div>

              <button
                className="inline-flex h-12 items-center justify-center rounded-lg bg-[var(--tipbot-text)] px-4 text-base font-bold leading-none text-[var(--tipbot-bg)] transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#36c5f0]"
                onClick={() => void connect().catch((error) => setMessage(getErrorMessage(error)))}
                type="button"
              >
                Connect wallet
              </button>

              <p className="rounded-xl bg-[var(--tipbot-message-bg)] px-4 py-3 text-sm leading-5 text-[var(--tipbot-muted)]">
                {message}
              </p>
            </>
          )}
        </section>
      </section>
    </main>
  )
}

function SuccessPanel() {
  return (
    <div className="grid gap-5">
      <div className="grid gap-2 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-[#25c489] text-[#1d1c22]">
          <IconLucideCheck className="size-7" />
        </div>
        <p className="text-sm font-bold uppercase tracking-[0.12em] text-[var(--tipbot-muted)]">
          Wallet connected
        </p>
        <h2 className="text-2xl font-bold leading-tight tracking-[-0.04em] text-[var(--tipbot-text)]">
          You’re ready to tip from Slack.
        </h2>
        <p className="text-[15px] leading-6 text-[var(--tipbot-muted)]">
          You can close this tab. Back in Slack, use Tipbot from messages, mentions, or reactions.
        </p>
      </div>

      <div className="grid gap-3">
        <GuideItem command="/tip @account" text="Send a stablecoin tip with the slash command." />
        <GuideItem command="@tipbot tip @account" text="Mention Tipbot in a channel or thread." />
        <GuideItem
          command="reaction emoji"
          text="React with your workspace’s configured emoji to tip."
        />
      </div>
    </div>
  )
}

function GuideItem(props: { command: string; text: string }) {
  return (
    <div className="grid gap-1 rounded-xl border border-[var(--tipbot-card-border)] bg-[var(--tipbot-message-bg)] px-4 py-3">
      <code className="font-mono text-sm font-bold text-[var(--tipbot-text)]">{props.command}</code>
      <p className="text-sm leading-5 text-[var(--tipbot-muted)]">{props.text}</p>
    </div>
  )
}

function Row(props: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--tipbot-card-border)] px-4 py-3 last:border-b-0">
      <span className="text-sm font-medium text-[var(--tipbot-muted)]">{props.label}</span>
      <span className="text-sm font-bold text-[var(--tipbot-text)]">{props.value}</span>
    </div>
  )
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return 'Connection failed.'
}

const completeConnect = createServerFn({ method: 'POST' })
  .inputValidator((data) =>
    z.parse(
      z.object({
        accessKeyAddress: z.string(),
        accessKeyAuthorization: z.unknown(),
        accessKeyExpiresAt: z.string(),
        accessKeyPrivateKey: z.string(),
        tempoAddress: z.string(),
        token: z.string(),
      }),
      data,
    ),
  )
  .handler(async (c) => {
    if (!env.ACCESS_KEY_ENCRYPTION_SECRET)
      throw new Error('ACCESS_KEY_ENCRYPTION_SECRET is not configured.')

    const token = await createClient(env.DB)
      .selectFrom('connect_token')
      .selectAll()
      .where('token_hash', '=', await hashValue(c.data.token))
      .executeTakeFirst()
    if (!token || token.used_at) throw new Error('Connect token is invalid.')
    if (new Date(token.expires_at).getTime() <= Date.now())
      throw new Error('Connect token expired. Run /tip connect again.')

    const existing = await createClient(env.DB)
      .selectFrom('account')
      .select('id')
      .where('workspace_id', '=', token.workspace_id)
      .where('platform', '=', 'slack')
      .where('platform_account_id', '=', token.platform_account_id)
      .executeTakeFirst()
    const accountId = existing?.id ?? Nanoid.generate()
    const encrypted = await encryptSecret(
      c.data.accessKeyPrivateKey,
      env.ACCESS_KEY_ENCRYPTION_SECRET,
    )
    const now = new Date().toISOString()

    await createClient(env.DB)
      .insertInto('account')
      .values({
        access_key_address: c.data.accessKeyAddress,
        access_key_authorization: JSON.stringify(c.data.accessKeyAuthorization),
        access_key_ciphertext: encrypted,
        access_key_expires_at: c.data.accessKeyExpiresAt,
        created_at: now,
        id: accountId,
        platform: 'slack',
        platform_account_id: token.platform_account_id,
        tempo_address: c.data.tempoAddress.toLowerCase(),
        updated_at: now,
        workspace_id: token.workspace_id,
      })
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'platform', 'platform_account_id']).doUpdateSet({
          access_key_address: c.data.accessKeyAddress,
          access_key_authorization: JSON.stringify(c.data.accessKeyAuthorization),
          access_key_ciphertext: encrypted,
          access_key_expires_at: c.data.accessKeyExpiresAt,
          tempo_address: c.data.tempoAddress.toLowerCase(),
          updated_at: now,
        }),
      )
      .execute()
    await createClient(env.DB)
      .updateTable('connect_token')
      .set({ used_at: now })
      .where('id', '=', token.id)
      .execute()

    return { ok: true }
  })
