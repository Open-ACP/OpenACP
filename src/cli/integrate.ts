import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getAgentCapabilities, commandExists, listAgentsWithIntegration } from "../core/agent-dependencies.js";
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

function generateInjectScript(_agentKey: string, spec: AgentIntegrationSpec): string {
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

function generateHandoffCommand(_agentKey: string, spec: AgentIntegrationSpec): string {
  const sidVar = spec.sessionIdVar ?? "SESSION_ID";
  const cwdVar = spec.workingDirVar ?? "WORKING_DIR";
  const hooksDir = expandPath(spec.hooksDirPath);

  return `---
description: Transfer current session to OpenACP (Telegram)
---

Look at the context injected at the start of this message to find
${sidVar} and ${cwdVar}, then run:

bash ${hooksDir}openacp-handoff.sh <${sidVar}> <${cwdVar}>
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
      return {
        success: false,
        logs: ["jq is required for handoff hooks. Install: brew install jq (macOS) or apt install jq (Linux)"],
      };
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
    const injectFullPath = join(hooksDir, "openacp-inject-session.sh");
    if (spec.settingsFormat === "hooks_json") {
      mergeHooksJson(spec.settingsPath, spec.hookEvent, injectFullPath);
    } else {
      mergeSettingsJson(spec.settingsPath, spec.hookEvent, injectFullPath);
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
          try { rmdirSync(skillDir); } catch { /* not empty */ }
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

// --- Public API (backward compat with existing cmdIntegrate / Telegram integrate) ---

function buildIntegrationItem(agentKey: string, spec: AgentIntegrationSpec): IntegrationItem {
  const hooksDir = expandPath(spec.hooksDirPath);
  return {
    id: "handoff",
    name: "Handoff",
    description: "Transfer sessions between terminal and Telegram",
    isInstalled(): boolean {
      return (
        existsSync(join(hooksDir, "openacp-inject-session.sh")) &&
        existsSync(join(hooksDir, "openacp-handoff.sh"))
      );
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
  return listAgentsWithIntegration();
}
