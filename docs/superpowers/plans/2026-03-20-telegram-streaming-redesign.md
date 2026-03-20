# Telegram Streaming Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `editMessageText`-based streaming with Telegram's native `sendMessageDraft` and add a global send queue to eliminate 429 rate limit errors.

**Architecture:** 3-layer defense — Layer 1: `sendMessageDraft` for streaming text (200ms throttle), Layer 2: global send queue for non-streaming calls (100ms interval), Layer 3: existing auto-retry transformer as fallback. Each layer is independent and can be tested separately.

**Tech Stack:** grammY 1.41.1, Telegram Bot API 9.5, TypeScript, ESM

**Spec:** `docs/superpowers/specs/2026-03-20-telegram-streaming-redesign.md`

---

### Task 1: Create TelegramSendQueue

**Files:**
- Create: `src/adapters/telegram/send-queue.ts`

- [ ] **Step 1: Create send-queue.ts**

```typescript
export class TelegramSendQueue {
  private queue: Promise<void> = Promise.resolve()
  private lastExec: number = 0
  private minInterval: number

  constructor(minInterval = 100) {
    this.minInterval = minInterval
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    let resolve: (value: T) => void
    let reject: (err: unknown) => void
    const resultPromise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })

    this.queue = this.queue.then(async () => {
      // Only delay if not enough time has passed since last execution
      const elapsed = Date.now() - this.lastExec
      if (elapsed < this.minInterval) {
        await new Promise((r) => setTimeout(r, this.minInterval - elapsed))
      }
      try {
        const result = await fn()
        resolve!(result)
      } catch (err) {
        reject!(err)
      } finally {
        this.lastExec = Date.now()
      }
    })

    return resultPromise
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/adapters/telegram/send-queue.ts
git commit -m "feat(telegram): add TelegramSendQueue for rate limit protection"
```

---

### Task 2: Add `streamThrottleMs` to config type

**Files:**
- Modify: `src/adapters/telegram/types.ts`

- [ ] **Step 1: Add streamThrottleMs field**

Add `streamThrottleMs?: number` to the end of the `TelegramChannelConfig` interface:

```typescript
export interface TelegramChannelConfig {
  enabled: boolean
  botToken: string
  chatId: number
  notificationTopicId: number | null
  assistantTopicId: number | null
  streamThrottleMs?: number
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/adapters/telegram/types.ts
git commit -m "feat(telegram): add streamThrottleMs config option"
```

---

### Task 3: Rewrite MessageDraft to use `sendMessageDraft`

**Files:**
- Modify: `src/adapters/telegram/streaming.ts`

- [ ] **Step 1: Rewrite streaming.ts**

Replace the entire file with:

