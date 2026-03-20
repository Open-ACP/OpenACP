# Telegram Streaming Redesign v2 — Simple FIFO Queue + Text Coalescing

**Date:** 2026-03-20
**Status:** Approved
**Goal:** Remove `sendMessageDraft` (unsupported in forum supergroups), redesign streaming with simple FIFO queue to eliminate 429 rate limit errors.

## Problem

1. `sendMessageDraft` only works in private chats. Forum supergroups always get `TEXTDRAFT_PEER_INVALID`, falling back to `sendMessage` + `editMessageText`.
2. Text streaming at 200ms interval eats rate limit budget, causing 429 errors with `retryAfter` up to 41 seconds.
3. All sessions in a forum supergroup share ONE rate limit budget (~20 calls/min per chat_id). Rate limit is per-chat, NOT per-topic.
4. `sendChatAction` ("typing") shares the same rate limit bucket as `sendMessage`/`editMessageText`.

## Design Decisions

- **Remove `sendMessageDraft` entirely** — not supported for supergroups
- **Simple FIFO queue** — no priority, no lanes. Whatever arrives first gets processed first.
- **3s min interval** between API calls (~20 calls/min, matching Telegram group limit)
- **Text coalesce per-session** — pending text items for the same session get replaced by newer content. Tool/system items never coalesced.
- **Text flush every 5s** — fixed interval, no adaptive complexity
- **Typing: once per prompt** — single `sendChatAction("typing")` when prompt received, not repeated. Direct call (not queued) to show immediate response.
- **Rate limit: reactive** — on 429, drop all pending text items from queue
- **Queue scope: session calls only** — one-off calls (topic creation, commands, skill pins) stay direct
- **Truncate during flush, split during finalize** — flush caps at 4090 chars + `...`, finalize splits into multiple messages
- **Finalize draft on new prompt** — fix existing bug where second prompt appends to first message

## Rate Limit Budget

Telegram limits for groups/supergroups (per chat_id, shared across ALL topics):

| Scope | Limit |
|-------|-------|
| Per chat (group/supergroup) | ~20 msg/min (~1 per 3s) |
| Per chat (private) | ~1 msg/sec |
| Global (per bot token) | ~30 msg/sec across all chats |

`sendMessage`, `editMessageText`, `editMessageReplyMarkup`, and `sendChatAction` all share the same per-chat bucket.

**Multi-session impact:** 10 concurrent sessions = ~1 text update per 30s per session. Slow but correct — no 429.

## Architecture

```
User sends prompt
    ↓
Adapter → sendChatAction("typing") DIRECT (1 time only)
    ↓
Agent events arrive
    ↓
TelegramAdapter.sendMessage()
    ├─ "text" → MessageDraft.append()
    │              └─ 5s timer → flush()
    │                  └─ sendQueue.enqueue(fn, { type: 'text', key: sessionId })
    │                      ↓ coalesce: replaces pending text for same session
    │
    ├─ "tool_call" / "tool_update" / "plan" / "usage" / "error" / "session_end"
    │   └─ sendQueue.enqueue(fn, { type: 'other' })
    │       ↓ never coalesced, always appended
    │
    └─ finalize() → cancel timer, send final content
                     └─ enqueue(fn, { type: 'other' }) per chunk

TelegramSendQueue (FIFO)
    ├─ Serial execution, 3s min interval
    ├─ Coalesce: text items with same key get replaced
    └─ On 429: drop all pending text items
```

## Flows

### Flow 1: User sends prompt

```
User sends message on Telegram
    → Adapter receives, routes to Core
    → Core creates/gets Session, calls agent.prompt()
    → Adapter finalizes existing draft (if any — fixes multi-prompt bug)
    → Adapter sends sendChatAction("typing") DIRECT (not queued)
    → User sees "Bot is typing..." in topic
    → Only sent once, not repeated
```

### Flow 2: Agent streams text

