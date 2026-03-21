import type { Bot } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { nanoid } from 'nanoid'
import type { PermissionRequest, NotificationMessage, Session } from '../../core/index.js'
import { escapeHtml } from './formatting.js'
import { buildDeepLink } from './topics.js'
import { createChildLogger } from '../../core/log.js'
const log = createChildLogger({ module: 'telegram-permissions' })

// Stored pending permission callbacks: callbackKey → { sessionId, requestId, options }
interface PendingPermission {
  sessionId: string
  requestId: string
  options: { id: string; isAllow: boolean }[]
}

export class PermissionHandler {
  private pending: Map<string, PendingPermission> = new Map()

  constructor(
    private bot: Bot,
    private chatId: number,
    private getSession: (sessionId: string) => Session | undefined,
    private sendNotification: (notification: NotificationMessage) => Promise<void>,
  ) {}

  async sendPermissionRequest(session: Session, request: PermissionRequest): Promise<void> {
    const threadId = Number(session.threadId)

    // Short callback key (Telegram 64-byte limit on callback_data)
    const callbackKey = nanoid(8)
    this.pending.set(callbackKey, {
      sessionId: session.id,
      requestId: request.id,
      options: request.options.map(o => ({ id: o.id, isAllow: o.isAllow })),
    })

    // Build inline keyboard
    const keyboard = new InlineKeyboard()
    for (const option of request.options) {
      const emoji = option.isAllow ? '✅' : '❌'
      keyboard.text(`${emoji} ${option.label}`, `p:${callbackKey}:${option.id}`)
    }

    // Send in session topic WITH notification
    const msg = await this.bot.api.sendMessage(this.chatId,
      `🔐 <b>Permission request:</b>\n\n${escapeHtml(request.description)}`,
      {
        message_thread_id: threadId,
        parse_mode: 'HTML',
        reply_markup: keyboard,
        disable_notification: false,
      }
    )

    // Deep link for notification
    const deepLink = buildDeepLink(this.chatId, msg.message_id)

    // Notify in notification topic (fire-and-forget to avoid sendQueue deadlock:
    // this method runs INSIDE a sendQueue item, so awaiting another enqueue() deadlocks)
    void this.sendNotification({
      sessionId: session.id,
      sessionName: session.name,
      type: 'permission',
      summary: request.description,
      deepLink,
    })
  }

  setupCallbackHandler(): void {
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data
      if (!data.startsWith('p:')) return

      const parts = data.split(':')
      if (parts.length < 3) return
      const [, callbackKey, optionId] = parts

      const pending = this.pending.get(callbackKey)
      if (!pending) {
        try { await ctx.answerCallbackQuery({ text: '❌ Expired' }) } catch { /* old query */ }
        return
      }

      const session = this.getSession(pending.sessionId)
      const isAllow = pending.options.find(o => o.id === optionId)?.isAllow ?? false
      log.info({ requestId: pending.requestId, optionId, isAllow }, 'Permission responded')
      if (session?.permissionGate.requestId === pending.requestId) {
        session.permissionGate.resolve(optionId)
      }
      this.pending.delete(callbackKey)

      try { await ctx.answerCallbackQuery({ text: '✅ Responded' }) } catch { /* old query */ }

      // Remove buttons
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined })
      } catch { /* ignore */ }
    })
  }
}
