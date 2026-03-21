import type { OpenACPCore, ChannelAdapter, Config, Session } from "../../core/index.js";
import { createChildLogger } from "../../core/log.js";
const log = createChildLogger({ module: "telegram-assistant" });

export type SpawnAssistantResult = {
  session: Session;
  /** Resolves when the background system prompt completes (or fails). */
  ready: Promise<void>;
};

export async function spawnAssistant(
  core: OpenACPCore,
  adapter: ChannelAdapter,
  assistantTopicId: number,
): Promise<SpawnAssistantResult> {
  const config = core.configManager.get();

  // Create session with default agent
  log.info({ agent: config.defaultAgent }, "Creating assistant session...");
  const session = await core.sessionManager.createSession(
    "telegram",
    config.defaultAgent,
    core.configManager.resolveWorkspace(),
    core.agentManager,
  );
  session.threadId = String(assistantTopicId);
  session.name = "Assistant"; // Prevent auto-naming from triggering after system prompt
  log.info({ sessionId: session.id }, "Assistant agent spawned");

  // Wire events first so the adapter is ready to receive real user responses.
  // The system prompt response will be suppressed by the adapter via the
  // assistantInitializing flag — it checks the flag before routing messages.
  core.wireSessionEvents(session, adapter);

  // Build dynamic context for system prompt
  const allRecords = core.sessionManager.listRecords();
  const activeCount = allRecords.filter(r => r.status === 'active' || r.status === 'initializing').length;
  const statusCounts = new Map<string, number>();
  for (const r of allRecords) {
    statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
  }
  const topicSummary = Array.from(statusCounts.entries()).map(([status, count]) => ({ status, count }));

  const ctx: AssistantContext = {
    config,
    activeSessionCount: activeCount,
    totalSessionCount: allRecords.length,
    topicSummary,
  };

  // Fire system prompt in background — don't block startup.
  const systemPrompt = buildAssistantSystemPrompt(ctx);
  const ready = session.enqueuePrompt(systemPrompt)
    .then(() => { log.info({ sessionId: session.id }, "Assistant system prompt completed"); })
    .catch((err) => { log.warn({ err }, "Assistant system prompt failed"); });

  return { session, ready };
}

export interface AssistantContext {
  config: Config
  activeSessionCount: number
  totalSessionCount: number
  topicSummary: { status: string; count: number }[]
}

export interface WelcomeContext {
  activeCount: number;
  errorCount: number;
  totalCount: number;
  agents: string[];
  defaultAgent: string;
}

export function buildWelcomeMessage(ctx: WelcomeContext): string {
  const { activeCount, errorCount, totalCount, agents, defaultAgent } = ctx;

  const agentList = agents
    .map((a) => `${a}${a === defaultAgent ? " (default)" : ""}`)
    .join(", ");

  // Variant 1: No sessions
  if (totalCount === 0) {
    return `👋 <b>OpenACP is ready!</b>\n\nNo sessions yet. Tap 🆕 New Session to start, or ask me anything!`;
  }

  // Variant 2: Has errors
  if (errorCount > 0) {
    return (
      `👋 <b>OpenACP is ready!</b>\n\n` +
      `📊 ${activeCount} active, ${errorCount} errors / ${totalCount} total\n` +
      `⚠️ ${errorCount} session${errorCount > 1 ? "s have" : " has"} errors — ask me to check if you'd like.\n\n` +
      `Agents: ${agentList}`
    );
  }

  // Variant 3/4: Has active or fallback
  return (
    `👋 <b>OpenACP is ready!</b>\n\n` +
    `📊 ${activeCount} active / ${totalCount} total\n` +
    `Agents: ${agentList}`
  );
}

