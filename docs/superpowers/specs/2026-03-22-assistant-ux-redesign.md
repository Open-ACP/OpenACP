# Assistant UX Redesign

## Summary

Redesign the Telegram Assistant experience to be smarter, more user-friendly, and capable of guiding users through all OpenACP features. The assistant should be approachable for new users while remaining powerful for experienced ones.

## Requirements

- **Target users**: Both individual devs and small teams with non-tech members. Prioritize easy onboarding.
- **Error handling**: Hybrid — auto-fix small/obvious issues, ask confirmation before destructive actions.
- **Welcome**: Context-aware based on current session state (pure logic, no AI).
- **Menu**: Keep all feature buttons visible for discoverability, organize logically. Remove New Chat and Cancel.
- **Assistant behavior**: Self-execute via `openacp api ...` when possible, guide user for Telegram-only actions.
- **Language**: Auto-detect, respond in user's language.
- **Startup speed**: Welcome message is static/logic-based. AI assistant spawns in background, does not block startup.

## Design

### 1. Welcome Message (Context-Aware, No AI)

Replace the current fixed welcome message with `buildWelcomeMessage(ctx: WelcomeContext)` — a pure logic function that generates different messages based on state.

**Interface:**

```typescript
interface WelcomeContext {
  activeCount: number;    // sessions with status "active" or "initializing"
  errorCount: number;     // sessions with status "error"
  totalCount: number;     // all session records
  agents: string[];       // from agentManager.getAvailableAgents() (not config.agents)
  defaultAgent: string;   // from config.defaultAgent
}
```

**Variant selection logic (evaluated top to bottom, first match wins):**

1. `totalCount === 0` → **No sessions variant**
2. `errorCount > 0` → **Has errors variant** (show active + errors + total)
3. `activeCount > 0` → **Has active variant** (show active + total)
4. Fallback → **Has active variant** with `activeCount = 0`

**Variant templates:**

**No sessions (totalCount === 0):**
```
👋 OpenACP is ready!

No sessions yet. Tap 🆕 New Session to start, or ask me anything!
```

**Has active sessions (activeCount > 0, errorCount === 0):**
```
👋 OpenACP is ready!

📊 2 active / 5 total
Agents: claude (default), codex
```

**Has error sessions (errorCount > 0):**
```
👋 OpenACP is ready!

📊 1 active, 2 errors / 5 total
⚠️ 2 sessions have errors — ask me to check if you'd like.

Agents: claude (default), codex
```

All variants include the menu keyboard below. Agent list always shown except in "no sessions" variant (less noise for first-time users).

Startup flow unchanged: send welcome (static) → spawn assistant session (background) → no blocking.

### 2. Menu Keyboard

Remove New Chat and Cancel. Reorganize into logical groups — common actions first, admin second:

```
Row 1: 🆕 New Session (m:new)       📋 Sessions (m:topics)
Row 2: 📊 Status (m:status)         🤖 Agents (m:agents)
Row 3: 🔗 Integrate (m:integrate)   ❓ Help (m:help)
Row 4: 🔄 Restart (m:restart)       ⬆️ Update (m:update)
```

**Removed from menu:**
- `💬 New Chat` (`m:newchat`) — rarely used from assistant topic, `/newchat` still works as command
- `⛔ Cancel` (`m:cancel`) — only meaningful inside session topics, user can ask assistant to cancel

Callback handling: remove `m:newchat` and `m:cancel` cases from `setupMenuCallbacks()`. Keep all cleanup-related callbacks (`m:cleanup:*`) — they are triggered from the Sessions list (handleTopics), not from the top-level menu.

### 3. Session Creation Flow (Redesign)

The current `/new` command is confusing — it silently uses `baseDir` as workspace, but `baseDir` is just the **base directory** (e.g. `~/openacp-workspace`), not a specific project folder. Users don't understand where the agent will work.

#### Key concept

**Workspace = the project directory the agent works in.** Not the base dir. For example: `~/openacp-workspace/my-app` or `~/code/my-project`. The agent reads, writes, and executes code inside this directory.

