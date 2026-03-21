import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { OpenACPCore } from "../../core/index.js";
import type { Session } from "../../core/session.js";
import { escapeHtml } from "./formatting.js";
import { createSessionTopic, renameSessionTopic } from "./topics.js";
import { createChildLogger } from "../../core/log.js";
import { nanoid } from "nanoid";
import type { AgentCommand } from "../../core/index.js";
const log = createChildLogger({ module: "telegram-commands" });

interface AssistantContext {
  topicId: number;
  getSession: () => Session | null;
}

export function setupCommands(
  bot: Bot,
  core: OpenACPCore,
  chatId: number,
  assistant?: AssistantContext,
): void {
  bot.command("new", (ctx) => handleNew(ctx, core, chatId, assistant));
  bot.command("new_chat", (ctx) => handleNewChat(ctx, core, chatId));
  bot.command("cancel", (ctx) => handleCancel(ctx, core, assistant));
  bot.command("status", (ctx) => handleStatus(ctx, core));
  bot.command("agents", (ctx) => handleAgents(ctx, core));
  bot.command("help", (ctx) => handleHelp(ctx));
  bot.command("menu", (ctx) => handleMenu(ctx));
  bot.command("enable_dangerous", (ctx) => handleEnableDangerous(ctx, core));
  bot.command("disable_dangerous", (ctx) => handleDisableDangerous(ctx, core));
  bot.command("restart", (ctx) => handleRestart(ctx, core));
  bot.command("update", (ctx) => handleUpdate(ctx, core));
}

export function buildMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🆕 New Session", "m:new")
    .text("💬 New Chat", "m:new_chat")
    .row()
    .text("⛔ Cancel", "m:cancel")
    .text("📊 Status", "m:status")
    .row()
    .text("🤖 Agents", "m:agents")
    .text("❓ Help", "m:help")
    .row()
    .text("🔄 Restart", "m:restart")
    .text("⬆️ Update", "m:update");
}

export function setupMenuCallbacks(
  bot: Bot,
  core: OpenACPCore,
  chatId: number,
): void {
  bot.callbackQuery(/^m:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* expired or network — ignore */
    }

    switch (data) {
      case "m:new":
        await handleNew(ctx, core, chatId);
        break;
      case "m:new_chat":
        await handleNewChat(ctx, core, chatId);
        break;
      case "m:cancel":
        await handleCancel(ctx, core);
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

  // In assistant topic: if missing params, forward to assistant for conversational gathering
  const currentThreadId = ctx.message?.message_thread_id;
  if (
    assistant &&
    currentThreadId === assistant.topicId &&
    (!agentName || !workspace)
  ) {
    const assistantSession = assistant.getSession();
    if (assistantSession) {
      const prompt = agentName
        ? `User wants to create a new session with agent "${agentName}" but didn't specify a workspace. Ask them which workspace to use.`
        : `User wants to create a new session. Ask them which agent and workspace to use.`;
      await assistantSession.enqueuePrompt(prompt);
      return;
    }
  }

  log.info({ userId: ctx.from?.id, agentName }, "New session command");

  // Create topic first so threadId is ready before session events fire
  let threadId: number | undefined;
  try {
    const topicName = `🔄 New Session`;
    threadId = await createSessionTopic(botFromCtx(ctx), chatId, topicName);

    // Let user know we're setting up (spawn + warm-up can take a while)
    await ctx.api.sendMessage(chatId, `⏳ Setting up session, please wait...`, {
      message_thread_id: threadId,
      parse_mode: "HTML",
    });

    const session = await core.handleNewSession(
      "telegram",
      agentName,
      workspace,
    );
    session.threadId = String(threadId);

    // Persist platform mapping
    await core.sessionManager.updateSessionPlatform(session.id, {
      topicId: threadId,
    });

    // Rename topic with actual agent name
    const finalName = `🔄 ${session.agentName} — New Session`;
    try {
      await ctx.api.editForumTopic(chatId, threadId, { name: finalName });
    } catch {
      /* ignore rename failures */
    }

    await ctx.api.sendMessage(
      chatId,
      `✅ Session started\n` +
        `<b>Agent:</b> ${escapeHtml(session.agentName)}\n` +
        `<b>Workspace:</b> <code>${escapeHtml(session.workingDirectory)}</code>`,
      {
        message_thread_id: threadId,
        parse_mode: "HTML",
        reply_markup: buildDangerousModeKeyboard(session.id, false),
      },
    );

    // Warm up model cache in background while user types
    session.warmup().catch((err) => log.error({ err }, "Warm-up error"));
  } catch (err) {
    log.error({ err }, "Session creation failed");
    // Clean up orphaned topic if session creation failed
    if (threadId) {
      try {
        await ctx.api.deleteForumTopic(chatId, threadId);
      } catch {
        /* ignore cleanup failures */
      }
    }
    const message = err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err));
    await ctx.reply(`❌ ${escapeHtml(message)}`, { parse_mode: "HTML" });
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
      "Use /new_chat inside a session topic to inherit its config.",
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
    `<b>OpenACP Commands:</b>\n\n` +
      `/new [agent] [workspace] — Create new session\n` +
      `/new_chat — New chat, same agent &amp; workspace\n` +
      `/cancel — Cancel current session\n` +
      `/status — Show session/system status\n` +
      `/agents — List available agents\n` +
      `/menu — Show interactive menu\n` +
      `/restart — Restart OpenACP\n` +
      `/update — Update to latest version and restart\n` +
      `/help — Show this help\n\n` +
      `Or just chat in the 🤖 Assistant topic for help!`,
    { parse_mode: "HTML" },
  );
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
    if (!session) {
      try { await ctx.answerCallbackQuery({ text: "⚠️ Session not found or already ended." }); } catch { /* expired */ }
      return;
    }

    session.dangerousMode = !session.dangerousMode;
    log.info({ sessionId, dangerousMode: session.dangerousMode }, "Dangerous mode toggled via button");

    const toastText = session.dangerousMode
      ? "☠️ Dangerous mode enabled — permissions auto-approved"
      : "🔐 Dangerous mode disabled — permissions shown normally";
    try { await ctx.answerCallbackQuery({ text: toastText }); } catch { /* expired */ }

    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: buildDangerousModeKeyboard(sessionId, session.dangerousMode),
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
  if (!session) {
    await ctx.reply("⚠️ No active session in this topic.", { parse_mode: "HTML" });
    return;
  }
  if (session.dangerousMode) {
    await ctx.reply("☠️ Dangerous mode is already enabled.", { parse_mode: "HTML" });
    return;
  }
  session.dangerousMode = true;
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
  if (!session) {
    await ctx.reply("⚠️ No active session in this topic.", { parse_mode: "HTML" });
    return;
  }
  if (!session.dangerousMode) {
    await ctx.reply("🔐 Dangerous mode is already disabled.", { parse_mode: "HTML" });
    return;
  }
  session.dangerousMode = false;
  await ctx.reply("🔐 <b>Dangerous mode disabled</b>\n\nPermission requests will be shown normally.", { parse_mode: "HTML" });
}

