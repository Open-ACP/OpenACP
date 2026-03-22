# Dynamic Config Update System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable runtime config updates through a config registry, with hot-reload support, Telegram Settings menu, smart-routing CLI, and assistant integration.

**Architecture:** A central config registry (`config-registry.ts`) defines metadata for each config field (scope, type, hot-reload). The API layer uses this registry to determine restart needs and emit change events. The Telegram adapter reads the registry to auto-generate a Settings menu. The CLI `openacp config` smart-routes to API when server is running.

**Tech Stack:** TypeScript, Zod (existing), pino (existing), grammY (existing), vitest (existing)

**Spec:** `docs/superpowers/specs/2026-03-22-dynamic-config-update-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/config-registry.ts` | Create | Config field metadata registry — types, scope, hot-reload flags, helpers |
| `src/core/config.ts` | Modify | Add EventEmitter to ConfigManager for `config:changed` events |
| `src/core/log.ts` | Modify | Export `setLogLevel()` for runtime log level changes |
| `src/core/api-server.ts` | Modify | Add `/api/config/editable`, replace `RESTART_PREFIXES` with registry lookup, emit events |
| `src/core/core.ts` | Modify | Subscribe to `config:changed` for logger reconfiguration |
| `src/core/index.ts` | Modify | Export new config-registry types |
| `src/adapters/telegram/commands/menu.ts` | Modify | Add Settings button to menu keyboard |
| `src/adapters/telegram/commands/settings.ts` | Create | Settings menu handlers — toggle, select, delegation to assistant |
| `src/adapters/telegram/commands/index.ts` | Modify | Register settings callbacks, export setup function |
| `src/adapters/telegram/assistant.ts` | Modify | Update system prompt — `openacp config set` instead of `openacp api config set` |
| `src/cli.ts` | Modify | Pass `args` to `cmdConfig()` |
| `src/cli/commands.ts` | Modify | Smart-routing `cmdConfig()`, `config set` subcommand, deprecate `api config` |
| `src/core/config-editor.ts` | Modify | Add `mode` param for API routing |

---

### Task 1: Config Registry

**Files:**
- Create: `src/core/config-registry.ts`
- Create: `src/core/__tests__/config-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/__tests__/config-registry.test.ts
import { describe, it, expect } from 'vitest'
import {
  CONFIG_REGISTRY,
  getFieldDef,
  getSafeFields,
  isHotReloadable,
  type ConfigFieldDef,
} from '../config-registry.js'

describe('config-registry', () => {
  it('exports a non-empty registry', () => {
    expect(CONFIG_REGISTRY.length).toBeGreaterThan(0)
  })

  it('getFieldDef returns definition for known path', () => {
    const def = getFieldDef('defaultAgent')
    expect(def).toBeDefined()
    expect(def!.type).toBe('select')
    expect(def!.scope).toBe('safe')
  })

  it('getFieldDef returns undefined for unknown path', () => {
    expect(getFieldDef('nonexistent.path')).toBeUndefined()
  })

  it('getSafeFields returns only safe-scoped fields', () => {
    const safe = getSafeFields()
    expect(safe.length).toBeGreaterThan(0)
    for (const field of safe) {
      expect(field.scope).toBe('safe')
    }
  })

  it('isHotReloadable returns correct values', () => {
    expect(isHotReloadable('defaultAgent')).toBe(true)
    expect(isHotReloadable('logging.level')).toBe(true)
    expect(isHotReloadable('tunnel.enabled')).toBe(false)
    // Unknown paths are not hot-reloadable
    expect(isHotReloadable('channels.telegram.botToken')).toBe(false)
  })

  it('all safe fields have required metadata', () => {
    const safe = getSafeFields()
    for (const field of safe) {
      expect(field.path).toBeTruthy()
      expect(field.displayName).toBeTruthy()
      expect(field.group).toBeTruthy()
      expect(['toggle', 'select', 'number', 'string']).toContain(field.type)
      if (field.type === 'select') {
        expect(field.options).toBeDefined()
      }
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/core/__tests__/config-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the config registry**

```ts
// src/core/config-registry.ts
import type { Config } from './config.js'

