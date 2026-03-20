# Activity Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic Working Card with purpose-specific, independent messages (ThinkingIndicator, PlanCard, UsageMessage) that avoid Telegram's 4096-char limit, eliminate race conditions, and preserve tool call history.

**Architecture:** Each message type has one responsibility and its own lifecycle. `ActivityTracker` is a thin coordinator that manages only the new message types — `sessionDrafts`, `toolCallMessages`, and `MessageDraft` in `adapter.ts` remain unchanged. The `extractToolLabel` standalone function is replaced by a `compact` mode on `formatToolCall`.

**Tech Stack:** TypeScript, grammY (Telegram bot framework), Node.js ESM

---

## File Map

| File | Change |
|---|---|
| `src/adapters/telegram/activity.ts` | Full rewrite — ThinkingIndicator, PlanCard, UsageMessage, ActivityTracker |
| `src/adapters/telegram/formatting.ts` | Add `compact` mode to `formatToolCall`, add `extractCompactLabel` helper |
| `src/adapters/telegram/adapter.ts` | Update wiring: new ActivityTracker interface, fix MessageDraft bug, remove stale PlanEntryStatus alias |

---

## Pre-work: Verify session_end metadata shape

Before writing any code, verify whether `session_end` events carry usage data (tokensUsed/contextSize/cost) or whether usage only arrives via the separate `usage` event.

**Files:**
- Read: `src/core/channel.ts`
- Read: `src/core/agent-instance.ts`

- [ ] **Step 1: Check OutgoingMessage types**

```bash
grep -n "session_end\|usage\|OutgoingMessage" /Users/hieu/Documents/Companies/Lab3/opensource/OpenACP/src/core/channel.ts | head -30
```

- [ ] **Step 2: Check agent-instance event emission**

```bash
grep -n "session_end\|usage" /Users/hieu/Documents/Companies/Lab3/opensource/OpenACP/src/core/agent-instance.ts | head -30
```

- [ ] **Step 3: Decide usage strategy**

If `session_end` carries usage metadata → usage is sent via `onComplete(usageMeta)`, and the separate `usage` case in `adapter.ts` can be removed.

If usage only comes via the separate `usage` event → keep the `usage` case in `adapter.ts` unchanged. `onComplete()` is called with no usage arg, and `UsageMessage.send()` is called from the `usage` case instead.

Record the decision here before proceeding to Task 1.

---

## Task 1: Add `compact` mode to `formatToolCall` in formatting.ts

Replaces the separate `extractToolLabel` function currently in `activity.ts`.

**Files:**
- Modify: `src/adapters/telegram/formatting.ts`

- [ ] **Step 1: Add `extractCompactLabel` helper and `compact` mode to `formatToolCall`**

In `formatting.ts`, add the helper function and update `formatToolCall`. Place the helper above `formatToolCall`:

```typescript
function extractCompactLabel(name: string, content: unknown, depth = 0): string {
  if (!content || depth > 2) return name
  if (typeof content === 'string') {
    const t = content.trim()
    return t.length > 0 ? (t.length > 55 ? t.slice(0, 55) + '…' : t) : name
  }
  if (typeof content === 'object' && content !== null) {
    const c = content as Record<string, unknown>
    const value =
      c.query ?? c.command ?? c.path ?? c.file_path ??
      c.url ?? c.input ?? c.text ?? c.prompt
    if (typeof value === 'string' && value.trim().length > 0) {
      const v = value.trim()
      return `"${v.length > 55 ? v.slice(0, 55) + '…' : v}"`
    }
    if (c.input && typeof c.input === 'object') {
      return extractCompactLabel(name, c.input, depth + 1)
    }
  }
  return name
}
```

Update `formatToolCall` signature to accept optional `mode`:

```typescript
export function formatToolCall(
  tool: {
    id: string
    name?: string
    kind?: string
    status?: string
    content?: unknown
    viewerLinks?: { file?: string; diff?: string }
  },
  mode: 'full' | 'compact' = 'full',
): string {
  if (mode === 'compact') {
    const si = STATUS_ICON[tool.status || ''] || '⏳'
    const ki = KIND_ICON[tool.kind || ''] || '🔧'
    const label = extractCompactLabel(tool.name || 'tool', tool.content)
    return `${si} ${ki} ${escapeHtml(label)}`
  }
  // full mode — existing implementation unchanged below
  const si = STATUS_ICON[tool.status || ''] || '🔧'
  const ki = KIND_ICON[tool.kind || ''] || '🛠️'
  let text = `${si} ${ki} <b>${escapeHtml(tool.name || 'Tool')}</b>`
  const details = extractContentText(tool.content)
  if (details) {
    text += `\n<pre>${escapeHtml(truncateContent(details))}</pre>`
  }
  text += formatViewerLinks(tool.viewerLinks)
  return text
}
```

