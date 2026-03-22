# Assistant UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Telegram Assistant UX to be context-aware, user-friendly, and capable of guiding users through all OpenACP features.

**Architecture:** Rewrite 3 files in the Telegram adapter: assistant.ts (welcome message builder + system prompt), commands.ts (menu keyboard + help text + interactive session creation), adapter.ts (use new welcome builder). Add tests for pure logic functions (welcome message builder, system prompt builder). No architecture changes — same routing, same startup flow.

**Tech Stack:** TypeScript, grammY (Telegram bot), vitest (tests)

**Spec:** `docs/superpowers/specs/2026-03-22-assistant-ux-redesign.md`

---

### Task 1: Welcome Message Builder

Add `buildWelcomeMessage()` to `assistant.ts` — a pure logic function that generates context-aware welcome text.

**Files:**
- Modify: `src/adapters/telegram/assistant.ts:60-65` (add WelcomeContext interface + buildWelcomeMessage function)
- Create: `src/__tests__/welcome-message.test.ts`

- [ ] **Step 1: Write tests for buildWelcomeMessage**

Create `src/__tests__/welcome-message.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildWelcomeMessage, type WelcomeContext } from "../adapters/telegram/assistant.js";

describe("buildWelcomeMessage", () => {
  it("shows no-sessions variant when totalCount is 0", () => {
    const ctx: WelcomeContext = {
      activeCount: 0,
      errorCount: 0,
      totalCount: 0,
      agents: ["claude"],
      defaultAgent: "claude",
    };
    const msg = buildWelcomeMessage(ctx);
    expect(msg).toContain("OpenACP is ready");
    expect(msg).toContain("No sessions yet");
    expect(msg).not.toContain("Agents:");
  });

  it("shows active variant when there are active sessions and no errors", () => {
    const ctx: WelcomeContext = {
      activeCount: 2,
      errorCount: 0,
      totalCount: 5,
      agents: ["claude", "codex"],
      defaultAgent: "claude",
    };
    const msg = buildWelcomeMessage(ctx);
    expect(msg).toContain("2 active / 5 total");
    expect(msg).toContain("claude (default)");
    expect(msg).toContain("codex");
    expect(msg).not.toContain("errors");
  });

  it("shows error variant when there are error sessions", () => {
    const ctx: WelcomeContext = {
      activeCount: 1,
      errorCount: 2,
      totalCount: 5,
      agents: ["claude"],
      defaultAgent: "claude",
    };
    const msg = buildWelcomeMessage(ctx);
    expect(msg).toContain("1 active");
    expect(msg).toContain("2 errors");
    expect(msg).toContain("5 total");
    expect(msg).toContain("ask me to check");
  });

  it("shows fallback variant when all sessions are finished (0 active, 0 errors)", () => {
    const ctx: WelcomeContext = {
      activeCount: 0,
      errorCount: 0,
      totalCount: 3,
      agents: ["claude"],
      defaultAgent: "claude",
    };
    const msg = buildWelcomeMessage(ctx);
    expect(msg).toContain("0 active / 3 total");
    expect(msg).toContain("Agents:");
  });

  it("errors variant takes priority over active variant", () => {
    const ctx: WelcomeContext = {
      activeCount: 3,
      errorCount: 1,
      totalCount: 10,
      agents: ["claude"],
      defaultAgent: "claude",
    };
    const msg = buildWelcomeMessage(ctx);
    expect(msg).toContain("errors");
    expect(msg).toContain("ask me to check");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/welcome-message.test.ts`
Expected: FAIL — `buildWelcomeMessage` not exported / does not exist

- [ ] **Step 3: Implement buildWelcomeMessage in assistant.ts**

Add the `WelcomeContext` interface and `buildWelcomeMessage` function to `src/adapters/telegram/assistant.ts` after the existing `AssistantContext` interface (after line 65):

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/welcome-message.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Wire buildWelcomeMessage into adapter.ts**

In `src/adapters/telegram/adapter.ts`, replace the inline welcome message logic (lines ~303-325) with a call to `buildWelcomeMessage()`.