export interface ConfigFieldDef {
  path: string
  displayName: string
  group: string
  type: 'toggle' | 'select' | 'number' | 'string'
  options?: string[] | ((config: Config) => string[])
  scope: 'safe' | 'sensitive'
  hotReload: boolean
}

export const CONFIG_REGISTRY: ConfigFieldDef[] = [
  // --- Safe fields (editable via Telegram/API) ---
  {
    path: 'defaultAgent',
    displayName: 'Default Agent',
    group: 'agent',
    type: 'select',
    options: (config) => Object.keys(config.agents),
    scope: 'safe',
    hotReload: true,
  },
  {
    path: 'logging.level',
    displayName: 'Log Level',
    group: 'logging',
    type: 'select',
    options: ['silent', 'debug', 'info', 'warn', 'error', 'fatal'],
    scope: 'safe',
    hotReload: true,
  },
  {
    path: 'tunnel.enabled',
    displayName: 'Tunnel',
    group: 'tunnel',
    type: 'toggle',
    scope: 'safe',
    hotReload: false,
  },
  {
    path: 'security.maxConcurrentSessions',
    displayName: 'Max Concurrent Sessions',
    group: 'security',
    type: 'number',
    scope: 'safe',
    hotReload: true,
  },
  {
    path: 'security.sessionTimeoutMinutes',
    displayName: 'Session Timeout (min)',
    group: 'security',
    type: 'number',
    scope: 'safe',
    hotReload: true,
  },
  {
    path: 'workspace.baseDir',
    displayName: 'Workspace Directory',
    group: 'workspace',
    type: 'string',
    scope: 'safe',
    hotReload: true,
  },
  {
    path: 'sessionStore.ttlDays',
    displayName: 'Session Store TTL (days)',
    group: 'storage',
    type: 'number',
    scope: 'safe',
    hotReload: true,
  },
]

export function getFieldDef(path: string): ConfigFieldDef | undefined {
  return CONFIG_REGISTRY.find((f) => f.path === path)
}

export function getSafeFields(): ConfigFieldDef[] {
  return CONFIG_REGISTRY.filter((f) => f.scope === 'safe')
}

export function isHotReloadable(path: string): boolean {
  const def = getFieldDef(path)
  return def?.hotReload ?? false
}

/** Resolve options for a select field — handles both static arrays and dynamic functions */
export function resolveOptions(def: ConfigFieldDef, config: Config): string[] | undefined {
  if (!def.options) return undefined
  return typeof def.options === 'function' ? def.options(config) : def.options
}