```typescript
import type { Bot } from 'grammy'
import { markdownToTelegramHtml, splitMessage } from './formatting.js'
import type { TelegramSendQueue } from './send-queue.js'

let nextDraftId = 1

export class MessageDraft {
  private draftId: number
  private buffer: string = ''
  private lastFlush: number = 0
  private flushTimer?: ReturnType<typeof setTimeout>
  private flushPromise: Promise<void> = Promise.resolve()
  private minInterval: number
  private useFallback = false
  private messageId?: number  // Only set in fallback mode (sendMessageDraft returns true, not Message)

  constructor(
    private bot: Bot,
    private chatId: number,
    private threadId: number,
    throttleMs = 200,
    private sendQueue?: TelegramSendQueue,
  ) {
    this.draftId = nextDraftId++
    this.minInterval = throttleMs
  }

  append(text: string): void {
    this.buffer += text
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    const now = Date.now()
    const elapsed = now - this.lastFlush

    if (elapsed >= this.minInterval) {
      this.flushPromise = this.flushPromise.then(() => this.flush()).catch(() => {})
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined
        this.flushPromise = this.flushPromise.then(() => this.flush()).catch(() => {})
      }, this.minInterval - elapsed)
    }
  }

  private async flush(): Promise<void> {
    if (!this.buffer) return
    this.lastFlush = Date.now()

    const html = markdownToTelegramHtml(this.buffer)
    const truncated = html.length > 4096 ? html.slice(0, 4090) + '\n...' : html
    if (!truncated) return

    if (this.useFallback) {
      await this.flushFallback(truncated)
      return
    }

    try {
      await this.bot.api.sendMessageDraft(this.chatId, this.draftId, truncated, {
        message_thread_id: this.threadId,
        parse_mode: 'HTML',
      })
    } catch {
      // sendMessageDraft failed — switch to fallback for this session
      this.useFallback = true
      this.minInterval = 1000  // Slower interval for editMessageText
      await this.flushFallback(truncated)
    }
  }

  private async flushFallback(html: string): Promise<void> {
    // Route through send queue when available (fallback uses editMessageText which shares rate limits)
    const exec = this.sendQueue
      ? <T>(fn: () => Promise<T>) => this.sendQueue!.enqueue(fn)
      : <T>(fn: () => Promise<T>) => fn()

    try {
      if (!this.messageId) {
        const msg = await exec(() =>
          this.bot.api.sendMessage(this.chatId, html, {
            message_thread_id: this.threadId,
            parse_mode: 'HTML',
            disable_notification: true,
          }),
        )
        this.messageId = msg.message_id
      } else {
        await exec(() =>
          this.bot.api.editMessageText(this.chatId, this.messageId!, html, {
            parse_mode: 'HTML',
          }),
        )
      }
    } catch {
      try {
        if (!this.messageId) {
          const msg = await exec(() =>
            this.bot.api.sendMessage(this.chatId, this.buffer.slice(0, 4096), {
              message_thread_id: this.threadId,
              disable_notification: true,
            }),
          )
          this.messageId = msg.message_id
        }
      } catch {
        // Give up on this flush
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
          // Fallback mode only: messageId is only set when using sendMessage+editMessageText
          await this.bot.api.editMessageText(this.chatId, this.messageId, chunk, {
            parse_mode: 'HTML',
          })
        } else {
          // sendMessage replaces the draft (non-fallback) or creates new message (fallback/splits)
          const msg = await this.bot.api.sendMessage(this.chatId, chunk, {
            message_thread_id: this.threadId,
            parse_mode: 'HTML',
            disable_notification: true,
          })
          this.messageId = msg.message_id
        }
      }
    } catch {
      try {
        await this.bot.api.sendMessage(this.chatId, this.buffer.slice(0, 4096), {
          message_thread_id: this.threadId,
          disable_notification: true,
        })
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

- [ ] **Step 2: Verify it compiles**

Run: `pnpm build`
Expected: No errors. If `sendMessageDraft` types are not recognized, check grammY version with `node -e "console.log(require('./node_modules/grammy/package.json').version)"` — must be >= 1.41.1.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/telegram/streaming.ts
git commit -m "feat(telegram): rewrite MessageDraft to use sendMessageDraft with fallback"
```

---

### Task 4: Integrate send queue into adapter

**Files:**
- Modify: `src/adapters/telegram/adapter.ts`

- [ ] **Step 1: Add import and instance**

Add import at the top of adapter.ts (after the existing imports):

```typescript
import { TelegramSendQueue } from './send-queue.js'
```

Add field to `TelegramAdapter` class (after the `skillMessages` field):

```typescript
  private sendQueue = new TelegramSendQueue()
```

- [ ] **Step 2: Update MessageDraft construction to pass `streamThrottleMs` and `sendQueue`**

In the `case "text"` block, change the MessageDraft constructor call from:

```typescript
          draft = new MessageDraft(
            this.bot,
            this.telegramConfig.chatId,
            threadId,
          );
```

to:

```typescript
          draft = new MessageDraft(
            this.bot,
            this.telegramConfig.chatId,
            threadId,
            this.telegramConfig.streamThrottleMs,
            this.sendQueue,
          );
```

- [ ] **Step 3: Wrap `tool_call` sendMessage with queue**

In the `case "tool_call"` block, change:

```typescript
        const msg = await this.bot.api.sendMessage(
          this.telegramConfig.chatId,
          formatToolCall(meta),
          {
            message_thread_id: threadId,
            parse_mode: "HTML",
            disable_notification: true,
          },
        );
```

to:

```typescript
        const msg = await this.sendQueue.enqueue(() =>
          this.bot.api.sendMessage(
            this.telegramConfig.chatId,
            formatToolCall(meta),
            {
              message_thread_id: threadId,
              parse_mode: "HTML",
              disable_notification: true,
            },
          ),
        );
```

- [ ] **Step 4: Wrap `tool_update` editMessageText with queue**

In the `case "tool_update"` block, change:

```typescript
            await this.bot.api.editMessageText(
              this.telegramConfig.chatId,
              toolState.msgId,
              formatToolUpdate(merged),
              { parse_mode: "HTML" },
            );
```

to:

```typescript
            await this.sendQueue.enqueue(() =>
              this.bot.api.editMessageText(
                this.telegramConfig.chatId,
                toolState.msgId,
                formatToolUpdate(merged),
                { parse_mode: "HTML" },
              ),
            );
```

- [ ] **Step 5: Wrap `plan` sendMessage with queue**

