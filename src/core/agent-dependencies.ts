import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AvailabilityResult } from "./types.js";

export interface AgentDependency {
  command: string;
  label: string;
  installHint: string;
}

export interface AgentSetupInfo {
  setupSteps: string[];
  loginCommand?: string;
}

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

export interface AgentCapability {
  supportsResume: boolean;
  resumeCommand?: (sessionId: string) => string;
  integration?: AgentIntegrationSpec;
}

const AGENT_DEPENDENCIES: Record<string, AgentDependency[]> = {
  "claude-acp": [
    {
      command: "claude",
      label: "Claude CLI",
      installHint: "npm install -g @anthropic-ai/claude-code",
    },
  ],
  "codex-acp": [
    {
      command: "codex",
      label: "Codex CLI",
      installHint: "npm install -g @openai/codex",
    },
  ],
};

const AGENT_SETUP: Record<string, AgentSetupInfo> = {
  // --- Agents requiring their own CLI installed first ---
  "claude-acp": {
    setupSteps: [
      "Install Claude CLI: npm install -g @anthropic-ai/claude-code",
      "Login: claude login (opens browser for Anthropic account)",
    ],
    loginCommand: "claude login",
  },
  "codex-acp": {
    setupSteps: [
      "Install Codex CLI: npm install -g @openai/codex",
      "Login: codex (select 'Sign in with ChatGPT')",
      "Or set API key: export OPENAI_API_KEY=<your-key>",
    ],
    loginCommand: "codex",
  },

  // --- Agents with built-in auth (npx handles download) ---
  "gemini": {
    setupSteps: [
      "Login with Google: openacp agents run gemini (select 'Sign in with Google')",
      "Or set API key: export GEMINI_API_KEY=<key> (get from aistudio.google.com/apikey)",
      "Free tier: 60 requests/min, 1000 requests/day",
    ],
    loginCommand: "openacp agents run gemini",
  },
  "github-copilot-cli": {
    setupSteps: [
      "Requires active GitHub Copilot subscription",
      "Login: openacp agents run copilot (use /login command inside CLI)",
      "Or set token: export GITHUB_TOKEN=<personal-access-token>",
    ],
    loginCommand: "openacp agents run copilot",
  },
  "cline": {
    setupSteps: [
      "Setup: openacp agents run cline (guided API key setup on first run)",
      "Supports: Anthropic, OpenAI, Gemini, AWS Bedrock, Azure, Ollama, and more",
      "Or set env: export ANTHROPIC_API_KEY=<key> (or OPENAI_API_KEY, etc.)",
    ],
    loginCommand: "openacp agents run cline",
  },
  "auggie": {
    setupSteps: [
      "Login: openacp agents run auggie (opens browser for Augment account on first run)",
    ],
    loginCommand: "openacp agents run auggie",
  },
  "qwen-code": {
    setupSteps: [
      "Login: openacp agents run qwen (use /auth command, select 'Qwen OAuth')",
      "Free: 1000 requests/day with Qwen OAuth",
      "Or set API key: export OPENAI_API_KEY=<key> in ~/.qwen/settings.json",
    ],
    loginCommand: "openacp agents run qwen",
  },

  // --- Agents requiring API keys via env vars ---
  "kimi": {
    setupSteps: [
      "Login: openacp agents run kimi (use /login command inside CLI)",
      "Recommended: select 'Kimi Code' for browser-based OAuth",
      "Or select another provider and enter API key manually",
    ],
    loginCommand: "openacp agents run kimi",
  },
  "cursor": {
    setupSteps: [
      "Requires active Cursor subscription",
      "Login: openacp agents run cursor (opens browser for Cursor account)",
    ],
    loginCommand: "openacp agents run cursor",
  },

  // --- Agents with provider selection on first run ---
  "goose": {
    setupSteps: [
      "First run auto-enters setup mode — choose your LLM provider",
      "Options: OpenAI, Anthropic, Google Gemini, OpenRouter, or local models",
      "Set provider API key: export OPENAI_API_KEY=<key> (or other provider)",
      "Reconfigure anytime: goose configure",
    ],
  },
  "junie": {
    setupSteps: [
      "Bring Your Own Key (BYOK) — provide API key from any supported provider",
      "Supports: OpenAI, Anthropic, Gemini, xAI, OpenRouter",
      "Free tier: up to $50 with Gemini 3 Flash included",
      "Set key via env or first-run setup prompt",
    ],
  },
  "kilo": {
    setupSteps: [
      "Options: bring your own API keys (Anthropic, OpenAI, Google) or use Kilo Gateway",
      "Kilo Gateway: pay-as-you-go, includes free models — no API key needed",
      "BYOK: set provider key, e.g. export ANTHROPIC_API_KEY=<key>",
    ],
  },
  "mistral-vibe": {
    setupSteps: [
      "Get API key from console.mistral.ai/codestral/cli",
      "Or sign up for Free/Pro/Team plan at mistral.ai",
      "Set key when prompted on first run",
    ],
  },
  "deepagents": {
    setupSteps: [
      "Powered by LangChain — set your LLM provider API key",
      "Example: export OPENAI_API_KEY=<key> or export ANTHROPIC_API_KEY=<key>",
    ],
  },

  // --- Agents that work out of the box (no setup / minimal setup) ---
  "crow-cli": {
    setupSteps: [
      "Requires uvx (Python package runner): pip install uv",
      "Bring your own API key for your chosen LLM provider",
    ],
  },
  "fast-agent": {
    setupSteps: [
      "Requires uvx (Python package runner): pip install uv",
      "Configure LLM provider in agent config file",
    ],
  },
};

export function getAgentSetup(registryId: string): AgentSetupInfo | undefined {
  return AGENT_SETUP[registryId];
}

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

export const REGISTRY_AGENT_ALIASES: Record<string, string> = {
  "claude-acp": "claude",
  "codex-acp": "codex",
  "gemini": "gemini",
  "cursor": "cursor",
  "github-copilot-cli": "copilot",
  "cline": "cline",
  "goose": "goose",
  "kilo": "kilo",
  "qwen-code": "qwen",
};

export function getAgentAlias(registryId: string): string {
  return REGISTRY_AGENT_ALIASES[registryId] ?? registryId;
}

export function getAgentDependencies(registryId: string): AgentDependency[] {
  return AGENT_DEPENDENCIES[registryId] ?? [];
}

export function getAgentCapabilities(agentName: string): AgentCapability {
  return AGENT_CAPABILITIES[agentName] ?? { supportsResume: false };
}

export function listAgentsWithIntegration(): string[] {
  return Object.entries(AGENT_CAPABILITIES)
    .filter(([, cap]) => cap.integration != null)
    .map(([key]) => key);
}

export function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "pipe" });
    return true;
  } catch {
    // not in PATH
  }
  // Check node_modules/.bin (walks up from cwd)
  let dir = process.cwd();
  while (true) {
    const binPath = path.join(dir, "node_modules", ".bin", cmd);
    if (fs.existsSync(binPath)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

export function checkDependencies(registryId: string): AvailabilityResult {
  const deps = getAgentDependencies(registryId);
  if (deps.length === 0) return { available: true };

  const missing = deps.filter((d) => !commandExists(d.command));
  if (missing.length === 0) return { available: true };

  return {
    available: false,
    reason: `Requires: ${missing.map((m) => m.label).join(", ")}`,
    missing: missing.map((m) => ({ label: m.label, installHint: m.installHint })),
  };
}

export function checkRuntimeAvailable(runtime: "npx" | "uvx"): boolean {
  return commandExists(runtime);
}
