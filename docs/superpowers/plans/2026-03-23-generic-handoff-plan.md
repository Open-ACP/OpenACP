# Generic Bi-directional Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Claude-only handoff with a data-driven integration engine supporting all agents with hooks/resume capabilities.

**Architecture:** Extend `AgentCapability` interface with optional `integration` spec. Refactor `integrate.ts` from hardcoded Claude logic to a generic engine that reads spec data to generate scripts, merge settings, and manage slash commands. Auto-integrate on agent install/uninstall.

**Tech Stack:** TypeScript, Node.js fs, jq (shell scripts)

**Spec:** `docs/superpowers/specs/2026-03-23-generic-handoff-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/agent-dependencies.ts` | Modify | Add `AgentIntegrationSpec` interface, extend `AgentCapability`, add integration specs + resume commands for 7 agents |
| `src/core/agent-registry.ts` | No change | Already re-exports from agent-dependencies.ts |
| `src/cli/integrate.ts` | Rewrite | Data-driven engine: script generators, generic settings merger, dynamic integration registry |
| `src/cli/commands.ts` | Modify | Auto-integrate after install, auto-unintegrate after uninstall |
| `src/adapters/telegram/commands/agents.ts` | Modify | Auto-integrate in bot install flow |

---

### Task 1: Extend AgentCapability with integration specs and resume commands

**Files:**
- Modify: `src/core/agent-dependencies.ts`

- [ ] **Step 1: Add AgentIntegrationSpec interface**

Add after `AgentCapability` interface (line 20):

```typescript
export interface AgentIntegrationSpec {
  hookEvent: string;
  settingsPath: string;
  settingsFormat: "settings_json" | "hooks_json";
  hooksDirPath: string;
  outputFormat: "plaintext" | "json";
  sessionIdField: string;
  commandsPath?: string;
  handoffCommandName?: string;
  commandFormat?: "markdown" | "skill";
  sessionIdVar?: string;
  workingDirVar?: string;
}
```

- [ ] **Step 2: Extend AgentCapability interface**

Update the `AgentCapability` interface to add the optional `integration` field:

```typescript
export interface AgentCapability {
  supportsResume: boolean;
  resumeCommand?: (sessionId: string) => string;
  integration?: AgentIntegrationSpec;
}
```

- [ ] **Step 3: Expand AGENT_CAPABILITIES with all agents**

Replace the existing `AGENT_CAPABILITIES` object (line 171-176) with:

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
      sessionIdVar: "CLAUDE_SESSION_ID",
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
  },
  kilo: {
    supportsResume: true,
    resumeCommand: () => `kilo --continue`,
  },
  amp: {
    supportsResume: true,
    resumeCommand: (sid) => `amp threads continue ${sid}`,
  },
};
```

- [ ] **Step 4: Build and verify no type errors**

Run: `pnpm build`
Expected: Compiles successfully

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-dependencies.ts
git commit -m "feat(handoff): extend AgentCapability with integration specs and resume for 7 agents"
```

---

### Task 2: Rewrite integrate.ts as data-driven engine

**Files:**
- Rewrite: `src/cli/integrate.ts`

- [ ] **Step 1: Write the data-driven integration engine**

Replace the entire `src/cli/integrate.ts` with a generic engine. The new file should:

1. Keep the existing `IntegrationResult`, `IntegrationItem`, `AgentIntegration` interfaces (backward compat)
2. Import `AgentIntegrationSpec` and capabilities from `agent-dependencies.ts`
3. Implement these functions:

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getAgentCapabilities, commandExists } from "../core/agent-dependencies.js";
import type { AgentIntegrationSpec } from "../core/agent-dependencies.js";

export interface IntegrationResult {
  success: boolean;
  logs: string[];
}

export interface IntegrationItem {
  id: string;
  name: string;
  description: string;
  isInstalled(): boolean;
  install(): Promise<IntegrationResult>;
  uninstall(): Promise<IntegrationResult>;
}

export interface AgentIntegration {
  items: IntegrationItem[];
}

