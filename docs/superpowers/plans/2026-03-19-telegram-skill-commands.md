# Telegram Skill Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register static bot commands with Telegram's `setMyCommands()` API and surface dynamic agent skill commands as pinned inline buttons in session topics.

**Architecture:** Two-layer approach — static commands registered once at bot startup for autocomplete, dynamic skill commands shown as inline keyboard buttons in a pinned message per session topic that updates live via `commands_update` ACP events. Callback data uses short nanoid keys with a lookup map (same pattern as permissions handler).

**Tech Stack:** grammY, nanoid, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-19-telegram-skill-commands-design.md`

---

### Task 1: Add `AgentCommand` type and update `commands_update` event

**Files:**
- Modify: `src/core/types.ts:34-43`
- Modify: `src/core/index.ts:1`

- [ ] **Step 1: Add `AgentCommand` interface and update event type**

In `src/core/types.ts`, add the `AgentCommand` interface before `AgentEvent` and update the `commands_update` variant:

```typescript
export interface AgentCommand {
  name: string
  description: string
  input?: unknown
}
```

Change line 41 from:
```typescript
| { type: 'commands_update'; commands: unknown[] }
```
to:
```typescript
| { type: 'commands_update'; commands: AgentCommand[] }
```

- [ ] **Step 2: Export `AgentCommand` from index**

In `src/core/index.ts`, the `AgentCommand` is already exported via `export * from './types.js'` — no change needed. Verify by checking the file.

- [ ] **Step 3: Build and verify no type errors**

Run: `pnpm build`
Expected: Clean compile, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add AgentCommand interface and type commands_update event"
```

---

### Task 2: Add `sendSkillCommands` and `cleanupSkillCommands` to `ChannelAdapter`

**Files:**
- Modify: `src/core/channel.ts:1-22`

- [ ] **Step 1: Add import for `AgentCommand`**

Add `AgentCommand` to the import line in `src/core/channel.ts`:

```typescript
import type { OutgoingMessage, PermissionRequest, NotificationMessage, AgentCommand } from './types.js'
```

- [ ] **Step 2: Add default no-op methods to `ChannelAdapter`**

Add these methods at the end of the `ChannelAdapter` class (before the closing `}`), after line 21:

```typescript
  // Skill commands — override in adapters that support dynamic commands
  async sendSkillCommands(_sessionId: string, _commands: AgentCommand[]): Promise<void> {}
  async cleanupSkillCommands(_sessionId: string): Promise<void> {}
```

These are non-abstract with default no-op implementations so existing plugins don't break.

- [ ] **Step 3: Build and verify no type errors**

Run: `pnpm build`
Expected: Clean compile, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/core/channel.ts
git commit -m "feat: add sendSkillCommands and cleanupSkillCommands to ChannelAdapter"
```

---

### Task 3: Wire `commands_update` and session cleanup in `core.ts`

**Files:**
- Modify: `src/core/core.ts:133-196`

- [ ] **Step 1: Remove dead `commands_update` case from `toOutgoingMessage`**

In `src/core/core.ts`, delete lines 147-150 (the `commands_update` case in `toOutgoingMessage`):

```typescript
      case 'commands_update':
        // Log but don't surface to user (Phase 3 feature)
        log.debug({ commands: event.commands }, 'Commands update')
        return { type: 'text', text: '' }  // no-op for now
```

The `default` case already returns `{ type: 'text', text: '' }` so the fallback is preserved.

- [ ] **Step 2: Forward `commands_update` to adapter in `wireSessionEvents`**

In `wireSessionEvents`, replace the `commands_update` case (lines 193-195):

```typescript
        case 'commands_update':
          log.debug({ commands: event.commands }, 'Commands available')
          break
```

with:

```typescript
        case 'commands_update':
          log.debug({ commands: event.commands }, 'Commands available')
          adapter.sendSkillCommands(session.id, event.commands)
          break
```

- [ ] **Step 3: Add cleanup call on `session_end`**

In the `session_end` case (line 172-181), add a cleanup call before the notification. After `session.status = 'finished'` (line 173), add:

```typescript
          adapter.cleanupSkillCommands(session.id)
