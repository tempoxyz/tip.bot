import * as Chat from '#/chat.ts'
import * as Tip from '#/lib/tip.ts'
import { processPendingTipMessage } from '#/queues/pendingTip.ts'
import { createMessageBatch } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, test, vi } from 'vitest'

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
  const updateSpy = vi.spyOn(Chat, 'updateSlackPendingTipMessage').mockResolvedValue(undefined)
  const batch = createMessageBatch<processPendingTipMessage.Body>(
    processPendingTipMessage.queueName,
    [
      {
        attempts: 1,
        body: { pendingTipId: 'pending_1' },
        id: crypto.randomUUID(),
        timestamp: new Date(),
      },
    ],
  )

  await processPendingTipMessage(batch.messages[0]!)

  expect(claimSpy).toHaveBeenCalledWith(env, { pendingTipId: 'pending_1' })
  expect(updateSpy).toHaveBeenCalledWith(expect.anything(), result)
})

test('skips queued Slack message update when pending tip no longer exists', async () => {
  vi.spyOn(Tip, 'claimPendingTip').mockResolvedValue(null)
  const updateSpy = vi.spyOn(Chat, 'updateSlackPendingTipMessage').mockResolvedValue(undefined)
  const batch = createMessageBatch<processPendingTipMessage.Body>(
    processPendingTipMessage.queueName,
    [
      {
        attempts: 1,
        body: { pendingTipId: 'missing_pending_tip' },
        id: crypto.randomUUID(),
        timestamp: new Date(),
      },
    ],
  )

  await processPendingTipMessage(batch.messages[0]!)

  expect(updateSpy).not.toHaveBeenCalled()
})
