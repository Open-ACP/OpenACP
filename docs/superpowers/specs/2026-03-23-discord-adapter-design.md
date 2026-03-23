# Discord Adapter Design Spec

**Date:** 2026-03-23
**Status:** Approved

## Overview

Add a built-in Discord adapter to OpenACP with full feature parity with the Telegram adapter. Uses discord.js library and maps Telegram concepts (forum topics, inline keyboards, callback queries) to Discord equivalents (forum channel posts, button components, interactions).

## Architecture: Mirror Approach

Replicate the Telegram adapter's file structure 1:1 in `src/adapters/discord/`, mapping each Telegram concept to its Discord equivalent. No shared base class extraction — keep adapters independent.

## File Structure

```
src/adapters/discord/
  adapter.ts              — Main DiscordAdapter class
  index.ts                — Re-exports
  types.ts                — DiscordChannelConfig, DiscordPlatformData
  forums.ts               — Forum post/thread CRUD + auto-unarchive helper
  streaming.ts            — MessageDraft (2000 char limit)
  send-queue.ts           — DiscordSendQueue with rate limiting
  permissions.ts          — Button-based permission handler
  formatting.ts           — Markdown formatting for Discord
  activity.ts             — ThinkingIndicator, UsageMessage, PlanCard, ActivityTracker
  tool-call-tracker.ts    — Tool call state tracking
  draft-manager.ts        — DraftManager for streaming
  skill-command-manager.ts — Skill command pinning via thread.messages.pin()
  action-detect.ts        — Action detection + button building
  assistant.ts            — Assistant session (channelId: "discord") in dedicated thread
  commands/
    index.ts              — Slash command registration (guild.commands.set() full replace)
    menu.ts               — Menu interactions
    new-session.ts        — /new command flow
    session.ts            — /cancel, /status, /sessions, /handoff
    admin.ts              — /dangerous, /restart, /update
    agents.ts             — /agents, /install
    integrate.ts          — /integrate
    settings.ts           — /settings
    doctor.ts             — /doctor

src/core/doctor/checks/
  discord.ts              — Discord-specific doctor check (token, guild, forum channel)
```

## Config

Added to `config.channels`:

```json
{
  "channels": {
    "discord": {
      "enabled": false,
      "botToken": "YOUR_DISCORD_BOT_TOKEN",
      "guildId": "",
      "forumChannelId": null,
      "notificationChannelId": null,
      "assistantThreadId": null
    }
  }
}
```

All fields use `.default()` or `.optional()` for backward compatibility.

**Type:**

```ts
interface DiscordChannelConfig {
  enabled: boolean
  botToken: string
  guildId: string
  forumChannelId: string | null
  notificationChannelId: string | null
  assistantThreadId: string | null
}
```

**Platform data** (defined in `src/core/types.ts` alongside `TelegramPlatformData`):

```ts
interface DiscordPlatformData {
  threadId: string
  skillMsgId?: string
}
```

**Env overrides** (fallback for Docker/CI, not primary flow — must be wired into `applyEnvOverrides()` in `config.ts`):
- `OPENACP_DISCORD_BOT_TOKEN` → `channels.discord.botToken`
- `OPENACP_DISCORD_GUILD_ID` → `channels.discord.guildId`

**Primary flow:** Token entered via interactive setup → saved to `config.json`.

## Platform Mapping

| Concern | Telegram | Discord |
|---|---|---|
| Message limit | 4096 chars | 2000 chars |
| Streaming | `editMessageText` | `message.edit()` |
| Buttons | InlineKeyboard + callback queries | ActionRow + ButtonBuilder + interactions |
| Interaction timeout | No timeout | 3s acknowledgment required |
| Thread model | Forum topics (integer `message_thread_id`) | Forum posts (string `threadId`) |
| Commands | `bot.command()` text commands | Slash commands (guild-registered via `guild.commands.set()`) |
| Formatting | HTML (`<b>`, `<code>`) | Native Markdown (`**bold**`, `` `code` ``) |
| Rate limits | ~30 msg/sec per chat | 50 req/sec global, 5 msg/sec per channel |
| Bot setup | BotFather token | Token + Guild ID + Privileged Gateway Intents |
| Typing indicator | `sendChatAction('typing')` | `channel.sendTyping()` |
| Deep links | `https://t.me/c/{id}/{msgId}` | `https://discord.com/channels/{guildId}/{channelId}/{msgId}` |
| Thread archival | N/A | Auto-archive (1h/24h/3d/1w) — must unarchive before sending |