```

So the full case becomes:

```typescript
        case 'session_end':
          session.status = 'finished'
          adapter.cleanupSkillCommands(session.id)
          adapter.sendMessage(session.id, { type: 'session_end', text: `Done (${event.reason})` })
          this.notificationManager.notify(session.channelId, {
            sessionId: session.id,
            sessionName: session.name,
            type: 'completed',
            summary: `Session "${session.name || session.id}" completed`,
          })
          break
```

- [ ] **Step 4: Add cleanup call on `error`**

In the `error` case (lines 183-191), add cleanup before sending the error message:

```typescript
        case 'error':
          adapter.cleanupSkillCommands(session.id)
          adapter.sendMessage(session.id, { type: 'error', text: event.message })
          // ... notification unchanged
```

This handles the case where an agent crashes without emitting `session_end`.

- [ ] **Step 5: Build and verify no type errors**

Run: `pnpm build`
Expected: Clean compile, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/core.ts
git commit -m "feat: wire commands_update to adapter and cleanup on session_end"
```

---

### Task 4: Add skill callback handler in `commands.ts`

**Files:**
- Modify: `src/adapters/telegram/commands.ts:1-288`

- [ ] **Step 1: Add imports**

Add `nanoid` import and `AgentCommand` type at the top of `src/adapters/telegram/commands.ts`:

```typescript
import { nanoid } from 'nanoid'
import type { AgentCommand } from '../../core/index.js'
```

- [ ] **Step 2: Add callback map and exported types**

After the imports, add the skill callback map:

```typescript
// Skill command callback lookup map (short key → session + command)
interface SkillCallbackEntry {
  sessionId: string
  commandName: string
}

const skillCallbackMap = new Map<string, SkillCallbackEntry>()
```

- [ ] **Step 3: Add `buildSkillKeyboard` function**

Add a function that builds the inline keyboard from agent commands and populates the callback map:

```typescript
export function buildSkillKeyboard(
  sessionId: string,
  commands: AgentCommand[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]
    const key = nanoid(8)
    skillCallbackMap.set(key, { sessionId, commandName: cmd.name })
    const label = cmd.description ? `/${cmd.name} — ${cmd.description}` : `/${cmd.name}`
    keyboard.text(label, `s:${key}`)
    if (i % 2 === 1 && i < commands.length - 1) {
      keyboard.row()
    }
  }
  return keyboard
}
```

- [ ] **Step 4: Add `clearSkillCallbacks` function**

Add a cleanup function to remove all callback entries for a session:

```typescript
export function clearSkillCallbacks(sessionId: string): void {
  for (const [key, entry] of skillCallbackMap) {
    if (entry.sessionId === sessionId) {
      skillCallbackMap.delete(key)
    }
  }
}
```

- [ ] **Step 5: Add `setupSkillCallbacks` function**

Add the callback handler. This must be called BEFORE `setupMenuCallbacks` and the permissions handler:

```typescript
export function setupSkillCallbacks(
  bot: Bot,
  core: OpenACPCore,
): void {
  bot.callbackQuery(/^s:/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery()
    } catch { /* expired */ }

    const key = ctx.callbackQuery.data.slice(2)
    const entry = skillCallbackMap.get(key)
    if (!entry) return

    const session = core.sessionManager.getSessionByThread(
      'telegram',
      // find session by ID
      (() => {
        const s = core.sessionManager.getSession(entry.sessionId)
        return s?.threadId ?? ''
      })(),
    )
    if (!session) return

    await session.enqueuePrompt(`/${entry.commandName}`)
  })
}
```

Wait — that's convoluted. Simpler to use `getSession` directly:

```typescript
export function setupSkillCallbacks(
  bot: Bot,
  core: OpenACPCore,
): void {
  bot.callbackQuery(/^s:/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery()
    } catch { /* expired */ }

    const key = ctx.callbackQuery.data.slice(2)
    const entry = skillCallbackMap.get(key)
    if (!entry) return

    const session = core.sessionManager.getSession(entry.sessionId)
    if (!session || session.status !== 'active') return

    await session.enqueuePrompt(`/${entry.commandName}`)
  })
}
```

