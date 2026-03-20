import type { Bot } from 'grammy'
import { createChildLogger } from '../../core/log.js'
import { formatUsage } from './formatting.js'
import type { TelegramSendQueue } from './send-queue.js'
import type { PlanEntry } from '../../core/types.js'

const log = createChildLogger({ module: 'telegram:activity' })

// ─── ThinkingIndicator ────────────────────────────────────────────────────────

const THINKING_REFRESH_MS = 15_000
const THINKING_MAX_MS = 3 * 60 * 1000

export class ThinkingIndicator {
  private msgId?: number
  private sending = false
  private dismissed = false
  private refreshTimer?: ReturnType<typeof setInterval>
  private showTime = 0

  constructor(
    private api: Bot['api'],
    private chatId: number,
    private threadId: number,
    private sendQueue: TelegramSendQueue,
  ) {}

  async show(): Promise<void> {
    if (this.msgId || this.sending || this.dismissed) return
    this.sending = true
    this.showTime = Date.now()
    try {
      const result = await this.sendQueue.enqueue(() =>
        this.api.sendMessage(this.chatId, '💭 <i>Thinking...</i>', {
          message_thread_id: this.threadId,
          parse_mode: 'HTML',
          disable_notification: true,
        }),
      )
      if (result && !this.dismissed) {
        this.msgId = result.message_id
        this.startRefreshTimer()
      }
    } catch (err) {
      log.warn({ err }, 'ThinkingIndicator.show() failed')
    } finally {
      this.sending = false
    }
  }

  /** Clear state — stops refresh timer, no Telegram API call */
  dismiss(): void {
    this.dismissed = true
    this.msgId = undefined
    this.stopRefreshTimer()
  }

  /** Reset for a new prompt cycle */
  reset(): void {
    this.dismissed = false
  }

  private startRefreshTimer(): void {
    this.stopRefreshTimer()
    this.refreshTimer = setInterval(() => {
      if (this.dismissed || !this.msgId || (Date.now() - this.showTime) >= THINKING_MAX_MS) {
        this.stopRefreshTimer()
        return
      }
      const elapsed = Math.round((Date.now() - this.showTime) / 1000)
      this.sendQueue.enqueue(() => {
        // Re-check after waiting in queue — dismiss may have been called
        if (this.dismissed) return Promise.resolve(undefined)
        return this.api.sendMessage(this.chatId, `💭 <i>Still thinking... (${elapsed}s)</i>`, {
          message_thread_id: this.threadId,
          parse_mode: 'HTML',
          disable_notification: true,
        })
      }).then(result => {
        if (result && !this.dismissed) {
          this.msgId = result.message_id
        }
      }).catch(() => {})
    }, THINKING_REFRESH_MS)
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = undefined
    }
  }
}

// ─── UsageMessage ─────────────────────────────────────────────────────────────

export class UsageMessage {
  private msgId?: number

  constructor(
    private api: Bot['api'],
    private chatId: number,
    private threadId: number,
    private sendQueue: TelegramSendQueue,
  ) {}

  async send(usage: { tokensUsed?: number; contextSize?: number }): Promise<void> {
    const text = formatUsage(usage)
    try {
      if (this.msgId) {
        await this.sendQueue.enqueue(() =>
          this.api.editMessageText(this.chatId, this.msgId!, text, {
            parse_mode: 'HTML',
          }),
        )
      } else {
        const result = await this.sendQueue.enqueue(() =>
          this.api.sendMessage(this.chatId, text, {
            message_thread_id: this.threadId,
            parse_mode: 'HTML',
            disable_notification: true,
          }),
        )
        if (result) this.msgId = result.message_id
      }
    } catch (err) {
      log.warn({ err }, 'UsageMessage.send() failed')
    }
  }

  getMsgId(): number | undefined {
    return this.msgId
  }

  async delete(): Promise<void> {
    if (!this.msgId) return
    const id = this.msgId
    this.msgId = undefined
    try {
      await this.sendQueue.enqueue(() => this.api.deleteMessage(this.chatId, id))
    } catch (err) {
      log.warn({ err }, 'UsageMessage.delete() failed')
    }
  }
}

// ─── PlanCard ─────────────────────────────────────────────────────────────────

