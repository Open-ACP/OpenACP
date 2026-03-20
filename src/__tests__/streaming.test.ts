import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageDraft } from '../adapters/telegram/streaming.js'
import { TelegramSendQueue } from '../adapters/telegram/send-queue.js'

function createMockBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
    },
  } as any
}

describe('MessageDraft', () => {
  let bot: ReturnType<typeof createMockBot>
  let queue: TelegramSendQueue
  let draft: MessageDraft

  beforeEach(() => {
    vi.useFakeTimers()
    bot = createMockBot()
    queue = new TelegramSendQueue(100)
    draft = new MessageDraft(bot, 123, 456, queue, 'session-1')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends first message via sendMessage after 5s', async () => {
    draft.append('hello')
    await vi.advanceTimersByTimeAsync(6000)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      123,
      expect.any(String),
      expect.objectContaining({
        message_thread_id: 456,
        parse_mode: 'HTML',
        disable_notification: true,
      }),
    )
  })

  it('edits message on subsequent flushes', async () => {
    draft.append('hello')
    await vi.advanceTimersByTimeAsync(6000)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()

    draft.append(' world')
    await vi.advanceTimersByTimeAsync(6000)
    expect(bot.api.editMessageText).toHaveBeenCalledOnce()
    expect(bot.api.editMessageText).toHaveBeenCalledWith(
      123, 42, expect.any(String),
      expect.objectContaining({ parse_mode: 'HTML' }),
    )
  })

  it('skips flush while first flush is pending', async () => {
    let resolveSend!: (v: any) => void
    bot.api.sendMessage.mockImplementation(() => new Promise(r => { resolveSend = r }))

    draft.append('hello')
    await vi.advanceTimersByTimeAsync(5100)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()

    draft.append(' world')
    await vi.advanceTimersByTimeAsync(5100)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()

    resolveSend({ message_id: 42 })
    await vi.advanceTimersByTimeAsync(100)

    draft.append('!')
    await vi.advanceTimersByTimeAsync(5100)
    expect(bot.api.editMessageText).toHaveBeenCalled()
  })

  it('finalize sends complete content', async () => {
    draft.append('hello world')
    const finalizePromise = draft.finalize()
    // Advance timers so the send queue's internal setTimeout fires
    await vi.advanceTimersByTimeAsync(200)
    const messageId = await finalizePromise
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()
    expect(messageId).toBe(42)
  })

  it('finalize edits existing message if already flushed', async () => {
    draft.append('hello')
    await vi.advanceTimersByTimeAsync(6000)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()

    draft.append(' world')
    const finalizePromise = draft.finalize()
    // Advance timers so the send queue's internal setTimeout fires
    await vi.advanceTimersByTimeAsync(200)
    const messageId = await finalizePromise
    expect(bot.api.editMessageText).toHaveBeenCalled()
    expect(messageId).toBe(42)
  })

  it('resets messageId when editMessageText fails', async () => {
    draft.append('hello')
    await vi.advanceTimersByTimeAsync(6000)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()

    bot.api.editMessageText.mockRejectedValueOnce(new Error('message not found'))
    draft.append(' world')
    await vi.advanceTimersByTimeAsync(6000)

    bot.api.sendMessage.mockResolvedValueOnce({ message_id: 99 })
    draft.append('!')
    await vi.advanceTimersByTimeAsync(6000)
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('finalize with empty buffer returns undefined', async () => {
    const messageId = await draft.finalize()
    expect(messageId).toBeUndefined()
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })
})
