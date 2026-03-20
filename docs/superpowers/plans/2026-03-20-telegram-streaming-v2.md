# Telegram Streaming Redesign v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-03-20-telegram-streaming-v2.md`

**Goal:** Remove `sendMessageDraft`, rewrite streaming with a simple FIFO queue (3s interval, per-session text coalescing) to eliminate Telegram 429 rate limit errors in forum supergroups.

**Architecture:** Single FIFO queue serializes all session API calls at 3s intervals. Text edits coalesce per-session (newer content replaces pending edits for the same session). MessageDraft flushes every 5s with a `firstFlushPending` guard to prevent duplicate `sendMessage` calls.

**Tech Stack:** TypeScript, grammY (Telegram bot framework), Node.js ESM, vitest

---

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/adapters/telegram/send-queue.ts` | Rewrite | FIFO queue with type/key coalescing, 3s interval, 429 drop |
| `src/adapters/telegram/streaming.ts` | Rewrite | Text buffer + 5s flush via send queue, no sendMessageDraft |
| `src/adapters/telegram/adapter.ts` | Modify | Wire new queue/draft API, finalize on new prompt, typing, 429 hook |
| `src/adapters/telegram/types.ts` | Modify | Remove `streamThrottleMs` |
| `src/__tests__/send-queue.test.ts` | Create | Unit tests for TelegramSendQueue |
| `src/__tests__/streaming.test.ts` | Create | Unit tests for MessageDraft |

---

## Task 1: Rewrite TelegramSendQueue

**Files:**
- Create: `src/__tests__/send-queue.test.ts`
- Rewrite: `src/adapters/telegram/send-queue.ts`

- [ ] **Step 1: Write failing tests for basic FIFO queue**

```typescript
// src/__tests__/send-queue.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelegramSendQueue } from '../adapters/telegram/send-queue.js'

