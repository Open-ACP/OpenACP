import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DraftManager } from '../adapters/telegram/draft-manager.js'

// Mock MessageDraft to avoid real Telegram API calls
vi.mock('../adapters/telegram/streaming.js', () => {
  const MockMessageDraft = class {
    append = vi.fn()
    finalize = vi.fn().mockResolvedValue(42)
    getMessageId = vi.fn().mockReturnValue(42)
  }
  return { MessageDraft: MockMessageDraft }
})

// Mock action-detect module
vi.mock('../adapters/telegram/action-detect.js', () => ({
  detectAction: vi.fn().mockReturnValue(null),
  storeAction: vi.fn().mockReturnValue('action-id'),
  buildActionKeyboard: vi.fn().mockReturnValue({ inline_keyboard: [] }),
}))

function mockBot() {
  return {
    api: {
      editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
    },
  } as any
}

function mockSendQueue() {
  return {
    enqueue: vi.fn(async (fn: () => Promise<any>) => fn()),
  } as any
}

describe('DraftManager', () => {
  let manager: DraftManager
  let bot: ReturnType<typeof mockBot>

  beforeEach(() => {
    vi.clearAllMocks()
    bot = mockBot()
    manager = new DraftManager(bot, 12345, mockSendQueue())
  })

  describe('getOrCreate()', () => {
    it('creates a new draft for unknown session', () => {
      const draft = manager.getOrCreate('sess-1', 100)
      expect(draft).toBeDefined()
    })

    it('returns same draft for same session', () => {
      const d1 = manager.getOrCreate('sess-1', 100)
      const d2 = manager.getOrCreate('sess-1', 100)
      expect(d1).toBe(d2)
    })

    it('creates different drafts for different sessions', () => {
      const d1 = manager.getOrCreate('sess-1', 100)
      const d2 = manager.getOrCreate('sess-2', 200)
      expect(d1).not.toBe(d2)
    })
  })

  describe('hasDraft()', () => {
    it('returns false for unknown session', () => {
      expect(manager.hasDraft('unknown')).toBe(false)
    })

    it('returns true after getOrCreate', () => {
      manager.getOrCreate('sess-1', 100)
      expect(manager.hasDraft('sess-1')).toBe(true)
    })
  })

  describe('appendText()', () => {
    it('accumulates text in buffer', () => {
      manager.appendText('sess-1', 'hello ')
      manager.appendText('sess-1', 'world')
      // Text buffer is used internally by finalize
      expect(manager.hasDraft('sess-1')).toBe(false) // draft not created by appendText
    })
  })

  describe('finalize()', () => {
    it('does nothing when no draft exists', async () => {
      await manager.finalize('unknown')
      // Should not throw
    })

    it('calls draft.finalize()', async () => {
      const draft = manager.getOrCreate('sess-1', 100)
      await manager.finalize('sess-1')
      expect(draft.finalize).toHaveBeenCalled()
    })

    it('removes draft after finalize', async () => {
      manager.getOrCreate('sess-1', 100)
      await manager.finalize('sess-1')
      expect(manager.hasDraft('sess-1')).toBe(false)
    })

    it('cleans up text buffer for non-assistant sessions', async () => {
      manager.getOrCreate('sess-1', 100)
      manager.appendText('sess-1', 'some text')
      await manager.finalize('sess-1')
      // Text buffer should be cleaned up
    })

    it('detects actions in assistant responses', async () => {
      const { detectAction } = await import('../adapters/telegram/action-detect.js')
      ;(detectAction as any).mockReturnValue({ action: 'new_session', agent: 'claude' })

      manager.getOrCreate('assistant-sess', 100)
      manager.appendText('assistant-sess', '/new claude workspace')
      await manager.finalize('assistant-sess', 'assistant-sess')

      expect(detectAction).toHaveBeenCalledWith('/new claude workspace')
      expect(bot.api.editMessageReplyMarkup).toHaveBeenCalled()
    })

    it('does not detect actions for non-assistant sessions', async () => {
      const { detectAction } = await import('../adapters/telegram/action-detect.js')

      manager.getOrCreate('regular-sess', 100)
      manager.appendText('regular-sess', '/new claude')
      await manager.finalize('regular-sess')

      expect(detectAction).not.toHaveBeenCalled()
    })

    it('handles editMessageReplyMarkup failure gracefully', async () => {
      const { detectAction } = await import('../adapters/telegram/action-detect.js')
      ;(detectAction as any).mockReturnValue({ action: 'new_session' })
      bot.api.editMessageReplyMarkup.mockRejectedValue(new Error('API error'))

      manager.getOrCreate('assistant-sess', 100)
      manager.appendText('assistant-sess', '/new')
      // Should not throw
      await manager.finalize('assistant-sess', 'assistant-sess')
    })
  })

  describe('cleanup()', () => {
    it('removes draft and text buffer', () => {
      manager.getOrCreate('sess-1', 100)
      manager.appendText('sess-1', 'data')
      manager.cleanup('sess-1')
      expect(manager.hasDraft('sess-1')).toBe(false)
    })

    it('handles cleanup of non-existent session', () => {
      manager.cleanup('unknown') // should not throw
    })
  })
})
