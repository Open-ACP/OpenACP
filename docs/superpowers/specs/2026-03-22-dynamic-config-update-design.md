# Dynamic Config Update System

**Date**: 2026-03-22
**Status**: Approved

## Overview

Enable users to update safe system configs at runtime through multiple interfaces: Telegram Settings menu, assistant conversation, and CLI — all routing through a single config registry as source of truth.

## Decisions

- **Hot-reload when possible**: Apply config changes at runtime where feasible. Only require restart for configs that cannot be hot-reloaded (e.g. `tunnel.enabled`).
- **Safe configs only via Telegram/API**: Sensitive configs (bot token, agent commands, API port) are CLI-only.
- **Hybrid Telegram UX**: Inline keyboard buttons for toggles/selects, assistant for text/number input.
- **Single CLI entry point**: `openacp config` is the primary config command. Smart-routes to API when server is running, file when not. Deprecate `openacp api config` (keep working with warning).
- **Config Registry pattern**: Central metadata registry that all layers consume.
- **Scope filtering at UI layer, not API**: `PATCH /api/config` remains unrestricted (localhost-only). Scope check is enforced in the Telegram UI and assistant layers, not at the API level.

## 1. Config Registry

New file: `src/core/config-registry.ts`

```ts
interface ConfigFieldDef {
  path: string                              // "security.maxConcurrentSessions"
  displayName: string                       // "Max Concurrent Sessions"
  group: string                             // "security", "logging", etc.
  type: 'toggle' | 'select' | 'number' | 'string'
  options?: string[] | (() => string[])     // for 'select' type
  scope: 'safe' | 'sensitive'              // safe = editable via Telegram/API
  hotReload: boolean                        // true = apply runtime without restart
}

```

### Safe fields (editable via Telegram/API)

| Path | Type | Hot-reload | Telegram UI |
|------|------|------------|-------------|
| `defaultAgent` | select (from configured agents) | yes | button |
| `logging.level` | select (silent/debug/info/warn/error/fatal) | yes | button |
| `tunnel.enabled` | toggle | no (restart) | button |
| `security.maxConcurrentSessions` | number | yes | assistant |
| `security.sessionTimeoutMinutes` | number | yes | assistant |
| `workspace.baseDir` | string | yes | assistant |
| `sessionStore.ttlDays` | number | yes | assistant |

### Sensitive fields (CLI only)

- `channels.*` (bot token, chat ID)
- `agents.*` (command, args, env, workingDirectory)
- `api.port`, `api.host`
- `tunnel.provider`, `tunnel.port`, `tunnel.options`, `tunnel.auth`
- `runMode`, `autoStart`
- `integrations`

## 2. API Layer

### Changes to `PATCH /api/config`

`PATCH /api/config` remains unrestricted — it is localhost-only (`127.0.0.1`) so any local process can set any config. Scope filtering is the responsibility of the Telegram/assistant UI layers.

1. **Hot-reload**: After saving, if field is `hotReload: true` in registry → emit `config:changed` event with `{ path, value, oldValue }`. Core subscribes and applies at runtime.
2. **No hot-reload**: Save file, return `needsRestart: true`, send Telegram notification "Config changed, restart needed".
3. **Replace `RESTART_PREFIXES`**: The existing hardcoded `RESTART_PREFIXES` array in `handleUpdateConfig` should be replaced by a lookup against the registry's `hotReload` field. `needsRestart = !registry.isHotReloadable(path)`. Single source of truth.

### New endpoint: `GET /api/config/editable`

Returns safe fields from registry with current values. Used by Telegram menu and assistant.

```json
{
  "fields": [
    {
      "path": "defaultAgent",
      "displayName": "Default Agent",
      "group": "agent",
      "type": "select",
      "options": ["claude", "codex"],
      "value": "claude",
      "hotReload": true
    }
  ]
}
```

### Hot-reload mechanism

`ConfigManager` gets EventEmitter pattern. On save of hot-reloadable field:
- `logging.level` → call pino's `logger.level = newLevel` on the root logger instance (pino supports runtime level changes)
- `defaultAgent`, `security.*`, `workspace.baseDir`, `sessionStore.ttlDays` → update in-memory config (code reads from `configManager.get()` each time, so updating in-memory is sufficient)

Note: `configManager.save()` already updates the in-memory config. The event is for side effects like logger reconfiguration that need explicit action beyond the in-memory update.

## 3. Telegram Settings Menu

### Menu integration

Add "Settings" to main menu keyboard:

```
🆕 New Session  |  📋 Sessions
📊 Status       |  🤖 Agents
⚙️ Settings     |  🔗 Integrate
❓ Help         |  🔄 Restart
⬆️ Update
```

### Settings flow

On press "Settings" → call `GET /api/config/editable` → show inline keyboard grouped:

