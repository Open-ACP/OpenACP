# Activity Tracker — Agent Live Status on Telegram

**Status:** In progress
**Files:** `src/adapters/telegram/activity.ts`, `src/adapters/telegram/adapter.ts`

---

## Problem Statement

When an agent handles a task taking 20–60 seconds, users see nothing between sending their message and receiving the response. Telegram's typing indicator disappears after 5 seconds, leaving the chat visually frozen.

Additionally:
- Tool calls displayed as `⏳ 🔧 Tool` with no context about what is being done
- Agent thoughts (extended thinking) were silently discarded
- No way to cancel mid-task
- No usage visibility (tokens, cost, context window consumption)

---

## Goals

1. Users always know the agent is alive and making progress
2. Tool calls show *what* is being done (the actual query/path/command)
3. User can cancel at any point before or during execution
4. Tool call history is preserved — users can scroll up and see what ran
5. Works for 20–60s tasks without spamming the chat or hitting Telegram's 4096-char message limit

---

## Architecture Decision

### Purpose-specific messages, independent lifecycles

Instead of a single "Working Card" that packs all state into one edited message, each message type has one responsibility and its own lifecycle. This avoids Telegram's 4096-char limit, eliminates shared state coordination, and preserves tool history.

| Message | Content | Lifecycle |
|---|---|---|
| `💭 Thinking...` | Static indicator | **Temporary** — delete when agent starts tool call or text |
| `📋 Plan` + Cancel button | Progress checklist | **Persistent** — edit-in-place as entries complete |
| `⏳/✅/❌ tool_name "label"` | One message per tool call | **Persistent** — edit-in-place on update |
| Text response | Streaming content | **Persistent** — existing `MessageDraft` unchanged |
| `📊 Usage` | Context %, tokens, cost | **Rolling** — delete previous when next prompt starts |

**Why this over a single card:**
- No 4096-char risk — each message has a single, bounded purpose
- No shared state machine — each message type is independent
- No race conditions — no competing throttled edits to the same message
- Tool history preserved — users scroll up and see exactly what ran
- Less new code — tool messages and text streaming already work

### Cancel button

Placed on the **Plan card** — the most persistent message during execution. When no plan is emitted (short tasks), no Cancel button is shown; this is acceptable since short tasks finish before a cancel would be useful.

### Thinking indicator

A static `💭 Thinking...` message sent when the first `thought` chunk arrives. Deleted immediately when the agent moves to a tool call, text, or session end. No streaming, no spoilers, no threshold logic — users just need to know the agent is alive.

### `extractToolLabel` → extend `formatToolCall`

The existing `formatToolCall()` in `formatting.ts` already renders tool name with status icons and context. Rather than a parallel `extractToolLabel()` function, add a `compact` mode to `formatToolCall()` that truncates label to 55 chars. Reuse, don't duplicate.

### `MessageDraft` finalization between prompts

Current bug: `MessageDraft` is only finalized on `tool_call`, `plan`, `session_end`, or `error`. If the agent responds to two consecutive prompts with text only (no tool calls), the second response appends to the first message. Fix: finalize the draft when a new prompt starts processing.

---

## State Flow

```
Agent starts processing prompt
  │
  ├─ [FIRST EVENT — any type] ───────▶ Delete previous Usage message (rolling)
  │                                     Finalize previous MessageDraft (bug fix)
  │                                     (tracked via isFirstEvent flag in ActivityTracker)
  │
  ├─ thought event ──────────────────▶ Send "💭 Thinking..." (if not already sent)
  │
  ├─ plan event ─────────────────────▶ Send/edit Plan card with checklist + [🛑 Cancel]
  │                                     Delete "💭 Thinking..." if present
  │
  ├─ tool_call event ────────────────▶ Send "⏳ tool_name "label"" message
  │                                     Delete "💭 Thinking..." if present
  │
  ├─ tool_update (done/fail) ────────▶ Edit tool message to "✅/❌ tool_name "label""
  │                                     Update Plan card entry if applicable
  │
  ├─ text (first chunk) ─────────────▶ Start MessageDraft (existing behavior)
  │
  └─ session_end ────────────────────▶ Finalize Plan card (remove Cancel button) if present
                                        Send "✅ Done" if no Plan card was emitted
                                        Send "📊 Usage" message
```

---

## Component Design

### `ActivityTracker` (coordinator)

Thin coordinator — does not replicate `sessionDrafts` or `toolCallMessages` state. Wraps the message lifecycle for the new message types only.