/** Read a config value by dot-path */
export function getConfigValue(config: Config, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = config
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/core/__tests__/config-registry.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Export from index.ts**

Add to `src/core/index.ts`:
```ts
export { CONFIG_REGISTRY, getFieldDef, getSafeFields, isHotReloadable, resolveOptions, getConfigValue, type ConfigFieldDef } from './config-registry.js'
```

- [ ] **Step 6: Build check**

Run: `pnpm build`
Expected: PASS, no type errors

- [ ] **Step 7: Commit**

```bash
git add src/core/config-registry.ts src/core/__tests__/config-registry.test.ts src/core/index.ts
git commit -m "feat: add config registry with field metadata"
```

---

### Task 2: ConfigManager EventEmitter + Log Level Runtime Change

**Files:**
- Modify: `src/core/config.ts:135-203` (ConfigManager class)
- Modify: `src/core/log.ts` (add setLogLevel export)
- Modify: `src/core/core.ts` (subscribe to config:changed)
- Test: `src/core/__tests__/config-registry.test.ts` (extend with event tests)

- [ ] **Step 1: Write failing test for ConfigManager events**

Add to `src/core/__tests__/config-registry.test.ts` (also add `beforeEach, afterEach, vi` to the existing imports from `vitest`):

```ts
import { ConfigManager } from '../config.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

describe('ConfigManager events', () => {
  let tmpDir: string
  let cm: ConfigManager

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-config-test-'))
    const configPath = path.join(tmpDir, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify({
      channels: { telegram: { enabled: false, botToken: 'test', chatId: 0 } },
      agents: { claude: { command: 'claude', args: [] } },
      defaultAgent: 'claude',
    }))
    process.env.OPENACP_CONFIG_PATH = configPath
    cm = new ConfigManager()
    await cm.load()
  })

  afterEach(() => {
    delete process.env.OPENACP_CONFIG_PATH
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('emits config:changed event on save', async () => {
    const events: Array<{ path: string; value: unknown }> = []
    cm.on('config:changed', (e) => events.push(e))

    await cm.save({ defaultAgent: 'codex' }, 'defaultAgent')
    expect(events).toHaveLength(1)
    expect(events[0].path).toBe('defaultAgent')
    expect(events[0].value).toBe('codex')
  })

  it('does not emit event when no changePath provided', async () => {
    const events: Array<unknown> = []
    cm.on('config:changed', (e) => events.push(e))

    await cm.save({ defaultAgent: 'codex' })
    expect(events).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/core/__tests__/config-registry.test.ts`
Expected: FAIL — `cm.on is not a function`

- [ ] **Step 3: Add EventEmitter to ConfigManager**

Modify `src/core/config.ts`. Change the class declaration:

```ts
import { EventEmitter } from 'node:events'

export class ConfigManager extends EventEmitter {
  private config!: Config;
  private configPath: string;

  constructor() {
    super()
    this.configPath =
      process.env.OPENACP_CONFIG_PATH || expandHome("~/.openacp/config.json");
  }
```

Update the `save()` method signature to accept optional `changePath`:

```ts
  async save(updates: Record<string, unknown>, changePath?: string): Promise<void> {
    const oldConfig = this.config ? structuredClone(this.config) : undefined
    // Read current file, merge updates, write back
    const raw = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    this.deepMerge(raw, updates);
    fs.writeFileSync(this.configPath, JSON.stringify(raw, null, 2));
    // Re-validate and update in-memory config
    const result = ConfigSchema.safeParse(raw);
    if (result.success) {
      this.config = result.data;
    }
    // Emit change event if path provided
    if (changePath) {
      const { getConfigValue } = await import('./config-registry.js')
      const value = getConfigValue(this.config, changePath)
      const oldValue = oldConfig ? getConfigValue(oldConfig, changePath) : undefined
      this.emit('config:changed', { path: changePath, value, oldValue })
    }
  }
```

- [ ] **Step 4: Add `setLogLevel` to log.ts**

Add to `src/core/log.ts` after the `initLogger` function:

```ts
/** Change log level at runtime. Pino transport targets respect parent level changes automatically. */
export function setLogLevel(level: string): void {
  rootLogger.level = level
}
```

- [ ] **Step 5: Subscribe to config:changed in core.ts**

Add at the end of the `OpenACPCore` constructor in `src/core/core.ts:31-43`:

```ts
  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
    const config = configManager.get();
    this.agentManager = new AgentManager(config);
    const storePath = path.join(os.homedir(), ".openacp", "sessions.json");
    this.sessionStore = new JsonFileSessionStore(
      storePath,
      config.sessionStore.ttlDays,
    );
    this.sessionManager = new SessionManager(this.sessionStore);
    this.notificationManager = new NotificationManager(this.adapters);
    this.messageTransformer = new MessageTransformer();

    // Hot-reload: handle config changes that need side effects
    this.configManager.on('config:changed', async ({ path: configPath, value }: { path: string; value: unknown }) => {
      if (configPath === 'logging.level' && typeof value === 'string') {
        const { setLogLevel } = await import('./log.js')
        setLogLevel(value)
        log.info({ level: value }, 'Log level changed at runtime')
      }
    })
```

- [ ] **Step 6: Run tests**

Run: `pnpm test -- src/core/__tests__/config-registry.test.ts`
Expected: all PASS

- [ ] **Step 7: Build check**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/config.ts src/core/log.ts src/core/core.ts src/core/__tests__/config-registry.test.ts
git commit -m "feat: add EventEmitter to ConfigManager with hot-reload support"
```

---

### Task 3: API Layer — `/api/config/editable` + Registry-Based Restart Detection

**Files:**
- Modify: `src/core/api-server.ts:119-174` (route table), `src/core/api-server.ts:355-436` (config handlers)
- Modify: `src/__tests__/api-server.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/__tests__/api-server.test.ts`:

```ts
  it('GET /api/config/editable returns safe fields with values', async () => {
    const port = await startServer()
    const res = await apiFetch(port, '/api/config/editable')
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.fields).toBeInstanceOf(Array)
    expect(data.fields.length).toBeGreaterThan(0)

    // All fields should have required shape
    for (const field of data.fields) {
      expect(field.path).toBeTruthy()
      expect(field.displayName).toBeTruthy()
      expect(field.type).toBeTruthy()
      expect(field.value).toBeDefined()
    }

    // defaultAgent should be present with resolved options
    const agentField = data.fields.find((f: any) => f.path === 'defaultAgent')
    expect(agentField).toBeDefined()
    expect(agentField.type).toBe('select')
    expect(agentField.options).toContain('claude')
    expect(agentField.value).toBe('claude')
  })

  it('PATCH /api/config uses registry for needsRestart', async () => {
    const port = await startServer()

    // Hot-reloadable field — should NOT need restart
    const res1 = await apiFetch(port, '/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'security.maxConcurrentSessions', value: 10 }),
    })
    const data1 = await res1.json() as any
    expect(data1.ok).toBe(true)
    expect(data1.needsRestart).toBe(false)

    // Non-hot-reloadable field — should need restart
    const res2 = await apiFetch(port, '/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'tunnel.enabled', value: false }),
    })
    const data2 = await res2.json() as any
    expect(data2.ok).toBe(true)
    expect(data2.needsRestart).toBe(true)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/api-server.test.ts`
Expected: FAIL — 404 for `/api/config/editable`, and `needsRestart` values wrong for registry-based check

- [ ] **Step 3: Add route and handler for `/api/config/editable`**

In `src/core/api-server.ts`, add the route in `handleRequest()` after the existing `GET /api/config` route (around line 148):

```ts
      } else if (method === 'GET' && url === '/api/config/editable') {
        await this.handleGetEditableConfig(res)
```

Add the handler method:

```ts
  private async handleGetEditableConfig(res: http.ServerResponse): Promise<void> {
    const { getSafeFields, resolveOptions, getConfigValue } = await import('./config-registry.js')
    const config = this.core.configManager.get()
    const safeFields = getSafeFields()

    const fields = safeFields.map((def) => ({
      path: def.path,
      displayName: def.displayName,
      group: def.group,
      type: def.type,
      options: resolveOptions(def, config),
      value: getConfigValue(config, def.path),
      hotReload: def.hotReload,
    }))

    this.sendJson(res, 200, { fields })
  }
```

- [ ] **Step 4: Replace `RESTART_PREFIXES` with registry lookup**

In `handleUpdateConfig()` (around line 425), replace:

```ts
    const RESTART_PREFIXES = ['api.port', 'api.host', 'runMode', 'channels.', 'tunnel.', 'agents.']
    const needsRestart = RESTART_PREFIXES.some(prefix =>
      configPath!.startsWith(prefix) ||
      configPath === prefix.replace(/\.$/, '') // exact match for non-wildcard
    )
```

With:

```ts
    const { isHotReloadable } = await import('./config-registry.js')
    const needsRestart = !isHotReloadable(configPath!)
```

Also, pass `changePath` to `save()` for event emission. Replace:

```ts
    await this.core.configManager.save(updates)
```

With:

```ts
    await this.core.configManager.save(updates, configPath)
```

- [ ] **Step 5: Update mock in test file**

The `mockCore.configManager` in `src/__tests__/api-server.test.ts` needs to:
1. Support `on`/`emit` methods (EventEmitter)
2. Return a fully Zod-valid Config so `ConfigSchema.safeParse()` passes in `handleUpdateConfig`
3. Accept the new `changePath` second argument in `save()`

Replace the existing `configManager` mock (around line 33):

```ts
    configManager: {
      get: vi.fn(() => ({
        defaultAgent: 'claude',
        agents: { claude: { command: 'claude', args: [], workingDirectory: '/tmp/ws' } },
        security: { maxConcurrentSessions: 5, sessionTimeoutMinutes: 60, allowedUserIds: [] },
        channels: { telegram: { enabled: false, botToken: 'secret-token', chatId: 0 } },
        workspace: { baseDir: '~/openacp-workspace' },
        logging: { level: 'info', logDir: '~/.openacp/logs', maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 },
        tunnel: { enabled: true, port: 3100, provider: 'cloudflare', options: {}, storeTtlMinutes: 60, auth: { enabled: false } },
        sessionStore: { ttlDays: 30 },
        runMode: 'foreground',
        autoStart: false,
        api: { port: 21420, host: '127.0.0.1' },
        integrations: {},
      })),
      save: vi.fn(),
      resolveWorkspace: vi.fn(() => '/tmp/ws'),
      on: vi.fn(),
      emit: vi.fn(),
    },
```

Also update the existing test for `PATCH /api/config updates config` — it asserts `save` was called with one argument, but now `save` receives a second `changePath` argument. Update the assertion to:
```ts
expect(mockCore.configManager.save).toHaveBeenCalledWith({ defaultAgent: 'codex' }, 'defaultAgent')
```

- [ ] **Step 6: Run tests**

Run: `pnpm test -- src/__tests__/api-server.test.ts`
Expected: all PASS

- [ ] **Step 7: Build check**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/api-server.ts src/__tests__/api-server.test.ts
git commit -m "feat: add /api/config/editable endpoint and registry-based restart detection"
```

---

### Task 4: Telegram Settings Menu

**Files:**
- Modify: `src/adapters/telegram/commands/menu.ts:8-21`
- Create: `src/adapters/telegram/commands/settings.ts`
- Modify: `src/adapters/telegram/commands/index.ts`

- [ ] **Step 1: Add Settings button to menu keyboard**

In `src/adapters/telegram/commands/menu.ts`, update `buildMenuKeyboard()`:

```ts
export function buildMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🆕 New Session", "m:new")
    .text("📋 Sessions", "m:topics")
    .row()
    .text("📊 Status", "m:status")
    .text("🤖 Agents", "m:agents")
    .row()
    .text("⚙️ Settings", "m:settings")
    .text("🔗 Integrate", "m:integrate")
    .row()
    .text("❓ Help", "m:help")
    .text("🔄 Restart", "m:restart")
    .row()
    .text("⬆️ Update", "m:update");
}
```

- [ ] **Step 2: Create settings.ts**

```ts
// src/adapters/telegram/commands/settings.ts
import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { OpenACPCore } from "../../../core/index.js";
import { getSafeFields, resolveOptions, getConfigValue, type ConfigFieldDef } from "../../../core/config-registry.js";
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
      // number/string — delegate to assistant
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
  // Toggle: flip boolean value
  bot.callbackQuery(/^s:toggle:/, async (ctx) => {
    const fieldPath = ctx.callbackQuery.data.replace('s:toggle:', '');
    const config = core.configManager.get();
    const currentValue = getConfigValue(config, fieldPath);
    const newValue = !currentValue;

    try {
      // Build nested update object from dot path
      const updates = buildNestedUpdate(fieldPath, newValue);
      await core.configManager.save(updates, fieldPath);

      const { isHotReloadable } = await import('../../../core/config-registry.js');
      const toast = isHotReloadable(fieldPath)
        ? `✅ ${fieldPath} = ${newValue}`
        : `✅ ${fieldPath} = ${newValue} (restart needed)`;
      try { await ctx.answerCallbackQuery({ text: toast }); } catch { /* expired */ }

      // Refresh the settings keyboard
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: buildSettingsKeyboard(core) });
      } catch { /* ignore */ }
    } catch (err) {
      log.error({ err, fieldPath }, 'Failed to toggle config');
      try { await ctx.answerCallbackQuery({ text: '❌ Failed to update' }); } catch { /* expired */ }
    }
  });

  // Select: show options as buttons
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

  // Pick: user selected a value from select options
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

  // Input: delegate to assistant for number/string input
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

  // Back to menu
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

  // Back with refresh (from select sub-menu)
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
```

- [ ] **Step 3: Register settings in index.ts**

In `src/adapters/telegram/commands/index.ts`:

Add import:
```ts
import { handleSettings } from "./settings.js";
```

Add static import at top of file:
```ts
import { handleSettings, setupSettingsCallbacks } from "./settings.js";
```

Add to `setupAllCallbacks()` — register `s:` callbacks BEFORE the `m:` handler. Add the `getAssistantSession` parameter and wire it. After `setupSessionCallbacks(...)`:
```ts
  // Settings handlers — must be before broad m: handler
  setupSettingsCallbacks(bot, core, getAssistantSession ?? (() => undefined))
```

Update `setupAllCallbacks` signature to accept the assistant getter:
```ts
export function setupAllCallbacks(
  bot: Bot,
  core: OpenACPCore,
  chatId: number,
  systemTopicIds?: { notificationTopicId: number; assistantTopicId: number },
  getAssistantSession?: () => { topicId: number; enqueuePrompt: (p: string) => Promise<void> } | undefined,
): void {
```

Add `m:settings` case to the `m:` switch block:
```ts
      case "m:settings":
        await handleSettings(ctx, core);
        break;
```

Add to exports:
```ts
export { setupSettingsCallbacks } from "./settings.js";
```

- [ ] **Step 4: Build check**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/telegram/commands/menu.ts src/adapters/telegram/commands/settings.ts src/adapters/telegram/commands/index.ts
git commit -m "feat(telegram): add Settings menu with toggle, select, and assistant delegation"
```

---

### Task 5: CLI Smart Routing + Deprecate `api config`

**Files:**
- Modify: `src/cli.ts:41` (pass args to cmdConfig)
- Modify: `src/cli/commands.ts:5-50` (help text), `src/cli/commands.ts:330-372` (api config), `src/cli/commands.ts:519-528` (cmdConfig)
- Modify: `src/core/config-editor.ts:560-613` (add mode param)

- [ ] **Step 1: Update cli.ts to pass args to cmdConfig**

In `src/cli.ts:41`, change:
```ts
  'config': () => cmdConfig(),
```
To:
```ts
  'config': () => cmdConfig(args),
```

Update the import signature — `cmdConfig` now accepts `args: string[]`.

- [ ] **Step 2: Add deprecation warning to `api config`**

In `src/cli/commands.ts`, inside `cmdApi()` around line 330, add deprecation warning at the start of the `config` branch:

```ts
    } else if (subCmd === 'config') {
      console.warn('⚠️  Deprecated: use "openacp config" or "openacp config set" instead.')
```

- [ ] **Step 3: Rewrite `cmdConfig()` with smart routing and `config set`**

Replace `src/cli/commands.ts:519-528`:

```ts
export async function cmdConfig(args: string[] = []): Promise<void> {
  const subCmd = args[1] // 'set' or undefined

  if (subCmd === 'set') {
    // Non-interactive: openacp config set <key> <value>
    const configPath = args[2]
    const configValue = args[3]
    if (!configPath || configValue === undefined) {
      console.error('Usage: openacp config set <path> <value>')
      process.exit(1)
    }

    let value: unknown = configValue
    try { value = JSON.parse(configValue) } catch { /* keep as string */ }

    const port = readApiPort()
    if (port !== null) {
      // Server running — use API
      const res = await apiCall(port, '/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: configPath, value }),
      })
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      console.log(`Config updated: ${configPath} = ${JSON.stringify(value)}`)
      if (data.needsRestart) {
        console.log('Note: restart required for this change to take effect.')
      }
    } else {
      // Server not running — update file directly
      const { ConfigManager } = await import('../core/config.js')
      const cm = new ConfigManager()
      if (!(await cm.exists())) {
        console.error('No config found. Run "openacp" first to set up.')
        process.exit(1)
      }
      await cm.load()
      const updates = buildNestedUpdateFromPath(configPath, value)
      await cm.save(updates)
      console.log(`Config updated: ${configPath} = ${JSON.stringify(value)}`)
    }
    return
  }

  // Interactive editor
  const { runConfigEditor } = await import('../core/config-editor.js')
  const { ConfigManager } = await import('../core/config.js')
  const cm = new ConfigManager()
  if (!(await cm.exists())) {
    console.error('No config found. Run "openacp" first to set up.')
    process.exit(1)
  }

  const port = readApiPort()
  if (port !== null) {
    await runConfigEditor(cm, 'api', port)
  } else {
    await runConfigEditor(cm, 'file')
  }
}