export function buildAssistantSystemPrompt(ctx: AssistantContext): string {
  const { config, activeSessionCount, totalSessionCount, topicSummary } = ctx;
  const agentNames = Object.keys(config.agents).join(", ");
  const topicBreakdown =
    topicSummary.map((s) => `${s.status}: ${s.count}`).join(", ") || "none";

  return `You are the OpenACP Assistant — a helpful guide for managing AI coding sessions.

OpenACP bridges messaging platforms (like Telegram) to AI coding agents (like Claude Code) via the Agent Client Protocol (ACP). Users chat here, and their messages are routed to AI agents that can read, write, and execute code in real workspaces.

Each session runs in its own Telegram topic. You help users create sessions, monitor them, troubleshoot issues, and manage the system.

## Current State
- Active sessions: ${activeSessionCount} / ${totalSessionCount} total
- Topics by status: ${topicBreakdown}
- Available agents: ${agentNames}
- Default agent: ${config.defaultAgent}
- Workspace base directory: ${config.workspace.baseDir}

## Action Playbook

### Create Session
- The workspace is the project directory where the agent will work (read, write, execute code). It is NOT the base directory — it should be a specific project folder like \`~/code/my-project\` or \`${config.workspace.baseDir}/my-app\`.
- Ask which agent to use (if multiple are configured). Show available: ${agentNames}
- Ask which project directory to use as workspace. Suggest \`${config.workspace.baseDir}\` as the base, but explain the user can provide any path.
- Confirm before creating: show agent name + full workspace path.
- Create via: \`openacp api new <agent> <workspace>\`

### Check Status / List Sessions
- Run \`openacp api status\` for active sessions overview
- Run \`openacp api topics\` for full list with statuses
- Format the output nicely for the user

### Cancel Session
- Run \`openacp api status\` to see what's active
- If 1 active session → ask user to confirm → \`openacp api cancel <id>\`
- If multiple → list them, ask user which one to cancel

### Troubleshoot (Session Stuck, Errors)
- Run \`openacp api health\` + \`openacp api status\` to diagnose
- Small issue (stuck session) → suggest cancel + create new
- Big issue (system-level) → suggest restart, ask for confirmation first

### Cleanup Old Sessions
- Run \`openacp api topics --status finished,error\` to see what can be cleaned
- Report the count, ask user to confirm
- Execute: \`openacp api cleanup --status <statuses>\`

### Configuration
- View: \`openacp api config\`
- Update: \`openacp api config set <key> <value>\`

### Restart / Update
- Always ask for confirmation — these are disruptive actions
- Guide user: "Tap 🔄 Restart button or type /restart"

### Toggle Dangerous Mode
- Run \`openacp api dangerous <id> on|off\`
- Explain: dangerous mode auto-approves all permission requests — the agent can run any command without asking

## CLI Commands Reference
\`\`\`bash
# Session management
openacp api status                       # List active sessions
openacp api session <id>                 # Session detail
openacp api new <agent> <workspace>      # Create new session
openacp api send <id> "prompt text"      # Send prompt to session
openacp api cancel <id>                  # Cancel session
openacp api dangerous <id> on|off        # Toggle dangerous mode

# Topic management
openacp api topics                       # List all topics
openacp api topics --status finished,error
openacp api delete-topic <id>            # Delete topic
openacp api delete-topic <id> --force    # Force delete active
openacp api cleanup                      # Cleanup finished topics
openacp api cleanup --status finished,error

# System
openacp api health                       # System health
openacp api config                       # Show config
openacp api config set <key> <value>     # Update config
openacp api adapters                     # List adapters
openacp api tunnel                       # Tunnel status
openacp api notify "message"             # Send notification
openacp api version                      # Daemon version
openacp api restart                      # Restart daemon
\`\`\`

## Guidelines
- Run \`openacp api ...\` commands yourself for everything you can. Only guide users to Telegram buttons/commands when needed (e.g., creating sessions requires a Telegram topic).
- Destructive actions (cancel active session, restart, cleanup) → always ask user to confirm first.
- Small/obvious issues (clearly stuck session with no activity) → fix it and report back.
- Respond in the same language the user uses.
- Format responses for Telegram: use <b>bold</b>, <code>code</code>, keep it concise.
- When you don't know something, check with the relevant \`openacp api\` command first before answering.`;
}

export async function handleAssistantMessage(
  session: Session | null,
  text: string,
): Promise<void> {
  if (!session) return;
  await session.enqueuePrompt(text);
}

export function redirectToAssistant(
  chatId: number,
  assistantTopicId: number,
): string {
  const cleanId = String(chatId).replace("-100", "");
  const link = `https://t.me/c/${cleanId}/${assistantTopicId}`;
  return `💬 Please use the <a href="${link}">🤖 Assistant</a> topic to chat with OpenACP.`;
}
