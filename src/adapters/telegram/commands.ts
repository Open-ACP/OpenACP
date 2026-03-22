import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { OpenACPCore } from "../../core/index.js";
import type { Session } from "../../core/session.js";
import { escapeHtml } from "./formatting.js";
import { createSessionTopic, renameSessionTopic, buildDeepLink } from "./topics.js";
import { createChildLogger } from "../../core/log.js";
import type { AgentCommand } from "../../core/index.js";
const log = createChildLogger({ module: "telegram-commands" });

interface AssistantContext {
  topicId: number;
  getSession: () => Session | null;
  respawn: () => Promise<void>;
}

interface PendingNewSession {
  agentName?: string;
  workspace?: string;
  step: "agent" | "workspace" | "workspace_input" | "confirm";
  messageId: number;
  threadId?: number;
  timer: ReturnType<typeof setTimeout>;
}

const pendingNewSessions = new Map<number, PendingNewSession>();

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function cleanupPending(userId: number): void {
  const pending = pendingNewSessions.get(userId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingNewSessions.delete(userId);
  }
}

export function setupCommands(
  bot: Bot,
  core: OpenACPCore,
  chatId: number,
  assistant?: AssistantContext,
): void {
  bot.command("new", (ctx) => handleNew(ctx, core, chatId, assistant));
  bot.command("newchat", (ctx) => handleNewChat(ctx, core, chatId));
  bot.command("cancel", (ctx) => handleCancel(ctx, core, assistant));
  bot.command("status", (ctx) => handleStatus(ctx, core));
  bot.command("sessions", (ctx) => handleTopics(ctx, core));
  bot.command("agents", (ctx) => handleAgents(ctx, core));
  bot.command("help", (ctx) => handleHelp(ctx));
  bot.command("menu", (ctx) => handleMenu(ctx));
  bot.command("enable_dangerous", (ctx) => handleEnableDangerous(ctx, core));
  bot.command("disable_dangerous", (ctx) => handleDisableDangerous(ctx, core));
  bot.command("restart", (ctx) => handleRestart(ctx, core));
  bot.command("update", (ctx) => handleUpdate(ctx, core));
  bot.command("integrate", (ctx) => handleIntegrate(ctx, core));
  bot.command("clear", (ctx) => handleClear(ctx, assistant));
}

export function buildMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🆕 New Session", "m:new")
    .text("📋 Sessions", "m:topics")
    .row()
    .text("📊 Status", "m:status")
    .text("🤖 Agents", "m:agents")
    .row()
    .text("🔗 Integrate", "m:integrate")
    .text("❓ Help", "m:help")
    .row()
    .text("🔄 Restart", "m:restart")
    .text("⬆️ Update", "m:update");
}

