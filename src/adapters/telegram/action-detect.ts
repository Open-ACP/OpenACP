import { nanoid } from "nanoid";
import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { OpenACPCore } from "../../core/core.js";
import { executeNewSession, executeCancelSession } from "./commands.js";

export interface DetectedAction {
  action: "new_session" | "cancel_session";
  agent?: string;
  workspace?: string;
}

// Command patterns: /new [agent] [workspace], /cancel
// Agent and workspace are ASCII-only tokens (no Unicode letters) to avoid matching non-ASCII words
const CMD_NEW_RE =
  /\/new(?:\s+([^\s\u0080-\uFFFF]+)(?:\s+([^\s\u0080-\uFFFF]+))?)?/;
const CMD_CANCEL_RE = /\/cancel\b/;

// Keyword patterns (compound phrases only to avoid false positives)
const KW_NEW_RE = /(?:create|new)\s+session/i;
const KW_CANCEL_RE = /(?:cancel|stop)\s+session/i;

export function detectAction(text: string): DetectedAction | null {
  if (!text) return null;

  // Priority 1: command pattern
  const cancelCmd = CMD_CANCEL_RE.exec(text);
  if (cancelCmd) return { action: "cancel_session" };

  const newCmd = CMD_NEW_RE.exec(text);
  if (newCmd) {
    return {
      action: "new_session",
      agent: newCmd[1] || undefined,
      workspace: newCmd[2] || undefined,
    };
  }

  // Priority 2: keyword matching
  if (KW_CANCEL_RE.test(text)) return { action: "cancel_session" };
  if (KW_NEW_RE.test(text))
    return { action: "new_session", agent: undefined, workspace: undefined };

  return null;
}

// --- Callback map for action buttons ---

const ACTION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const actionMap: Map<string, { action: DetectedAction; createdAt: number }> =
  new Map();

export function storeAction(action: DetectedAction): string {
  const id = nanoid(10);
  actionMap.set(id, { action, createdAt: Date.now() });
  // Cleanup expired entries
  for (const [key, entry] of actionMap) {
    if (Date.now() - entry.createdAt > ACTION_TTL_MS) {
      actionMap.delete(key);
    }
  }
  return id;
}

export function getAction(id: string): DetectedAction | undefined {
  const entry = actionMap.get(id);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > ACTION_TTL_MS) {
    actionMap.delete(id);
    return undefined;
  }
  return entry.action;
}

export function removeAction(id: string): void {
  actionMap.delete(id);
}

export function buildActionKeyboard(
  actionId: string,
  action: DetectedAction,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (action.action === "new_session") {
    keyboard.text("✅ Create session", `a:${actionId}`);
    keyboard.text("❌ Cancel", `a:dismiss:${actionId}`);
  } else {
    keyboard.text("⛔ Cancel session", `a:${actionId}`);
    keyboard.text("❌ No", `a:dismiss:${actionId}`);
  }
  return keyboard;
}

export function setupActionCallbacks(
  bot: Bot,
  core: OpenACPCore,
  chatId: number,
  getAssistantSessionId: () => string | undefined,
): void {
  // IMPORTANT: dismiss handler MUST be registered BEFORE generic a: handler
  // because grammY routes to the first matching handler and /^a:/ also matches a:dismiss:
  bot.callbackQuery(/^a:dismiss:/, async (ctx) => {
    const actionId = ctx.callbackQuery.data.replace("a:dismiss:", "");
    removeAction(actionId);
    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      /* message may be old */
    }
    await ctx.answerCallbackQuery({ text: "Dismissed" });
  });

  bot.callbackQuery(/^a:(?!dismiss)/, async (ctx) => {
    const actionId = ctx.callbackQuery.data.replace("a:", "");
    const action = getAction(actionId);
    if (!action) {
      await ctx.answerCallbackQuery({ text: "Action expired" });
      return;
    }
    removeAction(actionId);

    try {
      if (action.action === "new_session") {
        await ctx.answerCallbackQuery({ text: "⏳ Creating session..." });
        const { threadId, firstMsgId } = await executeNewSession(
          bot,
          core,
          chatId,
          action.agent,
          action.workspace,
        );
        const topicLink = `https://t.me/c/${String(chatId).replace("-100", "")}/${firstMsgId ?? threadId}`;
        const originalText = ctx.callbackQuery.message?.text ?? "";
        try {
          await ctx.editMessageText(
            originalText +
              `\n\n✅ Session created → <a href="${topicLink}">Go to topic</a>`,
            { parse_mode: "HTML" },
          );
        } catch {
          await ctx.editMessageReplyMarkup({
            reply_markup: { inline_keyboard: [] },
          });
        }
      } else if (action.action === "cancel_session") {
        const assistantId = getAssistantSessionId();
        const cancelled = await executeCancelSession(core, assistantId);
        if (cancelled) {
          await ctx.answerCallbackQuery({ text: "⛔ Session cancelled" });
          const originalText = ctx.callbackQuery.message?.text ?? "";
          try {
            await ctx.editMessageText(
              originalText +
                `\n\n⛔ Session "${cancelled.name ?? cancelled.id}" cancelled`,
              { parse_mode: "HTML" },
            );
          } catch {
            await ctx.editMessageReplyMarkup({
              reply_markup: { inline_keyboard: [] },
            });
          }
        } else {
          await ctx.answerCallbackQuery({
            text: "No active session",
          });
          try {
            await ctx.editMessageReplyMarkup({
              reply_markup: { inline_keyboard: [] },
            });
          } catch {
            /* best effort */
          }
        }
      }
    } catch {
      await ctx.answerCallbackQuery({ text: "❌ Error, try again later" });
      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        /* best effort */
      }
    }
  });
}
