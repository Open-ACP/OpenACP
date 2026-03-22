# Telegram Adapter Refactor Design

**Date:** 2026-03-22
**Scope:** `src/adapters/telegram/adapter.ts` — extract responsibilities into focused classes
**Constraint:** TDD, external behavior preserved, commands/ directory unchanged

---

## Problem Statement

`adapter.ts` is a 939-line God object that manages:
1. Bot lifecycle (start/stop)
2. Message routing (10+ event types in single switch)
3. Streaming (MessageDraft per session)
4. Tool call message tracking (pending/complete states, viewer links)
5. Activity tracking (thinking, plans, usage)
6. Skill command management (pinned messages)
7. Permission requests
8. Assistant session management
9. Topic lifecycle

This makes it hard to:
- Understand any single concern without reading all 939 lines
- Test individual concerns in isolation
- Add new message types or features without growing the file further
- Support future adapters (Discord, Slack) — shared logic is locked inside Telegram-specific code

---

## Design

### 1. MessageRouter — Extract sendMessage dispatch

**Current:** `sendMessage()` is a 200+ line switch statement handling text, thought, tool_call, tool_update, plan, usage, session_end, error.

**Extract to:** `MessageRouter` class that receives events and delegates to the appropriate handler.

```ts
class MessageRouter {
  constructor(
    private bot: Bot,
    private chatId: number,
    private sendQueue: TelegramSendQueue,
    private toolTracker: ToolCallTracker,
    private activityManager: ActivityManager,
    private draftManager: DraftManager,
  ) {}

  async route(sessionId: string, content: OutgoingMessage): Promise<void> {
    switch (content.type) {
      case "text": return this.handleText(sessionId, content);
      case "thought": return this.handleThought(sessionId, content);
      case "tool_call": return this.handleToolCall(sessionId, content);
      case "tool_update": return this.handleToolUpdate(sessionId, content);
      // ... etc
    }
  }
}
```

The adapter's `sendMessage()` becomes a one-liner: `this.messageRouter.route(sessionId, content)`.

### 2. ToolCallTracker — Extract tool call state

**Current:** `toolCallMessages` Map with complex ready-promise pattern, viewer link accumulation, message editing.

**Extract to:** `ToolCallTracker` class that encapsulates:
- Pending tool call message creation
- Tool update matching and message editing
- Viewer link accumulation
- Cleanup on session end

```ts
class ToolCallTracker {
  private pending: Map<string, Map<string, ToolCallState>> = new Map();

  async trackNewCall(sessionId: string, toolCallId: string, ...): Promise<void>;
  async updateCall(sessionId: string, toolCallId: string, ...): Promise<void>;
  cleanup(sessionId: string): void;
}
```

### 3. DraftManager — Extract streaming draft lifecycle

**Current:** `sessionDrafts` Map + `sessionTextBuffers` Map + `finalizeDraft()` method with action detection.

**Extract to:** `DraftManager` class:

```ts
class DraftManager {
  private drafts: Map<string, MessageDraft> = new Map();
  private textBuffers: Map<string, string> = new Map();

  getOrCreate(sessionId: string, ...): MessageDraft;
  appendText(sessionId: string, text: string): void;
  async finalize(sessionId: string): Promise<string>; // returns full text
  cleanup(sessionId: string): void;
}
```

Action detection stays in adapter (it's adapter-level orchestration that reads the accumulated text and decides what keyboard to show).

### 4. ActivityManager — Already exists as ActivityTracker

`ActivityTracker` in activity.ts is already well-extracted. The adapter just needs a thin management layer:

```ts
// Already good — just move getOrCreateTracker() logic into a manager
class ActivityManager {
  private trackers: Map<string, ActivityTracker> = new Map();

  getOrCreate(sessionId: string, ...): ActivityTracker;
  cleanup(sessionId: string): void;
}
```

This is minor — mostly moving existing Map + factory from adapter.ts.

### 5. SkillCommandManager — Extract skill command pinning

**Current:** `skillMessages` Map + `sendSkillCommands()` + `cleanupSkillCommands()` methods (90 lines).

**Extract to:** `SkillCommandManager` class:

```ts
class SkillCommandManager {
  private messages: Map<string, number> = new Map(); // sessionId → msgId

  async send(sessionId: string, commands: AgentCommand[]): Promise<void>;
  async cleanup(sessionId: string): Promise<void>;
  restore(sessionId: string, msgId: number): void; // from session record
}
```

---

## What adapter.ts becomes after refactor

```ts
class TelegramAdapter extends ChannelAdapter<OpenACPCore> {
  // Dependencies
  private bot: Bot;
  private sendQueue: TelegramSendQueue;

  // Extracted managers
  private messageRouter: MessageRouter;
  private toolTracker: ToolCallTracker;
  private draftManager: DraftManager;
  private activityManager: ActivityManager;
  private skillManager: SkillCommandManager;

  // Remaining adapter-level concerns
  private assistantSession?: Session;
  private assistantInitializing: boolean;

  // Thin delegation methods
  async sendMessage(sessionId, content) { return this.messageRouter.route(sessionId, content); }
  async sendSkillCommands(sessionId, commands) { return this.skillManager.send(sessionId, commands); }
  async cleanupSkillCommands(sessionId) { return this.skillManager.cleanup(sessionId); }

  // Topic management stays in adapter (small, adapter-specific)
  // Permission handling stays in adapter (uses topics.ts helpers)
  // Assistant management stays in adapter (lifecycle concern)
  // Start/stop stays in adapter (bot lifecycle)
}
```

**Expected result:** adapter.ts shrinks from ~939 lines to ~400 lines.

---

## Implementation Order

1. **ToolCallTracker** — extract tool call state (most self-contained)
2. **DraftManager** — extract streaming drafts + text buffers
3. **SkillCommandManager** — extract skill pinning
4. **ActivityManager** — thin wrapper around existing ActivityTracker
5. **MessageRouter** — extract sendMessage dispatch (depends on 1-4)
6. **Cleanup adapter.ts** — remove extracted code, wire managers

---

## Files

| File | Action |
|------|--------|
| `src/adapters/telegram/tool-call-tracker.ts` | **New** |
| `src/adapters/telegram/draft-manager.ts` | **New** |
| `src/adapters/telegram/skill-command-manager.ts` | **New** |
| `src/adapters/telegram/activity-manager.ts` | **New** (thin wrapper) |
| `src/adapters/telegram/message-router.ts` | **New** |
| `src/adapters/telegram/adapter.ts` | **Major** — shrinks to ~400 lines |
| `src/adapters/telegram/commands/*` | No change |

---

## Testing Strategy

- Write tests for each extracted class before extracting
- Verify all existing tests pass after each extraction
- New test files: `tool-call-tracker.test.ts`, `draft-manager.test.ts`, `message-router.test.ts`