export function setupMenuCallbacks(
  bot: Bot,
  core: OpenACPCore,
  chatId: number,
  systemTopicIds?: { notificationTopicId: number; assistantTopicId: number },
): void {
  bot.callbackQuery(/^m:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* expired or network — ignore */
    }

    // --- New session interactive flow (prefix-based) ---
    if (data.startsWith("m:new:agent:")) {
      const agentName = data.replace("m:new:agent:", "");
      const userId = ctx.from?.id;
      if (userId) await startWorkspaceStep(ctx, core, chatId, userId, agentName);
      return;
    }
    if (data === "m:new:ws:default") {
      const userId = ctx.from?.id;
      if (!userId) return;
      const pending = pendingNewSessions.get(userId);
      if (!pending?.agentName) return;
      const workspace = core.configManager.get().workspace.baseDir;
      await startConfirmStep(ctx, chatId, userId, pending.agentName, workspace);
      return;
    }
    if (data === "m:new:ws:custom") {
      const userId = ctx.from?.id;
      if (!userId) return;
      const pending = pendingNewSessions.get(userId);
      if (!pending?.agentName) return;
      try {
        await ctx.api.editMessageText(
          chatId,
          pending.messageId,
          `✏️ <b>Enter your project path:</b>\n\n` +
            `Full path like <code>~/code/my-project</code>\n` +
            `Or just the folder name like <code>my-project</code> (will use ${core.configManager.get().workspace.baseDir}/)`,
          { parse_mode: "HTML" },
        );
      } catch {
        await ctx.reply(
          `✏️ <b>Enter your project path:</b>`,
          { parse_mode: "HTML" },
        );
      }
      clearTimeout(pending.timer);
      pending.step = "workspace_input";
      pending.timer = setTimeout(() => pendingNewSessions.delete(userId), PENDING_TIMEOUT_MS);
      return;
    }
    if (data === "m:new:confirm") {
      const userId = ctx.from?.id;
      if (!userId) return;
      const pending = pendingNewSessions.get(userId);
      if (!pending?.agentName || !pending?.workspace) return;
      cleanupPending(userId);
      const confirmMsgId = pending.messageId;
      try {
        await ctx.api.editMessageText(chatId, confirmMsgId, `⏳ Creating session...`, { parse_mode: "HTML" });
      } catch { /* ignore */ }
      const resultThreadId = await createSessionDirect(ctx, core, chatId, pending.agentName, pending.workspace);
      try {
        if (resultThreadId) {
          const link = buildDeepLink(chatId, resultThreadId);
          await ctx.api.editMessageText(chatId, confirmMsgId, `✅ Session created → <a href="${link}">Open topic</a>`, { parse_mode: "HTML" });
        } else {
          await ctx.api.editMessageText(chatId, confirmMsgId, `❌ Session creation failed.`, { parse_mode: "HTML" });
        }
      } catch { /* ignore */ }
      return;
    }
    if (data === "m:new:cancel") {
      const userId = ctx.from?.id;
      if (userId) cleanupPending(userId);
      try {
        await ctx.editMessageText("❌ Session creation cancelled.", { parse_mode: "HTML" });
      } catch { /* ignore */ }
      return;
    }

    switch (data) {
      case "m:new":
        await handleNew(ctx, core, chatId);
        break;
      case "m:status":
        await handleStatus(ctx, core);
        break;
      case "m:agents":
        await handleAgents(ctx, core);
        break;
      case "m:help":
        await handleHelp(ctx);
        break;
      case "m:restart":
        await handleRestart(ctx, core);
        break;
      case "m:update":
        await handleUpdate(ctx, core);
        break;
      case "m:integrate":
        await handleIntegrate(ctx, core);
        break;
      case "m:topics":
        await handleTopics(ctx, core);
        break;
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

async function handleMenu(ctx: Context): Promise<void> {
  await ctx.reply(`<b>OpenACP Menu</b>\nChoose an action:`, {
    parse_mode: "HTML",
    reply_markup: buildMenuKeyboard(),
  });
}

async function handleNew(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
  assistant?: AssistantContext,
): Promise<void> {
  const rawMatch = (ctx as Context & { match: unknown }).match;
  const matchStr = typeof rawMatch === "string" ? rawMatch : "";
  const args = matchStr.split(" ").filter(Boolean);
  const agentName = args[0];
  const workspace = args[1];

  // Full args → create directly
  if (agentName && workspace) {
    await createSessionDirect(ctx, core, chatId, agentName, workspace);
    return;
  }

  // In assistant topic → forward to assistant for conversational handling
  const currentThreadId = ctx.message?.message_thread_id;
  if (assistant && currentThreadId === assistant.topicId) {
    const assistantSession = assistant.getSession();
    if (assistantSession) {
      const prompt = agentName
        ? `User wants to create a new session with agent "${agentName}" but didn't specify a workspace. Ask them which project directory to use as workspace.`
        : `User wants to create a new session. Guide them through choosing an agent and workspace (project directory).`;
      await assistantSession.enqueuePrompt(prompt);
      return;
    }
  }

  // Outside assistant topic → interactive flow
  const userId = ctx.from?.id;
  if (!userId) return;

  const agents = core.agentManager.getAvailableAgents();
  const config = core.configManager.get();

  // If agent provided or only 1 agent → skip to workspace step
  if (agentName || agents.length === 1) {
    const selectedAgent = agentName || config.defaultAgent;
    await startWorkspaceStep(ctx, core, chatId, userId, selectedAgent);
    return;
  }

  // Multiple agents → show agent selection
  const keyboard = new InlineKeyboard();
  for (const agent of agents) {
    const label = agent.name === config.defaultAgent
      ? `${agent.name} (default)`
      : agent.name;
    keyboard.text(label, `m:new:agent:${agent.name}`).row();
  }

  const msg = await ctx.reply(
    `🤖 <b>Choose an agent:</b>`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );

  cleanupPending(userId);
  pendingNewSessions.set(userId, {
    step: "agent",
    messageId: msg.message_id,
    threadId: currentThreadId,
    timer: setTimeout(() => pendingNewSessions.delete(userId), PENDING_TIMEOUT_MS),
  });
}

async function startWorkspaceStep(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
  userId: number,
  agentName: string,
): Promise<void> {
  const config = core.configManager.get();
  const baseDir = config.workspace.baseDir;

  const keyboard = new InlineKeyboard()
    .text(`📁 Use ${baseDir}`, "m:new:ws:default")
    .row()
    .text("✏️ Enter project path", "m:new:ws:custom");

  const text =
    `📁 <b>Where should ${escapeHtml(agentName)} work?</b>\n\n` +
    `Enter the path to your project folder — the agent will read, write, and run code there.\n\n` +
    `Or use the default directory below:`;

  let msg;
  try {
    const pending = pendingNewSessions.get(userId);
    if (pending?.messageId) {
      await ctx.api.editMessageText(chatId, pending.messageId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      msg = { message_id: pending.messageId };
    } else {
      msg = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    }
  } catch {
    msg = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }

  cleanupPending(userId);
  pendingNewSessions.set(userId, {
    agentName,
    step: "workspace",
    messageId: msg.message_id,
    threadId: ctx.message?.message_thread_id ?? (ctx.callbackQuery as any)?.message?.message_thread_id,
    timer: setTimeout(() => pendingNewSessions.delete(userId), PENDING_TIMEOUT_MS),
  });
}

async function startConfirmStep(
  ctx: Context,
  chatId: number,
  userId: number,
  agentName: string,
  workspace: string,
): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("✅ Create", "m:new:confirm")
    .text("❌ Cancel", "m:new:cancel");

  const text =
    `✅ <b>Ready to create session?</b>\n\n` +
    `<b>Agent:</b> ${escapeHtml(agentName)}\n` +
    `<b>Project:</b> <code>${escapeHtml(workspace)}</code>`;

  let msg;
  try {
    const pending = pendingNewSessions.get(userId);
    if (pending?.messageId) {
      await ctx.api.editMessageText(chatId, pending.messageId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      msg = { message_id: pending.messageId };
    } else {
      msg = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    }
  } catch {
    msg = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }

  cleanupPending(userId);
  pendingNewSessions.set(userId, {
    agentName,
    workspace,
    step: "confirm",
    messageId: msg.message_id,
    threadId: ctx.message?.message_thread_id ?? (ctx.callbackQuery as any)?.message?.message_thread_id,
    timer: setTimeout(() => pendingNewSessions.delete(userId), PENDING_TIMEOUT_MS),
  });
}

async function createSessionDirect(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
  agentName: string,
  workspace: string,
): Promise<number | null> {
  log.info({ userId: ctx.from?.id, agentName, workspace }, "New session command (direct)");

  let threadId: number | undefined;
  try {
    const topicName = `🔄 New Session`;
    threadId = await createSessionTopic(botFromCtx(ctx), chatId, topicName);

    await ctx.api.sendMessage(chatId, `⏳ Setting up session, please wait...`, {
      message_thread_id: threadId,
      parse_mode: "HTML",
    });

    const session = await core.handleNewSession("telegram", agentName, workspace);
    session.threadId = String(threadId);

    await core.sessionManager.updateSessionPlatform(session.id, { topicId: threadId });

    const finalName = `🔄 ${session.agentName} — New Session`;
    try {
      await ctx.api.editForumTopic(chatId, threadId, { name: finalName });
    } catch { /* ignore rename failures */ }

    await ctx.api.sendMessage(
      chatId,
      `✅ <b>Session started</b>\n` +
        `<b>Agent:</b> ${escapeHtml(session.agentName)}\n` +
        `<b>Workspace:</b> <code>${escapeHtml(session.workingDirectory)}</code>\n\n` +
        `This is your coding session — chat here to work with the agent.`,
      {
        message_thread_id: threadId,
        parse_mode: "HTML",
        reply_markup: buildDangerousModeKeyboard(session.id, false),
      },
    );

    session.warmup().catch((err) => log.error({ err }, "Warm-up error"));
    return threadId ?? null;
  } catch (err) {
    log.error({ err }, "Session creation failed");
    if (threadId) {
      try { await ctx.api.deleteForumTopic(chatId, threadId); } catch { /* ignore */ }
    }
    const message = err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err));
    await ctx.reply(`❌ ${escapeHtml(message)}`, { parse_mode: "HTML" });
    return null;
  }
}

async function handleNewChat(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) {
    await ctx.reply(
      "Use /newchat inside a session topic to inherit its config.",
      { parse_mode: "HTML" },
    );
    return;
  }

  // Resolve agent config from existing session/record BEFORE spawning
  const currentSession = core.sessionManager.getSessionByThread(
    "telegram",
    String(threadId),
  );
  let agentName: string | undefined;
  let workspace: string | undefined;

  if (currentSession) {
    agentName = currentSession.agentName;
    workspace = currentSession.workingDirectory;
  } else {
    const record = core.sessionManager.getRecordByThread("telegram", String(threadId));
    if (!record || record.status === "cancelled" || record.status === "error") {
      await ctx.reply("No active session in this topic.", {
        parse_mode: "HTML",
      });
      return;
    }
    agentName = record.agentName;
    workspace = record.workingDir;
  }

  let newThreadId: number | undefined;
  try {
    // Create topic FIRST so threadId is ready before session events fire
    const topicName = `🔄 ${agentName} — New Chat`;
    newThreadId = await createSessionTopic(
      botFromCtx(ctx),
      chatId,
      topicName,
    );

    // Notify in the original topic immediately with a deep link to the new one
    const topicLink = buildDeepLink(chatId, newThreadId);
    await ctx.reply(
      `✅ New chat created → <a href="${topicLink}">Open topic</a>`,
      { parse_mode: "HTML" },
    );

    await ctx.api.sendMessage(chatId, `⏳ Setting up session, please wait...`, {
      message_thread_id: newThreadId,
      parse_mode: "HTML",
    });

    const session = await core.handleNewSession(
      "telegram",
      agentName,
      workspace,
    );
    session.threadId = String(newThreadId);

    // Persist platform mapping for new chat
    await core.sessionManager.updateSessionPlatform(session.id, {
      topicId: newThreadId,
    });

    await ctx.api.sendMessage(
      chatId,
      `✅ New chat (same agent &amp; workspace)\n` +
        `<b>Agent:</b> ${escapeHtml(session.agentName)}\n` +
        `<b>Workspace:</b> <code>${escapeHtml(session.workingDirectory)}</code>`,
      {
        message_thread_id: newThreadId,
        parse_mode: "HTML",
        reply_markup: buildDangerousModeKeyboard(session.id, false),
      },
    );

    // Warm up model cache in background while user types
    session.warmup().catch((err) => log.error({ err }, "Warm-up error"));
  } catch (err) {
    // Clean up orphaned topic if session creation failed
    if (newThreadId) {
      try {
        await ctx.api.deleteForumTopic(chatId, newThreadId);
      } catch {
        /* ignore cleanup failures */
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ ${escapeHtml(message)}`, { parse_mode: "HTML" });
  }
}

async function handleCancel(
  ctx: Context,
  core: OpenACPCore,
  assistant?: AssistantContext,
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
    await session.cancel();
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

async function handleStatus(ctx: Context, core: OpenACPCore): Promise<void> {
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

async function handleTopics(ctx: Context, core: OpenACPCore): Promise<void> {
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
    const activeCount = records.filter((r) => r.status === "active" || r.status === "initializing").length;

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

async function handleCleanup(ctx: Context, core: OpenACPCore, chatId: number, statuses: string[]): Promise<void> {
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

async function handleCleanupEverything(
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

async function handleCleanupEverythingConfirmed(
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

async function handleAgents(ctx: Context, core: OpenACPCore): Promise<void> {
  const agents = core.agentManager.getAvailableAgents();
  const defaultAgent = core.configManager.get().defaultAgent;
  const lines = agents.map(
    (a) =>
      `• <b>${escapeHtml(a.name)}</b>${a.name === defaultAgent ? " (default)" : ""}\n` +
      `  <code>${escapeHtml(a.command)} ${a.args.map((arg) => escapeHtml(arg)).join(" ")}</code>`,
  );
  const text =
    lines.length > 0
      ? `<b>Available Agents:</b>\n\n${lines.join("\n")}`
      : `<b>Available Agents:</b>\n\nNo agents configured.`;
  await ctx.reply(text, { parse_mode: "HTML" });
}

async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    `📖 <b>OpenACP Help</b>\n\n` +
      `🚀 <b>Getting Started</b>\n` +
      `Tap 🆕 New Session to start coding with AI.\n` +
      `Each session gets its own topic — chat there to work with the agent.\n\n` +
      `💡 <b>Common Tasks</b>\n` +
      `/new [agent] [workspace] — Create new session\n` +
      `/cancel — Cancel session (in session topic)\n` +
      `/status — Show session or system status\n` +
      `/sessions — List all sessions\n` +
      `/agents — List available agents\n\n` +
      `⚙️ <b>System</b>\n` +
      `/restart — Restart OpenACP\n` +
      `/update — Update to latest version\n` +
      `/integrate — Manage agent integrations\n` +
      `/menu — Show action menu\n\n` +
      `🔒 <b>Session Options</b>\n` +
      `/enable_dangerous — Auto-approve permissions\n` +
      `/disable_dangerous — Restore permission prompts\n` +
      `/handoff — Continue session in terminal\n` +
      `/clear — Clear assistant history\n\n` +
      `💬 Need help? Just ask me in this topic!`,
    { parse_mode: "HTML" },
  );
}

async function handleClear(ctx: Context, assistant?: AssistantContext): Promise<void> {
  if (!assistant) {
    await ctx.reply("⚠️ Assistant is not available.", { parse_mode: "HTML" });
    return;
  }

  const threadId = ctx.message?.message_thread_id;
  if (threadId !== assistant.topicId) {
    await ctx.reply("ℹ️ /clear only works in the Assistant topic.", { parse_mode: "HTML" });
    return;
  }

  await ctx.reply("🔄 Clearing assistant history...", { parse_mode: "HTML" });

  try {
    await assistant.respawn();
    await ctx.reply("✅ Assistant history cleared.", { parse_mode: "HTML" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ Failed to clear: <code>${message}</code>`, { parse_mode: "HTML" });
  }
}

export function buildDangerousModeKeyboard(sessionId: string, enabled: boolean): InlineKeyboard {
  return new InlineKeyboard().text(
    enabled ? "🔐 Disable Dangerous Mode" : "☠️ Enable Dangerous Mode",
    `d:${sessionId}`,
  );
}

export function setupDangerousModeCallbacks(bot: Bot, core: OpenACPCore): void {
  bot.callbackQuery(/^d:/, async (ctx) => {
    const sessionId = ctx.callbackQuery.data.slice(2);
    const session = core.sessionManager.getSession(sessionId);

    // Session live in memory — toggle directly
    if (session) {
      session.dangerousMode = !session.dangerousMode;
      log.info({ sessionId, dangerousMode: session.dangerousMode }, "Dangerous mode toggled via button");
      core.sessionManager.updateSessionDangerousMode(sessionId, session.dangerousMode).catch(() => {});

      const toastText = session.dangerousMode
        ? "☠️ Dangerous mode enabled — permissions auto-approved"
        : "🔐 Dangerous mode disabled — permissions shown normally";
      try { await ctx.answerCallbackQuery({ text: toastText }); } catch { /* expired */ }

      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: buildDangerousModeKeyboard(sessionId, session.dangerousMode),
        });
      } catch { /* ignore */ }
      return;
    }

    // Session not in memory (e.g. after restart) — toggle directly in store
    const record = core.sessionManager.getSessionRecord(sessionId);
    if (!record || record.status === "cancelled" || record.status === "error") {
      try { await ctx.answerCallbackQuery({ text: "⚠️ Session not found or already ended." }); } catch { /* expired */ }
      return;
    }

    const newDangerousMode = !(record.dangerousMode ?? false);
    core.sessionManager.updateSessionDangerousMode(sessionId, newDangerousMode).catch(() => {});
    log.info({ sessionId, dangerousMode: newDangerousMode }, "Dangerous mode toggled via button (store-only, session not in memory)");

    const toastText = newDangerousMode
      ? "☠️ Dangerous mode enabled — permissions auto-approved"
      : "🔐 Dangerous mode disabled — permissions shown normally";
    try { await ctx.answerCallbackQuery({ text: toastText }); } catch { /* expired */ }

    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: buildDangerousModeKeyboard(sessionId, newDangerousMode),
      });
    } catch { /* ignore */ }
  });
}

