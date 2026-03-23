# Generic Bi-directional Handoff Design

**Date**: 2026-03-23
**Status**: Draft
**Supersedes**: 2026-03-22-session-handoff-design.md

## Overview

Bi-directional session handoff between terminal agents and OpenACP (Telegram) for ALL supported agents. Replaces the Claude-only implementation with a data-driven integration engine.

**Key decisions:**
- Generic abstraction via `AgentIntegrationSpec` — no per-agent hardcoded logic in engine
- Auto-integrate on agent install (both CLI and Telegram bot)
- Manual `openacp adopt` for agents without hooks system
- Resume capabilities gộp chung (by ID and resume latest treated the same)

## Agent Capability Matrix

Based on research of all 28 agents in the OpenACP registry:

| Agent | Resume by ID | Resume Latest | Hooks System | Integration |
|-------|-------------|---------------|--------------|-------------|
| **Claude Code** | `claude -r <ID>` | `claude -c` | Full (12 events) | Full bi-directional |
| **Gemini CLI** | `gemini --resume <UUID>` | `gemini --resume` | Full (BeforeAgent, pre-LLM) | Full bi-directional |
| **Cursor** | `cursor --resume <chatId>` | `cursor --continue` | Full (~20 events, JSON I/O) | Full bi-directional |
| **Cline** | Via `/history` picker | `cline --continue` | Full (TaskStart, PreToolUse) | Full bi-directional |
| **Codex CLI** | `codex resume <ID>` | `codex resume` | No (instruction files only) | Manual adopt + resume |
| **Kilo Code** | Via `/sessions` picker | `kilo -c` | No | Manual adopt + resume |
| **Amp** | `amp threads continue <id>` | — | Limited (post-execute only) | Manual adopt + resume |
| **Aider** | No | `--restore-chat-history` | No | No handoff |
| **Other 21 agents** | Unknown | — | — | No handoff |

## Data Model

### AgentIntegrationSpec

Added to `agent-dependencies.ts` alongside existing `AGENT_CAPABILITIES`, `AGENT_SETUP`, `AGENT_DEPENDENCIES`:

```typescript
interface AgentIntegrationSpec {
  // Hook injection config (Terminal→Telegram)
  hookEvent: string;                    // "UserPromptSubmit" | "BeforeAgent" | "beforeSubmitPrompt"
  settingsPath: string;                 // "~/.claude/settings.json" or "~/.cursor/hooks.json"
  settingsFormat: "settings_json" | "hooks_json";  // how hooks are registered in the config file
  hooksDirPath: string;                 // "~/.claude/hooks/"
  outputFormat: "plaintext" | "json";   // Claude=plaintext, others=JSON
  sessionIdField: string;              // jq expression: ".session_id" or ".conversation_id"

  // Slash command / skill support (optional)
  commandsPath?: string;                // "~/.claude/commands/" or "~/.cursor/skills/"
  handoffCommandName?: string;          // "openacp:handoff" or "openacp-handoff"
  commandFormat?: "markdown" | "skill"; // Claude=markdown file, Cursor=SKILL.md in subdir

  // Hook output variable names (for backward compat)
  sessionIdVar?: string;               // default "SESSION_ID", Claude uses "CLAUDE_SESSION_ID"
  workingDirVar?: string;              // default "WORKING_DIR", Claude uses "CLAUDE_WORKING_DIR"
}
```

**`settingsFormat` variants:**
- `"settings_json"`: Hooks registered inside a general settings file (Claude, Gemini, Cline) — path like `hooks.{hookEvent}[].hooks[].command`
- `"hooks_json"`: Dedicated hooks file (Cursor) — path like `hooks.{hookEvent}[].command`

**`commandFormat` variants:**
- `"markdown"`: Single `.md` file in commands dir (Claude) — e.g., `~/.claude/commands/openacp:handoff.md`
- `"skill"`: Subdirectory with `SKILL.md` (Cursor) — e.g., `~/.cursor/skills/openacp-handoff/SKILL.md`

**Key mapping**: `AGENT_CAPABILITIES` uses bare agent names (aliases) as keys — e.g., `"claude"` not `"claude-acp"`. This matches the `agentKey` returned by `catalog.install()` via `REGISTRY_AGENT_ALIASES`.

**Assumptions requiring verification**:
- Gemini CLI: `~/.gemini/settings.json` path, `BeforeAgent` hook event name, JSON `additionalContext` output format
- Cline: `~/.cline/settings.json` path, `TaskStart` hook event name, JSON output format
- Cursor: hooks system works similarly to Claude Code (confirmed by user testing)

