import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { OpenACPCore } from "../../core/index.js";
import { escapeHtml } from "./formatting.js";
import { createSessionTopic } from "./topics.js";
import { createChildLogger } from '../../core/log.js'
const log = createChildLogger({ module: 'telegram-commands' })

export function setupCommands(
  bot: Bot,
  core: OpenACPCore,
  chatId: number,
): void {
  bot.command("new", (ctx) => handleNew(ctx, core, chatId));
  bot.command("new_chat", (ctx) => handleNewChat(ctx, core, chatId));
  bot.command("cancel", (ctx) => handleCancel(ctx, core));
  bot.command("status", (ctx) => handleStatus(ctx, core));
  bot.command("agents", (ctx) => handleAgents(ctx, core));
  bot.command("help", (ctx) => handleHelp(ctx));
  bot.command("menu", (ctx) => handleMenu(ctx));
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
    .text("❓ Help", "m:help");
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
): Promise<void> {
  const rawMatch = (ctx as Context & { match: unknown }).match;
  const matchStr = typeof rawMatch === "string" ? rawMatch : "";
  const args = matchStr.split(" ").filter(Boolean);
  const agentName = args[0];
  const workspace = args[1];

  log.info({ userId: ctx.from?.id, agentName }, 'New session command')

  // Create topic first so threadId is ready before session events fire
  let threadId: number | undefined;
  try {
    const topicName = `🔄 New Session`;
    threadId = await createSessionTopic(botFromCtx(ctx), chatId, topicName);

    const session = await core.handleNewSession(
      "telegram",
      agentName,
      workspace,
    );
    session.threadId = String(threadId);

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
      },
    );
  } catch (err) {
    // Clean up orphaned topic if session creation failed
    if (threadId) {
      try {
        await ctx.api.deleteForumTopic(chatId, threadId);
      } catch {
        /* ignore cleanup failures */
      }
    }
    const message = err instanceof Error ? err.message : String(err);
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

  try {
    const session = await core.handleNewChat("telegram", String(threadId));
    if (!session) {
      await ctx.reply("No active session in this topic.", {
        parse_mode: "HTML",
      });
      return;
    }

    const topicName = `🔄 ${session.agentName} — New Chat`;
    const newThreadId = await createSessionTopic(
      botFromCtx(ctx),
      chatId,
      topicName,
    );
    session.threadId = String(newThreadId);

    await ctx.api.sendMessage(
      chatId,
      `✅ New chat (same agent &amp; workspace)\n` +
        `<b>Agent:</b> ${escapeHtml(session.agentName)}\n` +
        `<b>Workspace:</b> <code>${escapeHtml(session.workingDirectory)}</code>`,
      {
        message_thread_id: newThreadId,
        parse_mode: "HTML",
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ ${escapeHtml(message)}`, { parse_mode: "HTML" });
  }
}

async function handleCancel(ctx: Context, core: OpenACPCore): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return;

  const session = core.sessionManager.getSessionByThread(
    "telegram",
    String(threadId),
  );
  if (session) {
    log.info({ sessionId: session.id }, 'Cancel session command')
    await session.cancel();
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
          `<b>Queue:</b> ${session.promptQueue.length} pending`,
        { parse_mode: "HTML" },
      );
    } else {
      await ctx.reply("No active session in this topic.", {
        parse_mode: "HTML",
      });
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
      `/help — Show this help\n\n` +
      `Or just chat in the 🤖 Assistant topic for help!`,
    { parse_mode: "HTML" },
  );
}

// grammy's Context exposes .api (the bot's Api instance) and internally the bot
// We need access to the bot instance for createSessionTopic (which uses bot.api.createForumTopic).
// ctx.api is the same Api object as bot.api, so we can pass a minimal shim.
function botFromCtx(ctx: Context): Bot {
  // createSessionTopic only uses bot.api.createForumTopic
  return { api: ctx.api } as unknown as Bot;
}