function buildNestedUpdateFromPath(dotPath: string, value: unknown): Record<string, unknown> {
  const parts = dotPath.split('.')
  const result: Record<string, unknown> = {}
  let target = result
  for (let i = 0; i < parts.length - 1; i++) {
    target[parts[i]] = {}
    target = target[parts[i]] as Record<string, unknown>
  }
  target[parts[parts.length - 1]] = value
  return result
}
```

Ensure `readApiPort` and `apiCall` are imported at the top of the file (they already are: line 2).

- [ ] **Step 4: Update help text**

In `src/cli/commands.ts:15`, add after `openacp config`:
```
  openacp config set <key> <value>       Set a config value
```

In the API section (line 41-42), add deprecation note:
```
  openacp api config                       Show runtime config (deprecated → openacp config)
  openacp api config set <key> <value>     Update config value (deprecated → openacp config set)
```

- [ ] **Step 5: Update config-editor.ts to accept mode param**

In `src/core/config-editor.ts`, update the `runConfigEditor` signature (line 560):

```ts
export async function runConfigEditor(
  configManager: ConfigManager,
  mode: 'file' | 'api' = 'file',
  apiPort?: number,
): Promise<void> {
```

For `mode: 'api'`, instead of accumulating updates and saving at exit, save after each sub-editor returns. Replace the section around lines 569-605:

```ts
  try {
    while (true) {
      const hasChanges = mode === 'file' ? Object.keys(updates).length > 0 : false
      const choice = await select({
        message: `What would you like to edit?${hasChanges ? ` ${c.yellow}(unsaved changes)${c.reset}` : ''}`,
        choices: [
          { name: 'Telegram', value: 'telegram' },
          { name: 'Agent', value: 'agent' },
          { name: 'Workspace', value: 'workspace' },
          { name: 'Security', value: 'security' },
          { name: 'Logging', value: 'logging' },
          { name: 'Run Mode', value: 'runMode' },
          { name: 'API', value: 'api' },
          { name: 'Tunnel', value: 'tunnel' },
          { name: hasChanges ? 'Save & Exit' : 'Exit', value: 'exit' },
        ],
      })

      if (choice === 'exit') {
        if (mode === 'file' && hasChanges) {
          await configManager.save(updates)
          console.log(ok(`Config saved to ${configManager.getConfigPath()}`))
        } else if (mode === 'file') {
          console.log(dim('No changes made.'))
        }
        break
      }

      const sectionUpdates: ConfigUpdates = {}

      if (choice === 'telegram') await editTelegram(config, sectionUpdates)
      else if (choice === 'agent') await editAgent(config, sectionUpdates)
      else if (choice === 'workspace') await editWorkspace(config, sectionUpdates)
      else if (choice === 'security') await editSecurity(config, sectionUpdates)
      else if (choice === 'logging') await editLogging(config, sectionUpdates)
      else if (choice === 'runMode') await editRunMode(config, sectionUpdates)
      else if (choice === 'api') await editApi(config, sectionUpdates)
      else if (choice === 'tunnel') await editTunnel(config, sectionUpdates)

      if (mode === 'api' && Object.keys(sectionUpdates).length > 0) {
        // Send each change via API for hot-reload
        await sendConfigViaApi(apiPort!, sectionUpdates)
        // Refresh in-memory config
        await configManager.load()
        Object.assign(config, configManager.get())
      } else {
        // Accumulate for file mode
        Object.assign(updates, sectionUpdates)
      }
    }
  } catch (err) {
    if ((err as Error).name === 'ExitPromptError') {
      console.log(dim('\nConfig editor cancelled. Changes discarded.'))
      return
    }
    throw err
  }
}

