import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { OpenACPCore } from "../../../core/index.js";
import type { Session } from "../../../core/session.js";
import { escapeHtml } from "../formatting.js";
import { createChildLogger } from "../../../core/log.js";
import type { CommandsAssistantContext } from "../types.js";
const log = createChildLogger({ module: "telegram-cmd-session" });

export async function handleCancel(
  ctx: Context,
  core: OpenACPCore,
  assistant?: CommandsAssistantContext,
): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return;

  // In assistant topic: forward to assistant for confirmation
  if (assistant && threadId === assistant.topicId) {
    const assistantSession = assistant.getSession();
    if (assistantSession) {
      await assistantSession.enqueuePrompt(
        "User wants to cancel a session. Confirm which session to cancel.",
      );
      return;
    }
  }

  const session = core.sessionManager.getSessionByThread(
    "telegram",
    String(threadId),
  );
  if (session) {
    log.info({ sessionId: session.id }, "Cancel session command");
    await session.abortPrompt();
    await ctx.reply("⛔ Session cancelled.", { parse_mode: "HTML" });
    return;
  }

  // Fallback: cancel from store when session not in memory (e.g. after restart)
  const record = core.sessionManager.getRecordByThread("telegram", String(threadId));
  if (record && record.status !== "cancelled" && record.status !== "error") {
    log.info({ sessionId: record.sessionId }, "Cancel session command (from store)");
    await core.sessionManager.cancelSession(record.sessionId);
    await ctx.reply("⛔ Session cancelled.", { parse_mode: "HTML" });
  }
}

export async function handleStatus(ctx: Context, core: OpenACPCore): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (threadId) {
    const session = core.sessionManager.getSessionByThread(
      "telegram",
      String(threadId),
    );
    if (session) {
      await ctx.reply(
        `<b>Session:</b> ${escapeHtml(session.name || session.id)}\n` +
          `<b>Agent:</b> ${escapeHtml(session.agentName)}\n` +
          `<b>Status:</b> ${escapeHtml(session.status)}\n` +
          `<b>Workspace:</b> <code>${escapeHtml(session.workingDirectory)}</code>\n` +
          `<b>Queue:</b> ${session.queueDepth} pending`,
        { parse_mode: "HTML" },
      );
    } else {
      // Fallback: show stored session info when not loaded in memory (e.g. after restart)
      const record = core.sessionManager.getRecordByThread("telegram", String(threadId));
      if (record) {
        await ctx.reply(
          `<b>Session:</b> ${escapeHtml(record.name || record.sessionId)}\n` +
            `<b>Agent:</b> ${escapeHtml(record.agentName)}\n` +
            `<b>Status:</b> ${escapeHtml(record.status)} (not loaded)\n` +
            `<b>Workspace:</b> <code>${escapeHtml(record.workingDir)}</code>`,
          { parse_mode: "HTML" },
        );
      } else {
        await ctx.reply("No active session in this topic.", {
          parse_mode: "HTML",
        });
      }
    }
  } else {
    const sessions = core.sessionManager.listSessions("telegram");
    const active = sessions.filter(
      (s) => s.status === "active" || s.status === "initializing",
    );
    await ctx.reply(
      `<b>OpenACP Status</b>\n` +
        `Active sessions: ${active.length}\n` +
        `Total sessions: ${sessions.length}`,
      { parse_mode: "HTML" },
    );
  }
}

