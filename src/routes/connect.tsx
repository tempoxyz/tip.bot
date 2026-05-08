import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Button, Info, Row, Rows } from 'regen-ui'
import { parseUnits, stringify, toHex } from 'viem'
import { Account as TempoAccount, Secp256k1 } from 'viem/tempo'

import { getTempoProvider, pathUsd, pathUsdDecimals } from '#/lib/tempo.ts'

export const Route = createFileRoute('/connect')({
  component: Connect,
})

function Connect() {
  const [message, setMessage] = useState('Checking Slack connect link.')
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    setToken(new URL(window.location.href).searchParams.get('token'))
  }, [])

  async function connect() {
    if (!token) {
      setMessage('Missing connect token. Run /tip connect in Slack.')
      return
    }

    setMessage('Opening Tempo Wallet.')
    const provider = getTempoProvider()
    const privateKey = Secp256k1.randomPrivateKey()
    const accessKey = TempoAccount.fromSecp256k1(privateKey)
    const expiry = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 // 7 days
    const period = 24 * 60 * 60 // 1 day
    const result = await provider.request({
      method: 'wallet_connect',
      params: [
        {
          capabilities: {
            authorizeAccessKey: {
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

    setMessage('Saving encrypted tipping key.')
    const response = await fetch('/api/connect/complete', {
      body: stringify({
        accessKeyAddress: accessKey.address,
        accessKeyAuthorization: keyAuthorization,
        accessKeyExpiresAt: new Date(expiry * 1000).toISOString(),
        accessKeyPrivateKey: privateKey,
        tempoAddress: address,
        token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    if (!response.ok) throw new Error(await response.text())
    setMessage('Connected. You can close this tab and tip from Slack.')
  }

  return (
    <main
      data-regen-color="blue"
      data-regen-radius="large"
      className="grid min-h-screen place-items-center bg-background p-[24px] text-foreground"
    >
      <section className="grid w-[min(100%,30rem)] gap-[16px] rounded-body border border-border bg-surface p-[20px]">
        <header className="grid gap-[6px]">
          <p className="label-13 text-foreground-secondary">Slack wallet binding</p>
          <h1 className="heading-32 text-foreground">Connect Tempo Wallet</h1>
          <p className="copy-14 text-foreground-secondary">
            Authorize a scoped server key so Slack commands and reactions can submit stablecoin
            tips.
          </p>
        </header>

        <Rows>
          <Row label="Access key">7 days</Row>
          <Row label="Daily limit">1 stablecoin</Row>
          <Row label="Scope">Stablecoin transfers only</Row>
        </Rows>

        <Button
          onClick={() => void connect().catch((error) => setMessage(getErrorMessage(error)))}
          size="large"
          type="button"
          variant="primary"
        >
          Connect wallet
        </Button>
        <Info message={message} />
      </section>
    </main>
  )
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return 'Connection failed.'
}