async function sendConfigViaApi(port: number, updates: ConfigUpdates): Promise<void> {
  const { apiCall: call } = await import('./api-client.js')

  // Flatten nested updates to dot-paths and send each
  const paths = flattenToPaths(updates)
  for (const { path, value } of paths) {
    const res = await call(port, '/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, value }),
    })
    const data = await res.json() as Record<string, unknown>
    if (!res.ok) {
      console.log(warn(`Failed to update ${path}: ${data.error}`))
    } else if (data.needsRestart) {
      console.log(warn(`${path} updated — restart required`))
    }
  }
}

function flattenToPaths(obj: Record<string, unknown>, prefix = ''): Array<{ path: string; value: unknown }> {
  const result: Array<{ path: string; value: unknown }> = []
  for (const [key, val] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      result.push(...flattenToPaths(val as Record<string, unknown>, fullPath))
    } else {
      result.push({ path: fullPath, value: val })
    }
  }
  return result
}
```

- [ ] **Step 6: Build check**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 7: Manual smoke test**

Run: `pnpm build && node dist/cli.js config --help` (should not crash)
Run: `node dist/cli.js api config` (should show deprecation warning when server not running)

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/cli/commands.ts src/core/config-editor.ts
git commit -m "feat(cli): smart-routing openacp config with api mode and deprecation"
```