function formatPlanCard(entries: PlanEntry[]): string {
  const statusIcon: Record<string, string> = {
    completed: '✅',
    in_progress: '🔄',
    pending: '⬜',
    failed: '❌',
  }
  const total = entries.length
  const done = entries.filter(e => e.status === 'completed').length
  const ratio = total > 0 ? done / total : 0
  const filled = Math.round(ratio * 10)
  const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled)
  const pct = Math.round(ratio * 100)
  const header = `📋 <b>Plan</b>\n${bar} ${pct}% · ${done}/${total}`
  const lines = entries.map((e, i) => {
    const icon = statusIcon[e.status] ?? '⬜'
    return `${icon} ${i + 1}. ${e.content}`
  })
  return [header, ...lines].join('\n')
}

export class PlanCard {
  private msgId?: number
  private flushPromise: Promise<void> = Promise.resolve()
  private latestEntries?: PlanEntry[]
  private flushTimer?: ReturnType<typeof setTimeout>

  constructor(
    private api: Bot['api'],
    private chatId: number,
    private threadId: number,
    private sendQueue: TelegramSendQueue,
  ) {}

  update(entries: PlanEntry[]): void {
    this.latestEntries = entries
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flushPromise = this.flushPromise
        .then(() => this._flush())
        .catch(() => {})
    }, 3500)
  }

  async finalize(): Promise<void> {
    if (!this.latestEntries) return
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    await this.flushPromise
    this.flushPromise = this.flushPromise
      .then(() => this._flush())
      .catch(() => {})
    await this.flushPromise
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  private async _flush(): Promise<void> {
    if (!this.latestEntries) return
    const text = formatPlanCard(this.latestEntries)
    try {
      if (this.msgId) {
        await this.sendQueue.enqueue(() =>
          this.api.editMessageText(this.chatId, this.msgId!, text, {
            parse_mode: 'HTML',
          }),
        )
      } else {
        const result = await this.sendQueue.enqueue(() =>
          this.api.sendMessage(this.chatId, text, {
            message_thread_id: this.threadId,
            parse_mode: 'HTML',
            disable_notification: true,
          }),
        )
        if (result) this.msgId = result.message_id
      }
    } catch (err) {
      log.warn({ err }, 'PlanCard flush failed')
    }
  }
}

// ─── ActivityTracker ──────────────────────────────────────────────────────────

export class ActivityTracker {
  private isFirstEvent = true
  private hasPlanCard = false
  private thinking: ThinkingIndicator
  private planCard: PlanCard
  private usage: UsageMessage

  constructor(
    private api: Bot['api'],
    private chatId: number,
    private threadId: number,
    private sendQueue: TelegramSendQueue,
  ) {
    this.thinking = new ThinkingIndicator(api, chatId, threadId, sendQueue)
    this.planCard = new PlanCard(api, chatId, threadId, sendQueue)
    this.usage = new UsageMessage(api, chatId, threadId, sendQueue)
  }

  async onNewPrompt(): Promise<void> {
    this.isFirstEvent = true
    this.hasPlanCard = false
    this.thinking.dismiss()
    this.thinking.reset()
  }

  async onThought(): Promise<void> {
    await this._firstEventGuard()
    await this.thinking.show()
  }

  async onPlan(entries: PlanEntry[]): Promise<void> {
    await this._firstEventGuard()
    this.thinking.dismiss()
    this.hasPlanCard = true
    this.planCard.update(entries)
  }

  async onToolCall(): Promise<void> {
    await this._firstEventGuard()
    this.thinking.dismiss()
    this.thinking.reset()
  }

  async onTextStart(): Promise<void> {
    await this._firstEventGuard()
    this.thinking.dismiss()
  }

  async sendUsage(data: { tokensUsed?: number; contextSize?: number }): Promise<void> {
    await this.usage.send(data)
  }

  getUsageMsgId(): number | undefined {
    return this.usage.getMsgId()
  }

  async onComplete(): Promise<void> {
    if (this.hasPlanCard) {
      await this.planCard.finalize()
    } else {
      try {
        await this.sendQueue.enqueue(() =>
          this.api.sendMessage(this.chatId, '✅ <b>Done</b>', {
            message_thread_id: this.threadId,
            parse_mode: 'HTML',
            disable_notification: true,
          }),
        )
      } catch (err) {
        log.warn({ err }, 'ActivityTracker.onComplete() Done send failed')
      }
    }
  }

  destroy(): void {
    this.thinking.dismiss()
    this.planCard.destroy()
  }

  private async _firstEventGuard(): Promise<void> {
    if (!this.isFirstEvent) return
    this.isFirstEvent = false
    await this.usage.delete()
  }
}