async function handleEnableDangerous(ctx: Context, core: OpenACPCore): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) {
    await ctx.reply("⚠️ This command only works inside a session topic.", { parse_mode: "HTML" });
    return;
  }
  const session = core.sessionManager.getSessionByThread("telegram", String(threadId));
  if (session) {
    if (session.dangerousMode) {
      await ctx.reply("☠️ Dangerous mode is already enabled.", { parse_mode: "HTML" });
      return;
    }
    session.dangerousMode = true;
    core.sessionManager.updateSessionDangerousMode(session.id, true).catch(() => {});
  } else {
    // Session not in memory (e.g. after restart) — update store directly
    const record = core.sessionManager.getRecordByThread("telegram", String(threadId));
    if (!record || record.status === "cancelled" || record.status === "error") {
      await ctx.reply("⚠️ No active session in this topic.", { parse_mode: "HTML" });
      return;
    }
    if (record.dangerousMode) {
      await ctx.reply("☠️ Dangerous mode is already enabled.", { parse_mode: "HTML" });
      return;
    }
    core.sessionManager.updateSessionDangerousMode(record.sessionId, true).catch(() => {});
  }
  await ctx.reply(
    `⚠️ <b>Dangerous mode enabled</b>\n\nAll permission requests will be auto-approved. Claude can run arbitrary commands without asking.\n\nUse /disable_dangerous to restore normal behaviour.`,
    { parse_mode: "HTML" },
  );
}