- [ ] **Step 2: Build to verify formatting.ts has no errors**

```bash
cd /Users/hieu/Documents/Companies/Lab3/opensource/OpenACP && pnpm build 2>&1 | grep "formatting"
```

Expected: no errors from `formatting.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/telegram/formatting.ts
git commit -m "feat(telegram): add compact mode to formatToolCall, extract label helper"
```

---

## Task 2: Rewrite activity.ts

Full rewrite replacing Working Card + ThoughtMessage with ThinkingIndicator + PlanCard + UsageMessage + ActivityTracker coordinator.

**Files:**
- Modify: `src/adapters/telegram/activity.ts`

- [ ] **Step 1: Replace file with new imports, constants, and types**

```typescript
import { InlineKeyboard } from 'grammy'
import type { Bot } from 'grammy'
import { escapeHtml } from './formatting.js'

// ── Constants ──────────────────────────────────────────────────────────────

const PLAN_ICON: Record<string, string> = {
  pending: '◻',
  in_progress: '▶',
  completed: '✅',
  failed: '❌',
}

const PLAN_FLUSH_INTERVAL_MS = 1200
const TYPING_INTERVAL_MS = 4500

// ── Types ──────────────────────────────────────────────────────────────────

export interface PlanEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}
```

Note: `formatToolCall` import is removed — compact labels are not used inside `activity.ts`. Only `escapeHtml` is needed.

- [ ] **Step 2: Add ThinkingIndicator class**

```typescript
// ── ThinkingIndicator ──────────────────────────────────────────────────────

/**
 * A temporary static "💭 Thinking..." message.
 * Sent when the agent starts a thinking phase, deleted when it moves on.
 */
class ThinkingIndicator {
  private messageId?: number
  private sending?: Promise<void>

  constructor(
    private bot: Bot,
    private chatId: number,
    private threadId: number,
  ) {}

  send(): void {
    if (this.messageId || this.sending) return
    this.sending = this.bot.api
      .sendMessage(this.chatId, '💭 <i>Thinking...</i>', {
        message_thread_id: this.threadId,
        parse_mode: 'HTML',
        disable_notification: true,
      })
      .then((msg) => {
        this.messageId = msg.message_id
      })
      .catch(() => {})
  }

  async delete(): Promise<void> {
    await this.sending
    if (!this.messageId) return
    const id = this.messageId
    this.messageId = undefined
    await this.bot.api.deleteMessage(this.chatId, id).catch(() => {})
  }
}
```

- [ ] **Step 3: Add PlanCard class**

