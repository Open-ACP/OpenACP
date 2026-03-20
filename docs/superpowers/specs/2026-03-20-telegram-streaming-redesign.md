# Telegram Streaming Redesign — `sendMessageDraft` + Global Send Queue

**Date**: 2026-03-20
**Status**: Approved
**Approach**: B — `sendMessageDraft` for streaming + global send queue for non-streaming calls

## Problem

The current Telegram adapter hits 429 (Too Many Requests) rate limits because:

1. **Streaming uses `editMessageText`** — limited to ~20 edits/minute/chat in groups
2. **No global throttle** — tool_call, usage, session_end, notification all fire `sendMessage` independently
3. **Multiple concurrent sessions** — compound the burst problem

## Solution: 3-Layer Architecture

```
Layer 1: sendMessageDraft (streaming text)     → 200ms throttle, dedicated Telegram method
Layer 2: TelegramSendQueue (non-streaming)     → 100ms min interval between calls
Layer 3: Auto-retry transformer (fallback)     → Wait retry_after + retry up to 3 times
```

### Layer 1: MessageDraft → `sendMessageDraft`

**File**: `src/adapters/telegram/streaming.ts` (rewrite)

Replace the current `sendMessage` + `editMessageText` pattern with Telegram's native streaming method `sendMessageDraft` (Bot API 9.3+, available to all bots since Bot API 9.5).

**API signature** (from grammY 1.41.1):
```typescript
bot.api.sendMessageDraft(
  chat_id: number,
  draft_id: number,    // Client-supplied ID. Use a unique number per draft session.
  text: string,
  other?: {            // Optional params
    message_thread_id?: number,
    parse_mode?: string,
    entities?: MessageEntity[],
    link_preview_options?: LinkPreviewOptions,
    reply_parameters?: ReplyParameters,
    reply_markup?: InlineKeyboardMarkup,
  }
): Promise<true>       // Returns true on success, NOT a Message object
```

**Flow**:
1. `append(text)` → buffer text, schedule flush
2. `flush()`:
   - Generate a unique `draftId` per MessageDraft instance (e.g., `Date.now()` at construction time, or incrementing counter)
   - First call: `bot.api.sendMessageDraft(chatId, draftId, htmlText, { message_thread_id, parse_mode: 'HTML' })` → returns `true`, user sees draft appearing
   - Subsequent calls: `bot.api.sendMessageDraft(chatId, draftId, updatedHtmlText, { parse_mode: 'HTML' })` → updates the same draft in-place
3. `finalize()`: `bot.api.sendMessage(chatId, fullHtmlText, { message_thread_id, parse_mode: 'HTML' })` → replaces draft with permanent message. Then clear the draft by stopping updates.

**Key changes**:
- `minInterval`: 200ms (down from 2000ms) — `sendMessageDraft` has significantly higher rate limits than `editMessageText`
- Configurable via `streamThrottleMs` in telegram channel config
- `draftId` is client-supplied (number), generated once per MessageDraft instance
- Returns `true`, not a `Message` — no `message_id` is returned during streaming
- `parse_mode: 'HTML'` — keep existing HTML formatting pipeline (no change to `formatting.ts`)
- Truncation during streaming: same as current (4090 chars + `...`)
- `finalize()` split logic: same as current (splitMessage for content > 4096 chars)
- `finalize()` does NOT go through the send queue — it must execute promptly to replace the draft

**Fallback strategy**:
- If `sendMessageDraft` throws an error (any error), the MessageDraft instance sets a `useFallback` flag
- All subsequent flushes for that session fall back to the old `sendMessage` + `editMessageText` pattern
- Fallback interval increases to 1000ms (safe for editMessageText)
- Fallback path goes through the send queue (Layer 2) since editMessageText shares rate limits

**grammY support**: v1.41.1 (already installed) includes `bot.api.sendMessageDraft()`.

### Layer 2: Global Send Queue

**File**: `src/adapters/telegram/send-queue.ts` (new, ~50 LOC)

A simple promise-chain queue that enforces minimum interval between non-streaming Telegram API calls.

```typescript
export class TelegramSendQueue {
  private queue: Promise<void> = Promise.resolve()
  private minInterval: number

  constructor(minInterval = 100) {
    this.minInterval = minInterval
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto queue: wait minInterval, then execute fn
    // If fn throws, the queue continues (error does not stall the chain)
    // Return the result/error of fn to caller
  }
}
```

**Integration in adapter.ts**:
- Queue applies to: `tool_call` sendMessage, `tool_update` editMessageText, `usage` sendMessage, `session_end` sendMessage, `plan` sendMessage, `error` sendMessage, `notification` sendMessage, `sendPermissionRequest`, `sendSkillCommands`
- Queue does NOT apply to: `sendMessageDraft` (has its own higher rate limit), `getUpdates` (polling), `finalize()` sendMessage (must execute promptly)
- Adapter creates one `TelegramSendQueue` instance shared across all sessions

**Design tradeoffs acknowledged**:
- No priority queue — permission requests wait behind other messages. Acceptable because the queue drains fast (100ms intervals) and permission requests are not time-critical to the millisecond.
- No max queue depth / backpressure — if burst is extreme, queue grows. Auto-retry (Layer 3) handles any 429s that slip through. In practice, agent events are sequential within a session, so bursts are bounded.

### Layer 3: Auto-retry Transformer (already implemented)

**File**: `src/adapters/telegram/adapter.ts` (existing, lines 107-129)

grammY API transformer that catches 429 responses and retries after `retry_after + 1` seconds, up to 3 times. Applies to ALL API calls globally as a last-resort safety net.

No changes needed.

## Config Changes

### `src/adapters/telegram/types.ts`

Add optional field to `TelegramChannelConfig`:

```typescript
streamThrottleMs?: number  // Default: 200. Min interval between sendMessageDraft calls.
```

### `src/core/config.ts`

The current config uses `BaseChannelSchema.passthrough()` for telegram channel config — telegram-specific fields are not individually validated in Zod. Keep this pattern: add `streamThrottleMs` only to the TypeScript type in `types.ts`, relying on `.passthrough()` in Zod.

## Files Changed

| File | Change |
|------|--------|
| `src/adapters/telegram/streaming.ts` | Rewrite: use `sendMessageDraft`, 200ms interval, fallback to edit |
| `src/adapters/telegram/send-queue.ts` | New: global send queue (~50 LOC) |
| `src/adapters/telegram/adapter.ts` | Integrate queue for non-streaming calls |
| `src/adapters/telegram/types.ts` | Add `streamThrottleMs` to config type |

## Files NOT Changed

- `formatting.ts` — keep HTML formatting pipeline as-is, `sendMessageDraft` supports `parse_mode: 'HTML'`
- `topics.ts` — no changes to topic management
- `commands.ts` — no changes to command routing
- `permissions.ts` — no changes to permission handling
- `assistant.ts` — no changes to assistant logic
- `config.ts` — no Zod schema change needed (`.passthrough()` handles new field)

## Rollback Plan

If `sendMessageDraft` causes issues in production:
1. MessageDraft has built-in per-session fallback to `sendMessage` + `editMessageText` (activates automatically on error)
2. Auto-retry transformer handles any 429s from the fallback path
3. Can increase `streamThrottleMs` via config without code change

## Dependencies

- grammY >= 1.41.1 (already installed) — supports `bot.api.sendMessageDraft()`
- Telegram Bot API 9.5 (live since 2026-03-01) — `sendMessageDraft` available to all bots