async function handleUpdate(ctx: Context, core: OpenACPCore): Promise<void> {
  if (!core.requestRestart) {
    await ctx.reply("⚠️ Update is not available (no restart handler registered).", { parse_mode: "HTML" });
    return;
  }

  const { getCurrentVersion, getLatestVersion, compareVersions, runUpdate } = await import("../../cli/version.js");
  const current = getCurrentVersion();
  const statusMsg = await ctx.reply(`🔍 Checking for updates... (current: v${escapeHtml(current)})`, { parse_mode: "HTML" });

  const latest = await getLatestVersion();
  if (!latest) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "❌ Could not check for updates.", { parse_mode: "HTML" });
    return;
  }

  if (compareVersions(current, latest) >= 0) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `✅ Already up to date (v${escapeHtml(current)}).`, { parse_mode: "HTML" });
    return;
  }

  await ctx.api.editMessageText(
    ctx.chat!.id,
    statusMsg.message_id,
    `⬇️ Updating v${escapeHtml(current)} → v${escapeHtml(latest)}...`,
    { parse_mode: "HTML" },
  );

  const ok = await runUpdate();
  if (!ok) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "❌ Update failed. Try manually: <code>npm install -g @openacp/cli@latest</code>", { parse_mode: "HTML" });
    return;
  }

  await ctx.api.editMessageText(
    ctx.chat!.id,
    statusMsg.message_id,
    `✅ Updated to v${escapeHtml(latest)}. Restarting...`,
    { parse_mode: "HTML" },
  );

  await new Promise((r) => setTimeout(r, 500));
  await core.requestRestart();
}