```typescript
// ── PlanCard ───────────────────────────────────────────────────────────────

/**
 * A persistent plan checklist message with Cancel/Stop button.
 * Created on first plan event, edited in-place as entries update,
 * finalized (button removed) when the session ends.
 */
class PlanCard {
  private messageId?: number
  private entries: PlanEntry[] = []
  private lastFlush = 0
  private flushTimer?: ReturnType<typeof setTimeout>
  private flushPromise: Promise<void> = Promise.resolve()
  private cancelled = false

  constructor(
    private bot: Bot,
    private chatId: number,
    private threadId: number,
    private sessionId: string,
  ) {}

  async send(entries: PlanEntry[]): Promise<void> {
    this.entries = [...entries]
    try {
      const msg = await this.bot.api.sendMessage(
        this.chatId,
        this._buildText(),
        {
          message_thread_id: this.threadId,
          parse_mode: 'HTML',
          disable_notification: true,
          reply_markup: this._buildKeyboard(),
        },
      )
      this.messageId = msg.message_id
      this.lastFlush = Date.now()
    } catch {
      /* continue without plan card */
    }
  }

  update(entries: PlanEntry[]): void {
    this.entries = [...entries]
    this._scheduleFlush()
  }

  async finalize(cancelled = false): Promise<void> {
    this.cancelled = cancelled
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    await this.flushPromise
    if (!this.messageId) return
    try {
      await this.bot.api.editMessageText(
        this.chatId,
        this.messageId,
        this._buildText(),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
      )
    } catch { /* best effort */ }
  }

  private _buildText(): string {
    if (this.cancelled) {
      return '🛑 <i>Cancelled</i>'
    }
    const total = this.entries.length
    const completed = this.entries.filter((e) => e.status === 'completed').length
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0
    const filled = Math.round(pct / 10)
    const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled)
    const progressLine = `${bar} ${pct}% · ${completed}/${total}`
    const lines = this.entries.map((e) => {
      const icon = PLAN_ICON[e.status] ?? '◻'
      return `${icon} ${escapeHtml(e.content)}`
    })
    return `📋 <b>Plan</b>\n${progressLine}\n${lines.join('\n')}`
  }

  private _buildKeyboard(): InstanceType<typeof InlineKeyboard> {
    const hasActive = this.entries.some((e) => e.status === 'in_progress')
    const label = hasActive ? '⏹ Stop' : '🛑 Cancel'
    const action = hasActive ? 'stop' : 'cancel'
    return new InlineKeyboard().text(label, `a:${action}:${this.sessionId}`)
  }

  private _scheduleFlush(): void {
    const elapsed = Date.now() - this.lastFlush
    if (elapsed >= PLAN_FLUSH_INTERVAL_MS) {
      this.flushPromise = this.flushPromise
        .then(() => this._flush())
        .catch(() => {})
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined
        this.flushPromise = this.flushPromise
          .then(() => this._flush())
          .catch(() => {})
      }, PLAN_FLUSH_INTERVAL_MS - elapsed)
    }
  }

  private async _flush(): Promise<void> {
    if (!this.messageId) return
    this.lastFlush = Date.now()
    try {
      await this.bot.api.editMessageText(
        this.chatId,
        this.messageId,
        this._buildText(),
        { parse_mode: 'HTML', reply_markup: this._buildKeyboard() },
      )
    } catch { /* rate-limited or unchanged */ }
  }
}
```

- [ ] **Step 4: Add UsageMessage class**

```typescript
// ── UsageMessage ───────────────────────────────────────────────────────────

/**
 * Rolling usage stats message. At most one per session at a time.
 * Previous message is deleted when a new prompt starts.
 */
export class UsageMessage {
  private messageId?: number

  constructor(
    private bot: Bot,
    private chatId: number,
    private threadId: number,
  ) {}

  async send(usage: {
    tokensUsed?: number
    contextSize?: number
    cost?: { amount: number; currency: string }
  }): Promise<void> {
    const lines: string[] = []
    if (usage.contextSize != null && usage.tokensUsed != null) {
      const pct = Math.round((usage.tokensUsed / usage.contextSize) * 100)
      const filled = Math.min(10, Math.round(pct / 10))
      const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled)
      const warning = pct >= 85 ? ' ⚠️' : ''
      lines.push(`${bar} ${pct}% context${warning}`)
      const tokenLine = `${usage.tokensUsed.toLocaleString()} / ${usage.contextSize.toLocaleString()} tokens`
      lines.push(usage.cost ? `${tokenLine} · $${usage.cost.amount.toFixed(4)}` : tokenLine)
    } else if (usage.tokensUsed != null) {
      const tokenLine = `${usage.tokensUsed.toLocaleString()} tokens`
      lines.push(usage.cost ? `${tokenLine} · $${usage.cost.amount.toFixed(4)}` : tokenLine)
    }
    if (lines.length === 0) return
    try {
      const msg = await this.bot.api.sendMessage(
        this.chatId,
        `📊 Usage\n${lines.join('\n')}`,
        {
          message_thread_id: this.threadId,
          disable_notification: true,
        },
      )
      this.messageId = msg.message_id
    } catch { /* best effort */ }
  }

  async deletePrevious(): Promise<void> {
    if (!this.messageId) return
    const id = this.messageId
    this.messageId = undefined
    await this.bot.api.deleteMessage(this.chatId, id).catch(() => {})
  }
}
```

- [ ] **Step 5: Add ActivityTracker coordinator class**

