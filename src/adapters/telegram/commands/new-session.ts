import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { OpenACPCore } from "../../../core/index.js";
import type { Session } from "../../../core/session.js";
import { escapeHtml } from "../formatting.js";
import { createSessionTopic, renameSessionTopic, buildDeepLink } from "../topics.js";
import { createChildLogger } from "../../../core/log.js";
import { buildDangerousModeKeyboard } from "./admin.js";
import type { CommandsAssistantContext } from "../types.js";
const log = createChildLogger({ module: "telegram-cmd-new-session" });

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

function botFromCtx(ctx: Context): Bot {
  // createSessionTopic only uses bot.api.createForumTopic
  return { api: ctx.api } as unknown as Bot;
}

export async function handleNew(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
  assistant?: CommandsAssistantContext,
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

    await core.sessionManager.patchRecord(session.id, { platform: { topicId: threadId } });

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

export async function handleNewChat(
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
    await core.sessionManager.patchRecord(session.id, { platform: {
      topicId: newThreadId,
    } });

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

    await core.sessionManager.patchRecord(session.id, { platform: {
      topicId: threadId,
    } });

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

export function setupNewSessionCallbacks(
  bot: Bot,
  core: OpenACPCore,
  chatId: number,
): void {
  bot.callbackQuery(/^m:new:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
      await ctx.answerCallbackQuery();
    } catch { /* expired or network — ignore */ }

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
  });
}