const HOOK_MARKER = "openacp-inject-session.sh";

function expandPath(p: string): string {
  return p.replace(/^~/, homedir());
}

// --- Script generators ---

function generateInjectScript(agentKey: string, spec: AgentIntegrationSpec): string {
  const sidVar = spec.sessionIdVar ?? "SESSION_ID";
  const cwdVar = spec.workingDirVar ?? "WORKING_DIR";

  if (spec.outputFormat === "plaintext") {
    return `#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '${spec.sessionIdField}')
CWD=$(echo "$INPUT" | jq -r '.cwd')

echo "${sidVar}: $SESSION_ID"
echo "${cwdVar}: $CWD"

exit 0
`;
  }
  // JSON output (Gemini, Cline, Cursor)
  return `#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '${spec.sessionIdField}')
CWD=$(echo "$INPUT" | jq -r '.cwd')

jq -n --arg sid "$SESSION_ID" --arg cwd "$CWD" \\
  '{"additionalContext":"${sidVar}: \\($sid)\\n${cwdVar}: \\($cwd)"}'

exit 0
`;
}

function generateHandoffScript(agentKey: string): string {
  return `#!/bin/bash
SESSION_ID=$1
CWD=$2

if [ -z "$SESSION_ID" ]; then
  echo "Usage: openacp-handoff.sh <session_id> [cwd]"
  exit 1
fi

openacp adopt ${agentKey} "$SESSION_ID" \${CWD:+--cwd "$CWD"}
`;
}

function generateHandoffCommand(agentKey: string, spec: AgentIntegrationSpec): string {
  const sidVar = spec.sessionIdVar ?? "SESSION_ID";
  const cwdVar = spec.workingDirVar ?? "WORKING_DIR";

  return `---
description: Transfer current session to OpenACP (Telegram)
---

Look at the context injected at the start of this message to find
${sidVar} and ${cwdVar}, then run:

bash ${expandPath(spec.hooksDirPath)}openacp-handoff.sh <${sidVar}> <${cwdVar}>
`;
}

// --- Settings mergers ---

function mergeSettingsJson(settingsPath: string, hookEvent: string, hookScriptPath: string): void {
  const fullPath = expandPath(settingsPath);
  let settings: Record<string, unknown> = {};

  if (existsSync(fullPath)) {
    const raw = readFileSync(fullPath, "utf-8");
    writeFileSync(`${fullPath}.bak`, raw);
    settings = JSON.parse(raw);
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  settings.hooks = hooks;

  const eventHooks = (hooks[hookEvent] ?? []) as Array<{ hooks?: Array<{ type?: string; command?: string }> }>;
  hooks[hookEvent] = eventHooks;

  const alreadyInstalled = eventHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes(HOOK_MARKER)),
  );

  if (!alreadyInstalled) {
    eventHooks.push({
      hooks: [{ type: "command", command: hookScriptPath }],
    });
  }

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(settings, null, 2) + "\n");
}

function mergeHooksJson(settingsPath: string, hookEvent: string, hookScriptPath: string): void {
  const fullPath = expandPath(settingsPath);
  let config: Record<string, unknown> = { version: 1 };

  if (existsSync(fullPath)) {
    const raw = readFileSync(fullPath, "utf-8");
    writeFileSync(`${fullPath}.bak`, raw);
    config = JSON.parse(raw);
  }

  const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
  config.hooks = hooks;

  const eventHooks = (hooks[hookEvent] ?? []) as Array<{ command?: string }>;
  hooks[hookEvent] = eventHooks;

  const alreadyInstalled = eventHooks.some((h) => h.command?.includes(HOOK_MARKER));

  if (!alreadyInstalled) {
    eventHooks.push({ command: hookScriptPath });
  }

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n");
}

