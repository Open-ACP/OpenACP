import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { OpenACPCore } from "../../../core/index.js";
import { getSafeFields, resolveOptions, getConfigValue, isHotReloadable, type ConfigFieldDef } from "../../../core/config-registry.js";
import { createChildLogger } from "../../../core/log.js";

const log = createChildLogger({ module: "telegram-settings" });

function buildSettingsKeyboard(core: OpenACPCore): InlineKeyboard {
  const config = core.configManager.get();
  const fields = getSafeFields();
  const kb = new InlineKeyboard();

  for (const field of fields) {
    const value = getConfigValue(config, field.path);
    const label = formatFieldLabel(field, value);

    if (field.type === 'toggle') {
      kb.text(`${label}`, `s:toggle:${field.path}`).row();
    } else if (field.type === 'select') {
      kb.text(`${label}`, `s:select:${field.path}`).row();
    } else {
      kb.text(`${label}`, `s:input:${field.path}`).row();
    }
  }

  kb.text("◀️ Back to Menu", "s:back");
  return kb;
}

function formatFieldLabel(field: ConfigFieldDef, value: unknown): string {
  const icons: Record<string, string> = {
    agent: '🤖', logging: '📝', tunnel: '🔗',
    security: '🔒', workspace: '📁', storage: '💾',
  };
  const icon = icons[field.group] ?? '⚙️';

  if (field.type === 'toggle') {
    return `${icon} ${field.displayName}: ${value ? 'ON' : 'OFF'}`;
  }
  return `${icon} ${field.displayName}: ${String(value)}`;
}

export async function handleSettings(ctx: Context, core: OpenACPCore): Promise<void> {
  const kb = buildSettingsKeyboard(core);
  await ctx.reply(`<b>⚙️ Settings</b>\nTap to change:`, {
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

export function setupSettingsCallbacks(
  bot: Bot,
  core: OpenACPCore,
  getAssistantSession: () => { topicId: number; enqueuePrompt: (p: string) => Promise<void> } | undefined,
): void {
  bot.callbackQuery(/^s:toggle:/, async (ctx) => {
    const fieldPath = ctx.callbackQuery.data.replace('s:toggle:', '');
    const config = core.configManager.get();
    const currentValue = getConfigValue(config, fieldPath);
    const newValue = !currentValue;

    try {
      const updates = buildNestedUpdate(fieldPath, newValue);
      await core.configManager.save(updates, fieldPath);

      const toast = isHotReloadable(fieldPath)
        ? `✅ ${fieldPath} = ${newValue}`
        : `✅ ${fieldPath} = ${newValue} (restart needed)`;
      try { await ctx.answerCallbackQuery({ text: toast }); } catch { /* expired */ }

      try {
        await ctx.editMessageReplyMarkup({ reply_markup: buildSettingsKeyboard(core) });
      } catch { /* ignore */ }
    } catch (err) {
      log.error({ err, fieldPath }, 'Failed to toggle config');
      try { await ctx.answerCallbackQuery({ text: '❌ Failed to update' }); } catch { /* expired */ }
    }
  });

  bot.callbackQuery(/^s:select:/, async (ctx) => {
    const fieldPath = ctx.callbackQuery.data.replace('s:select:', '');
    const config = core.configManager.get();
    const fieldDef = getSafeFields().find(f => f.path === fieldPath);
    if (!fieldDef) return;

    const options = resolveOptions(fieldDef, config) ?? [];
    const currentValue = getConfigValue(config, fieldPath);
    const kb = new InlineKeyboard();

    for (const opt of options) {
      const marker = opt === String(currentValue) ? ' ✓' : '';
      kb.text(`${opt}${marker}`, `s:pick:${fieldPath}:${opt}`).row();
    }
    kb.text("◀️ Back", "s:back:refresh");

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    try {
      await ctx.editMessageText(`<b>⚙️ ${fieldDef.displayName}</b>\nSelect a value:`, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    } catch { /* ignore */ }
  });

  bot.callbackQuery(/^s:pick:/, async (ctx) => {
    const parts = ctx.callbackQuery.data.replace('s:pick:', '').split(':');
    const fieldPath = parts.slice(0, -1).join(':');
    const newValue = parts[parts.length - 1];

    try {
      const updates = buildNestedUpdate(fieldPath, newValue);
      await core.configManager.save(updates, fieldPath);

      try { await ctx.answerCallbackQuery({ text: `✅ ${fieldPath} = ${newValue}` }); } catch { /* expired */ }
      try {
        await ctx.editMessageText(`<b>⚙️ Settings</b>\nTap to change:`, {
          parse_mode: "HTML",
          reply_markup: buildSettingsKeyboard(core),
        });
      } catch { /* ignore */ }
    } catch (err) {
      log.error({ err, fieldPath }, 'Failed to set config');
      try { await ctx.answerCallbackQuery({ text: '❌ Failed to update' }); } catch { /* expired */ }
    }
  });

  bot.callbackQuery(/^s:input:/, async (ctx) => {
    const fieldPath = ctx.callbackQuery.data.replace('s:input:', '');
    const config = core.configManager.get();
    const fieldDef = getSafeFields().find(f => f.path === fieldPath);
    if (!fieldDef) return;

    const currentValue = getConfigValue(config, fieldPath);
    const assistant = getAssistantSession();

    if (!assistant) {
      try { await ctx.answerCallbackQuery({ text: '⚠️ Start the assistant first (/assistant)' }); } catch { /* expired */ }
      return;
    }

    try { await ctx.answerCallbackQuery({ text: `Delegating to assistant...` }); } catch { /* expired */ }

    const prompt = `User wants to change ${fieldDef.displayName} (config path: ${fieldPath}). Current value: ${JSON.stringify(currentValue)}. Ask them for the new value and apply it using: openacp config set ${fieldPath} <value>`;
    await assistant.enqueuePrompt(prompt);
  });

  bot.callbackQuery("s:back", async (ctx) => {
    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }
    const { buildMenuKeyboard } = await import('./menu.js');
    try {
      await ctx.editMessageText(`<b>OpenACP Menu</b>\nChoose an action:`, {
        parse_mode: "HTML",
        reply_markup: buildMenuKeyboard(),
      });
    } catch { /* ignore */ }
  });

  bot.callbackQuery("s:back:refresh", async (ctx) => {
    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }
    try {
      await ctx.editMessageText(`<b>⚙️ Settings</b>\nTap to change:`, {
        parse_mode: "HTML",
        reply_markup: buildSettingsKeyboard(core),
      });
    } catch { /* ignore */ }
  });
}

function buildNestedUpdate(dotPath: string, value: unknown): Record<string, unknown> {
  const parts = dotPath.split('.');
  const result: Record<string, unknown> = {};
  let target = result;
  for (let i = 0; i < parts.length - 1; i++) {
    target[parts[i]] = {};
    target = target[parts[i]] as Record<string, unknown>;
  }
  target[parts[parts.length - 1]] = value;
  return result;
}
