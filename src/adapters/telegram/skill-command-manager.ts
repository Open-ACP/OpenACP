import type { Bot } from "grammy";
import type { TelegramSendQueue } from "./send-queue.js";
import type { AgentCommand } from "../../core/types.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { TelegramPlatformData } from "../../core/types.js";
import { buildSkillMessages } from "./commands/index.js";
import { createChildLogger } from "../../core/log.js";

const log = createChildLogger({ module: "skill-commands" });

export class SkillCommandManager {
  private messages: Map<string, number> = new Map(); // sessionId → pinned msgId

  constructor(
    private bot: Bot,
    private chatId: number,
    private sendQueue: TelegramSendQueue,
    private sessionManager: SessionManager,
  ) {}

  async send(
    sessionId: string,
    threadId: number,
    commands: AgentCommand[],
  ): Promise<void> {
    // Restore skillMsgIds from persisted platform data if not in memory
    if (!this.messages.has(sessionId)) {
      const record = this.sessionManager.getSessionRecord(sessionId);
      const platform = record?.platform as TelegramPlatformData | undefined;
      if (platform?.skillMsgId) {
        this.messages.set(sessionId, platform.skillMsgId);
      }
    }

    // Empty commands → remove pinned message
    if (commands.length === 0) {
      await this.cleanup(sessionId);
      return;
    }

    const messages = buildSkillMessages(commands);
    const existingMsgId = this.messages.get(sessionId);

    if (existingMsgId) {
      try {
        await this.bot.api.editMessageText(
          this.chatId,
          existingMsgId,
          messages[0],
          { parse_mode: "HTML" },
        );
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("message is not modified")) return;
        try {
          await this.bot.api.deleteMessage(this.chatId, existingMsgId);
        } catch { /* already gone */ }
        this.messages.delete(sessionId);
      }
    }

    // Send new messages and pin the first one
    try {
      let firstMsgId: number | undefined;
      for (const text of messages) {
        const msg = await this.sendQueue.enqueue(() =>
          this.bot.api.sendMessage(this.chatId, text, {
            message_thread_id: threadId,
            parse_mode: "HTML",
            disable_notification: true,
          }),
        );
        if (!firstMsgId) firstMsgId = msg!.message_id;
      }

      this.messages.set(sessionId, firstMsgId!);

      // Persist skillMsgId so it survives restarts
      const record = this.sessionManager.getSessionRecord(sessionId);
      if (record) {
        await this.sessionManager.patchRecord(sessionId, {
          platform: { ...record.platform, skillMsgId: firstMsgId },
        });
      }

      await this.bot.api.pinChatMessage(this.chatId, firstMsgId!, {
        disable_notification: true,
      });
    } catch (err) {
      log.error({ err, sessionId }, "Failed to send skill commands");
    }
  }

  async cleanup(sessionId: string): Promise<void> {
    const msgId = this.messages.get(sessionId);
    if (!msgId) return;

    try {
      await this.bot.api.editMessageText(
        this.chatId,
        msgId,
        "🛠 <i>Session ended</i>",
        { parse_mode: "HTML" },
      );
      await this.bot.api.unpinChatMessage(this.chatId, msgId);
    } catch { /* message may already be deleted */ }

    this.messages.delete(sessionId);

    // Clear persisted skillMsgId
    const record = this.sessionManager.getSessionRecord(sessionId);
    if (record) {
      const { skillMsgId: _removed, ...rest } = record.platform as unknown as TelegramPlatformData;
      await this.sessionManager.patchRecord(sessionId, { platform: rest });
    }
  }
}