async function handleRestart(ctx: Context, core: OpenACPCore): Promise<void> {
  if (!core.requestRestart) {
    await ctx.reply("⚠️ Restart is not available (no restart handler registered).", { parse_mode: "HTML" });
    return;
  }
  await ctx.reply("🔄 <b>Restarting OpenACP...</b>\nRebuilding and restarting. Be back shortly.", { parse_mode: "HTML" });
  // Give Telegram a moment to deliver the message before shutting down
  await new Promise((r) => setTimeout(r, 500));
  await core.requestRestart();
}

async function handleDisableDangerous(ctx: Context, core: OpenACPCore): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) {
    await ctx.reply("⚠️ This command only works inside a session topic.", { parse_mode: "HTML" });
    return;
  }
  const session = core.sessionManager.getSessionByThread("telegram", String(threadId));
  if (session) {
    if (!session.dangerousMode) {
      await ctx.reply("🔐 Dangerous mode is already disabled.", { parse_mode: "HTML" });
      return;
    }
    session.dangerousMode = false;
    core.sessionManager.updateSessionDangerousMode(session.id, false).catch(() => {});
  } else {
    // Session not in memory (e.g. after restart) — update store directly
    const record = core.sessionManager.getRecordByThread("telegram", String(threadId));
    if (!record || record.status === "cancelled" || record.status === "error") {
      await ctx.reply("⚠️ No active session in this topic.", { parse_mode: "HTML" });
      return;
    }
    if (!record.dangerousMode) {
      await ctx.reply("🔐 Dangerous mode is already disabled.", { parse_mode: "HTML" });
      return;
    }
    core.sessionManager.updateSessionDangerousMode(record.sessionId, false).catch(() => {});
  }
  await ctx.reply("🔐 <b>Dangerous mode disabled</b>\n\nPermission requests will be shown normally.", { parse_mode: "HTML" });
}

