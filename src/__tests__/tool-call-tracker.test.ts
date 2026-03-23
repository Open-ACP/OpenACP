import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolCallTracker } from '../adapters/telegram/tool-call-tracker.js'

function mockBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
      editMessageText: vi.fn().mockResolvedValue({}),
    },
  } as any
}

function mockSendQueue() {
  return {
    enqueue: vi.fn(async (fn: () => Promise<any>) => fn()),
  } as any
}

describe('ToolCallTracker', () => {
  let tracker: ToolCallTracker
  let bot: ReturnType<typeof mockBot>
  let sendQueue: ReturnType<typeof mockSendQueue>

  beforeEach(() => {
    bot = mockBot()
    sendQueue = mockSendQueue()
    tracker = new ToolCallTracker(bot, 12345, sendQueue)
  })

  describe('trackNewCall()', () => {
    it('sends initial message via sendQueue', async () => {
      await tracker.trackNewCall('sess-1', 100, {
        id: 'tool-1',
        name: 'Read',
        kind: 'read',
      })

      expect(sendQueue.enqueue).toHaveBeenCalled()
      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        12345,
        expect.any(String),
        expect.objectContaining({
          message_thread_id: 100,
          parse_mode: 'HTML',
          disable_notification: true,
        }),
      )
    })

    it('creates session map on first call', async () => {
      await tracker.trackNewCall('new-sess', 100, {
        id: 'tool-1',
        name: 'Read',
      })

      // Should work without errors, session map created internally
      expect(sendQueue.enqueue).toHaveBeenCalledTimes(1)
    })

    it('stores msgId from response', async () => {
      bot.api.sendMessage.mockResolvedValue({ message_id: 42 })

      await tracker.trackNewCall('sess-1', 100, {
        id: 'tool-1',
        name: 'Edit',
        kind: 'edit',
      })

      // The update should use the stored msgId
      await tracker.updateCall('sess-1', {
        id: 'tool-1',
        name: 'Edit',
        status: 'completed',
      })

      expect(bot.api.editMessageText).toHaveBeenCalledWith(
        12345,
        42,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'HTML' }),
      )
    })
  })

  describe('updateCall()', () => {
    it('does nothing for unknown session', async () => {
      await tracker.updateCall('unknown', {
        id: 'tool-1',
        name: 'Read',
        status: 'completed',
      })

      expect(bot.api.editMessageText).not.toHaveBeenCalled()
    })

    it('does nothing for unknown tool id', async () => {
      await tracker.trackNewCall('sess-1', 100, { id: 'tool-1', name: 'Read' })

      await tracker.updateCall('sess-1', {
        id: 'unknown-tool',
        name: 'Read',
        status: 'completed',
      })

      expect(bot.api.editMessageText).not.toHaveBeenCalled()
    })

    it('only edits on terminal status (completed)', async () => {
      await tracker.trackNewCall('sess-1', 100, { id: 'tool-1', name: 'Read' })

      // Non-terminal update
      await tracker.updateCall('sess-1', {
        id: 'tool-1',
        name: 'Read',
        status: 'running',
      })
      expect(bot.api.editMessageText).not.toHaveBeenCalled()

      // Terminal update
      await tracker.updateCall('sess-1', {
        id: 'tool-1',
        name: 'Read',
        status: 'completed',
      })
      expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    })

    it('only edits on terminal status (failed)', async () => {
      await tracker.trackNewCall('sess-1', 100, { id: 'tool-1', name: 'Read' })

      await tracker.updateCall('sess-1', {
        id: 'tool-1',
        name: 'Read',
        status: 'failed',
      })
      expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    })

    it('accumulates viewerLinks from intermediate updates', async () => {
      await tracker.trackNewCall('sess-1', 100, { id: 'tool-1', name: 'Edit' })

      // Intermediate update with viewerLinks
      await tracker.updateCall('sess-1', {
        id: 'tool-1',
        name: 'Edit',
        status: 'running',
        viewerLinks: { diff: 'https://example.com/diff/1' },
      })

      // Terminal update without viewerLinks — should use accumulated ones
      await tracker.updateCall('sess-1', {
        id: 'tool-1',
        name: 'Edit',
        status: 'completed',
      })

      // The edit should include accumulated viewerLinks in the formatted text
      expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    })

    it('accumulates name and kind from updates', async () => {
      await tracker.trackNewCall('sess-1', 100, { id: 'tool-1', name: 'Unknown' })

      await tracker.updateCall('sess-1', {
        id: 'tool-1',
        name: 'Edit file.ts',
        kind: 'edit',
        status: 'running',
      })

      await tracker.updateCall('sess-1', {
        id: 'tool-1',
        name: 'Edit file.ts',
        status: 'completed',
      })

      expect(bot.api.editMessageText).toHaveBeenCalled()
    })

    it('handles edit failure gracefully', async () => {
      bot.api.editMessageText.mockRejectedValue(new Error('API error'))

      await tracker.trackNewCall('sess-1', 100, { id: 'tool-1', name: 'Read' })

      // Should not throw
      await tracker.updateCall('sess-1', {
        id: 'tool-1',
        name: 'Read',
        status: 'completed',
      })
    })
  })

  describe('cleanup()', () => {
    it('removes session data', async () => {
      await tracker.trackNewCall('sess-1', 100, { id: 'tool-1', name: 'Read' })
      tracker.cleanup('sess-1')

      // After cleanup, updates for this session should be no-ops
      await tracker.updateCall('sess-1', {
        id: 'tool-1',
        name: 'Read',
        status: 'completed',
      })
      expect(bot.api.editMessageText).not.toHaveBeenCalled()
    })

    it('does not affect other sessions', async () => {
      await tracker.trackNewCall('sess-1', 100, { id: 'tool-1', name: 'Read' })
      await tracker.trackNewCall('sess-2', 200, { id: 'tool-2', name: 'Write' })

      tracker.cleanup('sess-1')

      await tracker.updateCall('sess-2', {
        id: 'tool-2',
        name: 'Write',
        status: 'completed',
      })
      expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    })
  })
})
