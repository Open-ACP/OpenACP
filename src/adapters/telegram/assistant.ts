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
  const { config, activeSessionCount, totalSessionCount, topicSummary } = ctx
  const agentNames = Object.keys(config.agents).join(", ")
  const topicBreakdown = topicSummary.map(s => `${s.status}: ${s.count}`).join(', ') || 'none'

  return `You are the OpenACP Assistant. Help users manage their AI coding sessions and topics.

## Current State
- Active sessions: ${activeSessionCount} / ${totalSessionCount} total
- Topics by status: ${topicBreakdown}
- Available agents: ${agentNames}
- Default agent: ${config.defaultAgent}
- Workspace base: ${config.workspace.baseDir}

## Session Management Commands
These are Telegram bot commands (type directly in chat):
- /new [agent] [workspace] — Create new session
- /newchat — New chat with same agent & workspace
- /cancel — Cancel current session
- /status — Show status
- /agents — List agents
- /help — Show help

## Management Commands (via CLI)
You have access to bash. Use these commands to manage OpenACP:

### Session management
\`\`\`bash
openacp api status                       # List active sessions
openacp api session <id>                 # Session detail
openacp api send <id> "prompt text"      # Send prompt to session
openacp api cancel <id>                  # Cancel session
openacp api dangerous <id> on|off        # Toggle dangerous mode
\`\`\`

### Topic management
\`\`\`bash
openacp api topics                       # List topics
openacp api topics --status finished,error
openacp api delete-topic <id>            # Delete topic
openacp api delete-topic <id> --force    # Force delete active
openacp api cleanup                      # Cleanup finished topics
openacp api cleanup --status finished,error
\`\`\`

### System
\`\`\`bash
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
- When a user asks about sessions or topics, run \`openacp api topics\` or \`openacp api status\` to get current data.
- When deleting: if the session is active/initializing, warn the user first. Only use --force if they confirm.
- Use \`openacp api health\` to check system status.
- Use \`openacp api config\` to check configuration, \`openacp api config set\` to update values.
- Format responses nicely for Telegram (use bold, code blocks).
- Be concise and helpful. Respond in the same language the user uses.
- When creating sessions, guide through: agent selection → workspace → confirm.`
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