function removeFromSettingsJson(settingsPath: string, hookEvent: string): void {
  const fullPath = expandPath(settingsPath);
  if (!existsSync(fullPath)) return;

  const raw = readFileSync(fullPath, "utf-8");
  const settings = JSON.parse(raw);
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks?.[hookEvent]) return;

  hooks[hookEvent] = (hooks[hookEvent] as Array<{ hooks?: Array<{ command?: string }> }>).filter(
    (group) => !group.hooks?.some((h) => h.command?.includes("openacp-")),
  );

  if ((hooks[hookEvent] as unknown[]).length === 0) {
    delete hooks[hookEvent];
  }

  writeFileSync(fullPath, JSON.stringify(settings, null, 2) + "\n");
}

function removeFromHooksJson(settingsPath: string, hookEvent: string): void {
  const fullPath = expandPath(settingsPath);
  if (!existsSync(fullPath)) return;

  const raw = readFileSync(fullPath, "utf-8");
  const config = JSON.parse(raw);
  const hooks = config.hooks as Record<string, unknown[]> | undefined;
  if (!hooks?.[hookEvent]) return;

  hooks[hookEvent] = (hooks[hookEvent] as Array<{ command?: string }>).filter(
    (h) => !h.command?.includes("openacp-"),
  );

  if ((hooks[hookEvent] as unknown[]).length === 0) {
    delete hooks[hookEvent];
  }

  writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n");
}

// --- Core install/uninstall ---

export async function installIntegration(agentKey: string, spec: AgentIntegrationSpec): Promise<IntegrationResult> {
  const logs: string[] = [];
  try {
    // Check jq
    if (!commandExists("jq")) {
      return { success: false, logs: ["jq is required for handoff hooks. Install: brew install jq (macOS) or apt install jq (Linux)"] };
    }

    const hooksDir = expandPath(spec.hooksDirPath);
    mkdirSync(hooksDir, { recursive: true });

    // Inject script
    const injectPath = join(hooksDir, "openacp-inject-session.sh");
    writeFileSync(injectPath, generateInjectScript(agentKey, spec));
    chmodSync(injectPath, 0o755);
    logs.push(`Created ${injectPath}`);

    // Handoff script
    const handoffPath = join(hooksDir, "openacp-handoff.sh");
    writeFileSync(handoffPath, generateHandoffScript(agentKey));
    chmodSync(handoffPath, 0o755);
    logs.push(`Created ${handoffPath}`);

    // Slash command / skill
    if (spec.commandsPath && spec.handoffCommandName) {
      if (spec.commandFormat === "skill") {
        const skillDir = expandPath(join(spec.commandsPath, spec.handoffCommandName));
        mkdirSync(skillDir, { recursive: true });
        const skillPath = join(skillDir, "SKILL.md");
        writeFileSync(skillPath, generateHandoffCommand(agentKey, spec));
        logs.push(`Created ${skillPath}`);
      } else {
        const cmdsDir = expandPath(spec.commandsPath);
        mkdirSync(cmdsDir, { recursive: true });
        const cmdPath = join(cmdsDir, `${spec.handoffCommandName}.md`);
        writeFileSync(cmdPath, generateHandoffCommand(agentKey, spec));
        logs.push(`Created ${cmdPath}`);
      }
    }

    // Merge settings
    if (spec.settingsFormat === "hooks_json") {
      mergeHooksJson(spec.settingsPath, spec.hookEvent, injectPath);
    } else {
      mergeSettingsJson(spec.settingsPath, spec.hookEvent, injectPath);
    }
    logs.push(`Updated ${expandPath(spec.settingsPath)}`);

    return { success: true, logs };
  } catch (err) {
    logs.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, logs };
  }
}