```
Agent sends text chunks: "Hello", " world", "!", " I'll", " help", ...
    → Adapter.sendMessage({ type: "text" }) called many times
    → MessageDraft.append(text) — accumulates in buffer
    ↓
5s timer fires → flush()
    ↓
Flush #1 (no messageId yet):
    → Convert buffer → HTML, truncate to 4090 + "..." if > 4096
    → sendQueue.enqueue(() => bot.api.sendMessage(...), { type: 'other' })
      ↑ type 'other' prevents coalescing — MUST execute to get messageId
    → flush() AWAITS the enqueue promise to capture messageId
    → Queue processes → Telegram returns Message → messageId stored
    → User sees first message appear in topic
    ↓
5s timer fires again → flush()
    ↓
Flush #2+ (has messageId):
    → Convert FULL buffer → HTML, truncate if needed
    → sendQueue.enqueue(() => bot.api.editMessageText(messageId, ...), { type: 'text', key: sessionId })
    → If queue already has pending text for this session → COALESCE (replace fn, old promise resolves undefined)
    → If not → append to queue
    → Queue processes → User sees message updated
    ↓
Agent finishes → finalize()
    → Cancel timer, await flushPromise (which awaits enqueue completion, including messageId capture)
    → Convert full buffer → HTML → splitMessage() if > 4096
    → Each chunk: sendQueue.enqueue(() => ..., { type: 'other' })
      ↑ type 'other' — final content must not be coalesced
    → Chunk 1: editMessageText if messageId exists, else sendMessage
    → Chunk 2+: sendMessage (new messages)
    → User sees complete message(s)
```

### Flow 3: Agent calls tool

```
Agent calls tool (e.g., Read file)
    → Adapter.sendMessage({ type: "tool_call" })
    → finalizeDraft() first (if draft is streaming)
    → sendQueue.enqueue(() => bot.api.sendMessage("🔧 Reading file..."), { type: 'other' })
    → Queue processes sequentially, 3s after previous item
    → User sees tool message appear
```

### Flow 4: Tool returns result

```
Tool completes
    → Adapter.sendMessage({ type: "tool_update" })
    → sendQueue.enqueue(() => bot.api.editMessageText(toolMsgId, "✅ Read file done"), { type: 'other' })
    → Queue processes sequentially
    → User sees tool message update 🔧 → ✅
```

### Flow 5: Plan / Usage / Error / Session end

```
Adapter.sendMessage({ type: "plan" | "usage" | "error" | "session_end" })
    → finalizeDraft() first (if draft exists)
    → sendQueue.enqueue(() => bot.api.sendMessage(...), { type: 'other' })
    → Queue processes sequentially
    → User sees message appear
```

### Flow 6: Coalescing in queue

```
Queue state: [tool_update_A, text(session-1), text(session-2)]

→ New text for session-1 arrives:
  Queue: [tool_update_A, text'(session-1), text(session-2)]
  (old text for session-1 replaced, its promise resolves undefined)

→ New text for session-2 arrives:
  Queue: [tool_update_A, text'(session-1), text'(session-2)]
  (old text for session-2 replaced)

→ New tool_update arrives:
  Queue: [tool_update_A, text'(session-1), text'(session-2), tool_update_D]
  (tool items NEVER coalesced, always appended)

→ New text for session-3 arrives (no existing text for session-3):
  Queue: [tool_update_A, text'(session-1), text'(session-2), tool_update_D, text(session-3)]
  (no match for key, appended normally)
```

### Flow 7: 429 Rate limit

```
Queue processes item → Telegram returns 429 (retryAfter: 10s)
    ↓
Retry transformer checks method:
    → If method in ['sendMessage', 'editMessageText', 'editMessageReplyMarkup']:
        → sendQueue.onRateLimited()
            → Remove ALL pending text items from queue
            → Resolve their promises with undefined
            → Tool/system items stay in queue
    → Wait retryAfter + 1s
    → Retry (max 3 times)
    ↓
After retry succeeds → queue continues with remaining items (tools/system)
    ↓
MessageDraft's next 5s flush will enqueue fresh text with full buffer
    → User still sees latest content, just delayed
```

### Flow 8: Multi-session (10 sessions)

```
10 sessions all streaming text + tool updates
    ↓
Queue example:
  [tool_1, text(s1), text(s2), tool_3, text(s3), text(s4), tool_5, ...]
    ↓
Processing: 1 item every 3s (FIFO order)
  → 0s:  tool_1 executes
  → 3s:  text(s1) executes — session 1 text updates
  → 6s:  text(s2) executes — session 2 text updates
  → 9s:  tool_3 executes
  → 12s: text(s3) executes
  ...
    ↓
Meanwhile, MessageDrafts keep appending text and flushing every 5s
  → If text(s1) still pending in queue → coalesce (replaced with fresh content)
  → If text(s1) already executed → new item appended
    ↓
Result per session: ~1 text update per 30s (10 sessions × 3s interval)
Slow but correct order, no 429, content always fresh thanks to coalescing
```

