import type { Bot } from "grammy";
import { MessageDraft } from "./streaming.js";
import type { TelegramSendQueue } from "./send-queue.js";
import {
  detectAction,
  storeAction,
  buildActionKeyboard,
} from "./action-detect.js";

export class DraftManager {
  private drafts: Map<string, MessageDraft> = new Map();
  private textBuffers: Map<string, string> = new Map();

  constructor(
    private bot: Bot,
    private chatId: number,
    private sendQueue: TelegramSendQueue,
  ) {}

  getOrCreate(sessionId: string, threadId: number): MessageDraft {
    let draft = this.drafts.get(sessionId);
    if (!draft) {
      draft = new MessageDraft(
        this.bot,
        this.chatId,
        threadId,
        this.sendQueue,
        sessionId,
      );
      this.drafts.set(sessionId, draft);
    }
    return draft;
  }

  hasDraft(sessionId: string): boolean {
    return this.drafts.has(sessionId);
  }

  appendText(sessionId: string, text: string): void {
    this.textBuffers.set(
      sessionId,
      (this.textBuffers.get(sessionId) ?? "") + text,
    );
  }

  /**
   * Finalize the current draft and return the message ID.
   * Optionally detects actions in assistant responses.
   */
  async finalize(
    sessionId: string,
    assistantSessionId?: string,
  ): Promise<void> {
    const draft = this.drafts.get(sessionId);
    if (!draft) return;

    // Delete BEFORE awaiting to prevent concurrent finalizeDraft() calls
    // from double-finalizing the same draft
    this.drafts.delete(sessionId);
    const finalMsgId = await draft.finalize();

    // Detect actions in assistant responses and attach keyboard
    if (assistantSessionId && sessionId === assistantSessionId) {
      const fullText = this.textBuffers.get(sessionId);
      this.textBuffers.delete(sessionId);
      if (fullText && finalMsgId) {
        const detected = detectAction(fullText);
        if (detected) {
          const actionId = storeAction(detected);
          const keyboard = buildActionKeyboard(actionId, detected);
          try {
            await this.bot.api.editMessageReplyMarkup(
              this.chatId,
              finalMsgId,
              { reply_markup: keyboard },
            );
          } catch {
            // Best effort — keyboard attachment is non-critical
          }
        }
      }
    } else {
      this.textBuffers.delete(sessionId);
    }
  }

  cleanup(sessionId: string): void {
    this.drafts.delete(sessionId);
    this.textBuffers.delete(sessionId);
  }
}