#### Flow: `/new` from assistant topic (no args or missing args)

Forward to AI assistant for conversational handling. The assistant guides:

1. Ask which agent (if multiple configured) — or skip if only one
2. Explain workspace concept: "Which project directory should the agent work in?"
3. Suggest the base dir as default, but make clear user can provide any path
4. Confirm before creating: "Creating session with **claude** at `~/code/my-project` — OK?"
5. Create via `openacp api new <agent> <workspace>`

This is already partially implemented (handleNew forwards to assistant when args are missing). The improvement is in the system prompt — give the assistant better guidance on how to walk users through this.

#### Flow: `/new` from outside assistant topic or menu button (no args)

Interactive button-based flow:

**Step 1 — Agent selection** (skip if only 1 agent):
```
🤖 Choose an agent:
[claude (default)]  [codex]
```
Callbacks: `m:new:agent:<name>`

**Step 2 — Workspace selection:**
```
📁 Choose workspace for <agent>:

The workspace is the project directory where the agent will read, write, and execute code.

[📁 Default (~/openacp-workspace)]  [✏️ Custom path]
```
- "Default" callback: `m:new:ws:default` → uses `config.workspace.baseDir`
- "Custom path" callback: `m:new:ws:custom` → bot replies "Enter the full path to your project directory:" and waits for next text message

**Step 3 — Confirmation:**
```
✅ Ready to create session?

Agent: claude
Workspace: ~/code/my-project

[✅ Create]  [❌ Cancel]
```
Callbacks: `m:new:confirm`, `m:new:cancel`

On confirm → create session (same logic as current handleNew with both args provided).

#### Flow: `/new <agent> <workspace>` (full args)

Skip interactive flow. Show confirmation message with details, then create directly. Same as current behavior but add a brief confirmation message in the new topic:

```
✅ Session started
Agent: claude
Workspace: ~/code/my-project

This is your coding session — chat here to work with the agent.
```

#### State management for interactive flow

Use a simple in-memory map to track pending session creation state per user:

```typescript
interface PendingNewSession {
  agentName?: string;
  workspace?: string;
  step: 'agent' | 'workspace' | 'workspace_input' | 'confirm';
  messageId: number; // to edit the interactive message
}

const pendingNewSessions = new Map<number, PendingNewSession>(); // keyed by userId
```

Clean up after: confirm, cancel, or timeout (5 minutes).

#### Files changed (additional)

| File | Change |
|------|--------|
| `src/adapters/telegram/commands.ts` | Rewrite `handleNew()` with interactive flow, add new callbacks (`m:new:agent:*`, `m:new:ws:*`, `m:new:confirm`, `m:new:cancel`), add `pendingNewSessions` state |

### 4. Assistant System Prompt (Complete Rewrite)

Rewrite `buildAssistantSystemPrompt()` with these sections:

#### 4.1 Identity & Product Context

Tell the assistant what OpenACP is and who uses it:

```
You are the OpenACP Assistant — a helpful guide for managing AI coding sessions.

OpenACP bridges messaging platforms (like Telegram) to AI coding agents (like Claude Code)
via the Agent Client Protocol (ACP). Users chat here, and their messages are routed to
AI agents that can read, write, and execute code in real workspaces.

Each session runs in its own Telegram topic. You help users create sessions, monitor them,
troubleshoot issues, and manage the system.
```

#### 4.2 Current State (Dynamic)

Same dynamic data as current — sessions, agents, workspace. Keep as-is.

#### 4.3 Action Playbook

Structured "when user says X → do Y" with concrete examples:

**Create session:**
- Explain that workspace = the project directory the agent will work in
- Ask which agent (if multiple configured), then which workspace (full path)
- Run `openacp api new <agent> <workspace>` to create the session
- Note: creating sessions via API is preferred because the assistant can guide through the full flow conversationally

**Check status / list sessions:**
- Self-execute: `openacp api status`, `openacp api topics`
- Respond with formatted data

**Cancel session:**
- Self-execute: `openacp api status` to see active sessions
- If 1 active → ask confirm → `openacp api cancel <id>`
- If multiple → list, ask user to pick