export async function handleTopics(ctx: Context, core: OpenACPCore): Promise<void> {
  try {
    const allRecords = core.sessionManager.listRecords();

    // Only show sessions that have a Telegram topic (skip headless/CLI-only)
    const records = allRecords.filter((r) => {
      const platform = r.platform as { topicId?: number };
      return !!platform?.topicId;
    });

    const headlessCount = allRecords.length - records.length;

    if (records.length === 0) {
      const extra = headlessCount > 0 ? ` (${headlessCount} headless hidden)` : "";
      await ctx.reply(`No sessions with topics found.${extra}`, { parse_mode: "HTML" });
      return;
    }

    const statusEmoji: Record<string, string> = {
      active: "🟢",
      initializing: "🟡",
      finished: "✅",
      error: "❌",
      cancelled: "⛔",
    };

    // Sort: active/initializing first, then by lastActiveAt desc
    const statusOrder: Record<string, number> = { active: 0, initializing: 1, error: 2, finished: 3, cancelled: 4 };
    records.sort((a, b) => (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5));

    const MAX_DISPLAY = 30;
    const displayed = records.slice(0, MAX_DISPLAY);

    const lines = displayed.map((r) => {
      const emoji = statusEmoji[r.status] || "⚪";
      const name = r.name?.trim();
      const label = name ? escapeHtml(name) : `<i>${escapeHtml(r.agentName)} session</i>`;
      return `${emoji} ${label}  <code>[${r.status}]</code>`;
    });

    const header = `<b>Sessions: ${records.length}</b>` +
      (headlessCount > 0 ? ` (${headlessCount} headless hidden)` : "");
    const truncated = records.length > MAX_DISPLAY ? `\n\n<i>...and ${records.length - MAX_DISPLAY} more</i>` : "";

    // Count by status for cleanup buttons
    const finishedCount = records.filter((r) => r.status === "finished").length;
    const errorCount = records.filter((r) => r.status === "error" || r.status === "cancelled").length;

    const keyboard = new InlineKeyboard();
    if (finishedCount > 0) {
      keyboard.text(`Cleanup finished (${finishedCount})`, "m:cleanup:finished").row();
    }
    if (errorCount > 0) {
      keyboard.text(`Cleanup errors (${errorCount})`, "m:cleanup:errors").row();
    }
    if (finishedCount + errorCount > 0) {
      keyboard.text(`Cleanup all non-active (${finishedCount + errorCount})`, "m:cleanup:all").row();
    }
    keyboard.text(`⚠️ Cleanup ALL (${records.length})`, "m:cleanup:everything").row();
    keyboard.text("Refresh", "m:topics");

    await ctx.reply(
      `${header}\n\n${lines.join("\n")}${truncated}`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  } catch (err) {
    log.error({ err }, "handleTopics error");
    await ctx.reply("❌ Failed to list sessions.", { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function handleCleanup(ctx: Context, core: OpenACPCore, chatId: number, statuses: string[]): Promise<void> {
  const allRecords = core.sessionManager.listRecords();
  const cleanable = allRecords.filter((r) => {
    const platform = r.platform as { topicId?: number };
    return !!platform?.topicId && statuses.includes(r.status);
  });

  if (cleanable.length === 0) {
    await ctx.reply("Nothing to clean up.", { parse_mode: "HTML" });
    return;
  }

  let deleted = 0;
  let failed = 0;

  for (const record of cleanable) {
    try {
      const topicId = (record.platform as { topicId?: number })?.topicId;
      if (topicId) {
        try {
          await ctx.api.deleteForumTopic(chatId, topicId);
        } catch (err) {
          log.warn({ err, sessionId: record.sessionId, topicId }, "Failed to delete forum topic during cleanup");
        }
      }
      await core.sessionManager.removeRecord(record.sessionId);
      deleted++;
    } catch (err) {
      log.error({ err, sessionId: record.sessionId }, "Failed to cleanup session");
      failed++;
    }
  }

  await ctx.reply(
    `🗑 Cleaned up <b>${deleted}</b> sessions${failed > 0 ? ` (${failed} failed)` : ""}.`,
    { parse_mode: "HTML" },
  );
}

export async function handleCleanupEverything(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
  systemTopicIds?: { notificationTopicId: number; assistantTopicId: number },
): Promise<void> {
  const allRecords = core.sessionManager.listRecords();
  const cleanable = allRecords.filter((r) => {
    const platform = r.platform as { topicId?: number };
    if (!platform?.topicId) return false;
    if (systemTopicIds && (platform.topicId === systemTopicIds.notificationTopicId || platform.topicId === systemTopicIds.assistantTopicId)) return false;
    return true;
  });

  if (cleanable.length === 0) {
    await ctx.reply("Nothing to clean up.", { parse_mode: "HTML" });
    return;
  }

  // Group by status for breakdown
  const statusCounts = new Map<string, number>();
  for (const r of cleanable) {
    statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
  }

  const statusEmoji: Record<string, string> = {
    active: "🟢", initializing: "🟡", finished: "✅", error: "❌", cancelled: "⛔",
  };

  const breakdown = Array.from(statusCounts.entries())
    .map(([status, count]) => `${statusEmoji[status] ?? "⚪"} ${status}: ${count}`)
    .join("\n");

  const activeCount = (statusCounts.get("active") ?? 0) + (statusCounts.get("initializing") ?? 0);
  const activeWarning = activeCount > 0
    ? `\n\n⚠️ <b>${activeCount} active session(s) will be cancelled and their agents stopped!</b>`
    : "";

  const keyboard = new InlineKeyboard()
    .text("Yes, delete all", "m:cleanup:everything:confirm")
    .text("Cancel", "m:topics");

  await ctx.reply(
    `<b>Delete ${cleanable.length} topics?</b>\n\n` +
    `This will:\n` +
    `• Delete all session topics from this group\n` +
    `• Cancel any running agent sessions\n` +
    `• Remove all session records\n\n` +
    `<b>Breakdown:</b>\n${breakdown}${activeWarning}\n\n` +
    `<i>Notifications and Assistant topics will NOT be deleted.</i>`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

export async function handleCleanupEverythingConfirmed(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
  systemTopicIds?: { notificationTopicId: number; assistantTopicId: number },
): Promise<void> {
  const allRecords = core.sessionManager.listRecords();
  const cleanable = allRecords.filter((r) => {
    const platform = r.platform as { topicId?: number };
    if (!platform?.topicId) return false;
    if (systemTopicIds && (platform.topicId === systemTopicIds.notificationTopicId || platform.topicId === systemTopicIds.assistantTopicId)) return false;
    return true;
  });

  if (cleanable.length === 0) {
    await ctx.reply("Nothing to clean up.", { parse_mode: "HTML" });
    return;
  }

  let deleted = 0;
  let failed = 0;

  for (const record of cleanable) {
    try {
      // Cancel active sessions first
      if (record.status === "active" || record.status === "initializing") {
        try {
          await core.sessionManager.cancelSession(record.sessionId);
        } catch (err) {
          log.warn({ err, sessionId: record.sessionId }, "Failed to cancel session during cleanup");
        }
      }

      const topicId = (record.platform as { topicId?: number })?.topicId;
      if (topicId) {
        try {
          await ctx.api.deleteForumTopic(chatId, topicId);
        } catch (err) {
          log.warn({ err, sessionId: record.sessionId, topicId }, "Failed to delete forum topic during cleanup");
        }
      }
      await core.sessionManager.removeRecord(record.sessionId);
      deleted++;
    } catch (err) {
      log.error({ err, sessionId: record.sessionId }, "Failed to cleanup session");
      failed++;
    }
  }

  await ctx.reply(
    `🗑 Cleaned up <b>${deleted}</b> sessions${failed > 0 ? ` (${failed} failed)` : ""}.`,
    { parse_mode: "HTML" },
  );
}

export async function executeCancelSession(
  core: OpenACPCore,
  excludeSessionId?: string,
): Promise<Session | null> {
  const sessions = core.sessionManager
    .listSessions("telegram")
    .filter((s) => s.status === "active" && s.id !== excludeSessionId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const session = sessions[0];
  if (!session) return null;

  await session.abortPrompt();
  return session;
}

export function setupSessionCallbacks(
  bot: Bot,
  core: OpenACPCore,
  chatId: number,
  systemTopicIds?: { notificationTopicId: number; assistantTopicId: number },
): void {
  bot.callbackQuery(/^m:cleanup/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
      await ctx.answerCallbackQuery();
    } catch { /* expired */ }

    switch (data) {
      case "m:cleanup:finished":
        await handleCleanup(ctx, core, chatId, ["finished"]);
        break;
      case "m:cleanup:errors":
        await handleCleanup(ctx, core, chatId, ["error", "cancelled"]);
        break;
      case "m:cleanup:all":
        await handleCleanup(ctx, core, chatId, ["finished", "error", "cancelled"]);
        break;
      case "m:cleanup:everything":
        await handleCleanupEverything(ctx, core, chatId, systemTopicIds);
        break;
      case "m:cleanup:everything:confirm":
        await handleCleanupEverythingConfirmed(ctx, core, chatId, systemTopicIds);
        break;
    }
  });
}
