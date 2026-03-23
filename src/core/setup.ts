import { execFileSync } from "node:child_process";
import { input, select } from "@inquirer/prompts";
import type { Config, ConfigManager } from "./config.js";
import { expandHome } from "./config.js";
import { commandExists } from "./agent-dependencies.js";

// --- ANSI colors ---

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

const ok = (msg: string) =>
  `${c.green}${c.bold}✓${c.reset} ${c.green}${msg}${c.reset}`;
const warn = (msg: string) => `${c.yellow}⚠ ${msg}${c.reset}`;
const fail = (msg: string) => `${c.red}✗ ${msg}${c.reset}`;
const step = (n: number, title: string) =>
  `\n${c.cyan}${c.bold}[${n}/3]${c.reset} ${c.bold}${title}${c.reset}\n`;
const dim = (msg: string) => `${c.dim}${msg}${c.reset}`;

// --- Telegram validation ---

export async function validateBotToken(
  token: string,
): Promise<
  | { ok: true; botName: string; botUsername: string }
  | { ok: false; error: string }
> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as {
      ok: boolean;
      result?: { first_name: string; username: string };
      description?: string;
    };
    if (data.ok && data.result) {
      return {
        ok: true,
        botName: data.result.first_name,
        botUsername: data.result.username,
      };
    }
    return { ok: false, error: data.description || "Invalid token" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function validateChatId(
  token: string,
  chatId: number,
): Promise<
  { ok: true; title: string; isForum: boolean } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId }),
    });
    const data = (await res.json()) as {
      ok: boolean;
      result?: { title: string; type: string; is_forum?: boolean };
      description?: string;
    };
    if (!data.ok || !data.result) {
      return { ok: false, error: data.description || "Invalid chat ID" };
    }
    if (data.result.type !== "supergroup") {
      return {
        ok: false,
        error: `Chat is "${data.result.type}", must be a supergroup`,
      };
    }
    return {
      ok: true,
      title: data.result.title,
      isForum: data.result.is_forum === true,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function validateBotAdmin(
  token: string,
  chatId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // Get bot's own user ID
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const meData = (await meRes.json()) as {
      ok: boolean;
      result?: { id: number };
    };
    if (!meData.ok || !meData.result) {
      return { ok: false, error: "Could not retrieve bot info" };
    }

    const res = await fetch(
      `https://api.telegram.org/bot${token}/getChatMember`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, user_id: meData.result.id }),
      },
    );
    const data = (await res.json()) as {
      ok: boolean;
      result?: { status: string };
      description?: string;
    };
    if (!data.ok || !data.result) {
      return {
        ok: false,
        error: data.description || "Could not check bot membership",
      };
    }

    const { status } = data.result;
    if (status === "administrator" || status === "creator") {
      return { ok: true };
    }
    return {
      ok: false,
      error: `Bot is "${status}" in this group. It must be an admin. Please promote the bot to admin in group settings.`,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// --- Chat ID auto-detection ---

function promptManualChatId(): Promise<number> {
  return input({
    message: "Supergroup chat ID (e.g. -1001234567890):",
    validate: (val) => {
      const n = Number(val.trim());
      if (isNaN(n) || !Number.isInteger(n)) return "Chat ID must be an integer";
      return true;
    },
  }).then((val) => Number(val.trim()));
}

async function detectChatId(token: string): Promise<number> {
  // Clear old updates
  let lastUpdateId = 0;
  try {
    const clearRes = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?offset=-1`,
    );
    const clearData = (await clearRes.json()) as {
      ok: boolean;
      result?: Array<{ update_id: number }>;
    };
    if (clearData.ok && clearData.result?.length) {
      lastUpdateId = clearData.result[clearData.result.length - 1].update_id;
    }
  } catch {
    // ignore
  }

  console.log("");
  console.log(`  ${c.bold}If you don't have a supergroup yet:${c.reset}`);
  console.log(dim("  1. Open Telegram → New Group → add your bot"));
  console.log(dim("  2. Group Settings → convert to Supergroup"));
  console.log(dim("  3. Enable Topics in group settings"));
  console.log("");
  console.log(`  ${c.bold}Then send "hi" in the group.${c.reset}`);
  console.log(
    dim(
      `  Listening... press ${c.reset}${c.yellow}m${c.reset}${c.dim} to enter ID manually`,
    ),
  );
  console.log("");

  const MAX_ATTEMPTS = 120;
  const POLL_INTERVAL = 1000;

  // Listen for 'm' keypress to switch to manual
  let cancelled = false;
  const onKeypress = (data: Buffer) => {
    const key = data.toString();
    if (key === "m" || key === "M") {
      cancelled = true;
    }
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onKeypress);
  }

  const cleanup = () => {
    if (process.stdin.isTTY) {
      process.stdin.removeListener("data", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  };

  try {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (cancelled) {
        cleanup();
        return promptManualChatId();
      }

      try {
        const offset = lastUpdateId ? lastUpdateId + 1 : 0;
        const res = await fetch(
          `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=1`,
        );
        const data = (await res.json()) as {
          ok: boolean;
          result?: Array<{
            update_id: number;
            message?: {
              chat: { id: number; title?: string; type: string };
            };
            my_chat_member?: {
              chat: { id: number; title?: string; type: string };
            };
          }>;
        };

        if (!data.ok || !data.result?.length) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL));
          continue;
        }

        const groups = new Map<number, string>();
        for (const update of data.result) {
          lastUpdateId = update.update_id;
          const chat = update.message?.chat ?? update.my_chat_member?.chat;
          if (chat && (chat.type === "supergroup" || chat.type === "group")) {
            groups.set(chat.id, chat.title ?? String(chat.id));
          }
        }

        if (groups.size === 1) {
          const [id, title] = [...groups.entries()][0];
          console.log(
            ok(`Group detected: ${c.bold}${title}${c.reset}${c.green} (${id})`),
          );
          cleanup();
          return id;
        }

        if (groups.size > 1) {
          cleanup();
          const choices = [...groups.entries()].map(([id, title]) => ({
            name: `${title} (${id})`,
            value: id,
          }));
          return select({
            message: "Multiple groups found. Pick one:",
            choices,
          });
        }
      } catch {
        // Network error, retry
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }

    console.log(warn("Timed out waiting for messages."));
    cleanup();
    return promptManualChatId();
  } catch (err) {
    cleanup();
    throw err;
  }
}