```typescript
// ── ActivityTracker ────────────────────────────────────────────────────────

/**
 * Coordinates ThinkingIndicator, PlanCard, and UsageMessage.
 * Does NOT manage sessionDrafts or toolCallMessages — those remain in adapter.ts.
 */
export class ActivityTracker {
  private thinkingIndicator: ThinkingIndicator
  private planCard?: PlanCard
  private usageMessage: UsageMessage
  private typingInterval?: ReturnType<typeof setInterval>

  constructor(
    private bot: Bot,
    private chatId: number,
    private threadId: number,
    private sessionId: string,
    private onCancel: () => Promise<void>,
  ) {
    this.thinkingIndicator = new ThinkingIndicator(bot, chatId, threadId)
    this.usageMessage = new UsageMessage(bot, chatId, threadId)

    this.typingInterval = setInterval(() => {
      this.bot.api
        .sendChatAction(this.chatId, 'typing', {
          message_thread_id: this.threadId,
        } as Parameters<typeof this.bot.api.sendChatAction>[2])
        .catch(() => {})
    }, TYPING_INTERVAL_MS)
  }

  /** Called on each thought chunk — shows static Thinking indicator if not present. */
  onThought(): void {
    this.thinkingIndicator.send()
  }

  /** Called on plan event — creates/updates PlanCard, deletes Thinking indicator. */
  async onPlan(entries: PlanEntry[]): Promise<void> {
    await this.thinkingIndicator.delete()
    if (!this.planCard) {
      this.planCard = new PlanCard(
        this.bot,
        this.chatId,
        this.threadId,
        this.sessionId,
      )
      await this.planCard.send(entries)
    } else {
      this.planCard.update(entries)
    }
  }

  /** Called on tool_call event — deletes Thinking indicator. */
  async onToolCall(): Promise<void> {
    await this.thinkingIndicator.delete()
  }

  /** Called on tool_update event — no-op in current design (tool messages managed by adapter). */
  onToolUpdate(_id: string, _status: string): void {
    // Future: update plan card entry status if Phase 3 mapping is implemented
  }

  /** Called on first text chunk — deletes Thinking indicator, stops typing. */
  async onTextStart(): Promise<void> {
    await this.thinkingIndicator.delete()
    this._stopTyping()
  }

  /**
   * Called on session_end — finalizes PlanCard, sends Usage if data provided.
   * Pass usage data if session_end event carries it; otherwise pass undefined
   * and send usage from the separate 'usage' event handler in adapter.ts.
   */
  async onComplete(usage?: {
    tokensUsed?: number
    contextSize?: number
    cost?: { amount: number; currency: string }
  }): Promise<void> {
    await this.thinkingIndicator.delete()
    this._stopTyping()
    if (this.planCard) {
      await this.planCard.finalize()
    }
    if (usage) {
      await this.usageMessage.send(usage)
    }
  }

  /** Called when a new prompt starts processing — rolls (deletes) previous usage message. */
  async onNewPrompt(): Promise<void> {
    await this.usageMessage.deletePrevious()
  }

  /** Send usage stats — called from adapter's 'usage' event handler if usage arrives separately. */
  async sendUsage(usage: {
    tokensUsed?: number
    contextSize?: number
    cost?: { amount: number; currency: string }
  }): Promise<void> {
    await this.usageMessage.send(usage)
  }

  /** Called when user presses Cancel or Stop. */
  async handleCancel(): Promise<void> {
    this._stopTyping()
    await this.thinkingIndicator.delete()
    if (this.planCard) {
      await this.planCard.finalize(true)
    }
    await this.onCancel()
  }

  /** Cleanup — called on session destroy or error. */
  destroy(): void {
    this._stopTyping()
    this.thinkingIndicator.delete().catch(() => {})
  }

  private _stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval)
      this.typingInterval = undefined
    }
  }
}
```

- [ ] **Step 6: Build to check for errors in activity.ts**

```bash
cd /Users/hieu/Documents/Companies/Lab3/opensource/OpenACP && pnpm build 2>&1 | grep -E "activity\.ts|error TS"
```

