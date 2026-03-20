import type { Bot } from "grammy";
import { markdownToTelegramHtml, splitMessage } from "./formatting.js";

export class MessageDraft {
  private messageId?: number;
  private buffer: string = "";
  private lastFlush: number = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushPromise: Promise<void> = Promise.resolve(); // serialize flushes
  private minInterval = 1000; // 1 second throttle

  constructor(
    private bot: Bot,
    private chatId: number,
    private threadId: number,
  ) {}

  append(text: string): void {
    this.buffer += text;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    const now = Date.now();
    const elapsed = now - this.lastFlush;

    if (elapsed >= this.minInterval) {
      // Chain flush to prevent concurrent sends
      this.flushPromise = this.flushPromise
        .then(() => this.flush())
        .catch(() => {});
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flushPromise = this.flushPromise
          .then(() => this.flush())
          .catch(() => {});
      }, this.minInterval - elapsed);
    }
  }

  private async flush(): Promise<void> {
    if (!this.buffer) return;
    this.lastFlush = Date.now();

    const html = markdownToTelegramHtml(this.buffer);
    // Truncate for streaming (will send full on finalize)
    const truncated = html.length > 4096 ? html.slice(0, 4090) + "\n..." : html;
    if (!truncated) return;

    try {
      if (!this.messageId) {
        const msg = await this.bot.api.sendMessage(this.chatId, truncated, {
          message_thread_id: this.threadId,
          parse_mode: "HTML",
          disable_notification: true,
        });
        this.messageId = msg.message_id;
      } else {
        await this.bot.api.editMessageText(
          this.chatId,
          this.messageId,
          truncated,
          {
            parse_mode: "HTML",
          },
        );
      }
    } catch {
      // Edit failed — try plain text without HTML parse mode
      try {
        if (!this.messageId) {
          const msg = await this.bot.api.sendMessage(
            this.chatId,
            this.buffer.slice(0, 4096),
            {
              message_thread_id: this.threadId,
              disable_notification: true,
            },
          );
          this.messageId = msg.message_id;
        }
      } catch {
        // Give up on this flush
      }
    }
  }

  async finalize(): Promise<number | undefined> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Wait for any in-flight flush to complete
    await this.flushPromise;

    if (!this.buffer) return this.messageId;

    // Final send with full content + splitting
    const html = markdownToTelegramHtml(this.buffer);
    const chunks = splitMessage(html);

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (i === 0 && this.messageId) {
          // Edit existing message with first chunk
          await this.bot.api.editMessageText(
            this.chatId,
            this.messageId,
            chunk,
            {
              parse_mode: "HTML",
            },
          );
        } else {
          // Send new message
          const msg = await this.bot.api.sendMessage(this.chatId, chunk, {
            message_thread_id: this.threadId,
            parse_mode: "HTML",
            disable_notification: true,
          });
          this.messageId = msg.message_id;
        }
      }
    } catch {
      // Best effort — try plain text
      try {
        await this.bot.api.sendMessage(
          this.chatId,
          this.buffer.slice(0, 4096),
          {
            message_thread_id: this.threadId,
            disable_notification: true,
          },
        );
      } catch {
        // Give up
      }
    }

    return this.messageId;
  }

  getMessageId(): number | undefined {
    return this.messageId;
  }

  getBuffer(): string {
    return this.buffer;
  }
}
