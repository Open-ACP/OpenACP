# Activity Tracker — Agent Live Status on Telegram

**Status:** Implemented (v1)
**Files:** `src/adapters/telegram/activity.ts`, `src/adapters/telegram/adapter.ts`

---

## Problem Statement

When an agent handles a task taking 20–60 seconds, users see nothing between sending their message and receiving the response. Telegram's typing indicator disappears after 5 seconds, leaving the chat visually frozen.

Additionally:
- Tool calls displayed as `⏳ 🔧 Tool` with no context about what is being done
- Agent thoughts (extended thinking) were silently discarded
- No way to cancel mid-task
- Mixed audience (dev + non-dev) had no progressive disclosure

---

## Goals

1. Users always know the agent is alive and making progress
2. Tool calls show *what* is being done (the actual query/path/command)
3. Agent thinking is visible optionally — live for those who want it, collapsible after
4. User can cancel at any point before or during execution
5. Works for 20–60s tasks without spamming the chat

---

## Architecture Decision

### Single "Working Card" message

One persistent Telegram message is created when the agent starts working. It:
- Gets edited in-place as state changes (throttled to ≥1.2s between edits)
- Shows plan checklist + current tool with extracted context
- Collapses to a `✅ N tools · Xs` summary when the agent finishes
- Has Cancel / Stop inline button throughout

**Why one message:** Avoids notification spam. Telegram shows one "new message" indicator regardless of how many edits happen.

### Separate ThoughtMessage per thinking phase

Each agent "thinking phase" (between tool calls) gets its own Telegram message:
- Appears as `💭 <i>live growing text...</i>` with throttled edits (≥1.5s)
- When the next tool call or final response starts, converts to `💭 <tg-spoiler>...</tg-spoiler>`
- Users tap the spoiler to read the full reasoning

**Why separate from card:** Thoughts can be long (500–2000 chars). Keeping them separate prevents the Working Card from becoming unwieldy.

---

## State Machine

```
Working Card states:

[initializing] ──plan event──▶ [planned] ──tool_call──▶ [executing]
                                                              │
                                    ◀──tool_update done───────┘
                                    (loops back to planned or executing)
                                              │
                                        text / session_end
                                              ▼
                                          [done]
```

**ThoughtMessage lifecycle:**
```
thought chunk arrives → ThoughtMessage created (lazy)
      │
      ▼
  append() → throttled edits to live message
      │
      ▼  (next tool_call OR text OR session_end)
  finalize() → edit to <tg-spoiler> (or delete if < 60 chars)
```

---

## Implementation Plan

### Phase 1 — Core Working Card ✅

**New file: `src/adapters/telegram/activity.ts`**

```
ActivityTracker
  ├── initialize()         — creates card message, starts typing loop
  ├── onPlan(entries)      — updates checklist in card
  ├── onThought(chunk)     — delegates to ThoughtMessage
  ├── onToolCall(name, kind, content)
  │     ├── finalizes current ThoughtMessage → spoiler
  │     └── extracts tool label from content, updates card
  ├── onToolUpdate(status) — clears current tool when done/failed
  ├── onTextStart()        — collapses card to summary, stops typing
  ├── onComplete()         — same as onTextStart (for tool-only tasks)
  ├── handleCancel()       — calls session.cancel(), updates card to 🛑
  └── destroy()            — cleanup timers

ThoughtMessage
  ├── append(chunk)        — accumulates + throttled live edit
  └── finalize()           — converts to spoiler or deletes if too short
```

**Key helpers:**

```typescript
extractToolLabel(name, content, depth)
```
Recursively extracts a human-readable label from ACP tool input:
- Checks: `query`, `command`, `path`, `file_path`, `url`, `input`, `text`, `prompt`
- Falls back to raw `name` if nothing found
- Truncates to 55 chars with `…`

**Modified: `src/adapters/telegram/adapter.ts`**

| Event | Before | After |
|---|---|---|
| `thought` | silently dropped | `tracker.onThought(chunk)` |
| `plan` | new standalone message | `tracker.onPlan(entries)` — integrated into card |
| `tool_call` | new message only | `tracker.onToolCall(name, kind, content)` + existing detail message |
| `tool_update` | edit detail message only | `tracker.onToolUpdate(status)` + existing edit |
| `text` (first chunk) | start draft | collapse card via `tracker.onTextStart()`, then draft |
| `session_end` | `✅ Done` message | `tracker.onComplete()` + cleanup, no separate Done message |

