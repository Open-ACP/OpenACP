import { Bot } from "grammy";
import {
  ChannelAdapter,
  type OpenACPCore,
  type OutgoingMessage,
  type PermissionRequest,
  type NotificationMessage,
  type Session,
  type AgentCommand,
} from "../../core/index.js";
import { createChildLogger } from "../../core/log.js";
const log = createChildLogger({ module: "telegram" });
import type { TelegramChannelConfig } from "./types.js";
import { MessageDraft } from "./streaming.js";
import {
  ensureTopics,
  createSessionTopic,
  renameSessionTopic,
} from "./topics.js";
import {
  setupCommands,
  setupMenuCallbacks,
  setupSkillCallbacks,
  buildMenuKeyboard,
  buildSkillKeyboard,
  clearSkillCallbacks,
  STATIC_COMMANDS,
} from "./commands.js";
import { PermissionHandler } from "./permissions.js";
import {
  spawnAssistant,
  handleAssistantMessage,
  redirectToAssistant,
} from "./assistant.js";
import {
  escapeHtml,
  formatToolCall,
  formatToolUpdate,
  formatPlan,
  formatUsage,
} from "./formatting.js";

export class TelegramAdapter extends ChannelAdapter {
  private bot!: Bot;
  private telegramConfig: TelegramChannelConfig;
  private sessionDrafts: Map<string, MessageDraft> = new Map();
  private toolCallMessages: Map<
    string,
    Map<string, { msgId: number; name: string; kind?: string; viewerLinks?: { file?: string; diff?: string } }>
  > = new Map(); // sessionId → (toolCallId → state)
  private permissionHandler!: PermissionHandler;
  private assistantSession: Session | null = null;
  private notificationTopicId!: number;
  private assistantTopicId!: number;
  private skillMessages: Map<string, number> = new Map(); // sessionId → pinned messageId

  constructor(core: OpenACPCore, config: TelegramChannelConfig) {
    super(core, config as never);
    this.telegramConfig = config;
  }