**Troubleshoot (session stuck, errors):**
- Self-execute: `openacp api health` + `openacp api status`
- Diagnose the problem
- Small issue (stuck session) → suggest cancel + create new
- Big issue (system problem) → suggest restart, ask confirm

**Cleanup:**
- Self-execute: `openacp api topics --status finished,error`
- Report count, ask confirm
- Execute: `openacp api cleanup --status <statuses>`

**Config:**
- Self-execute: `openacp api config` (view), `openacp api config set <key> <value>` (update)

**Restart / Update:**
- Always ask confirmation (destructive)
- Guide: "Tap 🔄 Restart or type /restart"

**Toggle dangerous mode:**
- Self-execute: `openacp api dangerous <id> on|off`
- Explain what it does if user seems unsure

#### 4.4 Guidelines

- Self-execute `openacp api ...` for everything you can. Only guide user to Telegram actions when needed (creating sessions, typing in topics).
- Destructive actions (cancel active session, restart, cleanup) → always confirm first.
- Small/obvious fixes (cancel a clearly stuck session) → do it, report back.
- Respond in the same language the user uses.
- Format for Telegram: bold, code blocks, concise.
- When creating sessions, guide through: agent selection → workspace → confirm.

#### 4.5 Available Commands Reference

Keep the current CLI command reference (`openacp api ...`) for the assistant to use. Remove the separate "Session Management Commands" section (Telegram bot commands like `/new`, `/cancel`) from the prompt — the playbook entries already contain the relevant Telegram commands where needed (e.g., "type `/new <agent> <workspace>`" in the Create Session playbook entry).

**Note on self-execution:** The assistant can run `openacp api ...` commands because the adapter already auto-approves permission requests containing "openacp" (existing behavior in adapter.ts). This spec does not change that behavior.

### 5. Help Text (Use-Case Grouped)

Rewrite `handleHelp()` to group commands by use case instead of flat list:

```
📖 OpenACP Help

🚀 Getting Started
  Tap 🆕 New Session to start coding with AI.
  Each session gets its own topic — chat there to work with the agent.

💡 Common Tasks
  /new [agent] [workspace] — Create new session
  /cancel — Cancel session (in session topic)
  /status — Show session or system status
  /sessions — List all sessions
  /agents — List available agents

⚙️ System
  /restart — Restart OpenACP
  /update — Update to latest version
  /integrate — Manage agent integrations
  /menu — Show action menu

🔒 Session Options
  /enable_dangerous — Auto-approve permissions
  /disable_dangerous — Restore permission prompts
  /handoff — Continue session in terminal

💬 Need help? Just ask me in this topic!
```

### 6. Files Changed

| File | Change |
|------|--------|
| `src/adapters/telegram/assistant.ts` | Rewrite `buildAssistantSystemPrompt()`, add `buildWelcomeMessage()` |
| `src/adapters/telegram/commands.ts` | Rewrite `buildMenuKeyboard()`, rewrite `handleHelp()`, rewrite `handleNew()` with interactive flow, add new callbacks (`m:new:agent:*`, `m:new:ws:*`, `m:new:confirm`, `m:new:cancel`), add `pendingNewSessions` state, remove `m:newchat` and `m:cancel` from `setupMenuCallbacks()` |
| `src/adapters/telegram/adapter.ts` | Use `buildWelcomeMessage()` instead of inline welcome logic |

### 7. Backward Compatibility

- `/newchat` command remains registered and functional — only removed from menu UI and help text
- `/cancel` command remains registered and functional — only removed from menu UI
- All other commands unchanged
- Startup flow unchanged
- Routing logic unchanged
- Menu callback prefixes unchanged for remaining buttons
- `m:newchat` and `m:cancel` callbacks can be safely removed (inline buttons are not bookmarkable)
- `STATIC_COMMANDS` array: keep `/newchat` and `/cancel` in the list so they still appear in Telegram's `/` autocomplete — users who know these commands can still use them
- Cleanup callbacks (`m:cleanup:*`) remain unchanged — they are triggered from Sessions list, not the top-level menu