describe('TelegramSendQueue', () => {
  let queue: TelegramSendQueue

  beforeEach(() => {
    vi.useFakeTimers()
    queue = new TelegramSendQueue(100) // 100ms for fast tests
  })

  it('executes items in FIFO order', async () => {
    const order: number[] = []
    const p1 = queue.enqueue(async () => { order.push(1); return 'a' })
    const p2 = queue.enqueue(async () => { order.push(2); return 'b' })
    const p3 = queue.enqueue(async () => { order.push(3); return 'c' })

    // Process all items
    await vi.advanceTimersByTimeAsync(500)

    expect(await p1).toBe('a')
    expect(await p2).toBe('b')
    expect(await p3).toBe('c')
    expect(order).toEqual([1, 2, 3])
  })

  it('enforces minimum interval between executions', async () => {
    const timestamps: number[] = []
    queue.enqueue(async () => { timestamps.push(Date.now()) })
    queue.enqueue(async () => { timestamps.push(Date.now()) })
    queue.enqueue(async () => { timestamps.push(Date.now()) })

    await vi.advanceTimersByTimeAsync(500)

    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(100)
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/send-queue.test.ts`
Expected: FAIL — old TelegramSendQueue doesn't match new API

- [ ] **Step 3: Write the new TelegramSendQueue**

```typescript
// src/adapters/telegram/send-queue.ts
export type QueueItemType = 'text' | 'other'

interface QueueItem<T = unknown> {
  fn: () => Promise<T>
  type: QueueItemType
  key?: string
  resolve: (value: T | undefined) => void
  reject: (err: unknown) => void
}

export class TelegramSendQueue {
  private items: QueueItem[] = []
  private processing = false
  private lastExec = 0
  private minInterval: number

  constructor(minInterval = 3000) {
    this.minInterval = minInterval
  }

  enqueue<T>(
    fn: () => Promise<T>,
    opts?: { type?: QueueItemType; key?: string },
  ): Promise<T | undefined> {
    const type = opts?.type ?? 'other'
    const key = opts?.key

    return new Promise<T | undefined>((resolve, reject) => {
      // Coalesce: replace existing pending text item with same key
      if (type === 'text' && key) {
        const idx = this.items.findIndex(
          (item) => item.type === 'text' && item.key === key,
        )
        if (idx !== -1) {
          // Resolve old promise with undefined (skipped)
          this.items[idx].resolve(undefined)
          // Replace fn and promise
          this.items[idx] = { fn, type, key, resolve, reject } as QueueItem
          this.scheduleProcess()
          return
        }
      }

      this.items.push({ fn, type, key, resolve, reject } as QueueItem)
      this.scheduleProcess()
    })
  }

  onRateLimited(): void {
    // Drop all pending text items
    const remaining: QueueItem[] = []
    for (const item of this.items) {
      if (item.type === 'text') {
        item.resolve(undefined)
      } else {
        remaining.push(item)
      }
    }
    this.items = remaining
  }

  private scheduleProcess(): void {
    if (this.processing) return
    if (this.items.length === 0) return

    const elapsed = Date.now() - this.lastExec
    const delay = Math.max(0, this.minInterval - elapsed)

    this.processing = true
    setTimeout(() => void this.processNext(), delay)
  }

  private async processNext(): Promise<void> {
    const item = this.items.shift()
    if (!item) {
      this.processing = false
      return
    }

    try {
      const result = await item.fn()
      item.resolve(result)
    } catch (err) {
      item.reject(err)
    } finally {
      this.lastExec = Date.now()
      this.processing = false
      this.scheduleProcess()
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/send-queue.test.ts`
Expected: PASS

- [ ] **Step 5: Add coalescing tests**

Append to `src/__tests__/send-queue.test.ts`:

```typescript
  it('coalesces text items with same key', async () => {
    const calls: string[] = []
    queue.enqueue(async () => { calls.push('other-1') }, { type: 'other' })
    const p1 = queue.enqueue(async () => { calls.push('text-v1'); return 'v1' }, { type: 'text', key: 's1' })
    const p2 = queue.enqueue(async () => { calls.push('text-v2'); return 'v2' }, { type: 'text', key: 's1' })

    await vi.advanceTimersByTimeAsync(1000)

    // p1 was coalesced — resolved undefined
    expect(await p1).toBeUndefined()
    // p2 replaced p1 and executed
    expect(await p2).toBe('v2')
    // Only other-1 and text-v2 executed (text-v1 was replaced)
    expect(calls).toEqual(['other-1', 'text-v2'])
  })

  it('does not coalesce text items with different keys', async () => {
    const calls: string[] = []
    const p1 = queue.enqueue(async () => { calls.push('s1'); return 'a' }, { type: 'text', key: 's1' })
    const p2 = queue.enqueue(async () => { calls.push('s2'); return 'b' }, { type: 'text', key: 's2' })

    await vi.advanceTimersByTimeAsync(1000)

    expect(await p1).toBe('a')
    expect(await p2).toBe('b')
    expect(calls).toEqual(['s1', 's2'])
  })

  it('never coalesces other items', async () => {
    const calls: string[] = []
    queue.enqueue(async () => { calls.push('a') }, { type: 'other' })
    queue.enqueue(async () => { calls.push('b') }, { type: 'other' })
    queue.enqueue(async () => { calls.push('c') }, { type: 'other' })

    await vi.advanceTimersByTimeAsync(1000)

    expect(calls).toEqual(['a', 'b', 'c'])
  })
```

- [ ] **Step 6: Run tests**

Run: `pnpm test -- src/__tests__/send-queue.test.ts`
Expected: PASS

- [ ] **Step 7: Add 429 drop tests**

Append to `src/__tests__/send-queue.test.ts`:

```typescript
  it('onRateLimited drops all pending text items', async () => {
    const calls: string[] = []
    queue.enqueue(async () => { calls.push('other-1') }, { type: 'other' })
    const pText1 = queue.enqueue(async () => { calls.push('text-1'); return 't1' }, { type: 'text', key: 's1' })
    queue.enqueue(async () => { calls.push('other-2') }, { type: 'other' })
    const pText2 = queue.enqueue(async () => { calls.push('text-2'); return 't2' }, { type: 'text', key: 's2' })

    // Let first item start processing
    await vi.advanceTimersByTimeAsync(100)

    // Drop text items while queue is processing
    queue.onRateLimited()

    await vi.advanceTimersByTimeAsync(1000)

    expect(await pText1).toBeUndefined()
    expect(await pText2).toBeUndefined()
    // Only other items executed
    expect(calls).toContain('other-1')
    expect(calls).toContain('other-2')
    expect(calls).not.toContain('text-1')
    expect(calls).not.toContain('text-2')
  })
```

- [ ] **Step 8: Run tests**

Run: `pnpm test -- src/__tests__/send-queue.test.ts`
Expected: PASS

- [ ] **Step 9: Add error propagation and in-flight safety tests**

Append to `src/__tests__/send-queue.test.ts`:

```typescript
  it('propagates errors from fn to caller', async () => {
    const p = queue.enqueue(async () => { throw new Error('boom') })

    await vi.advanceTimersByTimeAsync(200)

    await expect(p).rejects.toThrow('boom')
  })

  it('onRateLimited does not affect currently executing item', async () => {
    let resolveFirst!: (v: string) => void
    const p1 = queue.enqueue(
      () => new Promise<string>(r => { resolveFirst = r }),
      { type: 'text', key: 's1' },
    )
    const p2 = queue.enqueue(async () => 'second', { type: 'text', key: 's2' })

    // Let first item start executing
    await vi.advanceTimersByTimeAsync(100)

    // Drop text items — first is in-flight, only second is pending
    queue.onRateLimited()

    // Second was dropped
    expect(await p2).toBeUndefined()

    // First still completes normally
    resolveFirst('first')
    await vi.advanceTimersByTimeAsync(100)
    expect(await p1).toBe('first')
  })
```

- [ ] **Step 10: Run tests**

Run: `pnpm test -- src/__tests__/send-queue.test.ts`
Expected: PASS

- [ ] **Step 11: Build check**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 12: Commit**

```bash
git add src/adapters/telegram/send-queue.ts src/__tests__/send-queue.test.ts
git commit -m "feat(telegram): rewrite TelegramSendQueue with coalescing and 3s interval"
```

---

## Task 2: Rewrite MessageDraft

**Files:**
- Create: `src/__tests__/streaming.test.ts`
- Rewrite: `src/adapters/telegram/streaming.ts`

- [ ] **Step 1: Write failing test for basic flush flow**

```typescript
// src/__tests__/streaming.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageDraft } from '../adapters/telegram/streaming.js'
import { TelegramSendQueue } from '../adapters/telegram/send-queue.js'

// Mock bot
function createMockBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
    },
  } as any
}

describe('MessageDraft', () => {
  let bot: ReturnType<typeof createMockBot>
  let queue: TelegramSendQueue
  let draft: MessageDraft

  beforeEach(() => {
    vi.useFakeTimers()
    bot = createMockBot()
    queue = new TelegramSendQueue(100)
    draft = new MessageDraft(bot, 123, 456, queue, 'session-1')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends first message via sendMessage after 5s', async () => {
    draft.append('hello')

    // Advance past 5s flush + queue interval
    await vi.advanceTimersByTimeAsync(6000)

    expect(bot.api.sendMessage).toHaveBeenCalledOnce()
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      123,
      expect.any(String),
      expect.objectContaining({
        message_thread_id: 456,
        parse_mode: 'HTML',
        disable_notification: true,
      }),
    )
  })

  it('edits message on subsequent flushes', async () => {
    draft.append('hello')

    // First flush: sendMessage
    await vi.advanceTimersByTimeAsync(6000)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()

    draft.append(' world')

    // Second flush: editMessageText
    await vi.advanceTimersByTimeAsync(6000)
    expect(bot.api.editMessageText).toHaveBeenCalledOnce()
    expect(bot.api.editMessageText).toHaveBeenCalledWith(
      123,
      42,
      expect.any(String),
      expect.objectContaining({ parse_mode: 'HTML' }),
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/streaming.test.ts`
Expected: FAIL — old MessageDraft constructor doesn't accept sessionId

- [ ] **Step 3: Write the new MessageDraft**

```typescript
// src/adapters/telegram/streaming.ts
import type { Bot } from 'grammy'
import { markdownToTelegramHtml, splitMessage } from './formatting.js'
import type { TelegramSendQueue } from './send-queue.js'

const FLUSH_INTERVAL = 5000

export class MessageDraft {
  private buffer: string = ''
  private messageId?: number
  private firstFlushPending = false
  private flushTimer?: ReturnType<typeof setTimeout>
  private flushPromise: Promise<void> = Promise.resolve()

  constructor(
    private bot: Bot,
    private chatId: number,
    private threadId: number,
    private sendQueue: TelegramSendQueue,
    private sessionId: string,
  ) {}

  append(text: string): void {
    this.buffer += text
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flushPromise = this.flushPromise
        .then(() => this.flush())
        .catch(() => {})
    }, FLUSH_INTERVAL)
  }

  private async flush(): Promise<void> {
    if (!this.buffer) return
    if (this.firstFlushPending) return // Wait for first sendMessage to complete

    const html = markdownToTelegramHtml(this.buffer)
    const truncated = html.length > 4096 ? html.slice(0, 4090) + '\n...' : html
    if (!truncated) return

    if (!this.messageId) {
      // First flush: must execute (type 'other' prevents coalescing)
      this.firstFlushPending = true
      try {
        const result = await this.sendQueue.enqueue(
          () => this.bot.api.sendMessage(this.chatId, truncated, {
            message_thread_id: this.threadId,
            parse_mode: 'HTML',
            disable_notification: true,
          }),
          { type: 'other' },
        )
        if (result) {
          this.messageId = result.message_id
        }
      } catch {
        // sendMessage failed — next flush will retry
      } finally {
        this.firstFlushPending = false
      }
    } else {
      // Subsequent flush: coalesced if pending text for this session exists
      try {
        const result = await this.sendQueue.enqueue(
          () => this.bot.api.editMessageText(this.chatId, this.messageId!, truncated, {
            parse_mode: 'HTML',
          }),
          { type: 'text', key: this.sessionId },
        )
        // result === undefined means coalesced (skipped)
        // result === true means edit succeeded — nothing to update
      } catch {
        // editMessageText failed (message deleted?) — reset messageId
        this.messageId = undefined
      }
    }
  }

  async finalize(): Promise<number | undefined> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }

    await this.flushPromise

    if (!this.buffer) return this.messageId

    const html = markdownToTelegramHtml(this.buffer)
    const chunks = splitMessage(html)

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        if (i === 0 && this.messageId) {
          await this.sendQueue.enqueue(
            () => this.bot.api.editMessageText(this.chatId, this.messageId!, chunk, {
              parse_mode: 'HTML',
            }),
            { type: 'other' },
          )
        } else {
          const msg = await this.sendQueue.enqueue(
            () => this.bot.api.sendMessage(this.chatId, chunk, {
              message_thread_id: this.threadId,
              parse_mode: 'HTML',
              disable_notification: true,
            }),
            { type: 'other' },
          )
          if (msg) {
            this.messageId = msg.message_id
          }
        }
      }
    } catch {
      // Finalize best-effort: try plaintext
      try {
        await this.sendQueue.enqueue(
          () => this.bot.api.sendMessage(this.chatId, this.buffer.slice(0, 4096), {
            message_thread_id: this.threadId,
            disable_notification: true,
          }),
          { type: 'other' },
        )
      } catch {
        // Give up
      }
    }

    return this.messageId
  }

  getMessageId(): number | undefined {
    return this.messageId
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- src/__tests__/streaming.test.ts`
Expected: PASS

- [ ] **Step 5: Add firstFlushPending guard test**

Append to `src/__tests__/streaming.test.ts`:

```typescript
  it('skips flush while first flush is pending', async () => {
    // Slow sendMessage to simulate queue backlog
    let resolveSend!: (v: any) => void
    bot.api.sendMessage.mockImplementation(() => new Promise(r => { resolveSend = r }))

    draft.append('hello')

    // First flush fires at 5s
    await vi.advanceTimersByTimeAsync(5100)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()

    // Append more text, another flush fires at 10s
    draft.append(' world')
    await vi.advanceTimersByTimeAsync(5100)

    // Should NOT have called sendMessage again (firstFlushPending = true)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()

    // Resolve first send
    resolveSend({ message_id: 42 })
    await vi.advanceTimersByTimeAsync(100)

    // Now next flush should use editMessageText
    draft.append('!')
    await vi.advanceTimersByTimeAsync(5100)
    expect(bot.api.editMessageText).toHaveBeenCalled()
  })
```

- [ ] **Step 6: Run tests**

Run: `pnpm test -- src/__tests__/streaming.test.ts`
Expected: PASS

- [ ] **Step 7: Add finalize test**

Append to `src/__tests__/streaming.test.ts`:

```typescript
  it('finalize sends complete content', async () => {
    draft.append('hello world')

    const messageId = await draft.finalize()

    // Should have sent via sendMessage (no prior flush)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()
    expect(messageId).toBe(42)
  })

  it('finalize edits existing message if already flushed', async () => {
    draft.append('hello')

    // Let first flush happen
    await vi.advanceTimersByTimeAsync(6000)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()

    draft.append(' world')
    const messageId = await draft.finalize()

    expect(bot.api.editMessageText).toHaveBeenCalled()
    expect(messageId).toBe(42)
  })
```

- [ ] **Step 8: Run tests**

Run: `pnpm test -- src/__tests__/streaming.test.ts`
Expected: PASS

- [ ] **Step 9: Add error recovery and edge case tests**

Append to `src/__tests__/streaming.test.ts`:

```typescript
  it('resets messageId when editMessageText fails', async () => {
    draft.append('hello')

    // First flush: sendMessage succeeds
    await vi.advanceTimersByTimeAsync(6000)
    expect(bot.api.sendMessage).toHaveBeenCalledOnce()

    // Make editMessageText fail (message deleted)
    bot.api.editMessageText.mockRejectedValueOnce(new Error('message not found'))

    draft.append(' world')
    await vi.advanceTimersByTimeAsync(6000)

    // Next flush should use sendMessage again (messageId was reset)
    bot.api.sendMessage.mockResolvedValueOnce({ message_id: 99 })
    draft.append('!')
    await vi.advanceTimersByTimeAsync(6000)

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('finalize with empty buffer returns messageId', async () => {
    // No append, no buffer
    const messageId = await draft.finalize()
    expect(messageId).toBeUndefined()
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })
```

- [ ] **Step 10: Run tests**

Run: `pnpm test -- src/__tests__/streaming.test.ts`
Expected: PASS

- [ ] **Step 11: Build check**

Run: `pnpm build`
Expected: Errors in adapter.ts (expected — old constructor calls). We'll fix adapter next.

- [ ] **Step 12: Commit**

```bash
git add src/adapters/telegram/streaming.ts src/__tests__/streaming.test.ts
git commit -m "feat(telegram): rewrite MessageDraft with 5s flush and send queue coalescing"
```

---

## Task 3: Remove `streamThrottleMs` from config

**Files:**
- Modify: `src/adapters/telegram/types.ts`

- [ ] **Step 1: Remove `streamThrottleMs` from TelegramChannelConfig**

In `src/adapters/telegram/types.ts`, remove line 7 (`streamThrottleMs?: number`):

```typescript
export interface TelegramChannelConfig {
  enabled: boolean
  botToken: string
  chatId: number
  notificationTopicId: number | null
  assistantTopicId: number | null
}
```

- [ ] **Step 2: Build check**

Run: `pnpm build`
Expected: Errors in adapter.ts (still using old MessageDraft constructor). Next task fixes this.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/telegram/types.ts
git commit -m "refactor(telegram): remove streamThrottleMs from config"
```

---

## Task 4: Update adapter.ts

**Files:**
- Modify: `src/adapters/telegram/adapter.ts`

This task wires together the new queue and MessageDraft. Multiple changes in one file.

- [ ] **Step 1: Update TelegramSendQueue constructor**

In `src/adapters/telegram/adapter.ts`, find `private sendQueue = new TelegramSendQueue()` (line 99) and update:

```typescript
private sendQueue = new TelegramSendQueue(3000)
```

- [ ] **Step 2: Update MessageDraft import and construction**

Find the import (line 14):
```typescript
import { MessageDraft } from "./streaming.js";
```

No change needed to import. But remove any `ChatType` import if present.

Find the MessageDraft construction in the `text` case (around lines 342-348). Replace:

```typescript
          draft = new MessageDraft(
            this.bot,
            this.telegramConfig.chatId,
            threadId,
            this.telegramConfig.streamThrottleMs,
            this.sendQueue,
            'supergroup',
          );
```

With:

```typescript
          draft = new MessageDraft(
            this.bot,
            this.telegramConfig.chatId,
            threadId,
            this.sendQueue,
            sessionId,
          );
```

- [ ] **Step 3: Add finalizeDraft on new prompt**

In `setupRoutes()`, find the session topic message handler (around line 305-315). Before forwarding the prompt to core, add finalizeDraft:

Find the block that handles session messages (around lines 305-315 where `ctx.replyWithChatAction("typing")` is called). Add `finalizeDraft` before the typing action:

```typescript
        // Finalize any existing draft before new prompt
        await this.finalizeDraft(session.id);
```

This goes before `ctx.replyWithChatAction("typing")`.

Similarly, in the assistant topic handler (around line 297-302), add the same before typing:

```typescript
        await this.finalizeDraft(this.assistantSession!.id);
```

- [ ] **Step 4: Wire 429 retry transformer to send queue**

Find the 429 retry transformer (lines 117-139). Inside the `if` block that checks for 429 (around line 122-128), add `onRateLimited` call:

```typescript
        const retryAfter =
          ((result as { parameters?: { retry_after?: number } }).parameters
            ?.retry_after ?? 5) + 1;

        // Drop pending text items on message-related 429
        const rateLimitedMethods = ['sendMessage', 'editMessageText', 'editMessageReplyMarkup'];
        if (rateLimitedMethods.includes(method)) {
          this.sendQueue.onRateLimited();
        }

        log.warn(
```

- [ ] **Step 5: Fix TypeScript narrowing for existing enqueue call sites**

The return type of `enqueue` changed from `Promise<T>` to `Promise<T | undefined>`. Existing call sites in adapter.ts that access the result need `if (result)` guards or `!` assertions.

Find all `sendQueue.enqueue` calls in adapter.ts that use the result (tool_call `sendMessage`, `sendPermissionRequest`, `sendNotification`, `sendSkillCommands`). These all use `{ type: 'other' }` so they will never be coalesced — add `!` non-null assertion:

For tool_call sendMessage result (around line 370-380), the result is used to get `msg.message_id`. Wrap:

```typescript
          const msg = (await this.sendQueue.enqueue(() =>
            this.bot.api.sendMessage(...),
            { type: 'other' },
          ))!;
```

Apply the same pattern to all other `enqueue` calls in adapter.ts that use the result value. Since these are all `type: 'other'`, they are never coalesced, so `!` assertion is safe.

- [ ] **Step 6: Build check**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 7: Run all tests**

Run: `pnpm test`
Expected: All pass (15/16, setup-integration may timeout as before)

- [ ] **Step 8: Commit**

```bash
git add src/adapters/telegram/adapter.ts
git commit -m "feat(telegram): wire new send queue and MessageDraft, add prompt finalization"
```

---

## Task 5: Cleanup and verify

- [ ] **Step 1: Verify no stale references**

Run: `grep -rn 'sendMessageDraft\|draftUnsupportedChats\|ChatType\|chatType.*supergroup\|streamThrottleMs' src/`

Expected: No matches in source files (only in docs/specs).

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: All pass

- [ ] **Step 3: Run full build**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 4: Commit cleanup if any stale references found**

```bash
git add -A
git commit -m "refactor(telegram): remove stale sendMessageDraft references"
```

---

## Task 6: Manual smoke test

- [ ] **Step 1: Start the bot**

Run: `pnpm start`

- [ ] **Step 2: Send a message in Telegram**

Send a prompt to the bot. Verify:
- Typing indicator appears once
- First text response appears after ~5-8s (5s flush + 3s queue)
- Text updates every ~5s during streaming
- Tool calls appear correctly
- No 429 errors in logs

- [ ] **Step 3: Test multi-session**

Open 2-3 sessions. Send prompts to each. Verify:
- All sessions get text updates (slower but working)
- No 429 errors
- Messages appear in correct topics

- [ ] **Step 4: Check logs**

Verify:
- No `sendMessageDraft` errors
- No `TEXTDRAFT_PEER_INVALID` errors
- No `Rate limited by Telegram` warnings during normal operation