// --- Agent detection ---

const KNOWN_AGENTS: Array<{ name: string; commands: string[] }> = [
  // claude-agent-acp is bundled as a dependency — no detection needed, but
  // kept here so detectAgents() still returns it for display purposes.
  { name: "claude", commands: ["claude-agent-acp"] },
  { name: "codex", commands: ["codex"] },
];

export async function detectAgents(): Promise<
  Array<{ name: string; command: string }>
> {
  const found: Array<{ name: string; command: string }> = [];
  for (const agent of KNOWN_AGENTS) {
    // Find all available commands for this agent (PATH + node_modules/.bin)
    const available: string[] = [];
    for (const cmd of agent.commands) {
      if (commandExists(cmd)) {
        available.push(cmd);
      }
    }
    if (available.length > 0) {
      // Prefer claude-agent-acp over claude/claude-code (priority order)
      found.push({ name: agent.name, command: available[0] });
    }
  }
  return found;
}

export async function validateAgentCommand(command: string): Promise<boolean> {
  try {
    execFileSync("which", [command], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// --- Setup steps ---

export async function setupTelegram(): Promise<Config["channels"][string]> {
  console.log(step(1, "Telegram Bot"));

  let botToken = "";

  while (true) {
    botToken = await input({
      message: "Bot token (from @BotFather):",
      validate: (val) => val.trim().length > 0 || "Token cannot be empty",
    });
    botToken = botToken.trim();

    const result = await validateBotToken(botToken);
    if (result.ok) {
      console.log(ok(`Connected to @${result.botUsername}`));
      break;
    }
    console.log(fail(result.error));
    const action = await select({
      message: "What to do?",
      choices: [
        { name: "Re-enter token", value: "retry" },
        { name: "Use as-is (skip validation)", value: "skip" },
      ],
    });
    if (action === "skip") break;
  }

  let chatId: number;

  while (true) {
    chatId = await detectChatId(botToken);

    // Validate bot can access this chat and it's a supergroup
    const chatResult = await validateChatId(botToken, chatId);
    if (!chatResult.ok) {
      console.log(fail(chatResult.error));
      console.log("");
      console.log(`  ${c.bold}How to fix:${c.reset}`);
      console.log(dim("  1. Make sure the bot is added to the group"));
      console.log(dim("  2. The group must be a Supergroup (Group Settings → convert)"));
      console.log(dim("  3. Send a message in the group after adding the bot"));
      console.log("");
      await input({ message: "Press Enter to try again..." });
      continue;
    }
    console.log(
      ok(
        `Group: ${c.bold}${chatResult.title}${c.reset}${c.green}${chatResult.isForum ? " (Topics enabled)" : ""}`,
      ),
    );

    // Check bot has admin privileges
    const adminResult = await validateBotAdmin(botToken, chatId);
    if (!adminResult.ok) {
      console.log(fail(adminResult.error));
      console.log("");
      console.log(`  ${c.bold}How to fix:${c.reset}`);
      console.log(dim("  1. Open the group in Telegram"));
      console.log(dim("  2. Go to Group Settings → Administrators"));
      console.log(dim("  3. Add the bot as an administrator"));
      console.log("");
      await input({ message: "Press Enter to check again..." });
      continue;
    }
    console.log(ok("Bot has admin privileges"));
    break;
  }

  return {
    enabled: true,
    botToken,
    chatId,
    notificationTopicId: null,
    assistantTopicId: null,
  };
}

export async function setupAgents(): Promise<{
  defaultAgent: string;
}> {
  const { AgentCatalog } = await import("./agent-catalog.js");
  const { select, checkbox } = await import("@inquirer/prompts");

  const catalog = new AgentCatalog();
  catalog.load();

  console.log(dim("  Checking available agents..."));
  await catalog.refreshRegistryIfStale();

  // Claude is always pre-installed (bundled dependency)
  if (!catalog.getInstalledAgent("claude")) {
    const claudeRegistry = catalog.findRegistryAgent("claude-acp");
    if (claudeRegistry) {
      await catalog.install("claude-acp");
    } else {
      // Fallback: register bundled claude-agent-acp directly
      const { AgentStore } = await import("./agent-store.js");
      const store = new AgentStore();
      store.load();
      store.addAgent("claude", {
        registryId: "claude-acp",
        name: "Claude Agent",
        version: "bundled",
        distribution: "npx",
        command: "npx",
        args: ["@zed-industries/claude-agent-acp"],
        env: {},
        installedAt: new Date().toISOString(),
        binaryPath: null,
      });
    }
  }
  console.log(ok("Claude Agent ready"));

  const available = catalog.getAvailable();
  const installed = available.filter((a) => a.installed);
  const installable = available.filter((a) => !a.installed && a.available);

  // Offer agent selection — show installed agents as pre-checked + disabled
  if (installed.length > 0 || installable.length > 0) {
    const choices = [
      ...installed.map((a) => ({
        name: `${a.name} (installed)`,
        value: a.key,
        checked: true,
        disabled: "(already installed)",
      })),
      ...installable.slice(0, 10).map((a) => ({
        name: `${a.name} (${a.distribution})`,
        value: a.key,
        checked: false,
      })),
    ];

    const selected = await checkbox({
      message: "Install additional agents? (Space to select, Enter to continue)",
      choices,
    });

    for (const key of selected) {
      const regAgent = catalog.findRegistryAgent(key);
      if (regAgent) {
        process.stdout.write(`  Installing ${regAgent.name}... `);
        const result = await catalog.install(key);
        if (result.ok) {
          console.log(ok("done"));
        } else {
          console.log(warn(`skipped: ${result.error}`));
        }
      }
    }
  }

  // Choose default agent
  const installedAgents = Object.keys(catalog.getInstalledEntries());
  let defaultAgent = "claude";

  if (installedAgents.length > 1) {
    defaultAgent = await select({
      message: "Which agent should be the default?",
      choices: installedAgents.map((key) => {
        const agent = catalog.getInstalledAgent(key)!;
        return { name: `${agent.name} (${key})`, value: key };
      }),
      default: "claude",
    });
  }

  console.log(ok(`Default agent: ${c.bold}${defaultAgent}${c.reset}`));
  return { defaultAgent };
}

export async function setupWorkspace(): Promise<{ baseDir: string }> {
  console.log(step(2, "Workspace"));

  const baseDir = await input({
    message: "Base directory for workspaces:",
    default: "~/openacp-workspace",
    validate: (val) => val.trim().length > 0 || "Path cannot be empty",
  });

  return { baseDir: baseDir.trim().replace(/^['"]|['"]$/g, "") };
}

export async function setupRunMode(): Promise<{ runMode: 'foreground' | 'daemon'; autoStart: boolean }> {
  console.log(step(3, 'Run Mode'))

  // Don't show daemon option on Windows
  if (process.platform === 'win32') {
    console.log(dim('  (Daemon mode not available on Windows)'))
    return { runMode: 'foreground', autoStart: false }
  }

  const mode = await select({
    message: 'How would you like to run OpenACP?',
    choices: [
      {
        name: 'Background (daemon)',
        value: 'daemon' as const,
        description: 'Runs silently, auto-starts on boot. Manage with: openacp status | stop | logs',
      },
      {
        name: 'Foreground (terminal)',
        value: 'foreground' as const,
        description: 'Runs in current terminal session. Start with: openacp',
      },
    ],
  })

  if (mode === 'daemon') {
    const { installAutoStart, isAutoStartSupported } = await import('./autostart.js')
    const autoStart = isAutoStartSupported()
    if (autoStart) {
      const result = installAutoStart(expandHome('~/.openacp/logs'))
      if (result.success) {
        console.log(ok('Auto-start on boot enabled'))
      } else {
        console.log(warn(`Auto-start failed: ${result.error}`))
      }
    }
    return { runMode: 'daemon', autoStart }
  }

  return { runMode: 'foreground', autoStart: false }
}

// --- Orchestrator ---

function printWelcomeBanner(): void {
  console.log(`
${c.cyan}${c.bold}  ╔══════════════════════════════╗
  ║        Welcome to OpenACP    ║
  ╚══════════════════════════════╝${c.reset}
`);
}

export async function runSetup(configManager: ConfigManager): Promise<boolean> {
  printWelcomeBanner();

  try {
    const telegram = await setupTelegram();
    const { defaultAgent } = await setupAgents();

    // Offer Claude CLI integration
    {
      const { confirm } = await import("@inquirer/prompts");
      const installClaude = await confirm({
        message: "Install session transfer for Claude? (enables /openacp:handoff in your terminal)",
        default: true,
      });

      if (installClaude) {
        try {
          const { getIntegration } = await import("../cli/integrate.js");
          const integration = getIntegration("claude");
          if (integration) {
            for (const item of integration.items) {
              const result = await item.install();
              for (const log of result.logs) console.log(`  ${log}`);
            }
          }
          console.log("Claude CLI integration installed.\n");
        } catch (err) {
          console.log(`Could not install Claude CLI integration: ${err instanceof Error ? err.message : err}`);
          console.log("  You can install it later with: openacp integrate claude\n");
        }
      }
    }

    const workspace = await setupWorkspace();
    const { runMode, autoStart } = await setupRunMode();
    const security = {
      allowedUserIds: [] as string[],
      maxConcurrentSessions: 20,
      sessionTimeoutMinutes: 60,
    };

    const config: Config = {
      channels: { telegram },
      agents: {},
      defaultAgent,
      workspace,
      security,
      logging: {
        level: "info",
        logDir: "~/.openacp/logs",
        maxFileSize: "10m",
        maxFiles: 7,
        sessionLogRetentionDays: 30,
      },
      runMode,
      autoStart,
      api: {
        port: 21420,
        host: '127.0.0.1',
      },
      sessionStore: { ttlDays: 30 },
      tunnel: {
        enabled: true,
        port: 3100,
        provider: "cloudflare",
        options: {},
        storeTtlMinutes: 60,
        auth: { enabled: false },
      },
      integrations: {},
    };

    try {
      await configManager.writeNew(config);
    } catch (writeErr) {
      console.log(
        fail(`Could not save config: ${(writeErr as Error).message}`),
      );
      return false;
    }

    console.log("");
    console.log(
      ok(`Config saved to ${c.bold}${configManager.getConfigPath()}`),
    );

    // Pre-download cloudflared if tunnel enabled
    if (config.tunnel.enabled && config.tunnel.provider === "cloudflare") {
      console.log(dim("  Ensuring cloudflared is installed..."));
      try {
        const { ensureCloudflared } = await import(
          "../tunnel/providers/install-cloudflared.js"
        );
        const binPath = await ensureCloudflared();
        console.log(ok(`cloudflared ready at ${dim(binPath)}`));
      } catch (err) {
        console.log(
          warn(
            `Could not install cloudflared: ${(err as Error).message}. Tunnel may not work.`,
          ),
        );
      }
    }

    console.log(ok("Starting OpenACP..."));
    console.log("");

    return true;
  } catch (err) {
    if ((err as Error).name === "ExitPromptError") {
      console.log(dim("\nSetup cancelled."));
      return false;
    }
    throw err;
  }
}