export async function uninstallIntegration(agentKey: string, spec: AgentIntegrationSpec): Promise<IntegrationResult> {
  const logs: string[] = [];
  try {
    const hooksDir = expandPath(spec.hooksDirPath);

    // Remove hook scripts
    for (const filename of ["openacp-inject-session.sh", "openacp-handoff.sh"]) {
      const filePath = join(hooksDir, filename);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        logs.push(`Removed ${filePath}`);
      }
    }

    // Remove slash command / skill
    if (spec.commandsPath && spec.handoffCommandName) {
      if (spec.commandFormat === "skill") {
        const skillDir = expandPath(join(spec.commandsPath, spec.handoffCommandName));
        const skillPath = join(skillDir, "SKILL.md");
        if (existsSync(skillPath)) {
          unlinkSync(skillPath);
          // Try to remove empty skill dir
          try { const { rmdirSync } = await import("node:fs"); rmdirSync(skillDir); } catch { /* not empty */ }
          logs.push(`Removed ${skillPath}`);
        }
      } else {
        const cmdPath = expandPath(join(spec.commandsPath, `${spec.handoffCommandName}.md`));
        if (existsSync(cmdPath)) {
          unlinkSync(cmdPath);
          logs.push(`Removed ${cmdPath}`);
        }
      }
    }

    // Clean settings
    if (spec.settingsFormat === "hooks_json") {
      removeFromHooksJson(spec.settingsPath, spec.hookEvent);
    } else {
      removeFromSettingsJson(spec.settingsPath, spec.hookEvent);
    }
    logs.push(`Updated ${expandPath(spec.settingsPath)}`);

    return { success: true, logs };
  } catch (err) {
    logs.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, logs };
  }
}

// --- Public API (backward compat) ---

function buildIntegrationItem(agentKey: string, spec: AgentIntegrationSpec): IntegrationItem {
  const hooksDir = expandPath(spec.hooksDirPath);
  return {
    id: "handoff",
    name: "Handoff",
    description: "Transfer sessions between terminal and Telegram",
    isInstalled(): boolean {
      return existsSync(join(hooksDir, "openacp-inject-session.sh")) &&
        existsSync(join(hooksDir, "openacp-handoff.sh"));
    },
    install: () => installIntegration(agentKey, spec),
    uninstall: () => uninstallIntegration(agentKey, spec),
  };
}

export function getIntegration(agentName: string): AgentIntegration | undefined {
  const caps = getAgentCapabilities(agentName);
  if (!caps.integration) return undefined;
  return { items: [buildIntegrationItem(agentName, caps.integration)] };
}

export function listIntegrations(): string[] {
  // Import is sync-safe since agent-dependencies is already loaded
  const { getAllAgentCapabilities } = require("../core/agent-dependencies.js");
  // Fallback: hardcoded list matching agents with integration spec
  return ["claude", "cursor", "gemini", "cline"];
}
```

**Wait** — we can't use `require` in ESM. Instead, add a helper to `agent-dependencies.ts`.

- [ ] **Step 2: Add `listAgentsWithIntegration()` to agent-dependencies.ts**

Add at the bottom of `agent-dependencies.ts`:

```typescript
export function listAgentsWithIntegration(): string[] {
  return Object.entries(AGENT_CAPABILITIES)
    .filter(([, cap]) => cap.integration != null)
    .map(([key]) => key);
}
```

- [ ] **Step 3: Fix listIntegrations() in integrate.ts**

Update the `listIntegrations` function to use the new helper:

```typescript
export function listIntegrations(): string[] {
  // Dynamically builds list from agents that have integration specs
  const { listAgentsWithIntegration } = require("../core/agent-dependencies.js");
  return listAgentsWithIntegration();
}
```

Actually, since this is ESM, use a different approach — just import at top level:

```typescript
import { getAgentCapabilities, commandExists, listAgentsWithIntegration } from "../core/agent-dependencies.js";
import type { AgentIntegrationSpec } from "../core/agent-dependencies.js";
```

And:

```typescript
export function listIntegrations(): string[] {
  return listAgentsWithIntegration();
}
```

- [ ] **Step 4: Build and verify**

Run: `pnpm build`
Expected: Compiles successfully

- [ ] **Step 5: Test manually — Claude integration backward compat**

Run: `node dist/cli.js integrate claude`
Expected: Creates same files as before in `~/.claude/hooks/` and `~/.claude/commands/`, merges settings.json

Run: `node dist/cli.js integrate claude --uninstall`
Expected: Removes files, cleans settings.json

- [ ] **Step 6: Test manually — new agent integration**

Run: `node dist/cli.js integrate gemini`
Expected: Creates `~/.gemini/hooks/openacp-inject-session.sh` and `openacp-handoff.sh`, merges `~/.gemini/settings.json`

Run: `node dist/cli.js integrate gemini --uninstall`
Expected: Removes files, cleans settings

- [ ] **Step 7: Commit**

```bash
git add src/cli/integrate.ts src/core/agent-dependencies.ts
git commit -m "feat(handoff): rewrite integrate.ts as data-driven engine supporting all agents"
```

---

### Task 3: Auto-integrate on agent install (CLI)

**Files:**
- Modify: `src/cli/commands.ts`

- [ ] **Step 1: Add auto-integrate to agentsInstall()**

After line 960 (after the `if (!result.ok)` block), before setup steps display, add:

```typescript
  // Auto-integrate handoff if agent supports it
  const { getAgentCapabilities } = await import("../core/agent-dependencies.js");
  const caps = getAgentCapabilities(result.agentKey);
  if (caps.integration) {
    const { installIntegration } = await import("./integrate.js");
    const intResult = await installIntegration(result.agentKey, caps.integration);
    if (intResult.success) {
      console.log(`  \x1b[32m✓\x1b[0m Handoff integration installed for ${result.agentKey}`);
    } else {
      console.log(`  \x1b[33m⚠ Handoff integration failed: ${intResult.logs[intResult.logs.length - 1] ?? "unknown error"}\x1b[0m`);
    }
  }