These are based on web research and should be verified against actual agent installations before shipping.

### Extended AGENT_CAPABILITIES

```typescript
const AGENT_CAPABILITIES: Record<string, AgentCapability> = {
  claude: {
    supportsResume: true,
    resumeCommand: (sid) => `claude --resume ${sid}`,
    integration: {
      hookEvent: "UserPromptSubmit",
      settingsPath: "~/.claude/settings.json",
      settingsFormat: "settings_json",
      hooksDirPath: "~/.claude/hooks/",
      outputFormat: "plaintext",
      sessionIdField: ".session_id",
      commandsPath: "~/.claude/commands/",
      handoffCommandName: "openacp:handoff",
      commandFormat: "markdown",
      sessionIdVar: "CLAUDE_SESSION_ID",    // backward compat with existing installs
      workingDirVar: "CLAUDE_WORKING_DIR",
    },
  },
  cursor: {
    supportsResume: true,
    resumeCommand: (sid) => `cursor --resume ${sid}`,
    integration: {
      hookEvent: "beforeSubmitPrompt",
      settingsPath: "~/.cursor/hooks.json",
      settingsFormat: "hooks_json",
      hooksDirPath: "~/.cursor/hooks/",
      outputFormat: "json",
      sessionIdField: ".conversation_id",
      commandsPath: "~/.cursor/skills/",
      handoffCommandName: "openacp-handoff",
      commandFormat: "skill",
    },
  },
  gemini: {
    supportsResume: true,
    resumeCommand: (sid) => `gemini --resume ${sid}`,
    integration: {
      hookEvent: "BeforeAgent",
      settingsPath: "~/.gemini/settings.json",
      settingsFormat: "settings_json",
      hooksDirPath: "~/.gemini/hooks/",
      outputFormat: "json",
      sessionIdField: ".session_id",
    },
  },
  cline: {
    supportsResume: true,
    resumeCommand: () => `cline --continue`,
    integration: {
      hookEvent: "TaskStart",
      settingsPath: "~/.cline/settings.json",
      settingsFormat: "settings_json",
      hooksDirPath: "~/.cline/hooks/",
      outputFormat: "json",
      sessionIdField: ".session_id",
    },
  },
  codex: {
    supportsResume: true,
    resumeCommand: (sid) => `codex resume ${sid}`,
    // No integration — no hooks system
  },
  kilo: {
    supportsResume: true,
    resumeCommand: () => `kilo --continue`,
    // No integration — no hooks system
  },
  amp: {
    supportsResume: true,
    resumeCommand: (sid) => `amp threads continue ${sid}`,
    // No integration — limited hooks (post-execute only, not useful for inject)
  },
};
```

## Integration Engine

### Refactored `integrate.ts`

Replace hardcoded Claude logic with data-driven engine that reads `AgentIntegrationSpec`:

#### Script Generation

```typescript
function generateInjectScript(agentKey: string, spec: AgentIntegrationSpec): string {
  const sidVar = spec.sessionIdVar ?? "SESSION_ID";
  const cwdVar = spec.workingDirVar ?? "WORKING_DIR";

  if (spec.outputFormat === "plaintext") {
    // Claude style — plain text stdout
    return `#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '${spec.sessionIdField}')
CWD=$(echo "$INPUT" | jq -r '.cwd')
echo "${sidVar}: $SESSION_ID"
echo "${cwdVar}: $CWD"
exit 0`;
  } else {
    // Gemini/Cline style — must output pure JSON, no plain text
    return `#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '${spec.sessionIdField}')
CWD=$(echo "$INPUT" | jq -r '.cwd')
jq -n --arg sid "$SESSION_ID" --arg cwd "$CWD" \\
  '{"additionalContext":"${sidVar}: \\($sid)\\n${cwdVar}: \\($cwd)"}'
exit 0`;
  }
}

function generateHandoffScript(agentKey: string): string {
  return `#!/bin/bash
if [ -z "$1" ]; then
  echo "Usage: openacp-handoff.sh <session_id> [cwd]"
  exit 1
fi
openacp adopt ${agentKey} "$1" \${2:+--cwd "$2"}`;
}
```

#### Generic Install/Uninstall

