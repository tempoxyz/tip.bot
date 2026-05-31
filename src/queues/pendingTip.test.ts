import * as Chat from '#/chat.ts'
import * as Tip from '#/lib/tip.ts'
import { processPendingTipMessage } from '#/queues/pendingTip.ts'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: 'test-db',
    HOST: 'tip.bot',
    SLACK_API_URL: 'https://slack.example/api',
  },
}))

beforeEach(() => {
  vi.restoreAllMocks()
})

test('claims pending tip and updates queued Slack message', async () => {
  const result = {
    code: 'expired',
    message: 'Pending tip expired before recipient connected.',
    ok: false,
    pendingTip: { id: 'pending_1' },
    status: 'expired',
  } as Tip.PendingTipClaimResult
  const claimSpy = vi.spyOn(Tip, 'claimPendingTip').mockResolvedValue(result)
  const initializeSpy = vi.fn().mockResolvedValue(undefined)
  vi.spyOn(Chat, 'getChat').mockReturnValue({ initialize: initializeSpy } as never)
  const updateSpy = vi.spyOn(Chat, 'updateSlackPendingTipMessage').mockResolvedValue(undefined)

  await processPendingTipMessage(message({ pendingTipId: 'pending_1' }))

  expect(claimSpy).toHaveBeenCalledWith(env, { pendingTipId: 'pending_1' })
  expect(initializeSpy).toHaveBeenCalledOnce()
  expect(updateSpy).toHaveBeenCalledWith(expect.anything(), result)
})

test('skips queued Slack message update when pending tip no longer exists', async () => {
  vi.spyOn(Tip, 'claimPendingTip').mockResolvedValue(null)
  const updateSpy = vi.spyOn(Chat, 'updateSlackPendingTipMessage').mockResolvedValue(undefined)

  await processPendingTipMessage(message({ pendingTipId: 'missing_pending_tip' }))

  expect(updateSpy).not.toHaveBeenCalled()
})

function message(body: processPendingTipMessage.Body) {
  return { body } as Message<processPendingTipMessage.Body>
}