```

- [ ] **Step 2: Add auto-unintegrate to agentsUninstall()**

After `catalog.uninstall(name)` succeeds (inside the `if (result.ok)` block, line 984), add:

```typescript
    // Auto-uninstall handoff integration if exists
    const { getAgentCapabilities } = await import("../core/agent-dependencies.js");
    const caps = getAgentCapabilities(name);
    if (caps.integration) {
      const { uninstallIntegration } = await import("./integrate.js");
      await uninstallIntegration(name, caps.integration);
      console.log(`  \x1b[32m✓\x1b[0m Handoff integration removed for ${name}`);
    }
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands.ts
git commit -m "feat(handoff): auto-integrate/unintegrate on agent install/uninstall (CLI)"
```

---

### Task 4: Auto-integrate on agent install (Telegram bot)

**Files:**
- Modify: `src/adapters/telegram/commands/agents.ts`

- [ ] **Step 1: Add auto-integrate after successful install**

In the `installAgentWithProgress()` function, after the `catalog.install()` call (line 231) and the setup steps block (line 243), add:

```typescript
  // Auto-integrate handoff if agent supports it
  if (result.ok) {
    const { getAgentCapabilities } = await import("../../../core/agent-dependencies.js");
    const caps = getAgentCapabilities(result.agentKey);
    if (caps.integration) {
      const { installIntegration } = await import("../../../cli/integrate.js");
      const intResult = await installIntegration(result.agentKey, caps.integration);
      if (intResult.success) {
        try {
          await ctx.reply(`🔗 Handoff integration installed for <b>${escapeHtml(result.agentKey)}</b>`, { parse_mode: "HTML" });
        } catch { /* ignore */ }
      }
    }
  }
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build`
Expected: Compiles successfully

- [ ] **Step 3: Commit**

```bash
git add src/adapters/telegram/commands/agents.ts
git commit -m "feat(handoff): auto-integrate on agent install (Telegram bot)"
```

---

### Task 5: Final build verification and cleanup

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 2: Run tests (if any)**

Run: `pnpm test`
Expected: All pass (or no tests configured)

- [ ] **Step 3: Verify integrate command lists all agents**

Run: `node dist/cli.js integrate`
Expected: Shows "Available integrations: claude, cursor, gemini, cline"

- [ ] **Step 4: Final commit with all changes**

If any uncommitted changes remain:
```bash
git add -A
git commit -m "feat(handoff): generic bi-directional handoff for all agents"
```