---

### Task 6: Assistant Integration + Wire Settings Delegation

**Files:**
- Modify: `src/adapters/telegram/assistant.ts:144-177`
- Modify: `src/adapters/telegram/adapter.ts` (wire assistant session to settings)
- Modify: `src/adapters/telegram/commands/index.ts` (fix placeholder from Task 4)

- [ ] **Step 1: Update assistant system prompt**

In `src/adapters/telegram/assistant.ts`, replace lines 144-147:

```ts
### Configuration
- View: \`openacp api config\`
- Update: \`openacp api config set <key> <value>\`
```

With:

```ts
### Configuration
- View: \`openacp config\` (or \`openacp api config\` — deprecated)
- Update: \`openacp config set <key> <value>\`
- When user asks about "settings" or "config", use \`openacp config set\` directly
- When receiving a delegated request from the Settings menu, ask user for the new value, then apply with \`openacp config set <path> <value>\`
```

Also update the CLI Commands Reference section (lines 176-177):

```ts
openacp config                           # Edit config (interactive)
openacp config set <key> <value>         # Update config value
openacp api config                       # Show config (deprecated)
openacp api config set <key> <value>     # Update config (deprecated)
```

- [ ] **Step 2: Wire assistant session to settings callbacks in adapter.ts**

In `src/adapters/telegram/adapter.ts`, find where `setupAllCallbacks` is called (around line 214). The settings callbacks need access to the assistant session.