```
⚙️ Settings
├── 🤖 Default Agent: claude     [Change]
├── 📝 Log Level: info           [Change]
├── 🔗 Tunnel: enabled           [Toggle]
├── 🔒 Security...               [→]
└── 📁 Workspace...              [→]
```

### Interaction types

**Toggle/select (buttons):**
- `tunnel.enabled` → press Toggle → flip value → `PATCH /api/config` → update button text + toast
- `defaultAgent` → press Change → show agent list buttons → select → API call → update
- `logging.level` → press Change → show 6 level buttons → select → API call → update

**Number/string (delegate to assistant):**
- Press "Change Max Sessions" → bot sends message to assistant topic: `"User wants to change security.maxConcurrentSessions (current: 20). Ask them for the new value and apply it."`
- Assistant asks user → receives value → runs `openacp config set security.maxConcurrentSessions <value>` → confirms result

### Callback prefix

Use `s:` prefix for settings callbacks (consistent with `m:` for menu, `d:` for dangerous mode).

## 4. CLI — Single Entry Point

### Deprecate `openacp api config`

Keep `openacp api config` and `openacp api config set` working but print deprecation warning: `"Deprecated: use 'openacp config' or 'openacp config set' instead."` This follows the project's backward compatibility policy (never remove existing commands, deprecate with warning).

### `openacp config` (interactive)

1. Detect server running (read `~/.openacp/api.port` + health check)
2. **Server running** → each field change calls `PATCH /api/config` (hot-reload applies immediately)
3. **Server not running** → edit file directly (current behavior)

### `openacp config set <key> <value>` (non-interactive, for scripting)

Same smart routing: server running → API, not running → file. Primary replacement for `openacp api config set`.

### `cmdConfig()` argument handling

Current `cmdConfig()` takes no arguments. Updated to parse `args`:
- `openacp config` (no args) → interactive editor
- `openacp config set <key> <value>` → non-interactive set

### Implementation

Add `mode` parameter to `runConfigEditor()`:

```ts
async function runConfigEditor(
  configManager: ConfigManager,
  mode: 'file' | 'api',
  apiPort?: number
)
```

- `mode: 'file'` → accumulate changes, save to file on exit (current behavior)
- `mode: 'api'` → each sub-editor (e.g. editSecurity, editLogging) sends its changes immediately via `PATCH /api/config` when the user exits back to the main menu. This gives real-time hot-reload feedback while keeping the familiar sub-editor flow. No batching at final exit — changes apply as the user navigates.

`cmdConfig()` detects server → chooses mode. User experience is identical either way.

## 5. Assistant Integration

### System prompt updates

- Replace `openacp api config set` → `openacp config set` in `buildAssistantSystemPrompt()`. Only change config-specific references — other `openacp api` commands (`api new`, `api status`, etc.) remain unchanged as they route through the running daemon.
- Add instruction: when user asks about "settings" or "config", assistant runs `openacp config set` directly
- Add instruction: when receiving a delegated config change from Settings menu, ask user for value and apply

### Delegation flow

Settings menu → sends message to assistant topic → assistant asks user for value → runs `openacp config set <key> <value>` → confirms result. No new tools or APIs needed — uses existing shell command execution.

**How delegation accesses the assistant session**: The settings handler in `commands/settings.ts` receives `core` and the Telegram adapter context. It gets the assistant session via `core.sessionManager.getSessionByThread("telegram", assistantTopicId)` (assistant topic ID is stored on the adapter). If the assistant session is not available (not spawned or errored), the bot replies directly: "Please start the assistant first with /assistant, then try again."

## Files to modify

- **New**: `src/core/config-registry.ts` — registry definition
- **Modify**: `src/core/config.ts` — add EventEmitter to ConfigManager
- **Modify**: `src/core/api-server.ts` — scope check, hot-reload, new `/api/config/editable` endpoint
- **Modify**: `src/core/core.ts` — subscribe to `config:changed` events
- **Modify**: `src/adapters/telegram/commands/menu.ts` — add Settings button
- **New**: `src/adapters/telegram/commands/settings.ts` — Settings menu handlers
- **Modify**: `src/adapters/telegram/commands/index.ts` — register settings callbacks
- **Modify**: `src/adapters/telegram/assistant.ts` — update system prompt
- **Modify**: `src/cli/commands.ts` — smart routing for `cmdConfig()`, add `config set`, deprecate `api config`
- **Modify**: `src/core/config-editor.ts` — add `mode` parameter for API routing
- **Modify**: `src/core/index.ts` — export config-registry types
- **Modify**: `src/core/log.ts` — expose root logger for runtime level reconfiguration
- **Modify**: `src/adapters/telegram/adapter.ts` — pass assistant session reference to settings handlers
