import type { Bot } from 'grammy'
import { markdownToTelegramHtml, splitMessage } from './formatting.js'
import type { TelegramSendQueue } from './send-queue.js'

const FLUSH_INTERVAL = 5000

export class MessageDraft {
  private buffer: string = ''
  private messageId?: number
  private firstFlushPending = false
  private flushTimer?: ReturnType<typeof setTimeout>
  private flushPromise: Promise<void> = Promise.resolve()

  constructor(
    private bot: Bot,
    private chatId: number,
    private threadId: number,
    private sendQueue: TelegramSendQueue,
    private sessionId: string,
  ) {}

  append(text: string): void {
    this.buffer += text
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flushPromise = this.flushPromise
        .then(() => this.flush())
        .catch(() => {})
    }, FLUSH_INTERVAL)
  }

  private async flush(): Promise<void> {
    if (!this.buffer) return
    if (this.firstFlushPending) return

    const html = markdownToTelegramHtml(this.buffer)
    const truncated = html.length > 4096 ? html.slice(0, 4090) + '\n...' : html
    if (!truncated) return

    if (!this.messageId) {
      this.firstFlushPending = true
      try {
        const result = await this.sendQueue.enqueue(
          () => this.bot.api.sendMessage(this.chatId, truncated, {
            message_thread_id: this.threadId,
            parse_mode: 'HTML',
            disable_notification: true,
          }),
          { type: 'other' },
        )
        if (result) {
          this.messageId = result.message_id
        }
      } catch {
        // sendMessage failed — next flush will retry
      } finally {
        this.firstFlushPending = false
      }
    } else {
      try {
        await this.sendQueue.enqueue(
          () => this.bot.api.editMessageText(this.chatId, this.messageId!, truncated, {
            parse_mode: 'HTML',
          }),
          { type: 'text', key: this.sessionId },
        )
      } catch {
        // editMessageText failed (message deleted?) — reset messageId
        this.messageId = undefined
      }
    }
  }

  async finalize(): Promise<number | undefined> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }

    await this.flushPromise

    if (!this.buffer) return this.messageId

    const html = markdownToTelegramHtml(this.buffer)
    const chunks = splitMessage(html)

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        if (i === 0 && this.messageId) {
          await this.sendQueue.enqueue(
            () => this.bot.api.editMessageText(this.chatId, this.messageId!, chunk, {
              parse_mode: 'HTML',
            }),
            { type: 'other' },
          )
        } else {
          const msg = await this.sendQueue.enqueue(
            () => this.bot.api.sendMessage(this.chatId, chunk, {
              message_thread_id: this.threadId,
              parse_mode: 'HTML',
              disable_notification: true,
            }),
            { type: 'other' },
          )
          if (msg) {
            this.messageId = msg.message_id
          }
        }
      }
    } catch {
      try {
        await this.sendQueue.enqueue(
          () => this.bot.api.sendMessage(this.chatId, this.buffer.slice(0, 4096), {
            message_thread_id: this.threadId,
            disable_notification: true,
          }),
          { type: 'other' },
        )
      } catch {
        // Give up
      }
    }

    return this.messageId
  }

  getMessageId(): number | undefined {
    return this.messageId
  }
}