Find the call to `setupAllCallbacks()` and update `setupSettingsCallbacks` to pass a getter for the assistant session. This requires modifying how callbacks are set up.

The `setupAllCallbacks()` signature and `setupSettingsCallbacks` wiring were already updated in Task 4. Now wire the actual assistant session getter in `src/adapters/telegram/adapter.ts`.

Update the call to `setupAllCallbacks()` to pass the assistant session getter:

```ts
    setupAllCallbacks(
      this.bot,
      this.core,
      this.chatId,
      { notificationTopicId: this.notificationTopicId, assistantTopicId: this.assistantTopicId },
      () => {
        if (!this.assistantSession) return undefined;
        return {
          topicId: this.assistantTopicId,
          enqueuePrompt: (p: string) => this.assistantSession!.enqueuePrompt(p),
        };
      },
    );
```

- [ ] **Step 3: Build check**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 4: Run all tests**

Run: `pnpm test`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/telegram/assistant.ts src/adapters/telegram/adapter.ts src/adapters/telegram/commands/index.ts
git commit -m "feat(telegram): wire assistant delegation for settings and update system prompt"
```

---

### Task 7: Final Integration Test + Cleanup

**Files:**
- All modified files
- Test: `src/__tests__/api-server.test.ts`

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: all PASS

- [ ] **Step 2: Build check**

Run: `pnpm build`
Expected: PASS, no type errors

- [ ] **Step 3: Verify existing api-server tests still pass**

Run: `pnpm test -- src/__tests__/api-server.test.ts`
Expected: all PASS (existing tests not broken by changes)

- [ ] **Step 4: Verify config-registry tests pass**

Run: `pnpm test -- src/core/__tests__/config-registry.test.ts`
Expected: all PASS

- [ ] **Step 5: Manual smoke test on Telegram**

1. Start OpenACP: `pnpm build && node dist/cli.js`
2. In Telegram, tap Menu → verify "Settings" button appears
3. Tap Settings → verify config fields shown with current values
4. Tap Log Level → select "debug" → verify toast confirms change
5. Tap Default Agent → select different agent → verify update
6. Tap a number field (e.g., Max Sessions) → verify delegation to assistant topic
7. In terminal: `openacp config set security.maxConcurrentSessions 30` → verify it routes through API
8. In terminal: `openacp api config` → verify deprecation warning shown

- [ ] **Step 6: Commit final state**

```bash
git add -A
git commit -m "feat: dynamic config update system with registry, hot-reload, and Telegram settings menu"
```
