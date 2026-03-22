import type { Bot } from "grammy";
import type { TelegramSendQueue } from "./send-queue.js";
import { formatToolCall, formatToolUpdate } from "./formatting.js";
import { createChildLogger } from "../../core/log.js";

const log = createChildLogger({ module: "tool-call-tracker" });

interface ToolCallState {
  msgId: number;
  name: string;
  kind?: string;
  viewerLinks?: { file?: string; diff?: string };
  viewerFilePath?: string;
  ready: Promise<void>;
}

interface ToolCallMeta {
  id: string;
  name: string;
  kind?: string;
  status?: string;
  content?: unknown;
  viewerLinks?: { file?: string; diff?: string };
  viewerFilePath?: string;
}

export class ToolCallTracker {
  private sessions: Map<string, Map<string, ToolCallState>> = new Map();

  constructor(
    private bot: Bot,
    private chatId: number,
    private sendQueue: TelegramSendQueue,
  ) {}

  async trackNewCall(
    sessionId: string,
    threadId: number,
    meta: ToolCallMeta,
  ): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Map());
    }

    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });

    this.sessions.get(sessionId)!.set(meta.id, {
      msgId: 0,
      name: meta.name,
      kind: meta.kind,
      viewerLinks: meta.viewerLinks,
      viewerFilePath: meta.viewerFilePath,
      ready,
    });

    const msg = await this.sendQueue.enqueue(() =>
      this.bot.api.sendMessage(
        this.chatId,
        formatToolCall(meta),
        {
          message_thread_id: threadId,
          parse_mode: "HTML",
          disable_notification: true,
        },
      ),
    );

    const toolEntry = this.sessions.get(sessionId)!.get(meta.id)!;
    toolEntry.msgId = msg!.message_id;
    resolveReady();
  }

  async updateCall(
    sessionId: string,
    meta: ToolCallMeta & { status: string },
  ): Promise<void> {
    const toolState = this.sessions.get(sessionId)?.get(meta.id);
    if (!toolState) return;

    // Accumulate state from intermediate updates
    if (meta.viewerLinks) {
      toolState.viewerLinks = meta.viewerLinks;
      log.debug({ toolId: meta.id, viewerLinks: meta.viewerLinks }, "Accumulated viewerLinks");
    }
    if (meta.viewerFilePath) toolState.viewerFilePath = meta.viewerFilePath;
    if (meta.name) toolState.name = meta.name;
    if (meta.kind) toolState.kind = meta.kind;

    // Only edit on terminal status — minimizes API calls to avoid rate limits
    const isTerminal = meta.status === "completed" || meta.status === "failed";
    if (!isTerminal) return;

    await toolState.ready;

    log.debug(
      {
        toolId: meta.id,
        status: meta.status,
        hasViewerLinks: !!toolState.viewerLinks,
        viewerLinks: toolState.viewerLinks,
        name: toolState.name,
        msgId: toolState.msgId,
      },
      "Tool completed, preparing edit",
    );

    const merged = {
      ...meta,
      name: toolState.name,
      kind: toolState.kind,
      viewerLinks: toolState.viewerLinks,
      viewerFilePath: toolState.viewerFilePath,
    };
    const formattedText = formatToolUpdate(merged);

    try {
      await this.sendQueue.enqueue(() =>
        this.bot.api.editMessageText(
          this.chatId,
          toolState.msgId,
          formattedText,
          { parse_mode: "HTML" },
        ),
      );
    } catch (err) {
      log.warn(
        {
          err,
          msgId: toolState.msgId,
          textLen: formattedText.length,
          hasViewerLinks: !!merged.viewerLinks,
        },
        "Tool update edit failed",
      );
    }
  }

  cleanup(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