Replace:
```typescript
const config = this.core.configManager.get();
const agents = this.core.agentManager.getAvailableAgents();
const agentList = agents
  .map((a) => `${escapeHtml(a.name)}${a.name === config.defaultAgent ? " (default)" : ""}`)
  .join(", ");
const workspace = escapeHtml(config.workspace.baseDir);
const allRecords = this.core.sessionManager.listRecords();
const activeCount = allRecords.filter(r => r.status === 'active' || r.status === 'initializing').length;

const welcomeText =
  `👋 <b>OpenACP Assistant</b> is online.\n\n` +
  `Available agents: ${agentList}\n` +
  `Workspace: <code>${workspace}</code>\n` +
  `Sessions: ${activeCount} active / ${allRecords.length} total\n\n` +
  `<b>Select an action:</b>`;
```

With:
```typescript
const config = this.core.configManager.get();
const agents = this.core.agentManager.getAvailableAgents();
const allRecords = this.core.sessionManager.listRecords();

const welcomeText = buildWelcomeMessage({
  activeCount: allRecords.filter(r => r.status === 'active' || r.status === 'initializing').length,
  errorCount: allRecords.filter(r => r.status === 'error').length,
  totalCount: allRecords.length,
  agents: agents.map(a => a.name),
  defaultAgent: config.defaultAgent,
});
```

Add `buildWelcomeMessage` to the import from `./assistant.js`.

- [ ] **Step 6: Build and verify no TypeScript errors**

Run: `pnpm build`
Expected: Clean build, no errors

- [ ] **Step 7: Commit**

```bash
git add src/adapters/telegram/assistant.ts src/adapters/telegram/adapter.ts src/__tests__/welcome-message.test.ts
git commit -m "feat(assistant): add context-aware welcome message builder"
```

---

### Task 2: Menu Keyboard Redesign

Remove New Chat and Cancel from menu, reorganize layout.

**Files:**
- Modify: `src/adapters/telegram/commands.ts:37-53` (buildMenuKeyboard)
- Modify: `src/adapters/telegram/commands.ts:61-116` (setupMenuCallbacks — remove m:newchat and m:cancel cases)

- [ ] **Step 1: Update buildMenuKeyboard()**

In `src/adapters/telegram/commands.ts`, replace `buildMenuKeyboard()` (lines 37-53):

```typescript
export function buildMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🆕 New Session", "m:new")
    .text("📋 Sessions", "m:topics")
    .row()
    .text("📊 Status", "m:status")
    .text("🤖 Agents", "m:agents")
    .row()
    .text("🔗 Integrate", "m:integrate")
    .text("❓ Help", "m:help")
    .row()
    .text("🔄 Restart", "m:restart")
    .text("⬆️ Update", "m:update");
}
```

- [ ] **Step 2: Remove m:newchat and m:cancel from setupMenuCallbacks**

In `setupMenuCallbacks()`, remove these two cases from the switch statement:
```typescript
case "m:newchat":
  await handleNewChat(ctx, core, chatId);
  break;
case "m:cancel":
  await handleCancel(ctx, core);
  break;
```

Keep all `m:cleanup:*` cases and all other cases unchanged.

- [ ] **Step 3: Build and verify**

Run: `pnpm build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add src/adapters/telegram/commands.ts
git commit -m "feat(menu): reorganize keyboard, remove New Chat and Cancel buttons"
```

---

### Task 3: Help Text Rewrite

Rewrite `/help` output to group commands by use case.

**Files:**
- Modify: `src/adapters/telegram/commands.ts:638-653` (handleHelp function)

- [ ] **Step 1: Rewrite handleHelp()**

Replace the `handleHelp` function body:

```typescript
async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    `📖 <b>OpenACP Help</b>\n\n` +
      `🚀 <b>Getting Started</b>\n` +
      `Tap 🆕 New Session to start coding with AI.\n` +
      `Each session gets its own topic — chat there to work with the agent.\n\n` +
      `💡 <b>Common Tasks</b>\n` +
      `/new [agent] [workspace] — Create new session\n` +
      `/cancel — Cancel session (in session topic)\n` +
      `/status — Show session or system status\n` +
      `/sessions — List all sessions\n` +
      `/agents — List available agents\n\n` +
      `⚙️ <b>System</b>\n` +
      `/restart — Restart OpenACP\n` +
      `/update — Update to latest version\n` +
      `/integrate — Manage agent integrations\n` +
      `/menu — Show action menu\n\n` +
      `🔒 <b>Session Options</b>\n` +
      `/enable_dangerous — Auto-approve permissions\n` +
      `/disable_dangerous — Restore permission prompts\n` +
      `/handoff — Continue session in terminal\n\n` +
      `💬 Need help? Just ask me in this topic!`,
    { parse_mode: "HTML" },
  );
}
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add src/adapters/telegram/commands.ts
git commit -m "feat(help): rewrite help text grouped by use case"
```