Expected: errors only from `adapter.ts` referencing the old `ActivityTracker` API — those are fixed in Task 3.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/telegram/activity.ts
git commit -m "feat(telegram): rewrite ActivityTracker with ThinkingIndicator, PlanCard, UsageMessage"
```

---

## Task 3: Update adapter.ts wiring

Update `adapter.ts` to use the new `ActivityTracker` interface. All steps must be applied as a single edit to `adapter.ts` to avoid intermediate build errors.

**Files:**
- Modify: `src/adapters/telegram/adapter.ts`

- [ ] **Step 1: Make `getOrCreateTracker` synchronous (do this first)**

The new `ActivityTracker` constructor starts the typing interval directly — no async `initialize()` needed.

Find `getOrCreateTracker` (~line 625). Replace the entire method:

```typescript
private getOrCreateTracker(sessionId: string, threadId: number): ActivityTracker {
  let tracker = this.activityTrackers.get(sessionId)
  if (!tracker) {
    tracker = new ActivityTracker(
      this.bot,
      this.telegramConfig.chatId,
      threadId,
      sessionId,
      async () => {
        const session = (this.core as OpenACPCore).sessionManager.getSession(sessionId)
        await session?.cancel()
      },
    )
    this.activityTrackers.set(sessionId, tracker)
  }
  return tracker
}
```

- [ ] **Step 2: Update imports — add PlanEntry, remove unused items**

At the top of `adapter.ts`, update the import from `./activity.js`:

```typescript
import { ActivityTracker, type PlanEntry } from './activity.js'
```

- [ ] **Step 3: Delete the local `PlanEntryStatus` type alias**

At the bottom of `adapter.ts` (~line 660), delete:

```typescript
// DELETE THIS:
type PlanEntryStatus = "pending" | "in_progress" | "completed";
```

- [ ] **Step 4: Update `thought` handler**

Old:
```typescript
case 'thought': {
  const tracker = await this.getOrCreateTracker(sessionId, threadId)
  tracker.onThought(content.text)
  break
}
```

New:
```typescript
case 'thought': {
  const tracker = this.getOrCreateTracker(sessionId, threadId)
  tracker.onThought()
  break
}
```

- [ ] **Step 5: Update `tool_call` handler**

Old:
```typescript
const tracker = await this.getOrCreateTracker(sessionId, threadId)
await tracker.onToolCall(meta.name, meta.kind, meta.content)
```

New:
```typescript
// Finalize any leftover draft from a previous text-only response
await this.finalizeDraft(sessionId)
const tracker = this.getOrCreateTracker(sessionId, threadId)
await tracker.onToolCall()
```

Keep the `sendMessage` for the tool detail message unchanged — it still uses `formatToolCall(meta)` (full mode, no change).

- [ ] **Step 6: Update `plan` handler**

Old:
```typescript
const tracker = await this.getOrCreateTracker(sessionId, threadId)
tracker.onPlan(planMeta.entries.map(e => ({
  content: e.content,
  status: e.status as PlanEntryStatus,
})))
```

New:
```typescript
// Finalize any leftover draft from a previous text-only response
await this.finalizeDraft(sessionId)
const tracker = this.getOrCreateTracker(sessionId, threadId)
await tracker.onPlan(planMeta.entries.map(e => ({
  content: e.content,
  status: e.status as PlanEntry['status'],
})))
```

- [ ] **Step 7: Update `tool_update` handler — add onToolUpdate call**

Old:
```typescript
this.activityTrackers.get(sessionId)?.onToolUpdate(meta.status)
```

New:
```typescript
this.activityTrackers.get(sessionId)?.onToolUpdate(meta.id, meta.status)
```

(The new `onToolUpdate` is a no-op but satisfies the interface and prevents the silent call failure.)

- [ ] **Step 8: Fix MessageDraft bug and update `text` handler**

The bug: `sessionDrafts` retains the old `MessageDraft` across prompts. When the second prompt's first text chunk arrives, `sessionDrafts.has(sessionId)` is `true` → `onTextStart()` is never called → second response appends to first message.

The fix: finalize the draft in `tool_call` and `plan` handlers (Step 5 and 6 above already do this). For text-only responses (no tool calls), we need an additional guard in the `text` handler. A new prompt's first text will arrive immediately after the previous `session_end` cleared `sessionDrafts` — so `!sessionDrafts.has(sessionId)` correctly identifies the first chunk. No additional change needed for text-only multi-prompt (session_end already calls `finalizeDraft`).

However: add `onNewPrompt()` call on first text chunk to roll the usage message:

Old:
```typescript
case 'text': {
  if (!this.sessionDrafts.has(sessionId)) {
    const tracker = this.activityTrackers.get(sessionId)
    if (tracker) await tracker.onTextStart()
  }
  let draft = this.sessionDrafts.get(sessionId)
  // ...
}
```

New:
```typescript
case 'text': {
  if (!this.sessionDrafts.has(sessionId)) {
    // First chunk of a new text response
    const tracker = this.getOrCreateTracker(sessionId, threadId)
    await tracker.onTextStart()
    await tracker.onNewPrompt()  // delete previous usage message
  }
  let draft = this.sessionDrafts.get(sessionId)
  if (!draft) {
    draft = new MessageDraft(this.bot, this.telegramConfig.chatId, threadId)
    this.sessionDrafts.set(sessionId, draft)
  }
  draft.append(content.text)
  break
}
```

- [ ] **Step 9: Update `usage` handler (conditional on Pre-work decision)**

**If `session_end` carries usage** (verified in Pre-work): remove the separate `usage` case entirely.

**If usage arrives via separate `usage` event**: update the `usage` case to route through ActivityTracker:

```typescript
case 'usage': {
  const usageMeta = content.metadata as {
    tokensUsed?: number
    contextSize?: number
    cost?: { amount: number; currency: string }
  }
  const tracker = this.activityTrackers.get(sessionId)
  if (tracker) {
    await tracker.sendUsage(usageMeta)
  }
  break
}
```

This ensures usage participates in the rolling-delete pattern managed by `UsageMessage`.

- [ ] **Step 10: Update `session_end` handler**

Old:
```typescript
case 'session_end': {
  const tracker = this.activityTrackers.get(sessionId)
  if (tracker) {
    await tracker.onComplete()
    tracker.destroy()
    this.activityTrackers.delete(sessionId)
  }
  await this.finalizeDraft(sessionId)
  this.sessionDrafts.delete(sessionId)
  this.toolCallMessages.delete(sessionId)
  await this.cleanupSkillCommands(sessionId)
  break
}
```

New — pass usage if session_end carries it (else pass undefined):
```typescript
case 'session_end': {
  const tracker = this.activityTrackers.get(sessionId)
  if (tracker) {
    // Pass usage metadata if session_end carries it (see Pre-work step)
    const usageMeta = (content.metadata as { tokensUsed?: number; contextSize?: number; cost?: { amount: number; currency: string } } | undefined)
    await tracker.onComplete(usageMeta)
    tracker.destroy()
    this.activityTrackers.delete(sessionId)
  }
  await this.finalizeDraft(sessionId)
  this.sessionDrafts.delete(sessionId)
  this.toolCallMessages.delete(sessionId)
  await this.cleanupSkillCommands(sessionId)
  break
}
```

- [ ] **Step 11: Build and verify clean**

```bash
cd /Users/hieu/Documents/Companies/Lab3/opensource/OpenACP && pnpm build 2>&1 | tail -30
```

Expected: no TypeScript errors.

- [ ] **Step 12: Commit**

```bash
git add src/adapters/telegram/adapter.ts
git commit -m "feat(telegram): wire new ActivityTracker, fix draft finalization, roll usage message"
```

---

## Task 4: Run tests and verify

- [ ] **Step 1: Run test suite**

```bash
cd /Users/hieu/Documents/Companies/Lab3/opensource/OpenACP && pnpm test 2>&1
```

Expected: all existing tests pass.

- [ ] **Step 2: Final build verification**

```bash
pnpm build
```

Expected: clean output, `dist/` updated.

- [ ] **Step 3: Commit if any fixes needed**

```bash
git add -p
git commit -m "fix: resolve test failures after activity tracker rewrite"
```

---

## Verification Checklist

Manual test with a live Telegram bot session:

- [ ] Sending a prompt shows typing indicator immediately
- [ ] `💭 Thinking...` appears when agent thinks, disappears when tool call starts
- [ ] Plan card appears with checklist and Cancel/Stop button
- [ ] Tool call messages appear with `⏳` and update to `✅/❌`
- [ ] Cancel button works — plan card shows `🛑 Cancelled`
- [ ] After response: plan card has no button, `📊 Usage` appears
- [ ] Second prompt: old usage message deleted before new response
- [ ] Two consecutive text-only responses create separate messages (bug fix verified)
- [ ] Sessions with no plan event: no Cancel button (acceptable)