```typescript
async function installIntegration(agentKey: string, spec: AgentIntegrationSpec): Promise<IntegrationResult> {
  // 1. Create hooks dir
  await mkdirp(expandPath(spec.hooksDirPath));

  // 2. Write inject script + chmod 755
  const injectPath = path.join(spec.hooksDirPath, "openacp-inject-session.sh");
  await writeScript(injectPath, generateInjectScript(agentKey, spec));

  // 3. Write handoff script + chmod 755
  const handoffPath = path.join(spec.hooksDirPath, "openacp-handoff.sh");
  await writeScript(handoffPath, generateHandoffScript(agentKey));

  // 4. Write slash command / skill (if agent supports it)
  if (spec.commandsPath && spec.handoffCommandName) {
    if (spec.commandFormat === "skill") {
      // Cursor style: ~/.cursor/skills/openacp-handoff/SKILL.md
      const skillDir = path.join(spec.commandsPath, spec.handoffCommandName);
      await mkdirp(expandPath(skillDir));
      const skillPath = path.join(skillDir, "SKILL.md");
      await writeFile(skillPath, generateHandoffCommand(agentKey));
    } else {
      // Claude style: ~/.claude/commands/openacp:handoff.md
      await mkdirp(expandPath(spec.commandsPath));
      const cmdPath = path.join(spec.commandsPath, `${spec.handoffCommandName}.md`);
      await writeFile(cmdPath, generateHandoffCommand(agentKey));
    }
  }

  // 5. Merge settings.json — add hook entry for spec.hookEvent
  await mergeAgentSettings(spec.settingsPath, spec.hookEvent, injectPath);

  return { ok: true };
}

async function uninstallIntegration(agentKey: string, spec: AgentIntegrationSpec): Promise<IntegrationResult> {
  // Remove hook files with "openacp-" prefix from hooksDirPath
  // Remove slash command if commandsPath defined
  // Clean hook entry from settings.json
  return { ok: true };
}
```

#### Generic Settings Merger

```typescript
async function mergeAgentSettings(
  settingsPath: string,
  settingsFormat: "settings_json" | "hooks_json",
  hookEvent: string,
  hookScriptPath: string
): Promise<void> {
  // 1. Read existing file (or {} if not exists)
  // 2. Backup to .bak
  // 3. Check if entry with "openacp-inject-session.sh" already exists → skip
  // 4. Append hook entry based on format:
  //
  //    settings_json (Claude, Gemini, Cline):
  //      hooks[hookEvent][].hooks[].command = hookScriptPath
  //      → nested: { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "..." }] }] } }
  //
  //    hooks_json (Cursor):
  //      hooks[hookEvent][].command = hookScriptPath
  //      → flat: { version: 1, hooks: { beforeSubmitPrompt: [{ command: "..." }] } }
  //
  // 5. Write back with JSON.stringify(data, null, 2)
}
```

## Auto-integrate on Install

### CLI Flow

In `commands.ts` — `agentsInstall()`, after successful `catalog.install()`:

```
catalog.install(nameOrId, progress, force)
  → success
  → lookup AGENT_CAPABILITIES[agentKey].integration
  → found? → installIntegration(agentKey, spec)
    → success: log "✅ Handoff integration installed for {agent}"
    → failure: log "⚠️ Agent installed but handoff integration failed: {error}"
  → not found? → skip (no integration available)
```

### Telegram Bot Flow

In `agents.ts` — `installAgentWithProgress()`, after `onSuccess`:

```
onSuccess callback
  → lookup AGENT_CAPABILITIES[agentKey].integration
  → found? → installIntegration(agentKey, spec)
    → append to success message: "Handoff integration installed"
  → not found? → skip
```

### Auto-unintegrate on Uninstall

Both CLI and Telegram: after `catalog.uninstall()`, call `uninstallIntegration()` if spec exists.

## Bi-directional Handoff Flows

### Terminal → Telegram (adopt)

**Agents with hooks (Claude, Cursor, Gemini, Cline):**
1. User using agent in terminal/IDE
2. Hook injects `SESSION_ID` + `WORKING_DIR` into agent context every prompt
3. User triggers handoff:
   - Claude: `/openacp:handoff` slash command (auto-runs adopt)
   - Cursor: `/openacp-handoff` skill (auto-runs adopt)
   - Gemini/Cline: user manually runs `openacp adopt <agent> <session_id> --cwd <path>`
4. `POST /api/sessions/adopt` → `core.adoptSession()` → resume on Telegram

**Agents without hooks (Codex, Kilo, Amp):**
1. User manually runs: `openacp adopt codex <session_id> --cwd <path>`
2. Same API flow

### Telegram → Terminal (resume)