---

### Task 4: System Prompt Rewrite

Complete rewrite of `buildAssistantSystemPrompt()` with product context, action playbook, and guidelines.

**Files:**
- Modify: `src/adapters/telegram/assistant.ts:67-132` (buildAssistantSystemPrompt function)
- Create: `src/__tests__/assistant-prompt.test.ts`

- [ ] **Step 1: Write tests for the new system prompt**

Create `src/__tests__/assistant-prompt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildAssistantSystemPrompt, type AssistantContext } from "../adapters/telegram/assistant.js";

function makeCtx(overrides?: Partial<AssistantContext>): AssistantContext {
  return {
    config: {
      agents: { claude: { command: "claude", args: [] }, codex: { command: "codex", args: [] } },
      defaultAgent: "claude",
      workspace: { baseDir: "~/openacp-workspace" },
    } as any,
    activeSessionCount: 2,
    totalSessionCount: 5,
    topicSummary: [
      { status: "active", count: 2 },
      { status: "finished", count: 3 },
    ],
    ...overrides,
  };
}

describe("buildAssistantSystemPrompt", () => {
  it("includes product context", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("OpenACP Assistant");
    expect(prompt).toContain("Agent Client Protocol");
  });

  it("includes current state", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("Active sessions: 2");
    expect(prompt).toContain("claude");
    expect(prompt).toContain("codex");
  });

  it("includes action playbook", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("openacp api status");
    expect(prompt).toContain("openacp api cancel");
    expect(prompt).toContain("openacp api health");
    expect(prompt).toContain("openacp api cleanup");
    expect(prompt).toContain("openacp api config");
  });

  it("includes guidelines about self-execution", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("openacp api");
    expect(prompt).toContain("confirm");
    expect(prompt).toContain("same language");
  });

  it("does not include old Telegram bot commands section", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).not.toContain("Session Management Commands");
    expect(prompt).not.toContain("These are Telegram bot commands");
  });

  it("includes workspace explanation in create session playbook", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("workspace");
    expect(prompt).toContain("project directory");
  });
});
```

- [ ] **Step 2: Run tests to see current state**