// grammy's Context exposes .api (the bot's Api instance) and internally the bot
// We need access to the bot instance for createSessionTopic (which uses bot.api.createForumTopic).
// ctx.api is the same Api object as bot.api, so we can pass a minimal shim.
function botFromCtx(ctx: Context): Bot {
  // createSessionTopic only uses bot.api.createForumTopic
  return { api: ctx.api } as unknown as Bot;
}

// Skill command callback lookup map (short key → session + command)
interface SkillCallbackEntry {
  sessionId: string;
  commandName: string;
}

const skillCallbackMap = new Map<string, SkillCallbackEntry>();

export function buildSkillKeyboard(
  sessionId: string,
  commands: AgentCommand[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < sorted.length; i++) {
    const cmd = sorted[i];
    const key = nanoid(8);
    skillCallbackMap.set(key, { sessionId, commandName: cmd.name });
    keyboard.text(`/${cmd.name}`, `s:${key}`);
    if (i % 2 === 1 && i < sorted.length - 1) {
      keyboard.row();
    }
  }
  return keyboard;
}

export function clearSkillCallbacks(sessionId: string): void {
  for (const [key, entry] of skillCallbackMap) {
    if (entry.sessionId === sessionId) {
      skillCallbackMap.delete(key);
    }
  }
}

export function setupSkillCallbacks(bot: Bot, core: OpenACPCore): void {
  bot.callbackQuery(/^s:/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* expired */
    }

    const key = ctx.callbackQuery.data.slice(2);
    const entry = skillCallbackMap.get(key);
    if (!entry) return;

    const session = core.sessionManager.getSession(entry.sessionId);
    if (!session || session.status !== "active") return;

    await session.enqueuePrompt(`/${entry.commandName}`);
  });
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

export const STATIC_COMMANDS = [
  { command: "new", description: "Create new session" },
  { command: "new_chat", description: "New chat, same agent & workspace" },
  { command: "cancel", description: "Cancel current session" },
  { command: "status", description: "Show status" },
  { command: "agents", description: "List available agents" },
  { command: "help", description: "Help" },
  { command: "menu", description: "Show menu" },
  { command: "enable_dangerous", description: "Auto-approve all permission requests (session only)" },
  { command: "disable_dangerous", description: "Restore normal permission prompts (session only)" },
  { command: "restart", description: "Restart OpenACP" },
  { command: "update", description: "Update to latest version and restart" },
];