- [ ] **Step 6: Add static command list for `setMyCommands`**

Export the static commands list for use by the adapter:

```typescript
export const STATIC_COMMANDS = [
  { command: 'new', description: 'Create new session' },
  { command: 'new_chat', description: 'New chat, same agent & workspace' },
  { command: 'cancel', description: 'Cancel current session' },
  { command: 'status', description: 'Show status' },
  { command: 'agents', description: 'List available agents' },
  { command: 'help', description: 'Help' },
  { command: 'menu', description: 'Show menu' },
]
```

- [ ] **Step 7: Build and verify no type errors**

Run: `pnpm build`
Expected: Clean compile, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/telegram/commands.ts
git commit -m "feat: add skill callback handler, keyboard builder, and static commands list"
```

---

### Task 5: Implement `sendSkillCommands` and `cleanupSkillCommands` in `TelegramAdapter`

**Files:**
- Modify: `src/adapters/telegram/adapter.ts:1-424`

- [ ] **Step 1: Add imports**

Update imports in `src/adapters/telegram/adapter.ts`. Add to the `commands.ts` import:

```typescript
import {
  setupCommands,
  setupMenuCallbacks,
  setupSkillCallbacks,
  buildMenuKeyboard,
  buildSkillKeyboard,
  clearSkillCallbacks,
  STATIC_COMMANDS,
} from "./commands.js";
```

Add `AgentCommand` to the core import:

```typescript
import {
  ChannelAdapter,
  type OpenACPCore,
  type OutgoingMessage,
  type PermissionRequest,
  type NotificationMessage,
  type Session,
  type AgentCommand,
} from "../../core/index.js";
```

- [ ] **Step 2: Add skill message tracking map**

Add a new private field to the `TelegramAdapter` class (after `assistantTopicId` on line 49):

```typescript
  private skillMessages: Map<string, number> = new Map(); // sessionId → pinned messageId
```

- [ ] **Step 3: Register `setMyCommands` and fix callback order**

In the `start()` method, add `setMyCommands` call after bot initialization (after line 73, the `allowed_updates` config block):

```typescript
    // Register static commands for Telegram autocomplete
    await this.bot.api.setMyCommands(STATIC_COMMANDS);
```

Then fix the callback registration order. The current order is:
1. `permissionHandler.setupCallbackHandler()` (line 105) — uses `bot.on('callback_query:data')`, catch-all
2. `setupCommands` (line 108)
3. `setupMenuCallbacks` (line 113)

Change to:
1. `setupSkillCallbacks` — `bot.callbackQuery(/^s:/)` (most specific, new)
2. `setupMenuCallbacks` — `bot.callbackQuery(/^m:/)` (specific regex)
3. `setupCommands` — `bot.command(...)` handlers (unaffected)
4. `permissionHandler.setupCallbackHandler()` — `bot.on('callback_query:data')` (catch-all, must be LAST)

Replace lines 97-117 with:

```typescript
    // Setup permission handler (instance only, callback registered later)
    this.permissionHandler = new PermissionHandler(
      this.bot,
      this.telegramConfig.chatId,
      (sessionId) =>
        (this.core as OpenACPCore).sessionManager.getSession(sessionId),
      (notification) => this.sendNotification(notification),
    );

    // Callback registration order matters!
    // Specific regex handlers first, catch-all last.
    setupSkillCallbacks(this.bot, this.core as OpenACPCore);
    setupMenuCallbacks(
      this.bot,
      this.core as OpenACPCore,
      this.telegramConfig.chatId,
    );
    setupCommands(
      this.bot,
      this.core as OpenACPCore,
      this.telegramConfig.chatId,
    );
    this.permissionHandler.setupCallbackHandler();