In the `case "plan"` block, wrap the entire `this.bot.api.sendMessage(...)` call:

```typescript
        await this.sendQueue.enqueue(() =>
          this.bot.api.sendMessage(
            this.telegramConfig.chatId,
            formatPlan(
              content.metadata as never as {
                entries: Array<{ content: string; status: string }>;
              },
            ),
            {
              message_thread_id: threadId,
              parse_mode: "HTML",
              disable_notification: true,
            },
          ),
        );
```

- [ ] **Step 6: Wrap `usage` sendMessage with queue**

In the `case "usage"` block, wrap similarly:

```typescript
        await this.sendQueue.enqueue(() =>
          this.bot.api.sendMessage(
            this.telegramConfig.chatId,
            formatUsage(
              content.metadata as never as {
                tokensUsed?: number;
                contextSize?: number;
                cost?: { amount: number; currency: string };
              },
            ),
            {
              message_thread_id: threadId,
              parse_mode: "HTML",
              disable_notification: true,
            },
          ),
        );
```

- [ ] **Step 7: Wrap `session_end` sendMessage with queue**

In the `case "session_end"` block, change:

```typescript
        await this.bot.api.sendMessage(
          this.telegramConfig.chatId,
          `✅ <b>Done</b>`,
          {
            message_thread_id: threadId,
            parse_mode: "HTML",
            disable_notification: true,
          },
        );
```

to:

```typescript
        await this.sendQueue.enqueue(() =>
          this.bot.api.sendMessage(
            this.telegramConfig.chatId,
            `✅ <b>Done</b>`,
            {
              message_thread_id: threadId,
              parse_mode: "HTML",
              disable_notification: true,
            },
          ),
        );
```

- [ ] **Step 8: Wrap `error` sendMessage with queue**

In the `case "error"` block, change:

```typescript
        await this.bot.api.sendMessage(
          this.telegramConfig.chatId,
          `❌ <b>Error:</b> ${escapeHtml(content.text)}`,
          {
            message_thread_id: threadId,
            parse_mode: "HTML",
            disable_notification: true,
          },
        );
```

to:

```typescript
        await this.sendQueue.enqueue(() =>
          this.bot.api.sendMessage(
            this.telegramConfig.chatId,
            `❌ <b>Error:</b> ${escapeHtml(content.text)}`,
            {
              message_thread_id: threadId,
              parse_mode: "HTML",
              disable_notification: true,
            },
          ),
        );
```

- [ ] **Step 9: Wrap `sendNotification` with queue**

In the `sendNotification` method, change:

```typescript
    await this.bot.api.sendMessage(this.telegramConfig.chatId, text, {
      message_thread_id: this.notificationTopicId,
      parse_mode: "HTML",
      disable_notification: false,
    });
```

to:

```typescript
    await this.sendQueue.enqueue(() =>
      this.bot.api.sendMessage(this.telegramConfig.chatId, text, {
        message_thread_id: this.notificationTopicId,
        parse_mode: "HTML",
        disable_notification: false,
      }),
    );
```

- [ ] **Step 10: Wrap `sendSkillCommands` API calls with queue**

In the `sendSkillCommands` method, wrap the `sendMessage` call in the "Create and pin new message" section. Change:

```typescript
      const msg = await this.bot.api.sendMessage(
        this.telegramConfig.chatId,
        text,
        {
          message_thread_id: threadId,
          parse_mode: "HTML",
          reply_markup: keyboard,
          disable_notification: true,
        },
      );
```

to:

```typescript
      const msg = await this.sendQueue.enqueue(() =>
        this.bot.api.sendMessage(
          this.telegramConfig.chatId,
          text,
          {
            message_thread_id: threadId,
            parse_mode: "HTML",
            reply_markup: keyboard,
            disable_notification: true,
          },
        ),
      );
```

- [ ] **Step 11: Wrap `sendPermissionRequest` with queue**

In the `sendPermissionRequest` method, change:

```typescript
    await this.permissionHandler.sendPermissionRequest(session, request);
```

to:

```typescript
    await this.sendQueue.enqueue(() =>
      this.permissionHandler.sendPermissionRequest(session, request),
    );
```

- [ ] **Step 12: Verify it compiles**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 13: Commit**

```bash
git add src/adapters/telegram/adapter.ts
git commit -m "feat(telegram): integrate send queue for all non-streaming API calls"
```

---

### Task 5: Build and smoke test

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: Clean build, no errors

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: All existing tests pass

- [ ] **Step 3: Commit all remaining changes (if any)**

```bash
git add -A
git commit -m "chore: telegram streaming redesign — build verified"
```