```
ActivityTracker
  ├── onThought()              — [first event] delete previous UsageMessage, finalize old draft;
  │                              then send ThinkingIndicator if not present
  ├── onPlan(entries)          — [first event if no thought] delete previous UsageMessage, finalize old draft;
  │                              send/update PlanCard, delete ThinkingIndicator
  ├── onToolCall(name, kind, content)
  │     └── [first event if no thought/plan] delete previous UsageMessage, finalize old draft;
  │          delete ThinkingIndicator, send tool message (via existing toolCallMessages)
  ├── onToolUpdate(id, status) — edit tool message (via existing toolCallMessages)
  ├── onTextStart()            — [first event if no thought/plan/tool_call] delete previous UsageMessage, finalize old draft;
  │                              delete ThinkingIndicator (if still present)
  ├── onComplete(usage)        — finalize PlanCard (if present); send "✅ Done" if no PlanCard; send UsageMessage
  ├── handleCancel()           — calls session.cancel(), updates PlanCard to 🛑 Cancelled
  └── destroy()                — cleanup, delete ThinkingIndicator if lingering
```

**`onNewPrompt()` triggers on the first event of any type** (thought, plan, tool_call, or text). `ActivityTracker` tracks an `isFirstEvent` flag that resets at the start of each prompt cycle. This ensures the previous Usage message is deleted and the previous draft is finalized as soon as processing begins — not only when text arrives.

### `ThinkingIndicator`

Minimal — just a message ID and a `delete()` call. No throttling, no content updates.

```
ThinkingIndicator
  ├── send()    — sendMessage "💭 Thinking...", store messageId
  └── delete()  — deleteMessage, no-op if already deleted
```

### `PlanCard`

Manages the plan checklist message with Cancel/Stop button and a progress bar.

```
PlanCard
  ├── send(entries)            — create message with progress bar + checklist + Cancel button
  ├── update(entries)          — edit-in-place (throttled ≥1.2s)
  ├── finalize(cancelled?)     — remove inline keyboard, update final state
  └── _buildText(entries)      — render progress bar + checklist: ◻ ▶ ✅ ❌
```

**Progress bar format:**
```
📋 Plan
▓▓▓▓▓▓░░░░ 60% · 3/5
✅ Research gold prices
✅ Verify with second source
✅ Check exchange rates
▶ Format data for user
◻ Present final answer
```

Bar is 10 chars wide (`▓` filled, `░` empty). Percentage = completed / total. Updated on every `update()` call.

### `UsageMessage`

Rolling — always at most one per session at a time.

```
UsageMessage
  ├── send(usage)              — sendMessage with usage stats
  └── deletePrevious()         — deleteMessage previous, called at start of new prompt
```

**Format:**
```
📊 Usage
▓▓▓░░░░░░░ 28% context
12k / 42k tokens · $0.03
```

**Warning at high usage (≥85%):** append `⚠️` to the percentage line:
```
📊 Usage
▓▓▓▓▓▓▓▓▓░ 92% context ⚠️
89k / 96k tokens · $0.15
```

### `formatToolCall` compact mode (existing file)

Extend `formatting.ts`:

```typescript
formatToolCall(name, kind, content, mode: 'full' | 'compact' = 'full')
// compact: extract label, truncate to 55 chars, return "tool_name "label""
```

---

## Error Handling

| Failure | Behavior |
|---|---|
| `editMessageText` fails (rate limit / network) | Log warning, skip this update. Next scheduled flush will retry. |
| `sendMessage` for ThinkingIndicator fails | Swallow error — indicator is best-effort |
| `sendMessage` for PlanCard fails | Log error, continue without plan card |
| `deleteMessage` fails | Swallow — message may already be deleted by user |
| Agent crash / session_end not received | `destroy()` called by adapter on session cleanup; removes ThinkingIndicator, removes Cancel button from PlanCard |
| Typing interval not cleared | `destroy()` clears all timers |

---

## Rate Limit Considerations

| Action | Limit | Strategy |
|---|---|---|
| Plan card edits | 1/1.2s | `_scheduleFlush()` throttle |
| Tool message edits | 1 edit per tool (done/fail) | No throttle needed — single edit per message |
| Typing indicator | Every 4.5s | `setInterval(4500)` |
| Telegram global | 30 req/s per chat | Acceptable: only 1 active edit-in-place message (plan card) |

---

## UX Flow (full example)

User: *"giá vàng hôm nay là bao nhiêu?"*

