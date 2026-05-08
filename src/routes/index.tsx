import { createFileRoute } from '@tanstack/react-router'

function Home() {
  return (
    <main className="min-h-screen bg-[#1d1c22] p-8 text-[#d1d2d3] sm:p-[33px]">
      <section className="grid max-w-[75rem] gap-10">
        <header className="flex items-center gap-6">
          <img
            alt="Tipbot"
            className="size-[205px] rounded-[23px] object-cover"
            height={205}
            src="/tipbot.png"
            width={205}
          />
          <div className="flex items-center gap-[18px] pt-3">
            <h1 className="text-[34px] font-bold leading-none tracking-[-0.04em] text-[#d1d2d3]">
              Tipbot
            </h1>
            <span className="rounded bg-[#2a2d33] px-1.5 py-1 text-xl font-bold leading-none tracking-[-0.04em] text-[#c9cbcf]">
              APP
            </span>
            <span className="size-[18px] rounded-full bg-[#25c489]" />
          </div>
        </header>

        <p className="text-[34px] font-normal leading-[1.3] tracking-[-0.035em] text-[#d1d2d3] sm:text-[36px]">
          This is the very beginning of your direct message history with{' '}
          <a
            className="rounded-md bg-[#143247] px-1.5 py-0.5 text-[#25b8f2] no-underline"
            href="/api/slack/install"
          >
            @Tipbot
          </a>
        </p>

        <article className="flex max-w-[58rem] gap-3 opacity-0" data-tipbot-message>
          <img
            alt=""
            className="mt-1 size-11 rounded-xl object-cover"
            height={44}
            src="/tipbot.png"
            width={44}
          />
          <div className="grid gap-1.5">
            <div className="flex items-baseline gap-2">
              <p className="text-[17px] font-bold leading-none text-[#f4f4f5]">Tipbot</p>
              <p className="text-[13px] font-medium leading-none text-[#8d8e93]">just now</p>
            </div>
            <div className="rounded-2xl rounded-ss-md bg-[#2a2d33] px-4 py-3 text-[18px] leading-7 text-[#e8e8ea] shadow-[0_1px_0_#00000033]">
              <p>
                Hey, I turn Slack into a tiny tipping lane. Run{' '}
                <code className="rounded bg-[#1d1c22] px-1.5 py-0.5 text-[#25b8f2]">
                  /tip connect
                </code>{' '}
                once to link Tempo Wallet, then send PathUSD with{' '}
                <code className="rounded bg-[#1d1c22] px-1.5 py-0.5 text-[#25b8f2]">
                  /tip @account
                </code>{' '}
                or your workspace reaction.
              </p>
            </div>
            <a
              className="mt-2 inline-flex h-9 w-fit items-center justify-center justify-self-center rounded-md bg-[#f8f8f8] px-3 text-sm font-bold leading-none text-[#1d1c22] no-underline shadow-[0_1px_0_#00000066] transition hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#25b8f2]"
              href="/api/slack/install"
            >
              Add to Slack
            </a>
          </div>
        </article>
      </section>
    </main>
  )
}

export const Route = createFileRoute('/')({
  component: Home,
})