1. User in Telegram session topic, types `/handoff`
2. Bot reads `agentName` from session record
3. Looks up `AGENT_CAPABILITIES[agentName]`
4. `supportsResume: true` → reply with resume command:
   ```
   Resume in terminal:
   claude --resume abc123
   ```
5. `supportsResume: false` or not found → "This agent doesn't support session resume."

### `/handoff` Command (already generic)

The `/handoff` command in `adapter.ts` already uses `getAgentCapabilities()` for generic agent lookup — no refactoring needed. Only change: add new agent entries to `AGENT_CAPABILITIES` so the existing generic code automatically works for Gemini, Codex, Cline, etc.

**Limitation note**: Cline (`cline --continue`) and Kilo (`kilo --continue`) resume the most recent session, not a specific session by ID. The `/handoff` command will show this generic resume command, which may not resume the exact OpenACP session if the user has other sessions open.

## Backward Compatibility

### Config
- `integrations` field already in schema with `.default({})` — no migration needed
- Auto-integrate adds entries: `integrations.gemini.installed = true`

### Existing Claude Integration
- Users who ran `openacp integrate claude` already have files installed
- `installIntegration()` detects existing files via marker (`openacp-inject-session.sh`)
- If exists → update content, don't duplicate hook entries in settings.json
- Claude keeps `CLAUDE_SESSION_ID` / `CLAUDE_WORKING_DIR` variable names via `sessionIdVar`/`workingDirVar` fields — no breaking change for existing slash command that references these names
- The adopt endpoint does not parse hook output — it receives session ID directly as a parameter, so variable naming is only relevant to the agent's LLM context

### AGENT_CAPABILITIES Extension
- `integration?` field is optional — existing agents without it are unaffected
- New `resumeCommand` entries for Gemini/Codex/etc — `/handoff` works automatically

### Existing `IntegrationItem` Interface

The current `integrate.ts` has `IntegrationItem` with `install()`/`uninstall()`/`isInstalled()` methods and a registry via `getIntegration()`/`listIntegrations()`. This is replaced by:
- `installIntegration(agentKey, spec)` / `uninstallIntegration(agentKey, spec)` functions driven by `AgentIntegrationSpec`
- `getIntegration(agentName)` updated to build `IntegrationItem` dynamically from spec data
- `listIntegrations()` returns all agents that have `integration` in `AGENT_CAPABILITIES`
- `openacp integrate <agent>` CLI command continues to work, delegates to same engine
- `openacp integrate <agent>` is idempotent — re-running updates files without duplicating

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Integration install fails | Log warning, do NOT fail agent install |
| Agent settings.json doesn't exist | Create new with minimal structure |
| Agent settings.json corrupt | Backup, create new, log warning |
| Missing `jq` dependency | **Block integration install** with error message and install hint. Agent install itself still succeeds. |
| Agent not in AGENT_CAPABILITIES | No integrate, no crash, `/handoff` says "not supported" |

## Files Changed

| File | Change |
|------|--------|
| `src/core/types.ts` | Add `AgentIntegrationSpec` interface |
| `src/core/agent-dependencies.ts` | Add `integration` spec to `AGENT_CAPABILITIES`, add resume for Gemini/Codex/Cline/Kilo/Amp |
| `src/cli/integrate.ts` | Refactor to data-driven engine: `installIntegration()`, `uninstallIntegration()`, script generators, generic settings merger |
| `src/cli/commands.ts` | Auto-integrate after install, auto-unintegrate after uninstall |
| `src/adapters/telegram/commands/agents.ts` | Auto-integrate in bot install flow |
| `src/adapters/telegram/adapter.ts` | No change needed — `/handoff` already uses generic `getAgentCapabilities()` |

## Hook Output Format

New agents default to `SESSION_ID` / `WORKING_DIR` variable names. Existing agents (Claude) retain their agent-specific prefixes for backward compatibility via `sessionIdVar` / `workingDirVar` fields.

Plaintext format (Claude — backward compat):
```
CLAUDE_SESSION_ID: abc123
CLAUDE_WORKING_DIR: /path/to/dir
```

Plaintext format (new agents without custom vars):
```
SESSION_ID: abc123
WORKING_DIR: /path/to/dir
```

JSON format (Gemini, Cline):
```json
{"additionalContext": "SESSION_ID: abc123\nWORKING_DIR: /path/to/dir"}
```

Note: `agent-registry.ts` re-exports capabilities from `agent-dependencies.ts`. The adapter's `/handoff` command imports via `agent-registry.ts` — this indirection is preserved.