```
[0s]   💭 Thinking...

[1s]   💭 Thinking...      ← still present

       📋 Plan
       ◻ Research current gold prices
       ◻ Format and present the data
       [🛑 Cancel]         ← ThinkingIndicator deleted

[3s]   ⏳ 🔍 "gold price world today March 2026"

       📋 Plan
       ▶ Research current gold prices
       ◻ Format and present the data
       [⏹ Stop]

[6s]   ✅ 🔍 "gold price world today March 2026"  ← tool message edited

       💭 Thinking...      ← new indicator (second thinking phase)

[7s]   ⏳ 🌐 "https://markets.com/..."   ← second tool, indicator deleted

[9s]   ✅ 🌐 "https://markets.com/..."

       📋 Plan
       ✅ Research current gold prices
       ▶ Format and present the data
                           ← Cancel button removed (text starting)

       Dưới đây là giá vàng hôm nay (20/03/2026)...
       (final response streams in)

       📊 Usage
       ▓▓▓░░░░░░░ 28% context
       12k / 42k tokens · $0.03
```

**Short task (no plan event):**

```
[0s]   💭 Thinking...

       Xin chào! Tôi có thể giúp gì cho bạn?
       (response streams in)

       ✅ Done

       📊 Usage
       ▓░░░░░░░░░ 8% context
       3k / 42k tokens · $0.01
```

When no `plan` event is emitted, `onComplete()` sends `✅ <b>Done</b>` so the user has a clear completion signal.

---

## Implementation Phases

### Phase 1 — Core activity tracking

- `ThinkingIndicator`: send static message, delete on transition
- `PlanCard`: send/edit checklist with Cancel/Stop button
- `ActivityTracker` coordinator wiring all events
- Extend `formatToolCall()` with compact mode (replaces `extractToolLabel`)
- Fix `MessageDraft` not finalized between text-only prompts
- Error handling for all message operations (swallow vs log per table above)

**Modified: `src/adapters/telegram/adapter.ts`**

| Event | Before | After |
|---|---|---|
| `thought` | silently dropped | `tracker.onThought()` — triggers `onNewPrompt()` on first event |
| `plan` | new standalone message | `tracker.onPlan(entries)` — PlanCard; triggers `onNewPrompt()` on first event |
| `tool_call` | new message only | `tracker.onToolCall()` + existing tool message; triggers `onNewPrompt()` on first event |
| `tool_update` | edit tool message only | `tracker.onToolUpdate()` + existing edit |
| `text` (first chunk) | start draft | `tracker.onTextStart()` — triggers `onNewPrompt()` on first event, then draft |
| `session_end` | `✅ Done` message | `tracker.onComplete(usage)` — `✅ Done` only when no PlanCard |
| new prompt starts | (no handler) | handled via `isFirstEvent` flag inside `ActivityTracker` |

**Callback routing:** `a:<action>:<sessionId>` prefix, handled before menu callbacks.

---

### Phase 2 — Permission Integration (planned)

**Problem:** Permission requests appear as a separate message with inline buttons, disconnected from the activity flow.

**Proposed:** When `onPermissionRequest` fires:
1. PlanCard (if present) updates to `⏸️ Waiting for your approval...`
2. Permission buttons appear on a new message (existing behavior), not on the card
3. On approval/denial, PlanCard returns to previous state

**Integration approach:** Use event/callback pattern — `PermissionHandler` emits an event, `ActivityTracker` listens. No direct reference between the two components. This keeps both decoupled.

---

### Phase 3 — Plan Entry ↔ Tool Call Mapping (planned)

**Problem:** Plan checklist entries are text descriptions; tool calls are ACP events. Plan entry status only updates when ACP emits a new `plan` event.

**Proposed approach:** Trust ACP plan updates fully (Claude Code updates plan entry statuses reliably). No heuristic mapping needed in v1.

**Fallback if ACP plan updates prove unreliable:** Sequential pointer — advance `▶` to next `◻` entry on each new `tool_call`, mark previous as `✅`.

---

## Files Changed

| File | Change |
|---|---|
| `src/adapters/telegram/activity.ts` | Full rewrite — ThinkingIndicator, PlanCard, UsageMessage, ActivityTracker coordinator |
| `src/adapters/telegram/formatting.ts` | Add `compact` mode to `formatToolCall`, remove `extractToolLabel` |
| `src/adapters/telegram/adapter.ts` | Wire new ActivityTracker interface, fix MessageDraft finalization on new prompt |

---

## Known Limitations

1. **No plan entry status sync from tool events** — checklist only updates when ACP emits a new `plan` event. If Claude Code skips plan updates mid-task, checklist stays stale. (Addressed in Phase 3.)

2. **No Cancel when plan is absent** — Cancel button only appears on the Plan card. Short tasks that don't emit a `plan` event have no cancel UI. Acceptable for now; revisit if needed.

3. **`sendChatAction` typing in forum topics** — grammY's type for `sendChatAction` doesn't officially expose `message_thread_id`, requiring an `as never` cast. Works at runtime; monitor for grammY API changes.