  async start(): Promise<void> {
    this.bot = new Bot(this.telegramConfig.botToken);

    // Global error handler — prevent unhandled errors from crashing the bot
    this.bot.catch((err) => {
      const rootCause = err.error instanceof Error ? err.error : err;
      log.error({ err: rootCause }, "Telegram bot error");
    });

    // Ensure allowed_updates includes callback_query on every poll.
    // bot.start() passes allowed_updates, but grammY only sends it on the first
    // getUpdates call. Subsequent polls may omit the parameter, causing Telegram
    // to fall back to its default (which excludes callback_query). This transformer
    // guarantees callback_query is always requested.
    this.bot.api.config.use((prev, method, payload, signal) => {
      if (method === "getUpdates") {
        const p = payload as never as Record<string, unknown>;
        p.allowed_updates = (p.allowed_updates as string[] | undefined) ?? [
          "message",
          "callback_query",
        ];
      }
      return prev(method, payload, signal);
    });

    // Register static commands for Telegram autocomplete (scoped to this chat)
    await this.bot.api.setMyCommands(STATIC_COMMANDS, {
      scope: { type: "chat", chat_id: this.telegramConfig.chatId },
    });

    // Middleware: only accept updates from configured chatId
    this.bot.use((ctx, next) => {
      const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
      if (chatId !== this.telegramConfig.chatId) return;
      return next();
    });

    // Ensure system topics exist
    const topics = await ensureTopics(
      this.bot,
      this.telegramConfig.chatId,
      this.telegramConfig,
      async (updates) => {
        // Save topic IDs to config
        await (this.core as OpenACPCore).configManager.save({
          channels: { telegram: updates },
        });
      },
    );
    this.notificationTopicId = topics.notificationTopicId;
    this.assistantTopicId = topics.assistantTopicId;

    // Setup permission handler (instance only, callback registered later)
    this.permissionHandler = new PermissionHandler(
      this.bot,
      this.telegramConfig.chatId,
      (sessionId) =>
        (this.core as OpenACPCore).sessionManager.getSession(sessionId),
      (notification) => this.sendNotification(notification),
    );

    // Callback registration order matters!
    // Specific regex handlers first, catch-all last.
    setupSkillCallbacks(this.bot, this.core as OpenACPCore);
    setupMenuCallbacks(
      this.bot,
      this.core as OpenACPCore,
      this.telegramConfig.chatId,
    );
    setupCommands(
      this.bot,
      this.core as OpenACPCore,
      this.telegramConfig.chatId,
    );
    this.permissionHandler.setupCallbackHandler();

    // Setup message routing
    this.setupRoutes();

    // Start bot polling
    this.bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: () =>
        log.info(
          { chatId: this.telegramConfig.chatId },
          "Telegram bot started",
        ),
    });

    // Spawn assistant (after bot is started so it can send messages)
    try {
      this.assistantSession = await spawnAssistant(
        this.core as OpenACPCore,
        this,
        this.assistantTopicId,
      );
    } catch (err) {
      log.error({ err }, "Failed to spawn assistant");
    }

    // Send welcome message with menu to assistant topic
    try {
      const config = (this.core as OpenACPCore).configManager.get();
      const agents = (
        this.core as OpenACPCore
      ).agentManager.getAvailableAgents();
      const agentList = agents
        .map(
          (a) =>
            `${escapeHtml(a.name)}${a.name === config.defaultAgent ? " (default)" : ""}`,
        )
        .join(", ");
      const workspace = escapeHtml(config.workspace.baseDir);

      const welcomeText =
        `👋 <b>OpenACP Assistant</b> is online.\n\n` +
        `Available agents: ${agentList}\n` +
        `Workspace: <code>${workspace}</code>\n\n` +
        `<b>Select an action:</b>`;

      await this.bot.api.sendMessage(this.telegramConfig.chatId, welcomeText, {
        message_thread_id: this.assistantTopicId,
        parse_mode: "HTML",
        reply_markup: buildMenuKeyboard(),
      });
    } catch (err) {
      log.warn({ err }, "Failed to send welcome message");
    }
  }

  async stop(): Promise<void> {
    if (this.assistantSession) {
      await this.assistantSession.destroy();
    }
    await this.bot.stop();
    log.info("Telegram bot stopped");
  }

  private setupRoutes(): void {
    this.bot.on("message:text", async (ctx) => {
      const threadId = ctx.message.message_thread_id;

      // General topic or no thread → redirect to assistant
      if (!threadId) {
        const html = redirectToAssistant(
          this.telegramConfig.chatId,
          this.assistantTopicId,
        );
        await ctx.reply(html, { parse_mode: "HTML" });
        return;
      }

      // Notification topic → ignore
      if (threadId === this.notificationTopicId) return;

      // Assistant topic → send typing indicator and forward to assistant session
      if (threadId === this.assistantTopicId) {
        ctx.replyWithChatAction("typing").catch(() => {});
        handleAssistantMessage(this.assistantSession, ctx.message.text).catch(
          (err) => log.error({ err }, "Assistant error"),
        );
        return;
      }

      // Session topic → send typing indicator and forward to core
      ctx.replyWithChatAction("typing").catch(() => {});
      (this.core as OpenACPCore)
        .handleMessage({
          channelId: "telegram",
          threadId: String(threadId),
          userId: String(ctx.from.id),
          text: ctx.message.text,
        })
        .catch((err) => log.error({ err }, "handleMessage error"));
    });
  }

  // --- ChannelAdapter implementations ---

  async sendMessage(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    // log.debug({ sessionId, type: content.type }, "Sending message to Telegram");
    const session = (this.core as OpenACPCore).sessionManager.getSession(
      sessionId,
    );
    if (!session) return;
    const threadId = Number(session.threadId);

    switch (content.type) {
      case "thought": {
        // Skip thought/thinking content — it's internal agent reasoning
        // Users don't need to see it
        break;
      }

      case "text": {
        let draft = this.sessionDrafts.get(sessionId);
        if (!draft) {
          draft = new MessageDraft(
            this.bot,
            this.telegramConfig.chatId,
            threadId,
          );
          this.sessionDrafts.set(sessionId, draft);
        }
        draft.append(content.text);
        break;
      }

      case "tool_call": {
        await this.finalizeDraft(sessionId);
        const meta = content.metadata as never as { id: string; name: string; kind?: string; status?: string; content?: unknown; viewerLinks?: { file?: string; diff?: string } };
        const msg = await this.bot.api.sendMessage(
          this.telegramConfig.chatId,
          formatToolCall(meta),
          {
            message_thread_id: threadId,
            parse_mode: "HTML",
            disable_notification: true,
          },
        );
        if (!this.toolCallMessages.has(sessionId)) {
          this.toolCallMessages.set(sessionId, new Map());
        }
        this.toolCallMessages.get(sessionId)!.set(meta.id, {
          msgId: msg.message_id,
          name: meta.name,
          kind: meta.kind,
          viewerLinks: meta.viewerLinks,
        });
        break;
      }

      case "tool_update": {
        const meta = content.metadata as never as { id: string; name: string; kind?: string; status: string; content?: unknown; viewerLinks?: { file?: string; diff?: string } };
        const toolState = this.toolCallMessages.get(sessionId)?.get(meta.id);
        if (toolState) {
          // Carry forward viewerLinks from previous updates if not present in current
          const viewerLinks = meta.viewerLinks || toolState.viewerLinks;
          if (meta.viewerLinks) toolState.viewerLinks = meta.viewerLinks;
          // Merge name/kind from original tool_call
          const merged = {
            ...meta,
            name: meta.name || toolState.name,
            kind: meta.kind || toolState.kind,
            viewerLinks,
          };
          try {
            await this.bot.api.editMessageText(
              this.telegramConfig.chatId,
              toolState.msgId,
              formatToolUpdate(merged),
              { parse_mode: "HTML" },
            );
          } catch {
            /* edit failed */
          }
        }
        break;
      }

      case "plan": {
        await this.finalizeDraft(sessionId);
        await this.bot.api.sendMessage(
          this.telegramConfig.chatId,
          formatPlan(content.metadata as never as { entries: Array<{ content: string; status: string }> }),
          {
            message_thread_id: threadId,
            parse_mode: "HTML",
            disable_notification: true,
          },
        );
        break;
      }

      case "usage": {
        // Show usage stats
        await this.bot.api.sendMessage(
          this.telegramConfig.chatId,
          formatUsage(content.metadata as never as { tokensUsed?: number; contextSize?: number; cost?: { amount: number; currency: string } }),
          {
            message_thread_id: threadId,
            parse_mode: "HTML",
            disable_notification: true,
          },
        );
        break;
      }

      case "session_end": {
        await this.finalizeDraft(sessionId);
        this.sessionDrafts.delete(sessionId);
        this.toolCallMessages.delete(sessionId);
        await this.cleanupSkillCommands(sessionId);
        await this.bot.api.sendMessage(
          this.telegramConfig.chatId,
          `✅ <b>Done</b>`,
          {
            message_thread_id: threadId,
            parse_mode: "HTML",
            disable_notification: true,
          },
        );
        break;
      }

      case "error": {
        await this.finalizeDraft(sessionId);
        await this.bot.api.sendMessage(
          this.telegramConfig.chatId,
          `❌ <b>Error:</b> ${escapeHtml(content.text)}`,
          {
            message_thread_id: threadId,
            parse_mode: "HTML",
            disable_notification: true,
          },
        );
        break;
      }
    }
  }

  async sendPermissionRequest(
    sessionId: string,
    request: PermissionRequest,
  ): Promise<void> {
    log.info({ sessionId, requestId: request.id }, "Permission request sent");
    const session = (this.core as OpenACPCore).sessionManager.getSession(
      sessionId,
    );
    if (!session) return;
    await this.permissionHandler.sendPermissionRequest(session, request);
  }

  async sendNotification(notification: NotificationMessage): Promise<void> {
    log.info(
      { sessionId: notification.sessionId, type: notification.type },
      "Notification sent",
    );
    if (!this.notificationTopicId) return;
    const emoji: Record<string, string> = {
      completed: "✅",
      error: "❌",
      permission: "🔐",
      input_required: "💬",
    };
    let text = `${emoji[notification.type] || "ℹ️"} <b>${escapeHtml(notification.sessionName || notification.sessionId)}</b>\n`;
    text += escapeHtml(notification.summary);
    if (notification.deepLink) {
      text += `\n\n<a href="${notification.deepLink}">→ Go to message</a>`;
    }
    await this.bot.api.sendMessage(this.telegramConfig.chatId, text, {
      message_thread_id: this.notificationTopicId,
      parse_mode: "HTML",
      disable_notification: false,
    });
  }

  async createSessionThread(sessionId: string, name: string): Promise<string> {
    log.info({ sessionId, name }, "Session topic created");
    return String(
      await createSessionTopic(this.bot, this.telegramConfig.chatId, name),
    );
  }

  async renameSessionThread(sessionId: string, newName: string): Promise<void> {
    const session = (this.core as OpenACPCore).sessionManager.getSession(
      sessionId,
    );
    if (!session) return;
    await renameSessionTopic(
      this.bot,
      this.telegramConfig.chatId,
      Number(session.threadId),
      newName,
    );
  }

  async sendSkillCommands(sessionId: string, commands: AgentCommand[]): Promise<void> {
    const session = (this.core as OpenACPCore).sessionManager.getSession(sessionId);
    if (!session) return;
    const threadId = Number(session.threadId);
    if (!threadId) return;

    // Empty commands → remove pinned message
    if (commands.length === 0) {
      await this.cleanupSkillCommands(sessionId);
      return;
    }

    // Clear old callback entries before building new keyboard
    clearSkillCallbacks(sessionId);

    const keyboard = buildSkillKeyboard(sessionId, commands);
    const text = "🛠 <b>Available commands:</b>";
    const existingMsgId = this.skillMessages.get(sessionId);

    if (existingMsgId) {
      // Update existing pinned message
      try {
        await this.bot.api.editMessageText(
          this.telegramConfig.chatId,
          existingMsgId,
          text,
          { parse_mode: "HTML", reply_markup: keyboard },
        );
        return;
      } catch {
        // Message may have been deleted — fall through to create new
      }
    }

    // Create and pin new message
    try {
      const msg = await this.bot.api.sendMessage(
        this.telegramConfig.chatId,
        text,
        {
          message_thread_id: threadId,
          parse_mode: "HTML",
          reply_markup: keyboard,
          disable_notification: true,
        },
      );
      this.skillMessages.set(sessionId, msg.message_id);

      await this.bot.api.pinChatMessage(this.telegramConfig.chatId, msg.message_id, {
        disable_notification: true,
      });
    } catch (err) {
      log.error({ err, sessionId }, "Failed to send skill commands");
    }

    // Update Telegram autocomplete with skill commands
    await this.updateCommandAutocomplete(session.agentName, commands);
  }

  async cleanupSkillCommands(sessionId: string): Promise<void> {
    const msgId = this.skillMessages.get(sessionId);
    if (!msgId) return;

    try {
      await this.bot.api.editMessageText(
        this.telegramConfig.chatId,
        msgId,
        "🛠 <i>Session ended</i>",
        { parse_mode: "HTML" },
      );
      await this.bot.api.unpinChatMessage(this.telegramConfig.chatId, msgId);
    } catch {
      /* message may already be deleted */
    }

    this.skillMessages.delete(sessionId);
    clearSkillCallbacks(sessionId);

  }

  private async updateCommandAutocomplete(agentName: string, skillCommands: AgentCommand[]): Promise<void> {
    // Telegram requires: 1-32 chars, lowercase a-z, 0-9, underscores only
    const prefix = `[${agentName}] `;
    const validSkills = skillCommands
      .map((c) => ({
        command: c.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32),
        description: (prefix + ((c.description || c.name).replace(/\n/g, " "))).slice(0, 256),
      }))
      .filter((c) => c.command.length > 0);
    const all = [...STATIC_COMMANDS, ...validSkills];
    try {
      await this.bot.api.setMyCommands(all, {
        scope: { type: "chat", chat_id: this.telegramConfig.chatId },
      });
      log.info({ count: all.length, skills: validSkills.length }, "Updated command autocomplete");
    } catch (err) {
      log.error({ err, commands: all }, "Failed to update command autocomplete");
    }
  }

  private async finalizeDraft(sessionId: string): Promise<void> {
    const draft = this.sessionDrafts.get(sessionId);
    if (draft) {
      await draft.finalize();
      this.sessionDrafts.delete(sessionId);
    }
  }
}