## Startup Sequence

`DiscordAdapter.start()`:

1. Create `Client` with intents: `Guilds`, `GuildMessages`, `MessageContent` (privileged — requires Developer Portal toggle)
2. Instantiate `ToolCallTracker`, `DraftManager`, `SkillCommandManager`
3. `client.login(botToken)`
4. On `ready`:
   - Verify bot is in configured guild (throw if not)
   - `ensureForums()` — create Forum Channel + Notification Channel if `null`, persist IDs to config
   - Register slash commands to guild (`guild.commands.set()` — full replace, propagation delay is expected)
   - Create `PermissionHandler`
   - Set up `interactionCreate` handler (slash commands + button routing)
   - Set up `messageCreate` handler (message routing)
   - Spawn assistant session (`channelId: "discord"`, with Discord-specific system prompt)
   - Set `assistantInitializing = true` during system prompt — suppress adapter output until ready
   - Send welcome message to notification channel

`DiscordAdapter.stop()`:

1. Destroy assistant session if active (`this.assistantSession.destroy()`)
2. `client.destroy()` — disconnects from Discord gateway
3. Log "Discord bot stopped"

## Event Flow

### Message Routing (`messageCreate`)

```
User sends message in forum thread
  → guildId check (reject if wrong guild)
  → ignore bot messages (including self)
  → ignore DMs (only process guild messages)
  → threadId = message.channelId
  → core.handleMessage({ channelId: 'discord', threadId, userId, text })
```

### Interaction Routing (`interactionCreate`)

```
Button clicked or slash command used
  → interaction.deferReply() or interaction.deferUpdate() (within 3s)
  → Route by type:
    - ChatInputCommand → slash command handlers
    - Button → customId prefix routing (p:, m:, d:, a:, ag:, na:)
```

### sendMessage() Dispatch

Suppress output if `assistantInitializing && sessionId === assistantSession.id`.

| Type | Discord Action |
|---|---|
| `text` | `DraftManager.append()` → `message.edit()` streaming → split at 2000 chars |
| `thought` | `ActivityTracker.onThought()` → `channel.sendTyping()` |
| `tool_call` | `DraftManager.finalize()` → `ToolCallTracker.trackNewCall()` → send embed |
| `tool_update` | `ToolCallTracker.updateCall()` → edit embed on terminal status |
| `plan` | `ActivityTracker.onPlan()` → embed with plan entries |
| `usage` | `DraftManager.finalize()` → usage embed → notification channel (deep link: `https://discord.com/channels/{guildId}/{channelId}/{msgId}`) |
| `session_end` | `DraftManager.finalize()` → cleanup → "Done" message |
| `error` | `DraftManager.finalize()` → error embed |

### Permission Flow

```
AgentInstance.onPermissionRequest
  → session.permissionGate.setPending(request)
  → adapter.sendPermissionRequest()
    → Send message with ActionRow buttons (customId: "p:<key>:<optionId>")
  → User clicks button
  → interactionCreate handler matches "p:" prefix
    → interaction.deferUpdate()
    → session.permissionGate.resolve(optionId)
    → Edit message to remove buttons (editReply with empty components)
  → Promise resolves → ACP subprocess continues
```

Auto-approve: `session.dangerousMode = true` or description contains `"openacp"`.

### Session Thread Lifecycle

1. `/new` slash command → `interaction.deferReply()`
2. Create forum post in `forumChannelId` → get thread
3. `core.handleNewSession()` → spawns agent
4. `session.threadId = thread.id`
5. Auto-name event → `thread.setName()`

### Thread Auto-Archive Handling

Discord auto-archives inactive threads. The `forums.ts` module provides an `ensureUnarchived(thread)` helper that calls `thread.setArchived(false)` if needed. This helper is called in `sendMessage()` before any message send/edit operation, and in `forums.ts` thread lookup methods.

### deleteSessionThread()