### Flow 9: Long text during flush (> 4096 chars)

```
Buffer has grown to 6000 chars during 5s interval
    ↓
flush() fires:
    → Convert buffer → HTML
    → HTML > 4096 → truncate to 4090 + "..."
    → Enqueue truncated version
    → User sees message ending with "..."
    ↓
Agent finishes → finalize()
    → Full buffer → HTML → splitMessage()
    → Chunk 1 (4096 chars): editMessageText on existing message
    → Chunk 2 (remaining): sendMessage as new message
    → User sees complete content across 2 messages
```

### Flow 10: New prompt while draft exists (bug fix)

```
Session has finished prompt 1, MessageDraft still in sessionDrafts map
    ↓
User sends prompt 2
    → Adapter receives new prompt
    → finalizeDraft(sessionId) — finalizes and removes old draft
    → sendChatAction("typing")
    → Agent starts responding
    → New MessageDraft created for prompt 2 with fresh messageId
    → User sees new message, not appended to old one
```

## Component Details

### 1. TelegramSendQueue (rewrite `send-queue.ts`)

**New API:**

```ts
type QueueItemType = 'text' | 'other'

class TelegramSendQueue {
  enqueue<T>(fn: () => Promise<T>, opts?: { type?: QueueItemType; key?: string }): Promise<T | undefined>
  onRateLimited(): void  // called by 429 retry transformer
}
```

Note: return type is `Promise<T | undefined>` — coalesced items resolve with `undefined`.

**Internal state:**

- `items: Array<{ fn, type, key?, resolve, reject }>` — pending items
- `processing: boolean` — whether an item is currently executing
- `lastExec: number` — timestamp of last execution

**Coalesce rules:**

1. `enqueue({ type: 'text', key })`: scan pending items for existing `text` item with same `key`
   - If found: replace its `fn`, resolve old promise with `undefined`
   - If not found: append normally
2. `enqueue({ type: 'other' })`: always append, never replace. `key` is ignored for `type: 'other'`.
3. Item currently executing is never coalesced or dropped (already in-flight)

**Execution:**

- Process items one at a time from front of array
- Min 3000ms between executions (Telegram group limit ~20/min)
- After processing an item, schedule next processing after interval

**429 reaction:**

- `onRateLimited()`: remove all pending items with `type: 'text'`, resolve their promises with `undefined`

### 2. MessageDraft (rewrite `streaming.ts`)

**Remove:** `sendMessageDraft`, `useFallback`, `draftUnsupportedChats`, `draftId`, `ChatType`, `chatType` param, optional sendQueue, `log` import.

**New constructor:**

```ts
constructor(
  bot: Bot,
  chatId: number,
  threadId: number,
  sendQueue: TelegramSendQueue,
  sessionId: string,  // used as coalesce key
)
```

**Fixed interval:** 5000ms (no adaptive complexity)

**State:**

- `buffer: string` — accumulated text
- `messageId?: number` — Telegram message ID after first sendMessage
- `firstFlushPending: boolean` — true while first flush is queued but not yet executed
- `flushTimer` — setTimeout handle
- `flushPromise` — serializes flushes (flush awaits enqueue completion before resolving)
- `sessionId: string` — coalesce key

**flush():**

1. If `firstFlushPending` is true → skip this flush (first flush not yet executed, buffer keeps accumulating, next timer will try again)
2. Convert buffer to HTML via `markdownToTelegramHtml()`
3. Truncate: if HTML > 4096 → slice to 4090 + `\n...`
4. If no `messageId`:
   - Set `firstFlushPending = true`
   - `result = await sendQueue.enqueue(() => bot.api.sendMessage(...), { type: 'other' })`
   - Store `messageId` from result, set `firstFlushPending = false`
   - Type `'other'` prevents coalescing — must execute to get messageId
5. If has `messageId`:
   - `result = await sendQueue.enqueue(() => bot.api.editMessageText(messageId, ...), { type: 'text', key: sessionId })`
   - If `result === undefined` → was coalesced, skip (no state update needed)
   - Coalesced items resolve with `undefined`, distinct from Telegram API responses (`Message` for sendMessage, `true` for editMessageText)

**Error handling in flush():**

- If `editMessageText` throws (e.g., message deleted by user) → reset `messageId = undefined`, next flush creates a new message
- If `sendMessage` throws → `firstFlushPending = false`, next flush will retry

**finalize():**

