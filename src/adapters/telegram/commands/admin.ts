import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { OpenACPCore } from "../../../core/index.js";
import { escapeHtml } from "../formatting.js";
import { createChildLogger } from "../../../core/log.js";
const log = createChildLogger({ module: "telegram-cmd-admin" });

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
      core.sessionManager.patchRecord(sessionId, { dangerousMode: session.dangerousMode }).catch(() => {});

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
    core.sessionManager.patchRecord(sessionId, { dangerousMode: newDangerousMode }).catch(() => {});
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

export async function handleEnableDangerous(ctx: Context, core: OpenACPCore): Promise<void> {
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
    core.sessionManager.patchRecord(session.id, { dangerousMode: true }).catch(() => {});
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
    core.sessionManager.patchRecord(record.sessionId, { dangerousMode: true }).catch(() => {});
  }
  await ctx.reply(
    `⚠️ <b>Dangerous mode enabled</b>\n\nAll permission requests will be auto-approved. Claude can run arbitrary commands without asking.\n\nUse /disable_dangerous to restore normal behaviour.`,
    { parse_mode: "HTML" },
  );
}

export async function handleDisableDangerous(ctx: Context, core: OpenACPCore): Promise<void> {
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
    core.sessionManager.patchRecord(session.id, { dangerousMode: false }).catch(() => {});
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
    core.sessionManager.patchRecord(record.sessionId, { dangerousMode: false }).catch(() => {});
  }
  await ctx.reply("🔐 <b>Dangerous mode disabled</b>\n\nPermission requests will be shown normally.", { parse_mode: "HTML" });
}

export async function handleUpdate(ctx: Context, core: OpenACPCore): Promise<void> {
  if (!core.requestRestart) {
    await ctx.reply("⚠️ Update is not available (no restart handler registered).", { parse_mode: "HTML" });
    return;
  }

  const { getCurrentVersion, getLatestVersion, compareVersions, runUpdate } = await import("../../../cli/version.js");
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

export async function handleRestart(ctx: Context, core: OpenACPCore): Promise<void> {
  if (!core.requestRestart) {
    await ctx.reply("⚠️ Restart is not available (no restart handler registered).", { parse_mode: "HTML" });
    return;
  }
  await ctx.reply("🔄 <b>Restarting OpenACP...</b>\nRebuilding and restarting. Be back shortly.", { parse_mode: "HTML" });
  // Give Telegram a moment to deliver the message before shutting down
  await new Promise((r) => setTimeout(r, 500));
  await core.requestRestart();
}