Override the base class no-op: call `thread.delete()` to remove the forum post when a session is cleaned up.

### sendSkillCommands()

Pin a message containing skill commands in the session thread via `message.pin()`. Persist the `skillMsgId` in `DiscordPlatformData`. On cleanup, unpin and delete the message.

### /handoff Command

Same as Telegram: generates a terminal resume command for agents supporting `supportsResume`. Responds as an ephemeral reply in the interaction.

## Integration Points

### config.ts

- Add Discord default config to `channels` with all fields `.default()` or `.optional()`
- Add `OPENACP_DISCORD_BOT_TOKEN` and `OPENACP_DISCORD_GUILD_ID` to `applyEnvOverrides()` array

### setup.ts

Refactor `runSetup()` to support multiple channels:

1. Add channel selection step: "Which channels do you want to enable?" → Telegram, Discord, or both
2. If Telegram selected: run existing `setupTelegram()` flow
3. If Discord selected: run `setupDiscord()`:
   - Prompt for Bot Token (with link to Developer Portal)
   - Validate token via `GET /users/@me` API call
   - Prompt for Guild ID (with instructions: Developer Mode → right-click server → Copy ID)
4. Construct `channels` object based on selections (handle telegram-only, discord-only, both cases)
5. Update step counter to be dynamic based on selections (not hardcoded `[1/3]`)

### main.ts

Add built-in adapter lookup:

```ts
} else if (channelName === 'discord') {
  core.registerAdapter('discord', new DiscordAdapter(core, channelConfig as any))
  log.info({ adapter: 'discord' }, 'Adapter registered')
}
```

Address `TopicManager` Telegram coupling: when Discord is enabled without Telegram, `TopicManager` receives `null` adapter. Either:
- Make `TopicManager` adapter-agnostic (accept any adapter), or
- Skip `TopicManager` creation when Telegram adapter is not present (it's only used by the API server for Telegram topic operations)

Recommended: skip `TopicManager` when no Telegram adapter, since it's Telegram-specific.

### package.json

Add `discord.js` dependency.

### core/doctor/checks/discord.ts

Add Discord-specific doctor check:
- Validate bot token format
- Test API reachability (`GET /users/@me`)
- Verify guild membership
- Verify forum channel exists and is accessible

## Security

- **Guild restriction:** Only accept messages from configured `guildId`
- **User allowlist:** Uses existing `security.allowedUserIds` from core config
- **Ignore bot messages:** Skip all messages from bots (including self)
- **Ignore DMs:** Only process messages from guild channels

## Error Handling

| Scenario | Handling |
|---|---|
| Bot disconnected | discord.js auto-reconnects. Log warning. |
| Guild not found | `start()` throws: "Bot is not in guild {guildId}" |
| Forum channel deleted | Detect on send, recreate + log + update config |
| Rate limited | discord.js built-in rate limit queue. `DiscordSendQueue.onRateLimited()` drops all queued text-type edits (same pattern as Telegram's `TelegramSendQueue`). |
| Message too long | Split at 2000 chars on `\n\n` boundaries, respect code blocks |
| Interaction expired | Already deferred upfront. If followup fails, send new message. |
| Thread archived | `ensureUnarchived(thread)` in `forums.ts` called before sends |
| DM received | Silently ignored (guild-only) |

## Testing

Unit tests mock discord.js Client. Test each module independently.

```
tests/adapters/discord/
  streaming.test.ts
  send-queue.test.ts
  permissions.test.ts
  formatting.test.ts
  tool-call-tracker.test.ts
  adapter.test.ts
```

## Discord Bot Prerequisites

1. Create application at discord.com/developers
2. Add bot under "Bot" settings
3. **Enable privileged intent:** Under "Bot" → "Privileged Gateway Intents" → toggle ON "MESSAGE CONTENT INTENT" (required to read message content; without this, `message.content` is empty)
4. Generate invite URL with scopes: `bot`, `applications.commands`
5. Bot permissions: Send Messages, Manage Threads, Create Public Threads, Read Message History, Use Slash Commands, Manage Channels, Embed Links
6. Invite bot to server
7. Enable Developer Mode in Discord (Settings → Advanced → Developer Mode)
8. Right-click your server → "Copy Server ID" → this is your Guild ID
