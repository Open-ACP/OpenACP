# Activity Tracker — Design Spec

**Date:** 2026-03-20
**Feature spec:** `docs/specs/features/activity-tracker.md`

---

## Problem

When an agent handles a task taking 20–60 seconds, users see nothing. Telegram's typing indicator disappears after 5 seconds. Tool calls show no context. No cancel UI. No usage visibility.

---

## Goals

1. Users always know the agent is alive and making progress
2. Tool calls show what is being done (actual query/path/command)
3. User can cancel before or during execution
4. Tool call history is preserved — scroll up to see what ran
5. No Telegram 4096-char limit risk

---

## Architecture

### Core principle: purpose-specific messages, independent lifecycles

Each message type has one responsibility. No shared state machine. This eliminates:
- 4096-char limit risk (each message has bounded content)
- Race conditions (no competing throttled edits to the same message)
- State coordination complexity

| Message | Content | Lifecycle |
|---|---|---|
| `💭 Thinking...` | Static indicator | Temporary — delete on tool call or text |
| `📋 Plan [Cancel]` | Checklist of plan entries | Persistent — edit-in-place |
| `⏳/✅/❌ tool "label"` | One per tool call | Persistent — edit on update |
| Text response | Streaming content | Persistent — existing MessageDraft |
| `📊 Usage` | Tokens, context %, cost | Rolling — delete previous on new prompt |

### Cancel button

On the Plan card. Short tasks without a plan event have no cancel UI — acceptable since they finish quickly.

### Thinking indicator

Static `💭 Thinking...`. No streaming, no spoilers. Deleted when agent moves to tool/text.

---

## Components

### `ActivityTracker` (coordinator)

Thin coordinator in `activity.ts`. Does not replicate `sessionDrafts` or `toolCallMessages` from adapter. Only manages new message types.

```
ActivityTracker
  ├── onThought()              — send ThinkingIndicator if not present
  ├── onPlan(entries)          — send/update PlanCard, delete ThinkingIndicator
  ├── onToolCall(name, kind, content)
  │     └── delete ThinkingIndicator
  ├── onToolUpdate(id, status) — signal plan card to update entry if applicable
  ├── onTextStart()            — delete ThinkingIndicator
  ├── onComplete(usage)        — finalize PlanCard (remove Cancel), send/roll Usage
  ├── handleCancel()           — cancel session, update PlanCard to 🛑 Cancelled
  └── destroy()                — cleanup timers, delete lingering ThinkingIndicator
```

### `ThinkingIndicator`

```
ThinkingIndicator
  ├── send()    — sendMessage "💭 Thinking...", store messageId
  └── delete()  — deleteMessage, no-op if already deleted or never sent
```

### `PlanCard`

```
PlanCard
  ├── send(entries)         — create message with checklist + [🛑 Cancel]
  ├── update(entries)       — throttled edit-in-place (≥1.2s between edits)
  ├── finalize(cancelled?)  — remove inline keyboard, update final state
  └── _buildText(entries)   — render: ◻ pending, ▶ in_progress, ✅ completed
```

### `UsageMessage`

```
UsageMessage
  ├── send(usage)           — sendMessage with usage stats
  └── deletePrevious()      — delete previous usage message at start of new prompt
```

### `formatToolCall` compact mode

Extend existing `formatting.ts` — add `compact` parameter. Replaces standalone `extractToolLabel()`:

```typescript
// In formatting.ts
formatToolCall(tool, mode: 'full' | 'compact' = 'full')
// compact: extract label from tool input, truncate 55 chars
// Returns: "⏳ 🔍 web_search "gold price today""
```

---

## Event Flow

```
new prompt starts
  → usageMessage.deletePrevious()
  → draft.finalize() [bug fix: finalize between text-only prompts]

thought event
  → thinkingIndicator.send() [no-op if already sent]

plan event
  → planCard.send/update(entries)
  → thinkingIndicator.delete()

tool_call event
  → thinkingIndicator.delete()
  → send tool message (existing toolCallMessages Map)

tool_update (done/fail)
  → edit tool message (existing)
  → planCard.update() if entry status changed

text (first chunk)
  → thinkingIndicator.delete()
  → start MessageDraft (existing)

session_end
  → planCard.finalize()
  → usageMessage.send(usage)
  → destroy()
```

---

## Error Handling

| Failure | Behavior |
|---|---|
| `editMessageText` fails | Log warning, skip this update |
| `sendMessage` for ThinkingIndicator fails | Swallow — best-effort |
| `sendMessage` for PlanCard fails | Log error, continue without plan card |
| `deleteMessage` fails | Swallow — message may already be deleted |
| Session ends unexpectedly | `destroy()` cleans up timers, removes ThinkingIndicator |

---

## Rate Limits

| Action | Strategy |
|---|---|
| Plan card edits | Throttle ≥1.2s via `_scheduleFlush()` |
| Tool message edits | Single edit per tool (done/fail) — no throttle needed |
| Typing indicator | `setInterval(4500)` — Telegram clears after 5s |

---

## Files Changed

| File | Change |
|---|---|
| `src/adapters/telegram/activity.ts` | Full rewrite — ThinkingIndicator, PlanCard, UsageMessage, ActivityTracker coordinator |
| `src/adapters/telegram/formatting.ts` | Add `compact` mode to `formatToolCall`, remove `extractToolLabel` |
| `src/adapters/telegram/adapter.ts` | Wire new ActivityTracker interface, fix MessageDraft finalization on new prompt |

---

## Out of Scope (future phases)

- **Phase 2:** Permission Integration — PlanCard shows `⏸️ Waiting...` on permission request, event/callback pattern between PermissionHandler and ActivityTracker
- **Phase 3:** Plan entry ↔ tool call mapping — sequential pointer fallback if ACP plan updates unreliable
