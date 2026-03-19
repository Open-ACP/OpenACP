# Telegram Skill Commands UI

## Problem

OpenACP's Telegram bot has hardcoded commands (`/new`, `/help`, etc.) registered as grammY handlers, but they are not registered with Telegram's `setMyCommands()` API — so users don't see autocomplete suggestions in the Telegram UI. Additionally, agents send `commands_update` events via ACP with available skill commands, but these are currently logged and discarded (marked as "Phase 3 feature" in `core.ts`).

## Solution

Two-layer command system:

1. **Static commands** registered via `setMyCommands()` at bot startup for autocomplete
2. **Dynamic skill commands** shown as inline keyboard buttons in a pinned message per session topic, updated live as agents report available commands

## Design

### 1. Static Commands — `setMyCommands()`

Call `bot.api.setMyCommands()` once in `TelegramAdapter.start()` after bot initialization.

Commands to register:

| Command     | Description                      |
|-------------|----------------------------------|
| `new`       | Create new session               |
| `new_chat`  | New chat, same agent & workspace |
| `cancel`    | Cancel current session           |
| `status`    | Show status                      |
| `agents`    | List available agents            |
| `help`      | Help                             |
| `menu`      | Show menu                        |

### 2. Dynamic Skill Commands — Pinned Inline Buttons

#### Interface

Replace `commands: unknown[]` in the `commands_update` event type with a typed interface:

```typescript
interface AgentCommand {
  name: string
  description: string
  input?: unknown  // preserved from ACP AvailableCommandInput, not used in UI yet
}
```

Update in `src/core/types.ts`:
```typescript
| { type: 'commands_update'; commands: AgentCommand[] }
```

#### Flow: Receiving commands from agent

1. `AgentInstance` emits `commands_update` event with `AgentCommand[]`
2. `core.wireSessionEvents()` in the `commands_update` case at line ~193 forwards the event to the adapter (remove the dead `toOutgoingMessage` case at line ~148 as well)
3. `TelegramAdapter` receives the event via a new `sendSkillCommands(sessionId, commands)` method
4. Adapter creates or edits a message in the session's forum topic containing inline keyboard buttons
5. Adapter pins that message in the topic

#### Flow: User taps a skill button

**Callback data uses a lookup map** (same pattern as permissions handler in `permissions.ts`):
- Generate a short `nanoid(8)` key per button
- Store mapping `key → { sessionId, commandName }` in a `Map`
- Callback data format: `s:<key>` (stays well under Telegram's 64-byte limit)

Handler:
1. Parse callback key from `s:<key>`
2. Look up `{ sessionId, commandName }` from the map
3. Call `session.enqueuePrompt("/<commandName>")` directly — bypasses Telegram message routing to avoid conflicts with static bot commands
4. Call `ctx.answerCallbackQuery()` to dismiss loading indicator

#### Flow: Commands update

When a new `commands_update` event arrives for the same session:
- Edit the existing pinned message with the new set of buttons
- Track the pinned message ID per session (store in a `Map<sessionId, messageId>`)
- If commands array is empty: unpin and delete the pinned message, clean up stored message ID

#### Flow: Session ends

Cleanup is triggered from `core.ts` event wiring (in `wireSessionEvents`, on `session_end` event) where the adapter reference is available:
- Call `adapter.cleanupSkillCommands(sessionId)`
- Edit the pinned skill message to remove buttons (replace with "Session ended" text)
- Clean up the stored message ID and callback map entries

### 3. Callback Routing

**Middleware ordering is critical.** The `s:` handler must be registered using `bot.callbackQuery(/^s:/)` BEFORE the permissions handler's `bot.on('callback_query:data')` catch-all, otherwise the permissions handler will silently swallow `s:` callbacks (it does not call `next()` for non-matching prefixes).

Registration order in `TelegramAdapter.start()`:
1. `setupSkillCallbacks(bot, core)` — `bot.callbackQuery(/^s:/, ...)`
2. `setupMenuCallbacks(bot, core)` — `bot.callbackQuery(/^m:/, ...)`
3. `setupCallbackHandler(bot, core)` — `bot.on('callback_query:data', ...)` for `p:` permissions

```typescript
bot.callbackQuery(/^s:/, async (ctx) => {
  await ctx.answerCallbackQuery()
  const key = ctx.callbackQuery.data.slice(2)
  const mapping = skillCallbackMap.get(key)
  if (!mapping) return
  // find session, enqueue prompt directly
})
```

### 4. Button Layout

- Each command gets one button
- Label: command name + description (e.g., "commit — Create a git commit")
- Layout: 2 buttons per row for readability
- If no commands available, don't create/pin any message

### 5. ChannelAdapter Base Class

Add `sendSkillCommands()` and `cleanupSkillCommands()` as **non-abstract methods with default no-op implementations** to avoid breaking existing adapters (including plugins):

```typescript
async sendSkillCommands(sessionId: string, commands: AgentCommand[]): Promise<void> {
  // no-op by default, override in adapters that support skill commands
}

async cleanupSkillCommands(sessionId: string): Promise<void> {
  // no-op by default
}
```

## Files to Modify

| File | Change |
|------|--------|
| `src/core/types.ts` | Add `AgentCommand` interface, type `commands` field |
| `src/core/core.ts` | Forward `commands_update` to adapter, trigger cleanup on session end |
| `src/core/channel.ts` | Add `sendSkillCommands()` and `cleanupSkillCommands()` with default no-op |
| `src/adapters/telegram/adapter.ts` | Implement `sendSkillCommands()`, `cleanupSkillCommands()`, call `setMyCommands()` on start, fix callback registration order |
| `src/adapters/telegram/commands.ts` | Add skill callback handler, static command list for `setMyCommands()`, callback lookup map |

## Out of Scope

- Per-user or per-chat command scoping (all commands are global to the bot)
- Command arguments/parameters UI (agent handles input collection)
- Persisting skill commands across bot restarts (they are re-sent by agents on session init)
- `setChatMenuButton()` for native menu button (can be added later)