Run: `pnpm test -- src/__tests__/assistant-prompt.test.ts`
Expected: Some tests FAIL (old prompt doesn't have product context, playbook, etc.)

- [ ] **Step 3: Rewrite buildAssistantSystemPrompt()**

Replace the entire `buildAssistantSystemPrompt` function in `src/adapters/telegram/assistant.ts` (lines 67-132):

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/assistant-prompt.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Build and verify**

Run: `pnpm build`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
git add src/adapters/telegram/assistant.ts src/__tests__/assistant-prompt.test.ts
git commit -m "feat(assistant): rewrite system prompt with product context and action playbook"
```

---

### Task 5: Interactive Session Creation Flow

Rewrite `handleNew()` to use an interactive button flow when called without full args (outside assistant topic).

**Files:**
- Modify: `src/adapters/telegram/commands.ts:126-216` (handleNew function)
- Modify: `src/adapters/telegram/commands.ts:55-117` (setupMenuCallbacks — add new `m:new:*` callbacks)

- [ ] **Step 1: Add PendingNewSession state and types**

At the top of `commands.ts` (after imports, around line 9), add:

```typescript
interface PendingNewSession {
  agentName?: string;
  workspace?: string;
  step: "agent" | "workspace" | "workspace_input" | "confirm";
  messageId: number;
  threadId?: number;
  timer: ReturnType<typeof setTimeout>;
}

const pendingNewSessions = new Map<number, PendingNewSession>();

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function cleanupPending(userId: number): void {
  const pending = pendingNewSessions.get(userId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingNewSessions.delete(userId);
  }
}
```

- [ ] **Step 2: Rewrite handleNew() for interactive flow**

Replace the `handleNew` function. The new logic:
- **Full args provided** (`/new claude ~/code/project`) → create directly (keep current behavior)
- **In assistant topic without full args** → forward to assistant (keep current behavior)
- **Outside assistant topic without full args** → start interactive flow

```typescript
async function handleNew(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
  assistant?: AssistantContext,
): Promise<void> {
  const rawMatch = (ctx as Context & { match: unknown }).match;
  const matchStr = typeof rawMatch === "string" ? rawMatch : "";
  const args = matchStr.split(" ").filter(Boolean);
  const agentName = args[0];
  const workspace = args[1];

  // Full args → create directly
  if (agentName && workspace) {
    await createSessionDirect(ctx, core, chatId, agentName, workspace);
    return;
  }

  // In assistant topic → forward to assistant for conversational handling
  const currentThreadId = ctx.message?.message_thread_id;
  if (assistant && currentThreadId === assistant.topicId) {
    const assistantSession = assistant.getSession();
    if (assistantSession) {
      const prompt = agentName
        ? `User wants to create a new session with agent "${agentName}" but didn't specify a workspace. Ask them which project directory to use as workspace.`
        : `User wants to create a new session. Guide them through choosing an agent and workspace (project directory).`;
      await assistantSession.enqueuePrompt(prompt);
      return;
    }
  }

  // Outside assistant topic → interactive flow
  const userId = ctx.from?.id;
  if (!userId) return;

  const agents = core.agentManager.getAvailableAgents();
  const config = core.configManager.get();

  // If agent provided or only 1 agent → skip to workspace step
  if (agentName || agents.length === 1) {
    const selectedAgent = agentName || config.defaultAgent;
    await startWorkspaceStep(ctx, core, chatId, userId, selectedAgent);
    return;
  }

  // Multiple agents → show agent selection
  const keyboard = new InlineKeyboard();
  for (const agent of agents) {
    const label = agent.name === config.defaultAgent
      ? `${agent.name} (default)`
      : agent.name;
    keyboard.text(label, `m:new:agent:${agent.name}`).row();
  }

  const msg = await ctx.reply(
    `🤖 <b>Choose an agent:</b>`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );

  cleanupPending(userId);
  pendingNewSessions.set(userId, {
    step: "agent",
    messageId: msg.message_id,
    threadId: currentThreadId,
    timer: setTimeout(() => pendingNewSessions.delete(userId), PENDING_TIMEOUT_MS),
  });
}
```

- [ ] **Step 3: Add helper functions for the interactive flow**

Add these functions after the `handleNew` function:

```typescript
async function startWorkspaceStep(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
  userId: number,
  agentName: string,
): Promise<void> {
  const config = core.configManager.get();
  const baseDir = config.workspace.baseDir;

  const keyboard = new InlineKeyboard()
    .text(`📁 Default (${baseDir})`, "m:new:ws:default")
    .row()
    .text("✏️ Custom path", "m:new:ws:custom");

  const text =
    `📁 <b>Choose workspace for ${escapeHtml(agentName)}:</b>\n\n` +
    `The workspace is the project directory where the agent will read, write, and execute code.`;

  let msg;
  try {
    // Try to edit the existing message
    const pending = pendingNewSessions.get(userId);
    if (pending?.messageId) {
      await ctx.api.editMessageText(chatId, pending.messageId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      msg = { message_id: pending.messageId };
    } else {
      msg = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    }
  } catch {
    msg = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }

  cleanupPending(userId);
  pendingNewSessions.set(userId, {
    agentName,
    step: "workspace",
    messageId: msg.message_id,
    threadId: ctx.message?.message_thread_id ?? (ctx.callbackQuery as any)?.message?.message_thread_id,
    timer: setTimeout(() => pendingNewSessions.delete(userId), PENDING_TIMEOUT_MS),
  });
}

async function startConfirmStep(
  ctx: Context,
  chatId: number,
  userId: number,
  agentName: string,
  workspace: string,
): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("✅ Create", "m:new:confirm")
    .text("❌ Cancel", "m:new:cancel");

  const text =
    `✅ <b>Ready to create session?</b>\n\n` +
    `<b>Agent:</b> ${escapeHtml(agentName)}\n` +
    `<b>Workspace:</b> <code>${escapeHtml(workspace)}</code>`;

  let msg;
  try {
    const pending = pendingNewSessions.get(userId);
    if (pending?.messageId) {
      await ctx.api.editMessageText(chatId, pending.messageId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      msg = { message_id: pending.messageId };
    } else {
      msg = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    }
  } catch {
    msg = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }

  cleanupPending(userId);
  pendingNewSessions.set(userId, {
    agentName,
    workspace,
    step: "confirm",
    messageId: msg.message_id,
    threadId: ctx.message?.message_thread_id ?? (ctx.callbackQuery as any)?.message?.message_thread_id,
    timer: setTimeout(() => pendingNewSessions.delete(userId), PENDING_TIMEOUT_MS),
  });
}

async function createSessionDirect(
  ctx: Context,
  core: OpenACPCore,
  chatId: number,
  agentName: string,
  workspace: string,
): Promise<void> {
  log.info({ userId: ctx.from?.id, agentName, workspace }, "New session command (direct)");

  let threadId: number | undefined;
  try {
    const topicName = `🔄 New Session`;
    threadId = await createSessionTopic(botFromCtx(ctx), chatId, topicName);

    await ctx.api.sendMessage(chatId, `⏳ Setting up session, please wait...`, {
      message_thread_id: threadId,
      parse_mode: "HTML",
    });

    const session = await core.handleNewSession("telegram", agentName, workspace);
    session.threadId = String(threadId);

    await core.sessionManager.updateSessionPlatform(session.id, { topicId: threadId });

    const finalName = `🔄 ${session.agentName} — New Session`;
    try {
      await ctx.api.editForumTopic(chatId, threadId, { name: finalName });
    } catch { /* ignore rename failures */ }

    await ctx.api.sendMessage(
      chatId,
      `✅ <b>Session started</b>\n` +
        `<b>Agent:</b> ${escapeHtml(session.agentName)}\n` +
        `<b>Workspace:</b> <code>${escapeHtml(session.workingDirectory)}</code>\n\n` +
        `This is your coding session — chat here to work with the agent.`,
      {
        message_thread_id: threadId,
        parse_mode: "HTML",
        reply_markup: buildDangerousModeKeyboard(session.id, false),
      },
    );

    session.warmup().catch((err) => log.error({ err }, "Warm-up error"));
  } catch (err) {
    log.error({ err }, "Session creation failed");
    if (threadId) {
      try { await ctx.api.deleteForumTopic(chatId, threadId); } catch { /* ignore */ }
    }
    const message = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ ${escapeHtml(message)}`, { parse_mode: "HTML" });
  }
}
```

- [ ] **Step 4: Add new `m:new:*` callbacks inside setupMenuCallbacks**

**IMPORTANT: Middleware ordering.** grammY processes callback handlers in registration order. The existing `bot.callbackQuery(/^m:/, ...)` in `setupMenuCallbacks` matches ALL `m:` prefixed callbacks. If `m:new:agent:*` handlers are registered AFTER this catch-all, they will never be reached. Therefore, the new `m:new:*` callbacks MUST be handled INSIDE the existing `setupMenuCallbacks` function.

Modify `setupMenuCallbacks` to handle the new callbacks. Add these cases inside the existing `bot.callbackQuery(/^m:/, async (ctx) => { ... })` handler, BEFORE the switch statement (since switch only does exact matches and we need prefix matching for `m:new:agent:`):

```typescript
export function setupMenuCallbacks(
  bot: Bot,
  core: OpenACPCore,
  chatId: number,
  systemTopicIds?: { notificationTopicId: number; assistantTopicId: number },
): void {
  bot.callbackQuery(/^m:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* expired or network — ignore */
    }

    // --- New session interactive flow (prefix-based) ---
    if (data.startsWith("m:new:agent:")) {
      const agentName = data.replace("m:new:agent:", "");
      const userId = ctx.from?.id;
      if (userId) await startWorkspaceStep(ctx, core, chatId, userId, agentName);
      return;
    }
    if (data === "m:new:ws:default") {
      const userId = ctx.from?.id;
      if (!userId) return;
      const pending = pendingNewSessions.get(userId);
      if (!pending?.agentName) return;
      const workspace = core.configManager.get().workspace.baseDir;
      await startConfirmStep(ctx, chatId, userId, pending.agentName, workspace);
      return;
    }
    if (data === "m:new:ws:custom") {
      const userId = ctx.from?.id;
      if (!userId) return;
      const pending = pendingNewSessions.get(userId);
      if (!pending?.agentName) return;
      try {
        await ctx.api.editMessageText(
          chatId,
          pending.messageId,
          `✏️ <b>Enter the full path to your project directory:</b>\n\n` +
            `Example: <code>~/code/my-project</code> or <code>/home/user/projects/app</code>`,
          { parse_mode: "HTML" },
        );
      } catch {
        await ctx.reply(
          `✏️ <b>Enter the full path to your project directory:</b>`,
          { parse_mode: "HTML" },
        );
      }
      clearTimeout(pending.timer);
      pending.step = "workspace_input";
      pending.timer = setTimeout(() => pendingNewSessions.delete(userId), PENDING_TIMEOUT_MS);
      return;
    }
    if (data === "m:new:confirm") {
      const userId = ctx.from?.id;
      if (!userId) return;
      const pending = pendingNewSessions.get(userId);
      if (!pending?.agentName || !pending?.workspace) return;
      cleanupPending(userId);
      try {
        await ctx.api.editMessageText(chatId, pending.messageId, `⏳ Creating session...`, { parse_mode: "HTML" });
      } catch { /* ignore */ }
      await createSessionDirect(ctx, core, chatId, pending.agentName, pending.workspace);
      return;
    }
    if (data === "m:new:cancel") {
      const userId = ctx.from?.id;
      if (userId) cleanupPending(userId);
      try {
        await ctx.editMessageText("❌ Session creation cancelled.", { parse_mode: "HTML" });
      } catch { /* ignore */ }
      return;
    }

    // --- Existing menu callbacks (exact match) ---
    switch (data) {
      case "m:new":
        await handleNew(ctx, core, chatId);
        break;
      // ... rest of existing cases unchanged ...
    }
  });
}
```

The key change: new `m:new:*` callbacks are `if/return` blocks BEFORE the existing `switch` statement, all inside the same `bot.callbackQuery(/^m:/, ...)` handler. No middleware ordering issues.

- [ ] **Step 5: Export handleWorkspaceInput and pendingNewSessions for adapter wiring**

Export a handler function and the pending map from `commands.ts`:

```typescript
/**
 * Check if a text message is a workspace path input for the interactive new session flow.
 * Returns true if the message was handled (caller should not process further).
 */
export async function handlePendingWorkspaceInput(
  ctx: Context,
  chatId: number,
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  const pending = pendingNewSessions.get(userId);
  if (pending?.step !== "workspace_input" || !ctx.message?.text) return false;

  const workspace = ctx.message.text.trim();
  if (!workspace || !pending.agentName) {
    await ctx.reply("⚠️ Please enter a valid directory path.", { parse_mode: "HTML" });
    return true;
  }

  await startConfirmStep(ctx, chatId, userId, pending.agentName, workspace);
  return true;
}
```

In `adapter.ts`, import `handlePendingWorkspaceInput` from `./commands.js` and add it to the message routing. Find the section where text messages are routed (around line 364-412 in the `setupRoutes` method), and add this check BEFORE the assistant message routing:

```typescript
// Check for pending workspace input from interactive /new flow
if (await handlePendingWorkspaceInput(ctx, this.telegramConfig.chatId)) {
  return;
}
```

This should be placed after the security check and before the assistant topic / session topic routing logic. The exact location is inside `setupRoutes()` in the `bot.on("message:text", ...)` handler, before the `if (threadId === this.assistantTopicId)` check.

- [ ] **Step 6: Build and verify**

Run: `pnpm build`
Expected: Clean build

- [ ] **Step 7: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/adapters/telegram/commands.ts src/adapters/telegram/adapter.ts
git commit -m "feat(new-session): interactive flow with agent and workspace selection"
```

---

### Task 6: Final Integration Test

Verify all changes work together.

**Files:** (no new changes — verification only)

- [ ] **Step 1: Run full build**

Run: `pnpm build`
Expected: Clean build, no TypeScript errors

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (including new welcome-message and assistant-prompt tests)

- [ ] **Step 3: Review changes**

Run: `git diff --stat HEAD~5` (or however many commits back)
Verify:
- `assistant.ts` has: `WelcomeContext`, `buildWelcomeMessage`, rewritten `buildAssistantSystemPrompt`
- `commands.ts` has: new `buildMenuKeyboard` (8 buttons, 4 rows), rewritten `handleHelp`, interactive `handleNew`, `m:new:*` callbacks inside `setupMenuCallbacks`, `pendingNewSessions`, `handlePendingWorkspaceInput`
- `adapter.ts` has: welcome message using `buildWelcomeMessage()`, `handlePendingWorkspaceInput` wired in message routing

- [ ] **Step 4: Commit if any fixes were needed**

Only if adjustments were required during verification.