```

- [ ] **Step 4: Implement `sendSkillCommands`**

Add the method to `TelegramAdapter` class (after `renameSessionThread`, before `finalizeDraft`):

```typescript
  async sendSkillCommands(sessionId: string, commands: AgentCommand[]): Promise<void> {
    const session = (this.core as OpenACPCore).sessionManager.getSession(sessionId);
    if (!session) return;
    const threadId = Number(session.threadId);
    if (!threadId) return;

    // Empty commands → remove pinned message
    if (commands.length === 0) {
      await this.cleanupSkillCommands(sessionId);
      return;
    }

    // Clear old callback entries before building new keyboard
    clearSkillCallbacks(sessionId);

    const keyboard = buildSkillKeyboard(sessionId, commands);
    const text = '🛠 <b>Available commands:</b>';
    const existingMsgId = this.skillMessages.get(sessionId);

    if (existingMsgId) {
      // Update existing pinned message
      try {
        await this.bot.api.editMessageText(
          this.telegramConfig.chatId,
          existingMsgId,
          text,
          { parse_mode: 'HTML', reply_markup: keyboard },
        );
        return;
      } catch {
        // Message may have been deleted — fall through to create new
      }
    }

    // Create and pin new message
    try {
      const msg = await this.bot.api.sendMessage(
        this.telegramConfig.chatId,
        text,
        {
          message_thread_id: threadId,
          parse_mode: 'HTML',
          reply_markup: keyboard,
          disable_notification: true,
        },
      );
      this.skillMessages.set(sessionId, msg.message_id);

      await this.bot.api.pinChatMessage(this.telegramConfig.chatId, msg.message_id, {
        disable_notification: true,
      });
    } catch (err) {
      log.error({ err, sessionId }, 'Failed to send skill commands');
    }
  }
```

- [ ] **Step 5: Implement `cleanupSkillCommands`**

Add the cleanup method right after `sendSkillCommands`:

```typescript
  async cleanupSkillCommands(sessionId: string): Promise<void> {
    const msgId = this.skillMessages.get(sessionId);
    if (!msgId) return;

    try {
      await this.bot.api.editMessageText(
        this.telegramConfig.chatId,
        msgId,
        '🛠 <i>Session ended</i>',
        { parse_mode: 'HTML' },
      );
      await this.bot.api.unpinChatMessage(this.telegramConfig.chatId, { message_id: msgId });
    } catch {
      /* message may already be deleted */
    }

    this.skillMessages.delete(sessionId);
    clearSkillCallbacks(sessionId);
  }
```

- [ ] **Step 6: Also cleanup skill commands in `session_end` case of `sendMessage`**

In the `session_end` case of `sendMessage` (lines 329-342), add cleanup after deleting drafts:

```typescript
      case "session_end": {
        await this.finalizeDraft(sessionId);
        this.sessionDrafts.delete(sessionId);
        this.toolCallMessages.delete(sessionId);
        await this.cleanupSkillCommands(sessionId);
        // ... rest of the case
```

This ensures cleanup happens even if the adapter receives session_end through `sendMessage` rather than through `wireSessionEvents`.

- [ ] **Step 7: Build and verify no type errors**

Run: `pnpm build`
Expected: Clean compile, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/telegram/adapter.ts
git commit -m "feat: implement sendSkillCommands, cleanupSkillCommands, setMyCommands, and fix callback order"
```

---

### Task 6: Manual integration test

**Files:** None (manual testing)

- [ ] **Step 1: Build the project**

Run: `pnpm build`
Expected: Clean compile.

- [ ] **Step 2: Start the bot and verify static commands**

Run: `pnpm start`

Open Telegram, go to the bot's chat. Type `/` — you should see the autocomplete menu with all 7 commands (new, new_chat, cancel, status, agents, help, menu) with their descriptions.

- [ ] **Step 3: Verify dynamic skill commands**

Create a new session (`/new`). If the agent sends `commands_update` events, you should see a pinned message appear in the session topic with inline buttons for each command. Tap a button — it should send the command to the agent.

- [ ] **Step 4: Verify cleanup on session end**

When the session ends, the pinned message should change to "Session ended" with buttons removed.