**Callback routing:** `a:<action>:<sessionId>` prefix, handled before menu callbacks.

---

### Phase 2 — User Preference: Simple vs Verbose Mode (planned)

**Problem:** Non-dev users may not want individual tool call messages alongside the Working Card.

**Proposed:** Per-user setting stored in config, toggled via `/settings` command.

| Mode | Tool call messages | Thought spoilers | Card |
|---|---|---|---|
| Simple (default) | Hidden | Hidden | ✅ shown |
| Verbose | Shown | Shown | ✅ shown |

**Implementation notes:**
- `TelegramAdapter` reads user preference from config before `sendMessage`
- Preference keyed by Telegram `userId`
- Toggle command: `/settings` → inline keyboard `[Simple] [Verbose]`

---

### Phase 3 — Plan Entry ↔ Tool Call Mapping (planned)

**Problem:** Plan checklist entries are text descriptions; tool calls are ACP events. Currently decoupled — card shows plan from `plan` events and current tool separately. Plan entry status only updates when ACP emits a new `plan` event with updated statuses.

**Proposed approach:** Trust ACP plan updates fully (Claude Code updates plan entry statuses reliably). No heuristic mapping needed.

**If ACP plan updates prove unreliable:** Fall back to sequential pointer — advance `▶` to next `◻` entry on each new tool_call, mark previous as `✅`.

---

### Phase 4 — Permission Integration (planned)

**Problem:** Permission requests currently appear as a separate message with inline buttons, disconnected from the Working Card.

**Proposed:** When `onPermissionRequest` fires:
1. Working Card transforms to `⏸️ Waiting for your approval...`
2. Permission buttons appear on the card itself (or just below)
3. On approval/denial, card returns to previous state

**Constraint:** Permission handler (`permissions.ts`) currently manages its own message lifecycle. Integration requires refactoring `PermissionHandler` to accept an optional `ActivityTracker` reference.

---

## UX Flow (full example)

User: *"giá vàng hôm nay là bao nhiêu?"*

```
[0s]   ⚙️ Working on it...
       [🛑 Cancel]

[1s]   ⚙️ Working on it...
       ◻ Research current gold prices
       ◻ Format and present the data
       [🛑 Cancel]

       💭 I need to search for current gold prices.
          The user is asking about today's world price
          so I should look for USD/oz figures for March...
          (live, growing)

[4s]   💭 [spoiler — tap to read]    ← thought finalized

       ⚙️ Working on it...
       ▶ Research current gold prices
       ◻ Format and present the data
       🔍 "gold price world today March 2026"
       [⏹ Stop]

       ⏳ 🔍 web_search                ← detail message

[6s]   ✅ 🔍 web_search               ← detail message edited

       💭 The results show $4,720/oz for March 20.
          I should also verify with a second source...
          (next thought, live)

[9s]   💭 [spoiler — tap to read]    ← second thought finalized

       🌐 "https://markets.com/..."   ← second tool detail

[11s]  ✅ 2 tools · 11s              ← card collapses

       Dưới đây là giá vàng hôm nay (20/03/2026)...
       (final response streams in)
```

---

## Rate Limit Considerations

| Action | Limit | Strategy |
|---|---|---|
| Card edits | 1/1.2s per message | `_scheduleFlush()` throttle |
| Thought edits | 1/1.5s per message | `_scheduleFlush()` in ThoughtMessage |
| Typing indicator | Every 4.5s | `setInterval(4500)` |
| Telegram global | 30 req/s per chat | Acceptable: card + thought = 2 active messages |

---

## Known Limitations (v1)

1. **No plan entry status sync from tool events** — plan checklist only updates when ACP emits a new `plan` event. If Claude Code skips plan updates mid-task, checklist stays stale. (Addressed in Phase 3.)

2. **ThoughtMessage not shown for assistant session** — `ActivityTracker` is only created for session-topic conversations, not the assistant topic. This is intentional for now.

3. **`sendChatAction` typing in forum topics** — grammY's type for `sendChatAction` doesn't officially expose `message_thread_id` in its params type, requiring a `as never` cast. Works at runtime; monitor for grammY API changes.

4. **Card not pinned** — The Working Card appears at the bottom of the topic thread but isn't pinned, so it scrolls away during long tasks with many tool messages. Considered pinning but decided against it (pin/unpin creates system messages).