// grammy's Context exposes .api (the bot's Api instance) and internally the bot
// We need access to the bot instance for createSessionTopic (which uses bot.api.createForumTopic).
// ctx.api is the same Api object as bot.api, so we can pass a minimal shim.
function botFromCtx(ctx: Context): Bot {
  // createSessionTopic only uses bot.api.createForumTopic
  return { api: ctx.api } as unknown as Bot;
}

const TELEGRAM_MSG_LIMIT = 4096;

/**
 * Build plain-text skill command messages. Each command is on its own line
 * wrapped in <code> for tap-to-copy. If the list exceeds Telegram's message
 * limit, it is split into multiple messages (cut at line boundaries).
 */
export function buildSkillMessages(commands: AgentCommand[]): string[] {
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  const header = "🛠 <b>Available Skills</b>\n";
  const lines = sorted.map((c) => `<code>/${c.name}</code>`);

  const messages: string[] = [];
  let current = header;

  for (const line of lines) {
    const candidate = current + "\n" + line;
    if (candidate.length > TELEGRAM_MSG_LIMIT) {
      messages.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) messages.push(current);
  return messages;
}

export async function executeNewSession(
  bot: Bot,
  core: OpenACPCore,
  chatId: number,
  agentName?: string,
  workspace?: string,
): Promise<{ session: Session; threadId: number; firstMsgId: number }> {
  // Create topic with generic name first (same as original handleNew)
  const threadId = await createSessionTopic(bot, chatId, "🔄 New Session");

  const setupMsg = await bot.api.sendMessage(chatId, "⏳ Setting up session, please wait...", {
    message_thread_id: threadId,
    parse_mode: "HTML",
  });
  const firstMsgId = setupMsg.message_id;

  try {
    // core.handleNewSession() already wires events internally — do NOT call wireSessionEvents again
    const session = await core.handleNewSession(
      "telegram",
      agentName,
      workspace,
    );
    session.threadId = String(threadId);

    await core.sessionManager.updateSessionPlatform(session.id, {
      topicId: threadId,
    });

    // Rename topic with agent name after session is created
    const finalName = `🔄 ${session.agentName} — New Session`;
    await renameSessionTopic(bot, chatId, threadId, finalName);

    // Warm up model cache in background while user types
    session.warmup().catch((err) => log.error({ err }, "Warm-up error"));

    return { session, threadId, firstMsgId };
  } catch (err) {
    // Clean up orphaned topic on failure
    try {
      await bot.api.deleteForumTopic(chatId, threadId);
    } catch {
      /* best effort */
    }
    throw err;
  }
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

  await session.cancel();
  return session;
}

async function handleIntegrate(ctx: Context, _core: OpenACPCore): Promise<void> {
  const { listIntegrations } = await import("../../cli/integrate.js");
  const agents = listIntegrations();

  const keyboard = new InlineKeyboard();
  for (const agent of agents) {
    keyboard.text(`🤖 ${agent}`, `i:agent:${agent}`).row();
  }

  await ctx.reply(
    `<b>🔗 Integrations</b>\n\nSelect an agent to manage its integrations.`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

function buildAgentItemsKeyboard(agentName: string, items: import("../../cli/integrate.js").IntegrationItem[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const item of items) {
    const installed = item.isInstalled();
    keyboard.text(
      installed ? `✅ ${item.name} — Uninstall` : `📦 ${item.name} — Install`,
      installed ? `i:uninstall:${agentName}:${item.id}` : `i:install:${agentName}:${item.id}`,
    ).row();
  }
  keyboard.text("← Back", "i:back").row();
  return keyboard;
}

export function setupIntegrateCallbacks(
  bot: Bot,
  core: OpenACPCore,
): void {
  bot.callbackQuery(/^i:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* expired */
    }

    // Back to agent list
    if (data === "i:back") {
      const { listIntegrations } = await import("../../cli/integrate.js");
      const agents = listIntegrations();
      const keyboard = new InlineKeyboard();
      for (const agent of agents) {
        keyboard.text(`🤖 ${agent}`, `i:agent:${agent}`).row();
      }
      try {
        await ctx.editMessageText(
          `<b>🔗 Integrations</b>\n\nSelect an agent to manage its integrations.`,
          { parse_mode: "HTML", reply_markup: keyboard },
        );
      } catch { /* message unchanged */ }
      return;
    }

    // Show agent items
    const agentMatch = data.match(/^i:agent:(.+)$/);
    if (agentMatch) {
      const agentName = agentMatch[1];
      const { getIntegration } = await import("../../cli/integrate.js");
      const integration = getIntegration(agentName);
      if (!integration) {
        await ctx.reply(`❌ No integration available for '${escapeHtml(agentName)}'.`, { parse_mode: "HTML" });
        return;
      }
      const keyboard = buildAgentItemsKeyboard(agentName, integration.items);
      try {
        await ctx.editMessageText(
          `<b>🔗 ${escapeHtml(agentName)} Integrations</b>\n\n${integration.items.map((i) => `• <b>${escapeHtml(i.name)}</b> — ${escapeHtml(i.description)}`).join("\n")}`,
          { parse_mode: "HTML", reply_markup: keyboard },
        );
      } catch {
        await ctx.reply(
          `<b>🔗 ${escapeHtml(agentName)} Integrations</b>`,
          { parse_mode: "HTML", reply_markup: keyboard },
        );
      }
      return;
    }

    // Install / uninstall item
    const actionMatch = data.match(/^i:(install|uninstall):([^:]+):(.+)$/);
    if (!actionMatch) return;

    const action = actionMatch[1] as "install" | "uninstall";
    const agentName = actionMatch[2];
    const itemId = actionMatch[3];

    const { getIntegration } = await import("../../cli/integrate.js");
    const integration = getIntegration(agentName);
    if (!integration) return;

    const item = integration.items.find((i) => i.id === itemId);
    if (!item) return;

    const result = action === "install"
      ? await item.install()
      : await item.uninstall();

    // Save state to config
    const installed = action === "install" && result.success;
    await core.configManager.save({
      integrations: {
        [agentName]: {
          installed,
          installedAt: installed ? new Date().toISOString() : undefined,
        },
      },
    });

    const statusEmoji = result.success ? "✅" : "❌";
    const actionLabel = action === "install" ? "installed" : "uninstalled";
    const logsText = result.logs.map((l) => `<code>${escapeHtml(l)}</code>`).join("\n");
    const resultText = `${statusEmoji} <b>${escapeHtml(item.name)}</b> ${actionLabel}.\n\n${logsText}`;

    const keyboard = buildAgentItemsKeyboard(agentName, integration.items);
    try {
      await ctx.editMessageText(
        `<b>🔗 ${escapeHtml(agentName)} Integrations</b>\n\n${resultText}`,
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch {
      await ctx.reply(resultText, { parse_mode: "HTML" });
    }
  });
}

/**
 * Check if a text message is a workspace path input for the interactive new session flow.
 * Returns true if the message was handled (caller should not process further).
 */
export async function handlePendingWorkspaceInput(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
  assistantTopicId?: number,
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  const pending = pendingNewSessions.get(userId);
  if (!pending || !ctx.message?.text) return false;
  // Accept text input at both "workspace" step (user types directly instead of pressing buttons)
  // and "workspace_input" step (user pressed "Custom path" button)
  if (pending.step !== "workspace_input" && pending.step !== "workspace") return false;

  // Only intercept in assistant topic (or no-thread/general) — never in session topics
  const threadId = ctx.message.message_thread_id;
  if (threadId && threadId !== assistantTopicId) return false;

  let workspace = ctx.message.text.trim();
  if (!workspace || !pending.agentName) {
    await ctx.reply("⚠️ Please enter a valid directory path.", { parse_mode: "HTML" });
    return true;
  }

  // Relative path (no / or ~ prefix) → resolve against baseDir
  if (!workspace.startsWith("/") && !workspace.startsWith("~")) {
    const baseDir = core.configManager.get().workspace.baseDir;
    workspace = `${baseDir.replace(/\/$/, "")}/${workspace}`;
  }

  await startConfirmStep(ctx, chatId, userId, pending.agentName, workspace);
  return true;
}

/**
 * Start the interactive new session flow (agent → workspace → confirm).
 * Used by action-detect when workspace is not provided.
 */
export async function startInteractiveNewSession(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
  agentName?: string,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const agents = core.agentManager.getAvailableAgents();
  const config = core.configManager.get();

  // If agent provided or only 1 agent → skip to workspace step
  if (agentName || agents.length === 1) {
    const selectedAgent = agentName || config.defaultAgent;
    await startWorkspaceStep(ctx, core, chatId, userId, selectedAgent);
    return;
  }

  // Multiple agents → show agent selection
  const keyboard = new InlineKeyboard();
  for (const agent of agents) {
    const label = agent.name === config.defaultAgent
      ? `${agent.name} (default)`
      : agent.name;
    keyboard.text(label, `m:new:agent:${agent.name}`).row();
  }

  const msg = await ctx.reply(
    `🤖 <b>Choose an agent:</b>`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );

  cleanupPending(userId);
  pendingNewSessions.set(userId, {
    step: "agent",
    messageId: msg.message_id,
    threadId: (ctx.callbackQuery as any)?.message?.message_thread_id,
    timer: setTimeout(() => pendingNewSessions.delete(userId), PENDING_TIMEOUT_MS),
  });
}

export const STATIC_COMMANDS = [
  { command: "new", description: "Create new session" },
  { command: "newchat", description: "New chat, same agent & workspace" },
  { command: "cancel", description: "Cancel current session" },
  { command: "status", description: "Show status" },
  { command: "sessions", description: "List all sessions" },
  { command: "agents", description: "List available agents" },
  { command: "help", description: "Help" },
  { command: "menu", description: "Show menu" },
  { command: "enable_dangerous", description: "Auto-approve all permission requests (session only)" },
  { command: "disable_dangerous", description: "Restore normal permission prompts (session only)" },
  { command: "integrate", description: "Manage agent integrations" },
  { command: "handoff", description: "Continue this session in your terminal" },
  { command: "clear", description: "Clear assistant history" },
  { command: "restart", description: "Restart OpenACP" },
  { command: "update", description: "Update to latest version and restart" },
];