1. Cancel timer, await flushPromise (this ensures messageId is captured from first flush before proceeding)
2. If buffer empty → return messageId
3. Convert full buffer to HTML, split via `splitMessage()` if > 4096
4. Each chunk: `sendQueue.enqueue(() => ..., { type: 'other' })` — not coalesced
5. Chunk 1: editMessageText if messageId exists, else sendMessage
6. Chunk 2+: sendMessage
7. Return final messageId

### 3. Adapter changes (`adapter.ts`)

**Typing on prompt received:**

```ts
// In message handler, when routing user prompt to session:
await this.finalizeDraft(sessionId)  // fix: finalize old draft before new prompt
bot.api.sendChatAction(chatId, "typing", { message_thread_id: threadId })
  .catch(() => {})  // fire-and-forget, don't block on failure
```

Single call, not repeated. Direct (not queued).

Note: If Activity Tracker (PR #12) is merged, `sendChatAction` will be managed by `ActivityTracker.onNewPrompt()` instead. This spec's typing call serves as the baseline; Activity Tracker replaces it.

**sendMessage() event routing:**

| Event type    | Enqueue type | Key        |
|--------------|-------------|------------|
| `text`        | Via MessageDraft → first flush `other`, subsequent `text` | sessionId |
| `tool_call`   | `other`      | —          |
| `tool_update` | `other`      | —          |
| `plan`        | `other`      | —          |
| `usage`       | `other`      | —          |
| `session_end` | `other`      | —          |
| `error`       | `other`      | —          |

**MessageDraft construction:**

```ts
draft = new MessageDraft(
  this.bot,
  this.telegramConfig.chatId,
  threadId,
  this.sendQueue,
  sessionId,
)
```

**429 retry transformer update:**

```ts
// Only trigger for message-related methods (not getUpdates, setMyCommands, etc.)
const rateLimitedMethods = ['sendMessage', 'editMessageText', 'editMessageReplyMarkup']
if (result.error_code === 429 && rateLimitedMethods.includes(method)) {
  this.sendQueue.onRateLimited()
  // ... existing retry + wait logic
}
```

**Remove:**
- `chatType` / `'supergroup'` argument to MessageDraft
- `streamThrottleMs` usage
- `sendMessageDraft` related imports

### 4. Config changes (`types.ts`)

Remove `streamThrottleMs` from `TelegramChannelConfig`. Existing config files with this field are safe — Zod schema uses `.passthrough()`.

## Integration with Activity Tracker (PR #12)

PR #12 introduces ThinkingIndicator, PlanCard, and UsageMessage — all making Telegram API calls that share the same rate limit budget. When Activity Tracker is merged:

- **ThinkingIndicator** (send + delete): should go through send queue as `{ type: 'other' }`. Delete can be direct (rare, one-off).
- **PlanCard** (send + edit at 1.2s throttle): edits should go through send queue as `{ type: 'text', key: sessionId + ':plan' }` — coalescing plan edits per-session, same pattern as text streaming.
- **UsageMessage** (send + delete previous): send through queue as `{ type: 'other' }`. Delete previous can be direct.
- **Typing**: Activity Tracker's `sendChatAction("typing")` replaces this spec's direct typing call. Should remain direct (not queued) for immediate feedback.
- **`sessionTextBuffers`**: tracking in adapter for action detection remains unchanged by this spec.

The send queue design naturally supports these additional message types without changes — they just `enqueue()` with the appropriate type/key.

## Files Changed

| File | Change |
|------|--------|
| `src/adapters/telegram/send-queue.ts` | Rewrite: item array with type/key, coalesce per-session, 3s interval, 429 drop |
| `src/adapters/telegram/streaming.ts` | Rewrite: remove sendMessageDraft, 5s fixed interval, require sendQueue + sessionId, firstFlushPending guard |
| `src/adapters/telegram/adapter.ts` | Update: pass sessionId to MessageDraft, wire 429→queue, add typing on prompt, finalize draft on new prompt, remove chatType/streamThrottleMs |
| `src/adapters/telegram/types.ts` | Remove `streamThrottleMs` |

## Files NOT Changed

- `formatting.ts` — HTML conversion unchanged
- `commands.ts` — one-off calls stay direct
- `topics.ts` — one-off calls stay direct
- `permissions.ts` — one-off calls stay direct
- `action-detect.ts` — no streaming involvement, `sessionTextBuffers` unchanged
- `config.ts` — no schema changes needed (`.passthrough()` ignores extra fields)
- `activity.ts` — Activity Tracker (PR #12) integration is documented above but implemented separately
