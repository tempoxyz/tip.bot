import { createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Button, Info, Row, Rows, TokenIcon } from 'regen-ui'

import { defaultChain, pathUsd } from '#/lib/tempoConstants.ts'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <main
      data-regen-color="blue"
      data-regen-radius="large"
      className="min-h-screen bg-background text-foreground"
    >
      <section className="mx-auto grid min-h-screen w-[min(100%,72rem)] content-center gap-[32px] px-[24px] py-[48px]">
        <header className="grid max-w-[48rem] gap-[18px]">
          <p className="label-13 text-foreground-secondary">Tempo Slack tipping</p>
          <h1 className="heading-48 text-foreground">Tip teammates without leaving Slack.</h1>
          <p className="copy-16 max-w-[42rem] text-foreground-secondary">
            Connect a Tempo Wallet once, authorize a scoped PathUSD access key, then send fixed
            micro-tips from slash commands, bot mentions, or the workspace reaction.
          </p>
          <div className="flex flex-wrap gap-[10px]">
            <Button
              icon={<IconLucidePlus className="size-4" />}
              onClick={() => {
                window.location.href = '/api/slack/install'
              }}
              size="large"
              type="button"
              variant="primary"
            >
              Add to Slack
            </Button>
            <Button
              icon={<IconLucidePlug className="size-4" />}
              onClick={() => void navigator.clipboard.writeText('/tip connect')}
              size="large"
              type="button"
            >
              Copy /tip connect
            </Button>
            <Button
              icon={<IconLucideSend className="size-4" />}
              onClick={() => void navigator.clipboard.writeText('/tip @account')}
              size="large"
              type="button"
            >
              Copy tip command
            </Button>
          </div>
        </header>

        <section className="grid gap-[16px] md:grid-cols-[1.05fr_0.95fr]">
          <div className="grid gap-[16px] rounded-body border border-border bg-surface p-[18px]">
            <div className="flex items-start gap-[12px]">
              <TokenIcon
                address={pathUsd}
                chainId={defaultChain.id}
                className="h-[40px] w-[40px]"
              />
              <div className="grid gap-[4px]">
                <h2 className="heading-24 text-foreground">PathUSD tips on Tempo testnet</h2>
                <p className="copy-14 text-foreground-secondary">
                  Default amount is 0.0001 PathUSD with a 1 PathUSD daily cap per sender.
                </p>
              </div>
            </div>
            <Rows>
              <Row label="Slash command">/tip @account</Row>
              <Row label="Mention command">@tip tip @account</Row>
              <Row label="Reaction">money_with_wings by default</Row>
              <Row label="Admin config">/tip config amount, emoji, cap</Row>
            </Rows>
          </div>

          <div className="grid content-start gap-[12px] rounded-body border border-border bg-surface p-[18px]">
            <h2 className="heading-24 text-foreground">Slack-native flow</h2>
            <Info message="Both sender and recipient must connect before a tip executes." />
            <Info
              message="Reaction tips post confirmation as a thread reply on the original message."
              type="warning"
            />
            <div className="mt-[4px] grid gap-[10px]">
              <Step
                icon={<IconLucidePlug className="size-4" />}
                label="Connect"
                text="Slack issues a one-time wallet link."
              />
              <Step
                icon={<IconLucideSettings2 className="size-4" />}
                label="Authorize"
                text="Tempo Wallet grants a 7-day key."
              />
              <Step
                icon={<IconLucideSmilePlus className="size-4" />}
                label="React"
                text="Configured emoji triggers the same tip engine."
              />
            </div>
          </div>
        </section>
      </section>
    </main>
  )
}

function Step(props: { icon: ReactNode; label: string; text: string }) {
  return (
    <div className="grid grid-cols-[32px_1fr] gap-[10px] rounded-body bg-secondary p-[12px]">
      <div className="grid h-[32px] w-[32px] place-items-center rounded-body bg-accent text-on-accent">
        {props.icon}
      </div>
      <div className="grid gap-[2px]">
        <p className="label-14 text-foreground">{props.label}</p>
        <p className="copy-13 text-foreground-secondary">{props.text}</p>
      </div>
    </div>
  )
}
