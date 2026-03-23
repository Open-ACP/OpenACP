# Discord Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in Discord adapter with full feature parity with the Telegram adapter.

**Architecture:** Mirror the Telegram adapter 1:1 in `src/adapters/discord/`, using discord.js. Each session maps to a Discord forum channel post. Slash commands replace text commands. Button components replace inline keyboards.

**Tech Stack:** discord.js v14+, TypeScript ESM, Vitest

**Spec:** `docs/superpowers/specs/2026-03-23-discord-adapter-design.md`

**Critical API Notes (verified against actual codebase):**
- `sessionManager.listSessions(channelId?)` — NOT `getAllSessions()`
- `sessionManager.listRecords(filter?)` — for listing stored records
- `sessionManager.getSession(id)` — returns `Session | undefined`
- `sessionManager.getSessionByThread(channelId, threadId)` — in-memory lookup
- `sessionManager.patchRecord(id, patch)` — update stored record
- `sessionManager.cancelSession(id)` — abort + mark cancelled
- `agentManager.getAvailableAgents()` — NOT `getInstalledAgents()`
- `agentManager.getAgent(name)` — returns `AgentDefinition | undefined`
- `core.handleNewSession(channelId, agentName?, workspacePath?)` — 3 positional args, NOT an object
- `core.createSession(params)` — takes `{ channelId, agentName, workingDirectory, ... }`
- `configManager.save(updates)` — uses **deep merge with nested objects**, NOT dot-path strings. E.g. `save({ channels: { discord: { forumChannelId: '123' } } })` NOT `save({ 'channels.discord.forumChannelId': '123' })`
- `core.ts` line 236: `platform.topicId = Number(session.threadId)` — Telegram-specific, will lose precision for Discord snowflakes. **Task 13 must fix this to be channel-aware.**
- `getRecordByThread()` uses `(p) => String(p.topicId) === threadId` — Telegram-specific. **Task 13 must fix for Discord.**

---

### Task 1: Foundation — Types, Config, Dependencies

**Files:**
- Create: `src/adapters/discord/types.ts`
- Create: `src/adapters/discord/index.ts`
- Modify: `src/core/types.ts:197-201` (add DiscordPlatformData)
- Modify: `src/core/config.ts:247-267` (add env overrides)
- Modify: `package.json` (add discord.js)

- [ ] **Step 1: Install discord.js**

```bash
pnpm add discord.js
```

- [ ] **Step 2: Add DiscordPlatformData to core types**

In `src/core/types.ts` after `TelegramPlatformData` (line 200), add:

```ts
export interface DiscordPlatformData {
  threadId: string;
  skillMsgId?: string;
}
```

- [ ] **Step 3: Create `src/adapters/discord/types.ts`**

```ts
import type { Session } from '../../core/session.js'

export interface DiscordChannelConfig {
  enabled: boolean
  botToken: string
  guildId: string
  forumChannelId: string | null
  notificationChannelId: string | null
  assistantThreadId: string | null
}

export interface CommandsAssistantContext {
  threadId: string
  getSession: () => Session | null
  respawn: () => Promise<void>
}
```

- [ ] **Step 4: Create `src/adapters/discord/index.ts`**

```ts
export { DiscordAdapter } from './adapter.js'
export type { DiscordChannelConfig } from './types.js'
```

Note: `adapter.ts` doesn't exist yet — this will cause a TS error until Task 10. That's fine.

- [ ] **Step 5: Add Discord env overrides to `config.ts`**

In `src/core/config.ts` inside `applyEnvOverrides()`, add to the `overrides` array (after the Telegram entries):

```ts
["OPENACP_DISCORD_BOT_TOKEN", ["channels", "discord", "botToken"]],
["OPENACP_DISCORD_GUILD_ID", ["channels", "discord", "guildId"]],
```

- [ ] **Step 6: Add Discord default config**

In `src/core/config.ts`, find where the default config `channels.telegram` is defined. Add a sibling `discord` entry with all fields having defaults:

```ts
discord: {
  enabled: false,
  botToken: '',
  guildId: '',
  forumChannelId: null,
  notificationChannelId: null,
  assistantThreadId: null,
}
```

If this is in a Zod schema with `.passthrough()`, just ensure the default config JSON includes this. If not in schema, add it to the default config object only. Must NOT break existing configs that lack the `discord` key.

- [ ] **Step 7: Build and verify no TS errors (except missing adapter.ts)**

```bash
pnpm build 2>&1 | head -20
```

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(discord): add foundation types, config, and discord.js dependency"
```

---

### Task 2: Formatting Utilities

**Files:**
- Create: `src/adapters/discord/formatting.ts`
- Create: `src/adapters/discord/formatting.test.ts`

Discord uses native Markdown, so this is simpler than Telegram's HTML conversion.

- [ ] **Step 1: Write tests for formatting**

Create `src/adapters/discord/formatting.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatToolCall, formatToolUpdate, formatUsage, formatPlan, splitMessage } from './formatting.js'

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    const result = splitMessage('hello', 2000)
    expect(result).toEqual(['hello'])
  })

  it('splits at paragraph boundaries', () => {
    const text = 'A'.repeat(1500) + '\n\n' + 'B'.repeat(300)
    const result = splitMessage(text, 1900)
    expect(result.length).toBe(2)
    expect(result[0]).toContain('A')
    expect(result[1]).toContain('B')
  })

  it('does not split inside fenced code blocks', () => {
    const code = '```\n' + 'x\n'.repeat(500) + '```'
    const text = 'Before\n\n' + code + '\n\nAfter'
    const result = splitMessage(text, 1900)
    // Code block should stay together
    const codeChunk = result.find(c => c.includes('```'))
    expect(codeChunk).toContain('x')
  })
})

describe('formatUsage', () => {
  it('formats token count and progress bar', () => {
    const result = formatUsage({ inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 1000, cacheWriteTokens: 500, totalTokens: 8500, contextWindow: 200000 })
    expect(result).toContain('8,500')
    expect(result).toContain('200,000')
  })
})

describe('formatToolCall', () => {
  it('formats tool name and status', () => {
    const result = formatToolCall({ id: '1', name: 'Read', status: 'running', content: 'file.ts' })
    expect(result).toContain('Read')
    expect(result).toContain('file.ts')
  })
})

describe('formatPlan', () => {
  it('formats plan entries with status icons', () => {
    const result = formatPlan([
      { content: 'Step 1', status: 'completed', priority: 0 },
      { content: 'Step 2', status: 'in_progress', priority: 1 },
      { content: 'Step 3', status: 'pending', priority: 2 },
    ])
    expect(result).toContain('Step 1')
    expect(result).toContain('Step 2')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/adapters/discord/formatting.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/adapters/discord/formatting.ts`**

Port from Telegram's `formatting.ts` but output Discord Markdown instead of HTML:

```ts
import type { PlanEntry } from '../../core/types.js'

const STATUS_ICONS: Record<string, string> = {
  running: '🔄',
  completed: '✅',
  failed: '❌',
  pending: '⏳',
  in_progress: '🔄',
}

const KIND_ICONS: Record<string, string> = {
  read: '📖',
  write: '✏️',
  command: '⚡',
  search: '🔍',
}

export function formatToolCall(tool: { id: string; name: string; status: string; content?: string; kind?: string; viewerLinks?: { file?: string; diff?: string }; viewerFilePath?: string }): string {
  const statusIcon = STATUS_ICONS[tool.status] ?? '❓'
  const kindIcon = tool.kind ? (KIND_ICONS[tool.kind] ?? '') + ' ' : ''
  let text = `${statusIcon} ${kindIcon}**${tool.name}**`

  const links = formatViewerLinks(tool.viewerLinks, tool.viewerFilePath)
  if (links) text += ` ${links}`

  if (tool.content) {
    const truncated = tool.content.length > 500 ? tool.content.slice(0, 500) + '…' : tool.content
    text += `\n\`\`\`\n${truncated}\n\`\`\``
  }
  return text
}

export function formatToolUpdate(update: { id: string; name?: string; status: string; content?: string; kind?: string; viewerLinks?: { file?: string; diff?: string }; viewerFilePath?: string }): string {
  return formatToolCall({ ...update, name: update.name ?? 'Tool' } as any)
}

function formatViewerLinks(links?: { file?: string; diff?: string }, filePath?: string): string {
  const parts: string[] = []
  if (links?.file) parts.push(`[file](${links.file})`)
  if (links?.diff) parts.push(`[diff](${links.diff})`)
  if (filePath && parts.length === 0) parts.push(`\`${filePath}\``)
  return parts.length > 0 ? `(${parts.join(' | ')})` : ''
}

export function formatPlan(entries: PlanEntry[]): string {
  return entries.map(e => {
    const icon = STATUS_ICONS[e.status] ?? '❓'
    return `${icon} ${e.content}`
  }).join('\n')
}

export function formatUsage(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; contextWindow: number }): string {
  const pct = Math.round((usage.totalTokens / usage.contextWindow) * 100)
  const barLen = 20
  const filled = Math.round((pct / 100) * barLen)
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)

  const fmt = (n: number) => n.toLocaleString('en-US')
  let text = `${bar} ${pct}%\n`
  text += `**Total:** ${fmt(usage.totalTokens)} / ${fmt(usage.contextWindow)}\n`
  text += `Input: ${fmt(usage.inputTokens)} | Output: ${fmt(usage.outputTokens)}`
  if (usage.cacheReadTokens > 0) text += ` | Cache Read: ${fmt(usage.cacheReadTokens)}`
  if (usage.cacheWriteTokens > 0) text += ` | Cache Write: ${fmt(usage.cacheWriteTokens)}`

  if (pct >= 85) text += '\n⚠️ **Context window running low!**'
  return text
}

export function splitMessage(text: string, maxLength = 1800): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength)

    // Avoid splitting inside fenced code blocks
    const codeBlockStarts = [...remaining.slice(0, maxLength).matchAll(/```/g)]
    if (codeBlockStarts.length % 2 !== 0) {
      // We're inside a code block — find its end
      const endIdx = remaining.indexOf('```', codeBlockStarts[codeBlockStarts.length - 1].index! + 3)
      if (endIdx !== -1 && endIdx + 3 < remaining.length) {
        splitIdx = endIdx + 3
      }
    }

    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf('\n', maxLength)
    if (splitIdx <= 0) splitIdx = maxLength

    chunks.push(remaining.slice(0, splitIdx))
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '')
  }

  return chunks
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/adapters/discord/formatting.test.ts 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/discord/formatting.ts src/adapters/discord/formatting.test.ts && git commit -m "feat(discord): add formatting utilities with tests"
```

---

### Task 3: Send Queue

**Files:**
- Create: `src/adapters/discord/send-queue.ts`

Port from Telegram's `TelegramSendQueue`. Discord.js handles rate limits internally, but we still need the dedup logic for streaming edits.

- [ ] **Step 1: Create `src/adapters/discord/send-queue.ts`**

```ts
import { log } from '../../core/logger.js'

interface QueueItem<T> {
  fn: () => Promise<T>
  type: 'text' | 'other'
  key?: string
  resolve: (value: T | undefined) => void
  reject: (error: unknown) => void
}

export class DiscordSendQueue {
  private queue: QueueItem<any>[] = []
  private processing = false
  private lastRunTime = 0
  private minInterval: number

  constructor(minInterval = 1000) {
    this.minInterval = minInterval
  }

  async enqueue<T>(fn: () => Promise<T>, opts: { type: 'text' | 'other'; key?: string } = { type: 'other' }): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      // Dedup: replace existing text item with same key
      if (opts.type === 'text' && opts.key) {
        const existingIdx = this.queue.findIndex(
          item => item.type === 'text' && item.key === opts.key
        )
        if (existingIdx !== -1) {
          const old = this.queue[existingIdx]
          old.resolve(undefined) // resolve old with undefined (skipped)
          this.queue[existingIdx] = { fn, type: opts.type, key: opts.key, resolve, reject }
          return
        }
      }

      this.queue.push({ fn, type: opts.type, key: opts.key, resolve, reject })
      this.processQueue()
    })
  }

  onRateLimited(): void {
    const kept: QueueItem<any>[] = []
    for (const item of this.queue) {
      if (item.type === 'text') {
        item.resolve(undefined)
      } else {
        kept.push(item)
      }
    }
    this.queue = kept
    log.warn('DiscordSendQueue: dropped text items due to rate limit')
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      const elapsed = Date.now() - this.lastRunTime
      if (elapsed < this.minInterval) {
        await new Promise(r => setTimeout(r, this.minInterval - elapsed))
      }

      const item = this.queue.shift()!
      this.lastRunTime = Date.now()

      try {
        const result = await item.fn()
        item.resolve(result)
      } catch (err) {
        item.reject(err)
      }
    }

    this.processing = false
  }
}
```

- [ ] **Step 2: Build check**

```bash
pnpm build 2>&1 | grep -i error | head -5
```

- [ ] **Step 3: Commit**

```bash
git add src/adapters/discord/send-queue.ts && git commit -m "feat(discord): add send queue with dedup and rate limit support"
```

---

### Task 4: Streaming (MessageDraft)

**Files:**
- Create: `src/adapters/discord/streaming.ts`

Port from Telegram but with 2000 char limit and Discord message API.

- [ ] **Step 1: Create `src/adapters/discord/streaming.ts`**

```ts
import { log } from '../../core/logger.js'
import { splitMessage } from './formatting.js'
import { DiscordSendQueue } from './send-queue.js'
import type { TextChannel, ThreadChannel, Message } from 'discord.js'

export class MessageDraft {
  private buffer = ''
  private lastSentBuffer = ''
  private messageId: string | null = null
  private message: Message | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushPromise: Promise<void> | null = null
  private firstFlushPending = false

  constructor(
    private thread: TextChannel | ThreadChannel,
    private sendQueue: DiscordSendQueue,
    private sessionId: string,
  ) {}

  append(text: string): void {
    this.buffer += text
    this.scheduleFlush()
  }

  getBuffer(): string {
    return this.buffer
  }

  private scheduleFlush(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushPromise = this.flush()
    }, 5000)
  }

  private async flush(): Promise<void> {
    const snapshot = this.buffer
    if (snapshot === this.lastSentBuffer) return

    const truncated = snapshot.length > 1900
      ? snapshot.slice(0, 1900) + '…'
      : snapshot

    try {
      if (!this.message) {
        if (this.firstFlushPending) return
        this.firstFlushPending = true

        const result = await this.sendQueue.enqueue(
          () => this.thread.send(truncated || '…'),
          { type: 'other' }
        )
        if (result) {
          this.message = result
          this.messageId = result.id
        }
        this.firstFlushPending = false
      } else {
        await this.sendQueue.enqueue(
          () => this.message!.edit(truncated),
          { type: 'text', key: this.sessionId }
        )
      }
      this.lastSentBuffer = snapshot
    } catch (err) {
      log.warn({ err, sessionId: this.sessionId }, 'MessageDraft flush failed')
    }
  }

  async finalize(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.flushPromise) await this.flushPromise

    const finalText = this.buffer
    if (!finalText) return

    const chunks = splitMessage(finalText, 1900)

    try {
      if (this.message && chunks.length === 1) {
        // Edit existing message with final content
        await this.sendQueue.enqueue(
          () => this.message!.edit(chunks[0]),
          { type: 'other' }
        )
      } else if (this.message && chunks.length > 1) {
        // Edit first message, send rest as new
        await this.sendQueue.enqueue(
          () => this.message!.edit(chunks[0]),
          { type: 'other' }
        )
        for (let i = 1; i < chunks.length; i++) {
          await this.sendQueue.enqueue(
            () => this.thread.send(chunks[i]),
            { type: 'other' }
          )
        }
      } else {
        // No existing message — send all chunks
        for (const chunk of chunks) {
          await this.sendQueue.enqueue(
            () => this.thread.send(chunk),
            { type: 'other' }
          )
        }
      }
    } catch (err) {
      log.warn({ err, sessionId: this.sessionId }, 'MessageDraft finalize failed')
      // Fallback: try sending as plain text
      try {
        for (const chunk of chunks) {
          await this.thread.send(chunk)
        }
      } catch {
        log.error({ sessionId: this.sessionId }, 'MessageDraft finalize fallback also failed')
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/discord/streaming.ts && git commit -m "feat(discord): add MessageDraft streaming with 2000 char limit"
```

---

### Task 5: Activity Tracking

**Files:**
- Create: `src/adapters/discord/activity.ts`

Port ThinkingIndicator, UsageMessage, PlanCard, ActivityTracker. Use Discord typing indicator and embeds.

- [ ] **Step 1: Create `src/adapters/discord/activity.ts`**

Port from Telegram's `activity.ts`. Key differences:
- `ThinkingIndicator`: Use `channel.sendTyping()` (auto-expires after 10s, refresh every 8s)
- `UsageMessage`: Send as embed instead of HTML
- `PlanCard`: Send as embed with formatted plan entries
- All send calls go through `DiscordSendQueue`

```ts
import type { TextChannel, ThreadChannel, Message } from 'discord.js'
import { EmbedBuilder } from 'discord.js'
import { log } from '../../core/logger.js'
import { formatUsage, formatPlan } from './formatting.js'
import { DiscordSendQueue } from './send-queue.js'
import type { PlanEntry } from '../../core/types.js'

export class ThinkingIndicator {
  private interval: ReturnType<typeof setInterval> | null = null
  private active = false

  constructor(
    private thread: TextChannel | ThreadChannel,
  ) {}

  show(): void {
    if (this.active) return
    this.active = true
    this.sendTyping()
    this.interval = setInterval(() => this.sendTyping(), 8000)
  }

  private sendTyping(): void {
    this.thread.sendTyping().catch(err =>
      log.warn({ err }, 'Failed to send typing indicator')
    )
  }

  dismiss(): void {
    this.active = false
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  reset(): void {
    this.dismiss()
  }
}

export class UsageMessage {
  private message: Message | null = null

  constructor(
    private thread: TextChannel | ThreadChannel,
    private sendQueue: DiscordSendQueue,
  ) {}

  async send(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; contextWindow: number }): Promise<void> {
    const embed = new EmbedBuilder()
      .setDescription(formatUsage(usage))
      .setColor(0x5865F2)

    try {
      if (this.message) {
        await this.sendQueue.enqueue(
          () => this.message!.edit({ embeds: [embed] }),
          { type: 'text', key: 'usage' }
        )
      } else {
        const result = await this.sendQueue.enqueue(
          () => this.thread.send({ embeds: [embed] }),
          { type: 'other' }
        )
        if (result) this.message = result
      }
    } catch (err) {
      log.warn({ err }, 'Failed to send usage message')
    }
  }

  async delete(): Promise<void> {
    if (this.message) {
      try { await this.message.delete() } catch {}
      this.message = null
    }
  }
}

export class PlanCard {
  private message: Message | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private latestEntries: PlanEntry[] = []

  constructor(
    private thread: TextChannel | ThreadChannel,
    private sendQueue: DiscordSendQueue,
  ) {}

  update(entries: PlanEntry[]): void {
    this.latestEntries = entries
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 3500)
  }

  async finalize(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async flush(): Promise<void> {
    if (this.latestEntries.length === 0) return

    const embed = new EmbedBuilder()
      .setTitle('Plan')
      .setDescription(formatPlan(this.latestEntries))
      .setColor(0x5865F2)

    try {
      if (this.message) {
        await this.sendQueue.enqueue(
          () => this.message!.edit({ embeds: [embed] }),
          { type: 'text', key: 'plan' }
        )
      } else {
        const result = await this.sendQueue.enqueue(
          () => this.thread.send({ embeds: [embed] }),
          { type: 'other' }
        )
        if (result) this.message = result
      }
    } catch (err) {
      log.warn({ err }, 'Failed to send plan card')
    }
  }
}

export class ActivityTracker {
  private thinking: ThinkingIndicator
  private usage: UsageMessage
  private plan: PlanCard
  private isFirstEvent = true

  constructor(
    thread: TextChannel | ThreadChannel,
    sendQueue: DiscordSendQueue,
  ) {
    this.thinking = new ThinkingIndicator(thread)
    this.usage = new UsageMessage(thread, sendQueue)
    this.plan = new PlanCard(thread, sendQueue)
  }

  onNewPrompt(): void {
    this.isFirstEvent = true
    this.thinking.reset()
  }

  private handleFirstEvent(): void {
    if (this.isFirstEvent) {
      this.isFirstEvent = false
      this.usage.delete()
    }
  }

  onThought(): void {
    this.handleFirstEvent()
    this.thinking.show()
  }

  onTextStart(): void {
    this.handleFirstEvent()
    this.thinking.dismiss()
  }

  onToolCall(): void {
    this.handleFirstEvent()
    this.thinking.dismiss()
  }

  onPlan(entries: PlanEntry[]): void {
    this.handleFirstEvent()
    this.thinking.dismiss()
    this.plan.update(entries)
  }

  async sendUsage(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; contextWindow: number }): Promise<void> {
    this.thinking.dismiss()
    await this.plan.finalize()
    await this.usage.send(usage)
  }

  cleanup(): void {
    this.thinking.dismiss()
    this.plan.destroy()
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/discord/activity.ts && git commit -m "feat(discord): add activity tracking (thinking, usage, plan)"
```

---

### Task 6: Tool Call Tracker, Action Detection & Draft Manager

**Files:**
- Create: `src/adapters/discord/tool-call-tracker.ts`
- Create: `src/adapters/discord/action-detect.ts` (MUST be created before draft-manager, which imports it)
- Create: `src/adapters/discord/draft-manager.ts`

- [ ] **Step 1: Create `src/adapters/discord/tool-call-tracker.ts`**

Port from Telegram. Uses embeds instead of HTML messages.

```ts
import type { TextChannel, ThreadChannel, Message } from 'discord.js'
import { EmbedBuilder } from 'discord.js'
import { log } from '../../core/logger.js'
import { formatToolCall } from './formatting.js'
import { DiscordSendQueue } from './send-queue.js'

interface ToolCallState {
  msgId: string
  message: Message
  name: string
  status: string
  content?: string
  kind?: string
  viewerLinks?: { file?: string; diff?: string }
  viewerFilePath?: string
  ready: Promise<void>
  resolveReady: () => void
}

export class ToolCallTracker {
  private sessions = new Map<string, Map<string, ToolCallState>>()

  constructor(
    private sendQueue: DiscordSendQueue,
  ) {}

  async trackNewCall(
    sessionId: string,
    thread: TextChannel | ThreadChannel,
    tool: { id: string; name: string; content?: string; kind?: string },
  ): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Map())
    }
    const sessionTools = this.sessions.get(sessionId)!

    let resolveReady: () => void
    const ready = new Promise<void>(r => { resolveReady = r })

    const text = formatToolCall({ ...tool, status: 'running' })

    try {
      const msg = await this.sendQueue.enqueue(
        () => thread.send(text),
        { type: 'other' }
      )

      if (msg) {
        sessionTools.set(tool.id, {
          msgId: msg.id,
          message: msg,
          name: tool.name,
          status: 'running',
          content: tool.content,
          kind: tool.kind,
          ready,
          resolveReady: resolveReady!,
        })
        resolveReady!()
      }
    } catch (err) {
      log.warn({ err, toolId: tool.id }, 'Failed to send tool call message')
      resolveReady!()
    }
  }

  async updateCall(
    sessionId: string,
    update: { id: string; name?: string; status: string; content?: string; kind?: string; viewerLinks?: { file?: string; diff?: string }; viewerFilePath?: string },
  ): Promise<void> {
    const sessionTools = this.sessions.get(sessionId)
    if (!sessionTools) return

    const state = sessionTools.get(update.id)
    if (!state) return

    // Accumulate fields
    if (update.name) state.name = update.name
    if (update.kind) state.kind = update.kind
    if (update.viewerLinks) state.viewerLinks = update.viewerLinks
    if (update.viewerFilePath) state.viewerFilePath = update.viewerFilePath
    if (update.content) state.content = update.content
    state.status = update.status

    // Only edit on terminal status
    if (update.status !== 'completed' && update.status !== 'failed') return

    await state.ready

    const text = formatToolCall({
      id: update.id,
      name: state.name,
      status: state.status,
      content: state.content,
      kind: state.kind,
      viewerLinks: state.viewerLinks,
      viewerFilePath: state.viewerFilePath,
    })

    try {
      await this.sendQueue.enqueue(
        () => state.message.edit(text),
        { type: 'text', key: `tool:${update.id}` }
      )
    } catch (err) {
      log.warn({ err, toolId: update.id }, 'Failed to update tool call message')
    }
  }

  cleanup(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
```

- [ ] **Step 2: Create `src/adapters/discord/action-detect.ts`**

This MUST be created before draft-manager (which imports it). See Task 9's original action-detect code — move it here. Port from Telegram: same regex patterns, but use Discord buttons instead of InlineKeyboard.

```ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import { nanoid } from 'nanoid'

export interface DetectedAction {
  type: 'new_session' | 'cancel_session'
  agent?: string
  workspace?: string
}

const ACTION_TTL = 5 * 60 * 1000
const actions = new Map<string, { action: DetectedAction; expiresAt: number }>()

export function detectAction(text: string): DetectedAction | null {
  const newMatch = text.match(/\/new(?:\s+(\S+))?(?:\s+(\S+))?/)
  if (newMatch) return { type: 'new_session', agent: newMatch[1], workspace: newMatch[2] }
  if (/\/cancel\b/.test(text)) return { type: 'cancel_session' }
  if (/\b(?:create|start|new)\s+(?:a\s+)?session\b/i.test(text)) return { type: 'new_session' }
  if (/\b(?:cancel|stop|kill)\s+(?:the\s+)?session\b/i.test(text)) return { type: 'cancel_session' }
  return null
}

export function storeAction(action: DetectedAction): string {
  const now = Date.now()
  for (const [id, entry] of actions) { if (entry.expiresAt < now) actions.delete(id) }
  const id = nanoid(8)
  actions.set(id, { action, expiresAt: now + ACTION_TTL })
  return id
}

export function getAction(id: string): DetectedAction | null {
  const entry = actions.get(id)
  if (!entry || entry.expiresAt < Date.now()) { actions.delete(id); return null }
  return entry.action
}

export function removeAction(id: string): void { actions.delete(id) }

export function buildActionKeyboard(actionId: string, action: DetectedAction): ActionRowBuilder<ButtonBuilder> | null {
  const row = new ActionRowBuilder<ButtonBuilder>()
  if (action.type === 'new_session') {
    row.addComponents(
      new ButtonBuilder().setCustomId(`a:${actionId}`).setLabel(action.agent ? `New Session (${action.agent})` : 'New Session').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`a:dismiss:${actionId}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
    )
  } else if (action.type === 'cancel_session') {
    row.addComponents(
      new ButtonBuilder().setCustomId(`a:${actionId}`).setLabel('Cancel Session').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`a:dismiss:${actionId}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
    )
  } else { return null }
  return row
}
```

- [ ] **Step 3: Create `src/adapters/discord/draft-manager.ts`**

Port from Telegram. Manages `MessageDraft` instances per session.

```ts
import type { TextChannel, ThreadChannel } from 'discord.js'
import { MessageDraft } from './streaming.js'
import { DiscordSendQueue } from './send-queue.js'
import { detectAction, storeAction, buildActionKeyboard } from './action-detect.js'
import { ActionRowBuilder, ButtonBuilder } from 'discord.js'

export class DraftManager {
  private drafts = new Map<string, MessageDraft>()
  private textBuffers = new Map<string, string>()

  constructor(
    private sendQueue: DiscordSendQueue,
  ) {}

  getOrCreate(sessionId: string, thread: TextChannel | ThreadChannel): MessageDraft {
    let draft = this.drafts.get(sessionId)
    if (!draft) {
      draft = new MessageDraft(thread, this.sendQueue, sessionId)
      this.drafts.set(sessionId, draft)
    }
    return draft
  }

  hasDraft(sessionId: string): boolean {
    return this.drafts.has(sessionId)
  }

  appendText(sessionId: string, text: string): void {
    const buf = this.textBuffers.get(sessionId) ?? ''
    this.textBuffers.set(sessionId, buf + text)
  }

  async finalize(sessionId: string, thread?: TextChannel | ThreadChannel, isAssistant = false): Promise<void> {
    const draft = this.drafts.get(sessionId)
    if (!draft) return
    this.drafts.delete(sessionId)

    await draft.finalize()

    // Check for action detection in assistant responses
    if (isAssistant && thread) {
      const buf = this.textBuffers.get(sessionId) ?? ''
      const action = detectAction(buf)
      if (action) {
        const actionId = storeAction(action)
        const row = buildActionKeyboard(actionId, action)
        if (row) {
          await this.sendQueue.enqueue(
            () => thread.send({ content: '\u200b', components: [row] }),
            { type: 'other' }
          )
        }
      }
    }
    this.textBuffers.delete(sessionId)
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/adapters/discord/tool-call-tracker.ts src/adapters/discord/draft-manager.ts && git commit -m "feat(discord): add tool call tracker and draft manager"
```

---

### Task 7: Forums Management

**Files:**
- Create: `src/adapters/discord/forums.ts`

- [ ] **Step 1: Create `src/adapters/discord/forums.ts`**

```ts
import { ChannelType, ForumChannel, ThreadChannel, Guild, TextChannel } from 'discord.js'
import { log } from '../../core/logger.js'
import type { DiscordChannelConfig } from './types.js'

export async function ensureForums(
  guild: Guild,
  config: DiscordChannelConfig,
  saveConfig: (updates: Record<string, unknown>) => Promise<void>,
): Promise<{ forumChannel: ForumChannel; notificationChannel: TextChannel }> {
  // Ensure forum channel
  let forumChannel: ForumChannel
  if (config.forumChannelId) {
    const existing = guild.channels.cache.get(config.forumChannelId)
    if (existing && existing.type === ChannelType.GuildForum) {
      forumChannel = existing as ForumChannel
    } else {
      log.warn('Configured forum channel not found, creating new one')
      forumChannel = await createForumChannel(guild)
      await saveConfig({ channels: { discord: { forumChannelId: forumChannel.id } } })
    }
  } else {
    forumChannel = await createForumChannel(guild)
    await saveConfig({ channels: { discord: { forumChannelId: forumChannel.id } } })
  }

  // Ensure notification channel
  let notificationChannel: TextChannel
  if (config.notificationChannelId) {
    const existing = guild.channels.cache.get(config.notificationChannelId)
    if (existing && existing.type === ChannelType.GuildText) {
      notificationChannel = existing as TextChannel
    } else {
      log.warn('Configured notification channel not found, creating new one')
      notificationChannel = await createNotificationChannel(guild)
      await saveConfig({ channels: { discord: { notificationChannelId: notificationChannel.id } } })
    }
  } else {
    notificationChannel = await createNotificationChannel(guild)
    await saveConfig({ channels: { discord: { notificationChannelId: notificationChannel.id } } })
  }

  return { forumChannel, notificationChannel }
}

async function createForumChannel(guild: Guild): Promise<ForumChannel> {
  const channel = await guild.channels.create({
    name: 'openacp-sessions',
    type: ChannelType.GuildForum,
    reason: 'OpenACP session forum',
  })
  log.info({ channelId: channel.id }, 'Created forum channel')
  return channel as ForumChannel
}

async function createNotificationChannel(guild: Guild): Promise<TextChannel> {
  const channel = await guild.channels.create({
    name: 'openacp-notifications',
    type: ChannelType.GuildText,
    reason: 'OpenACP notifications',
  })
  log.info({ channelId: channel.id }, 'Created notification channel')
  return channel as TextChannel
}

export async function createSessionThread(
  forumChannel: ForumChannel,
  name: string,
): Promise<ThreadChannel> {
  const thread = await forumChannel.threads.create({
    name,
    message: { content: `⏳ Setting up session...` },
    reason: 'OpenACP new session',
  })
  log.info({ threadId: thread.id, name }, 'Created session thread')
  return thread
}

export async function renameSessionThread(
  guild: Guild,
  threadId: string,
  newName: string,
): Promise<void> {
  try {
    const thread = guild.channels.cache.get(threadId) as ThreadChannel | undefined
      ?? await guild.channels.fetch(threadId) as ThreadChannel | null
    if (thread) {
      await thread.setName(newName)
    }
  } catch (err) {
    log.warn({ err, threadId, newName }, 'Failed to rename session thread')
  }
}

export async function deleteSessionThread(
  guild: Guild,
  threadId: string,
): Promise<void> {
  try {
    const thread = guild.channels.cache.get(threadId) as ThreadChannel | undefined
      ?? await guild.channels.fetch(threadId) as ThreadChannel | null
    if (thread) {
      await thread.delete('OpenACP session cleanup')
    }
  } catch (err) {
    log.warn({ err, threadId }, 'Failed to delete session thread')
  }
}

export async function ensureUnarchived(thread: ThreadChannel): Promise<void> {
  if (thread.archived) {
    try {
      await thread.setArchived(false)
    } catch (err) {
      log.warn({ err, threadId: thread.id }, 'Failed to unarchive thread')
    }
  }
}

export function buildDeepLink(guildId: string, channelId: string, messageId?: string): string {
  if (messageId) {
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
  }
  return `https://discord.com/channels/${guildId}/${channelId}`
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/discord/forums.ts && git commit -m "feat(discord): add forum channel management and thread CRUD"
```

---

### Task 8: Permissions Handler

**Files:**
- Create: `src/adapters/discord/permissions.ts`

- [ ] **Step 1: Create `src/adapters/discord/permissions.ts`**

```ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction, type TextChannel, type ThreadChannel, type Message } from 'discord.js'
import { nanoid } from 'nanoid'
import { log } from '../../core/logger.js'
import { DiscordSendQueue } from './send-queue.js'
import type { PermissionRequest } from '../../core/types.js'
import type { Session } from '../../core/session.js'

interface PendingPermission {
  session: Session
  messageId: string
  message: Message
}

export class PermissionHandler {
  private pending = new Map<string, PendingPermission>()

  constructor(
    private sendQueue: DiscordSendQueue,
    private getThread: (sessionId: string) => TextChannel | ThreadChannel | null,
    private notificationChannel: TextChannel | null,
    private guildId: string,
  ) {}

  async sendPermissionRequest(
    session: Session,
    request: PermissionRequest,
  ): Promise<void> {
    const thread = this.getThread(session.id)
    if (!thread) {
      log.warn({ sessionId: session.id }, 'No thread for permission request')
      return
    }

    const callbackKey = nanoid(8)

    // Build buttons from request options
    const row = new ActionRowBuilder<ButtonBuilder>()
    for (const option of request.options) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`p:${callbackKey}:${option.id}`)
          .setLabel(option.label)
          .setStyle(option.isAllow ? ButtonStyle.Success : ButtonStyle.Danger)
      )
    }

    // Format description
    let content = `**Permission Request**\n${request.description}`
    if (content.length > 2000) {
      content = content.slice(0, 1997) + '...'
    }

    try {
      const msg = await this.sendQueue.enqueue(
        () => thread.send({ content, components: [row] }),
        { type: 'other' }
      )
      if (msg) {
        this.pending.set(callbackKey, { session, messageId: msg.id, message: msg })

        // Send notification
        if (this.notificationChannel) {
          const { buildDeepLink } = await import('./forums.js')
          const link = buildDeepLink(this.guildId, thread.id, msg.id)
          await this.notificationChannel.send(
            `⚠️ Permission request in **${session.name ?? 'session'}**: [View](${link})`
          ).catch(() => {})
        }
      }
    } catch (err) {
      log.error({ err, sessionId: session.id }, 'Failed to send permission request')
    }
  }

  handleButtonInteraction(interaction: ButtonInteraction): boolean {
    const customId = interaction.customId
    if (!customId.startsWith('p:')) return false

    const parts = customId.split(':')
    if (parts.length < 3) return false

    const callbackKey = parts[1]
    const optionId = parts.slice(2).join(':')

    const pending = this.pending.get(callbackKey)
    if (!pending) {
      interaction.deferUpdate().catch(() => {})
      return true
    }

    this.pending.delete(callbackKey)

    // Resolve permission
    pending.session.permissionGate.resolve(optionId)

    // Remove buttons from message
    interaction.deferUpdate().then(() => {
      pending.message.edit({ components: [] }).catch(() => {})
    }).catch(() => {})

    return true
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/discord/permissions.ts && git commit -m "feat(discord): add permission handler with button interactions"
```

---

### Task 9: Skill Command Manager

**Files:**
- Create: `src/adapters/discord/skill-command-manager.ts`

Note: `action-detect.ts` was already created in Task 6 (before draft-manager, which depends on it).

- [ ] **Step 1: Create `src/adapters/discord/skill-command-manager.ts`**

```ts
import type { TextChannel, ThreadChannel, Message } from 'discord.js'
import { log } from '../../core/logger.js'
import { DiscordSendQueue } from './send-queue.js'
import type { AgentCommand } from '../../core/types.js'
import type { SessionManager } from '../../core/session-manager.js'

export class SkillCommandManager {
  private messages = new Map<string, Message>()

  constructor(
    private sendQueue: DiscordSendQueue,
    private sessionManager: SessionManager,
  ) {}

  async send(
    sessionId: string,
    thread: TextChannel | ThreadChannel,
    commands: AgentCommand[],
  ): Promise<void> {
    const text = this.formatCommands(commands)
    if (!text) return

    // Check for existing pinned skill message from platform data
    const record = this.sessionManager.getSession(sessionId)
    const platform = record?.platform as { skillMsgId?: string } | undefined
    const existingMsgId = platform?.skillMsgId

    try {
      const existing = this.messages.get(sessionId)
      if (existing) {
        await this.sendQueue.enqueue(
          () => existing.edit(text),
          { type: 'text', key: `skill:${sessionId}` }
        )
        return
      }

      if (existingMsgId) {
        // Try to fetch and edit existing
        try {
          const msg = await thread.messages.fetch(existingMsgId)
          this.messages.set(sessionId, msg)
          await this.sendQueue.enqueue(
            () => msg.edit(text),
            { type: 'text', key: `skill:${sessionId}` }
          )
          return
        } catch {
          // Message gone, send new
        }
      }

      const msg = await this.sendQueue.enqueue(
        () => thread.send(text),
        { type: 'other' }
      )
      if (msg) {
        this.messages.set(sessionId, msg)
        try { await msg.pin() } catch {}
        // Persist skillMsgId
        this.sessionManager.patchRecord(sessionId, { platform: { skillMsgId: msg.id } })
      }
    } catch (err) {
      log.warn({ err, sessionId }, 'Failed to send skill commands')
    }
  }

  async cleanup(sessionId: string): Promise<void> {
    const msg = this.messages.get(sessionId)
    if (msg) {
      try {
        await msg.edit('_Session ended_')
        await msg.unpin()
      } catch {}
      this.messages.delete(sessionId)
    }
    this.sessionManager.patchRecord(sessionId, { platform: { skillMsgId: undefined } })
  }

  private formatCommands(commands: AgentCommand[]): string {
    if (commands.length === 0) return ''
    const lines = commands.map(c => `**/${c.name}** — ${c.description}`)
    return `📋 **Available Commands**\n${lines.join('\n')}`
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/adapters/discord/skill-command-manager.ts && git commit -m "feat(discord): add skill command manager"
```

---

### Task 10: Slash Commands

**Files:**
- Create: `src/adapters/discord/commands/index.ts`
- Create: `src/adapters/discord/commands/new-session.ts`
- Create: `src/adapters/discord/commands/session.ts`
- Create: `src/adapters/discord/commands/admin.ts`
- Create: `src/adapters/discord/commands/agents.ts`
- Create: `src/adapters/discord/commands/menu.ts`
- Create: `src/adapters/discord/commands/doctor.ts`
- Create: `src/adapters/discord/commands/integrate.ts`
- Create: `src/adapters/discord/commands/settings.ts`

This is the largest task. Each command file ports the Telegram equivalent to Discord slash commands + button interactions.

- [ ] **Step 1: Create `src/adapters/discord/commands/index.ts`**

Register all slash commands and set up interaction routing.

```ts
import { SlashCommandBuilder, type ChatInputCommandInteraction, type ButtonInteraction, type Guild } from 'discord.js'
import type { OpenACPCore } from '../../../core/core.js'
import type { DiscordAdapter } from '../adapter.js'

export const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName('new').setDescription('Create a new agent session')
    .addStringOption(opt => opt.setName('agent').setDescription('Agent to use').setRequired(false))
    .addStringOption(opt => opt.setName('workspace').setDescription('Workspace path').setRequired(false)),
  new SlashCommandBuilder().setName('newchat').setDescription('New chat in current session context'),
  new SlashCommandBuilder().setName('cancel').setDescription('Cancel the current session'),
  new SlashCommandBuilder().setName('status').setDescription('Show session status'),
  new SlashCommandBuilder().setName('sessions').setDescription('List all sessions'),
  new SlashCommandBuilder().setName('agents').setDescription('List available agents'),
  new SlashCommandBuilder().setName('install').setDescription('Install an agent')
    .addStringOption(opt => opt.setName('agent').setDescription('Agent name').setRequired(true)),
  new SlashCommandBuilder().setName('menu').setDescription('Show main menu'),
  new SlashCommandBuilder().setName('help').setDescription('Show help'),
  new SlashCommandBuilder().setName('dangerous').setDescription('Toggle dangerous mode'),
  new SlashCommandBuilder().setName('restart').setDescription('Restart OpenACP'),
  new SlashCommandBuilder().setName('update').setDescription('Check for updates'),
  new SlashCommandBuilder().setName('integrate').setDescription('Manage agent integrations'),
  new SlashCommandBuilder().setName('settings').setDescription('Configure settings'),
  new SlashCommandBuilder().setName('doctor').setDescription('Run diagnostics'),
  new SlashCommandBuilder().setName('handoff').setDescription('Get terminal resume command'),
  new SlashCommandBuilder().setName('clear').setDescription('Reset assistant session'),
]

export async function registerSlashCommands(guild: Guild): Promise<void> {
  await guild.commands.set(SLASH_COMMANDS.map(cmd => cmd.toJSON()))
}

export { handleSlashCommand } from './router.js'
export { setupButtonCallbacks } from './router.js'
```

- [ ] **Step 2: Create `src/adapters/discord/commands/router.ts`**

Central routing for slash commands and button interactions.

```ts
import type { ChatInputCommandInteraction, ButtonInteraction } from 'discord.js'
import type { DiscordAdapter } from '../adapter.js'
import { handleNew, handleNewChat, executeNewSession } from './new-session.js'
import { handleCancel, handleStatus, handleSessions, handleHandoff } from './session.js'
import { handleAgents, handleInstall } from './agents.js'
import { handleMenu, handleHelp, handleClear } from './menu.js'
import { handleDangerous, handleRestart, handleUpdate } from './admin.js'
import { handleIntegrate } from './integrate.js'
import { handleSettings } from './settings.js'
import { handleDoctor } from './doctor.js'
import { getAction, removeAction } from '../action-detect.js'
import { log } from '../../../core/logger.js'

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  const { commandName } = interaction

  try {
    switch (commandName) {
      case 'new': return await handleNew(interaction, adapter)
      case 'newchat': return await handleNewChat(interaction, adapter)
      case 'cancel': return await handleCancel(interaction, adapter)
      case 'status': return await handleStatus(interaction, adapter)
      case 'sessions': return await handleSessions(interaction, adapter)
      case 'agents': return await handleAgents(interaction, adapter)
      case 'install': return await handleInstall(interaction, adapter)
      case 'menu': return await handleMenu(interaction, adapter)
      case 'help': return await handleHelp(interaction, adapter)
      case 'dangerous': return await handleDangerous(interaction, adapter)
      case 'restart': return await handleRestart(interaction, adapter)
      case 'update': return await handleUpdate(interaction, adapter)
      case 'integrate': return await handleIntegrate(interaction, adapter)
      case 'settings': return await handleSettings(interaction, adapter)
      case 'doctor': return await handleDoctor(interaction, adapter)
      case 'handoff': return await handleHandoff(interaction, adapter)
      case 'clear': return await handleClear(interaction, adapter)
      default:
        await interaction.reply({ content: `Unknown command: ${commandName}`, ephemeral: true })
    }
  } catch (err) {
    log.error({ err, commandName }, 'Slash command error')
    const reply = interaction.deferred || interaction.replied
      ? interaction.editReply.bind(interaction)
      : interaction.reply.bind(interaction)
    await reply({ content: `Error: ${err instanceof Error ? err.message : String(err)}` }).catch(() => {})
  }
}

export async function setupButtonCallbacks(
  interaction: ButtonInteraction,
  adapter: DiscordAdapter,
): Promise<boolean> {
  const id = interaction.customId

  // Action buttons (a: prefix)
  if (id.startsWith('a:dismiss:')) {
    await interaction.deferUpdate()
    await interaction.message.edit({ components: [] }).catch(() => {})
    const actionId = id.slice('a:dismiss:'.length)
    removeAction(actionId)
    return true
  }

  if (id.startsWith('a:')) {
    await interaction.deferUpdate()
    const actionId = id.slice('a:'.length)
    const action = getAction(actionId)
    if (!action) {
      await interaction.message.edit({ content: 'Action expired', components: [] }).catch(() => {})
      return true
    }
    removeAction(actionId)
    await interaction.message.edit({ components: [] }).catch(() => {})

    if (action.type === 'new_session') {
      await executeNewSession(interaction, adapter, action.agent, action.workspace)
    } else if (action.type === 'cancel_session') {
      const { executeCancelSession } = await import('./session.js')
      await executeCancelSession(interaction, adapter)
    }
    return true
  }

  // Dangerous mode (d: prefix)
  if (id.startsWith('d:')) {
    const { handleDangerousButton } = await import('./admin.js')
    await handleDangerousButton(interaction, adapter)
    return true
  }

  // Menu callbacks (m: prefix) — handle specific sub-prefixes first
  if (id.startsWith('m:new:')) {
    const { handleNewSessionButton } = await import('./new-session.js')
    await handleNewSessionButton(interaction, adapter)
    return true
  }

  if (id.startsWith('m:cleanup')) {
    const { handleCleanupButton } = await import('./session.js')
    await handleCleanupButton(interaction, adapter)
    return true
  }

  if (id.startsWith('m:doctor')) {
    const { handleDoctorButton } = await import('./doctor.js')
    await handleDoctorButton(interaction, adapter)
    return true
  }

  // Agent callbacks (ag: prefix)
  if (id.startsWith('ag:')) {
    const { handleAgentButton } = await import('./agents.js')
    await handleAgentButton(interaction, adapter)
    return true
  }

  // New session with agent (na: prefix)
  if (id.startsWith('na:')) {
    await interaction.deferUpdate()
    const agentName = id.slice('na:'.length)
    await executeNewSession(interaction, adapter, agentName)
    return true
  }

  // Settings callbacks (s: prefix)
  if (id.startsWith('s:')) {
    const { handleSettingsButton } = await import('./settings.js')
    await handleSettingsButton(interaction, adapter)
    return true
  }

  // Integrate callbacks (i: prefix)
  if (id.startsWith('i:')) {
    const { handleIntegrateButton } = await import('./integrate.js')
    await handleIntegrateButton(interaction, adapter)
    return true
  }

  // Generic menu (m: prefix — catch-all, must be last)
  if (id.startsWith('m:')) {
    const { handleMenuButton } = await import('./menu.js')
    await handleMenuButton(interaction, adapter)
    return true
  }

  return false
}
```

- [ ] **Step 3: Create `src/adapters/discord/commands/new-session.ts`**

```ts
import { type ChatInputCommandInteraction, type ButtonInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, type StringSelectMenuInteraction } from 'discord.js'
import type { DiscordAdapter } from '../adapter.js'
import { createSessionThread } from '../forums.js'
import { log } from '../../../core/logger.js'

export async function handleNew(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const agentName = interaction.options.getString('agent')
  const workspace = interaction.options.getString('workspace')

  if (agentName) {
    // Direct creation with specified agent
    await interaction.editReply('Creating session...')
    await executeNewSession(interaction, adapter, agentName, workspace ?? undefined)
    return
  }

  // Show agent picker
  const agents = adapter.core.agentManager.getAvailableAgents()
  if (agents.length === 0) {
    await interaction.editReply('No agents installed. Use `/agents` to install one.')
    return
  }

  if (agents.length === 1) {
    await interaction.editReply('Creating session...')
    await executeNewSession(interaction, adapter, agents[0].name)
    return
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = []
  const row = new ActionRowBuilder<ButtonBuilder>()
  for (const agent of agents.slice(0, 5)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`m:new:agent:${agent.name}`)
        .setLabel(agent.name)
        .setStyle(ButtonStyle.Primary)
    )
  }
  rows.push(row)

  await interaction.editReply({ content: 'Select an agent:', components: rows })
}

export async function handleNewChat(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const threadId = interaction.channelId
  const session = adapter.core.sessionManager.getSessionByThread('discord', threadId)
  if (!session) {
    await interaction.editReply('No active session in this thread.')
    return
  }

  const agentName = session.agentName
  const workspace = session.workspace
  await interaction.editReply('Creating new chat...')
  await executeNewSession(interaction, adapter, agentName, workspace)
}

export async function executeNewSession(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  adapter: DiscordAdapter,
  agentName?: string,
  workspace?: string,
): Promise<void> {
  const resolvedAgent = agentName ?? adapter.core.configManager.get().defaultAgent
  if (!resolvedAgent) {
    const reply = 'replied' in interaction && interaction.replied
      ? interaction.followUp.bind(interaction)
      : interaction.editReply?.bind(interaction)
    if (reply) await reply({ content: 'No agent specified and no default agent configured.' }).catch(() => {})
    return
  }

  try {
    const forumChannel = adapter.getForumChannel()
    if (!forumChannel) throw new Error('Forum channel not found')

    const threadName = `🔄 ${resolvedAgent} — New Session`
    const thread = await createSessionThread(forumChannel, threadName)

    const session = await adapter.core.handleNewSession(
      'discord',
      resolvedAgent,
      workspace ?? undefined,
    )

    if (session) {
      session.threadId = thread.id
      await adapter.core.sessionManager.patchRecord(session.id, {
        platform: { threadId: thread.id },
      })

      // Build dangerous mode button
      const { buildDangerousModeKeyboard } = await import('./admin.js')
      const row = buildDangerousModeKeyboard(session.id, false)

      const link = `https://discord.com/channels/${adapter.getGuildId()}/${thread.id}`
      await thread.send({
        content: `Session started with **${resolvedAgent}**. Send a message to begin.`,
        components: row ? [row] : [],
      })

      // Reply to the original interaction
      const content = `Session created: [Go to thread](${link})`
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content }).catch(() =>
          interaction.followUp({ content, ephemeral: true }).catch(() => {})
        )
      }
    }
  } catch (err) {
    log.error({ err, agentName: resolvedAgent }, 'Failed to create session')
    const content = `Failed to create session: ${err instanceof Error ? err.message : String(err)}`
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content }).catch(() => {})
    }
  }
}

export async function handleNewSessionButton(
  interaction: ButtonInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  const id = interaction.customId

  if (id.startsWith('m:new:agent:')) {
    await interaction.deferUpdate()
    const agentName = id.slice('m:new:agent:'.length)
    await interaction.message.edit({ content: `Creating session with **${agentName}**...`, components: [] })
    await executeNewSession(interaction, adapter, agentName)
    return
  }
}
```

- [ ] **Step 4: Create `src/adapters/discord/commands/session.ts`**

```ts
import type { ChatInputCommandInteraction, ButtonInteraction } from 'discord.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import type { DiscordAdapter } from '../adapter.js'
import { log } from '../../../core/logger.js'

export async function handleCancel(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const threadId = interaction.channelId
  const session = adapter.core.sessionManager.getSessionByThread('discord', threadId)

  if (!session) {
    await interaction.editReply('No active session in this thread.')
    return
  }

  try {
    if (session.status === 'active') {
      await session.abortPrompt()
    }
    await adapter.core.sessionManager.cancelSession(session.id)
    await interaction.editReply('Session cancelled.')
  } catch (err) {
    log.error({ err }, 'Failed to cancel session')
    await interaction.editReply(`Failed to cancel: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function handleStatus(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const threadId = interaction.channelId
  const session = adapter.core.sessionManager.getSessionByThread('discord', threadId)

  if (session) {
    await interaction.editReply(
      `**Session:** ${session.name ?? session.id}\n**Agent:** ${session.agentName}\n**Status:** ${session.status}`
    )
    return
  }

  // Global status
  const sessions = adapter.core.sessionManager.listSessions()
  if (sessions.length === 0) {
    await interaction.editReply('No active sessions.')
    return
  }

  const lines = sessions.map(s =>
    `• **${s.name ?? s.id}** (${s.agentName}) — ${s.status}`
  )
  await interaction.editReply(lines.join('\n'))
}

export async function handleSessions(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const sessions = adapter.core.sessionManager.listSessions()
  if (sessions.length === 0) {
    await interaction.editReply('No sessions.')
    return
  }

  const lines = sessions.map(s => {
    const link = s.threadId
      ? `[View](https://discord.com/channels/${adapter.getGuildId()}/${s.threadId})`
      : ''
    return `• **${s.name ?? s.id}** (${s.agentName}) — ${s.status} ${link}`
  })

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('m:cleanup:all')
        .setLabel('Clean Up All')
        .setStyle(ButtonStyle.Danger),
    )

  await interaction.editReply({ content: lines.join('\n'), components: [row] })
}

export async function handleHandoff(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const threadId = interaction.channelId
  const session = adapter.core.sessionManager.getSessionByThread('discord', threadId)

  if (!session) {
    await interaction.editReply('No active session in this thread.')
    return
  }

  const agent = adapter.core.agentManager.getAgent(session.agentName)
  if (!agent?.supportsResume) {
    await interaction.editReply('This agent does not support session resume.')
    return
  }

  const cmd = `${session.agentName} --resume ${session.agentSessionId}`
  await interaction.editReply(`\`\`\`\n${cmd}\n\`\`\`\nRun this in your terminal to resume the session.`)
}

export async function executeCancelSession(
  interaction: ButtonInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  // Find most recent active non-assistant session
  const sessions = adapter.core.sessionManager.listSessions()
    .filter(s => s.status === 'active' && s.id !== adapter.getAssistantSessionId())

  if (sessions.length === 0) {
    await interaction.followUp({ content: 'No active sessions to cancel.', ephemeral: true }).catch(() => {})
    return
  }

  const session = sessions[sessions.length - 1]
  try {
    await session.abortPrompt()
    await adapter.core.sessionManager.cancelSession(session.id)
    await interaction.followUp({ content: `Cancelled session: ${session.name ?? session.id}`, ephemeral: true }).catch(() => {})
  } catch (err) {
    log.error({ err }, 'Failed to cancel session via action')
  }
}

export async function handleCleanupButton(
  interaction: ButtonInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferUpdate()

  if (interaction.customId === 'm:cleanup:all') {
    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('m:cleanup:confirm')
          .setLabel('Confirm Delete All')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('m:cleanup:cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      )
    await interaction.message.edit({ content: 'Are you sure? This will delete all session threads.', components: [row] })
    return
  }

  if (interaction.customId === 'm:cleanup:cancel') {
    await interaction.message.edit({ content: 'Cleanup cancelled.', components: [] })
    return
  }

  if (interaction.customId === 'm:cleanup:confirm') {
    const sessions = adapter.core.sessionManager.listSessions()
      .filter(s => s.id !== adapter.getAssistantSessionId())

    let deleted = 0
    for (const session of sessions) {
      try {
        if (session.status === 'active') {
          await adapter.core.sessionManager.cancelSession(session.id)
        }
        if (session.threadId) {
          await adapter.deleteSessionThread(session.id)
        }
        deleted++
      } catch (err) {
        log.warn({ err, sessionId: session.id }, 'Failed to cleanup session')
      }
    }

    await interaction.message.edit({ content: `Cleaned up ${deleted} sessions.`, components: [] })
  }
}
```

- [ ] **Step 5: Create `src/adapters/discord/commands/admin.ts`**

```ts
import { type ChatInputCommandInteraction, type ButtonInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import type { DiscordAdapter } from '../adapter.js'
import { log } from '../../../core/logger.js'

export function buildDangerousModeKeyboard(sessionId: string, isDangerous: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`d:${sessionId}`)
        .setLabel(isDangerous ? '🔓 Disable Dangerous Mode' : '⚠️ Enable Dangerous Mode')
        .setStyle(isDangerous ? ButtonStyle.Success : ButtonStyle.Danger)
    )
}

export async function handleDangerous(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const threadId = interaction.channelId
  const session = adapter.core.sessionManager.getSessionByThread('discord', threadId)

  if (!session) {
    await interaction.editReply('No active session in this thread.')
    return
  }

  session.dangerousMode = !session.dangerousMode
  const status = session.dangerousMode ? 'enabled' : 'disabled'
  await interaction.editReply(`Dangerous mode ${status}.`)
}

export async function handleDangerousButton(
  interaction: ButtonInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferUpdate()

  const sessionId = interaction.customId.slice('d:'.length)
  const session = adapter.core.sessionManager.getSession(sessionId)
  if (!session) return

  session.dangerousMode = !session.dangerousMode
  const row = buildDangerousModeKeyboard(sessionId, session.dangerousMode)
  await interaction.message.edit({ components: [row] }).catch(() => {})
}

export async function handleRestart(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.reply({ content: 'Restarting OpenACP...', ephemeral: true })
  adapter.core.requestRestart()
}

export async function handleUpdate(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  try {
    const { checkForUpdate } = await import('../../../core/updater.js')
    const result = await checkForUpdate()
    if (result.updateAvailable) {
      await interaction.editReply(`Update available: ${result.currentVersion} → ${result.latestVersion}. Updating...`)
      await result.update()
      adapter.core.requestRestart()
    } else {
      await interaction.editReply(`Already on latest version (${result.currentVersion}).`)
    }
  } catch (err) {
    await interaction.editReply(`Update check failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
```

- [ ] **Step 6: Create remaining command files as stubs**

Create `src/adapters/discord/commands/menu.ts`, `agents.ts`, `doctor.ts`, `integrate.ts`, `settings.ts` — each following the same pattern as the Telegram equivalents but using Discord interactions.

For `menu.ts`:
```ts
import { type ChatInputCommandInteraction, type ButtonInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import type { DiscordAdapter } from '../adapter.js'

export function buildMenuKeyboard(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('m:new').setLabel('New Session').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('m:sessions').setLabel('Sessions').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('m:status').setLabel('Status').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('m:agents').setLabel('Agents').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('m:settings').setLabel('Settings').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('m:doctor').setLabel('Doctor').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('m:restart').setLabel('Restart').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('m:update').setLabel('Update').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('m:help').setLabel('Help').setStyle(ButtonStyle.Secondary),
    ),
  ]
}

export async function handleMenu(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.reply({ content: '**OpenACP Menu**', components: buildMenuKeyboard(), ephemeral: true })
}

export async function handleHelp(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  const help = [
    '**OpenACP Commands**',
    '`/new` — Create a new agent session',
    '`/cancel` — Cancel current session',
    '`/status` — Show session status',
    '`/sessions` — List all sessions',
    '`/agents` — List available agents',
    '`/menu` — Show main menu',
    '`/dangerous` — Toggle dangerous mode',
    '`/handoff` — Get terminal resume command',
    '`/doctor` — Run diagnostics',
    '`/settings` — Configure settings',
    '`/restart` — Restart OpenACP',
    '`/update` — Check for updates',
  ].join('\n')
  await interaction.reply({ content: help, ephemeral: true })
}

export async function handleClear(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  // Only works in assistant thread
  const assistantThreadId = adapter.getAssistantThreadId()
  if (interaction.channelId !== assistantThreadId) {
    await interaction.editReply('This command only works in the assistant thread.')
    return
  }

  await adapter.respawnAssistant()
  await interaction.editReply('Assistant session reset.')
}

export async function handleMenuButton(
  interaction: ButtonInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferUpdate()
  const id = interaction.customId

  // Route menu button clicks to the appropriate handler
  switch (id) {
    case 'm:new': {
      const { handleNew } = await import('./new-session.js')
      // Create a fake slash command-like interaction — just reply in the channel
      await interaction.message.edit({ content: 'Use `/new` to create a session.', components: [] })
      break
    }
    case 'm:sessions': {
      const sessions = adapter.core.sessionManager.listSessions()
      const lines = sessions.map(s =>
        `• **${s.name ?? s.id}** (${s.agentName}) — ${s.status}`
      )
      await interaction.message.edit({ content: lines.length > 0 ? lines.join('\n') : 'No sessions.', components: [] })
      break
    }
    case 'm:status': {
      const sessions = adapter.core.sessionManager.listSessions()
      const active = sessions.filter(s => s.status === 'active').length
      await interaction.message.edit({ content: `**Active sessions:** ${active}`, components: [] })
      break
    }
    case 'm:restart': {
      await interaction.message.edit({ content: 'Restarting...', components: [] })
      adapter.core.requestRestart()
      break
    }
    default:
      await interaction.message.edit({ content: `Use the \`/${id.slice(2)}\` command directly.`, components: [] })
  }
}
```

For `agents.ts`:
```ts
import { type ChatInputCommandInteraction, type ButtonInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js'
import type { DiscordAdapter } from '../adapter.js'
import { log } from '../../../core/logger.js'

export async function handleAgents(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const installed = adapter.core.agentManager.getAvailableAgents()
  const lines = installed.map(a => `✅ **${a.name}**${a.description ? ` — ${a.description}` : ''}`)

  const content = lines.length > 0
    ? `**Installed Agents:**\n${lines.join('\n')}`
    : 'No agents installed.'

  await interaction.editReply(content)
}

export async function handleInstall(
  interaction: ChatInputCommandInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const agentName = interaction.options.getString('agent', true)
  await interaction.editReply(`Installing **${agentName}**...`)

  try {
    await adapter.core.agentManager.installAgent(agentName, (progress) => {
      interaction.editReply(`Installing **${agentName}**: ${progress.message ?? 'working...'}`).catch(() => {})
    })
    await interaction.editReply(`✅ **${agentName}** installed successfully.`)
  } catch (err) {
    await interaction.editReply(`❌ Failed to install **${agentName}**: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function handleAgentButton(
  interaction: ButtonInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  await interaction.deferUpdate()

  if (interaction.customId.startsWith('ag:install:')) {
    const agentName = interaction.customId.slice('ag:install:'.length)
    await interaction.message.edit({ content: `Installing **${agentName}**...`, components: [] })
    try {
      await adapter.core.agentManager.installAgent(agentName)
      await interaction.message.edit({ content: `✅ **${agentName}** installed.`, components: [] })
    } catch (err) {
      await interaction.message.edit({ content: `❌ Failed: ${err instanceof Error ? err.message : String(err)}`, components: [] })
    }
  }
}
```

For `doctor.ts`, `integrate.ts`, `settings.ts` — create minimal stubs that defer to the core logic:

```ts
// doctor.ts
import type { ChatInputCommandInteraction, ButtonInteraction } from 'discord.js'
import type { DiscordAdapter } from '../adapter.js'

export async function handleDoctor(interaction: ChatInputCommandInteraction, adapter: DiscordAdapter): Promise<void> {
  await interaction.deferReply({ ephemeral: true })
  try {
    const { DoctorEngine } = await import('../../../core/doctor/engine.js')
    const engine = new DoctorEngine(adapter.core)
    const report = await engine.run()
    const lines = report.checks.map(c => `${c.passed ? '✅' : '❌'} ${c.name}: ${c.message}`)
    await interaction.editReply(lines.join('\n') || 'All checks passed.')
  } catch (err) {
    await interaction.editReply(`Doctor failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function handleDoctorButton(interaction: ButtonInteraction, adapter: DiscordAdapter): Promise<void> {
  await interaction.deferUpdate()
  // Handle fix buttons if needed
}
```

```ts
// integrate.ts
import type { ChatInputCommandInteraction, ButtonInteraction } from 'discord.js'
import type { DiscordAdapter } from '../adapter.js'

export async function handleIntegrate(interaction: ChatInputCommandInteraction, adapter: DiscordAdapter): Promise<void> {
  await interaction.deferReply({ ephemeral: true })
  await interaction.editReply('Integration management — use `/agents` to see available agents.')
}

export async function handleIntegrateButton(interaction: ButtonInteraction, adapter: DiscordAdapter): Promise<void> {
  await interaction.deferUpdate()
}
```

```ts
// settings.ts
import type { ChatInputCommandInteraction, ButtonInteraction } from 'discord.js'
import type { DiscordAdapter } from '../adapter.js'

export async function handleSettings(interaction: ChatInputCommandInteraction, adapter: DiscordAdapter): Promise<void> {
  await interaction.deferReply({ ephemeral: true })
  const config = adapter.core.configManager.get()
  const lines = [
    `**Default Agent:** ${config.defaultAgent}`,
    `**Run Mode:** ${config.runMode}`,
    `**Max Sessions:** ${config.security.maxConcurrentSessions}`,
    `**Log Level:** ${config.logging.level}`,
  ]
  await interaction.editReply(lines.join('\n'))
}

export async function handleSettingsButton(interaction: ButtonInteraction, adapter: DiscordAdapter): Promise<void> {
  await interaction.deferUpdate()
}
```

- [ ] **Step 7: Commit**

```bash
git add src/adapters/discord/commands/ && git commit -m "feat(discord): add slash commands and interaction routing"
```

---

### Task 11: Assistant

**Files:**
- Create: `src/adapters/discord/assistant.ts`

- [ ] **Step 1: Create `src/adapters/discord/assistant.ts`**

Port from Telegram. Uses `channelId: "discord"` and Discord-specific system prompt.

```ts
import type { OpenACPCore } from '../../core/core.js'
import type { Session } from '../../core/session.js'
import type { TextChannel, ThreadChannel } from 'discord.js'
import { log } from '../../core/logger.js'

export async function spawnAssistant(
  core: OpenACPCore,
  threadId: string,
): Promise<{ session: Session; ready: Promise<void> }> {
  const config = core.configManager.get()
  const defaultAgent = config.defaultAgent
  if (!defaultAgent) throw new Error('No default agent configured')

  const session = await core.createSession({
    channelId: 'discord',
    agentName: defaultAgent,
    createThread: false,
  })

  session.threadId = threadId

  const systemPrompt = buildAssistantSystemPrompt(core)
  const ready = session.enqueuePrompt(systemPrompt)

  return { session, ready }
}

export function buildWelcomeMessage(core: OpenACPCore): string {
  const sessions = core.sessionManager.listSessions()
  const active = sessions.filter(s => s.status === 'active')

  if (active.length === 0) {
    return '👋 **OpenACP Assistant** ready. Use `/new` to create a session or ask me anything!'
  }

  const lines = active.map(s => `• **${s.name ?? s.id}** (${s.agentName}) — ${s.status}`)
  return `👋 **OpenACP Assistant** ready.\n\n**Active sessions:**\n${lines.join('\n')}\n\nUse `/new` to create a session or ask me anything!`
}

function buildAssistantSystemPrompt(core: OpenACPCore): string {
  const config = core.configManager.get()
  const sessions = core.sessionManager.listSessions()
  const agents = core.agentManager.getAvailableAgents()

  const sessionList = sessions.length > 0
    ? sessions.map(s => `- ${s.name ?? s.id} (${s.agentName}): ${s.status}`).join('\n')
    : 'No active sessions'

  const agentList = agents.map(a => `- ${a.name}`).join('\n')

  return `You are the OpenACP Assistant running in Discord. You help users manage their AI coding agent sessions.

Current state:
- Default agent: ${config.defaultAgent}
- Installed agents:\n${agentList}
- Sessions:\n${sessionList}

When the user wants to:
- Create a new session: respond with /new [agent_name] [workspace_path]
- Cancel a session: respond with /cancel
- Check status: provide a summary of active sessions

Keep responses concise. Use Discord markdown formatting.
Reply with only 'ready' to acknowledge this system prompt.`
}

export async function handleAssistantMessage(
  session: Session,
  text: string,
): Promise<void> {
  await session.enqueuePrompt(text)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/discord/assistant.ts && git commit -m "feat(discord): add assistant session management"
```

---

### Task 12: Main Adapter Class

**Files:**
- Create: `src/adapters/discord/adapter.ts`

This is the central class that wires everything together.

- [ ] **Step 1: Create `src/adapters/discord/adapter.ts`**

```ts
import { Client, GatewayIntentBits, Events, type TextChannel, type ThreadChannel, type ForumChannel, type Guild, type Message } from 'discord.js'
import { ChannelAdapter } from '../../core/channel.js'
import type { OpenACPCore } from '../../core/core.js'
import type { OutgoingMessage, PermissionRequest, NotificationMessage, AgentCommand } from '../../core/types.js'
import type { DiscordChannelConfig } from './types.js'
import type { Session } from '../../core/session.js'
import { DiscordSendQueue } from './send-queue.js'
import { ToolCallTracker } from './tool-call-tracker.js'
import { DraftManager } from './draft-manager.js'
import { SkillCommandManager } from './skill-command-manager.js'
import { PermissionHandler } from './permissions.js'
import { ActivityTracker } from './activity.js'
import { ensureForums, ensureUnarchived, buildDeepLink } from './forums.js'
import * as forumOps from './forums.js'
import { registerSlashCommands, handleSlashCommand, setupButtonCallbacks } from './commands/index.js'
import { spawnAssistant, buildWelcomeMessage, handleAssistantMessage } from './assistant.js'
import { formatUsage } from './formatting.js'
import { log } from '../../core/logger.js'

export class DiscordAdapter extends ChannelAdapter<OpenACPCore> {
  private client: Client
  private discordConfig: DiscordChannelConfig
  private sendQueue: DiscordSendQueue
  private toolTracker: ToolCallTracker
  private draftManager: DraftManager
  private skillManager!: SkillCommandManager
  private permissionHandler!: PermissionHandler
  private sessionTrackers = new Map<string, ActivityTracker>()

  private guild!: Guild
  private forumChannel!: ForumChannel
  private notificationChannel!: TextChannel
  assistantSession: Session | null = null
  private assistantInitializing = false

  constructor(core: OpenACPCore, config: DiscordChannelConfig) {
    super(core, config)
    this.discordConfig = config
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })
    this.sendQueue = new DiscordSendQueue()
    this.toolTracker = new ToolCallTracker(this.sendQueue)
    this.draftManager = new DraftManager(this.sendQueue)
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, async () => {
        try {
          // Verify guild
          this.guild = this.client.guilds.cache.get(this.discordConfig.guildId)
            ?? await this.client.guilds.fetch(this.discordConfig.guildId)
          if (!this.guild) throw new Error(`Bot is not in guild ${this.discordConfig.guildId}`)

          // Ensure channels
          const saveConfig = async (updates: Record<string, unknown>) => {
            await this.core.configManager.save(updates)
          }
          const { forumChannel, notificationChannel } = await ensureForums(
            this.guild, this.discordConfig, saveConfig
          )
          this.forumChannel = forumChannel
          this.notificationChannel = notificationChannel

          // Initialize managers
          this.skillManager = new SkillCommandManager(this.sendQueue, this.core.sessionManager)
          this.permissionHandler = new PermissionHandler(
            this.sendQueue,
            (sessionId) => this.getSessionThread(sessionId),
            this.notificationChannel,
            this.discordConfig.guildId,
          )

          // Register slash commands
          await registerSlashCommands(this.guild)

          // Set up event handlers
          this.setupInteractionHandler()
          this.setupMessageHandler()

          // Welcome message
          await this.notificationChannel.send(buildWelcomeMessage(this.core)).catch(() => {})

          // Spawn assistant
          await this.setupAssistant()

          log.info({ guildId: this.guild.id }, 'Discord bot ready')
          resolve()
        } catch (err) {
          reject(err)
        }
      })

      this.client.on(Events.Error, (err) => {
        log.error({ err }, 'Discord client error')
      })

      this.client.login(this.discordConfig.botToken).catch(reject)
    })
  }

  async stop(): Promise<void> {
    if (this.assistantSession) {
      await this.assistantSession.destroy()
    }
    this.client.destroy()
    log.info('Discord bot stopped')
  }

  private setupInteractionHandler(): void {
    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          await handleSlashCommand(interaction, this)
        } else if (interaction.isButton()) {
          // Try permission handler first
          if (this.permissionHandler.handleButtonInteraction(interaction)) return
          // Then general button routing
          await setupButtonCallbacks(interaction, this)
        }
      } catch (err) {
        log.error({ err }, 'Interaction handler error')
      }
    })
  }

  private setupMessageHandler(): void {
    this.client.on(Events.MessageCreate, async (message) => {
      // Ignore bots
      if (message.author.bot) return
      // Ignore DMs
      if (!message.guild) return
      // Check guild
      if (message.guild.id !== this.discordConfig.guildId) return
      // Ignore non-thread messages (must be in a forum thread)
      if (!message.channel.isThread()) return

      const threadId = message.channel.id
      const userId = message.author.id
      const text = message.content

      if (!text) return

      // Check if this is the assistant thread
      if (threadId === this.discordConfig.assistantThreadId && this.assistantSession) {
        await handleAssistantMessage(this.assistantSession, text)
        return
      }

      // Route to core
      await this.core.handleMessage({
        channelId: 'discord',
        threadId,
        userId,
        text,
      })
    })
  }

  private async setupAssistant(): Promise<void> {
    if (!this.discordConfig.assistantThreadId) {
      // Create assistant thread in forum
      const thread = await this.forumChannel.threads.create({
        name: '🤖 Assistant',
        message: { content: 'OpenACP Assistant thread' },
        reason: 'OpenACP assistant',
      })
      this.discordConfig.assistantThreadId = thread.id
      await this.core.configManager.save({ channels: { discord: { assistantThreadId: thread.id } } })
    }

    try {
      this.assistantInitializing = true
      const { session, ready } = await spawnAssistant(
        this.core,
        this.discordConfig.assistantThreadId,
      )
      this.assistantSession = session
      await ready
      this.assistantInitializing = false
    } catch (err) {
      log.error({ err }, 'Failed to spawn assistant')
      this.assistantInitializing = false
    }
  }

  async respawnAssistant(): Promise<void> {
    if (this.assistantSession) {
      await this.assistantSession.destroy()
      this.assistantSession = null
    }
    await this.setupAssistant()
  }

  // --- ChannelAdapter interface ---

  async sendMessage(sessionId: string, content: OutgoingMessage): Promise<void> {
    // Suppress assistant init output
    if (this.assistantInitializing && sessionId === this.assistantSession?.id) return

    const thread = this.getSessionThread(sessionId)
    if (!thread) return

    await ensureUnarchived(thread as ThreadChannel)

    const tracker = this.getOrCreateTracker(sessionId, thread)

    switch (content.type) {
      case 'thought':
        tracker.onThought()
        break

      case 'text':
        tracker.onTextStart()
        this.draftManager.getOrCreate(sessionId, thread).append(content.text)
        this.draftManager.appendText(sessionId, content.text)
        break

      case 'tool_call': {
        tracker.onToolCall()
        await this.draftManager.finalize(sessionId)
        const meta = content.metadata ?? {}
        await this.toolTracker.trackNewCall(sessionId, thread, {
          id: meta.toolId as string ?? '',
          name: meta.toolName as string ?? 'Tool',
          content: content.text,
          kind: meta.kind as string,
        })
        break
      }

      case 'tool_update': {
        const meta = content.metadata ?? {}
        await this.toolTracker.updateCall(sessionId, {
          id: meta.toolId as string ?? '',
          name: meta.toolName as string,
          status: meta.status as string ?? 'completed',
          content: content.text,
          kind: meta.kind as string,
          viewerLinks: meta.viewerLinks as any,
          viewerFilePath: meta.viewerFilePath as string,
        })
        break
      }

      case 'plan': {
        const entries = content.metadata?.entries as any[] ?? []
        tracker.onPlan(entries)
        break
      }

      case 'usage': {
        const usage = content.metadata as any
        await this.draftManager.finalize(sessionId)
        if (usage) await tracker.sendUsage(usage)

        // Send notification
        if (this.notificationChannel && usage) {
          const session = this.core.sessionManager.getSession(sessionId)
          const link = session?.threadId
            ? buildDeepLink(this.discordConfig.guildId, session.threadId)
            : ''
          const name = session?.name ?? sessionId
          await this.notificationChannel.send(
            `📊 **${name}** — ${formatUsage(usage).split('\n')[0]} ${link ? `[View](${link})` : ''}`
          ).catch(() => {})
        }
        break
      }

      case 'session_end':
        await this.draftManager.finalize(
          sessionId,
          thread,
          sessionId === this.assistantSession?.id,
        )
        tracker.cleanup()
        this.toolTracker.cleanup(sessionId)
        this.sessionTrackers.delete(sessionId)
        await this.sendQueue.enqueue(
          () => thread.send('✅ Done'),
          { type: 'other' }
        )
        break

      case 'error':
        await this.draftManager.finalize(sessionId)
        tracker.cleanup()
        this.toolTracker.cleanup(sessionId)
        this.sessionTrackers.delete(sessionId)
        await this.sendQueue.enqueue(
          () => thread.send(`❌ **Error:** ${content.text}`),
          { type: 'other' }
        )
        break
    }
  }

  async sendPermissionRequest(sessionId: string, request: PermissionRequest): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId)
    if (!session) return

    // Auto-approve openacp commands
    if (request.description?.includes('openacp')) {
      const allowOption = request.options.find(o => o.isAllow)
      if (allowOption) {
        session.permissionGate.resolve(allowOption.id)
        return
      }
    }

    // Auto-approve dangerous mode
    if (session.dangerousMode) {
      const allowOption = request.options.find(o => o.isAllow)
      if (allowOption) {
        session.permissionGate.resolve(allowOption.id)
        return
      }
    }

    await this.permissionHandler.sendPermissionRequest(session, request)
  }

  async sendNotification(notification: NotificationMessage): Promise<void> {
    if (!this.notificationChannel) return

    const link = notification.deepLink ?? ''
    const text = `📢 **${notification.sessionName ?? 'Session'}** — ${notification.summary} ${link}`

    await this.sendQueue.enqueue(
      () => this.notificationChannel.send(text),
      { type: 'other' }
    ).catch(err => log.warn({ err }, 'Failed to send notification'))
  }

  async createSessionThread(sessionId: string, name: string): Promise<string> {
    const thread = await forumOps.createSessionThread(this.forumChannel, name)
    return thread.id
  }

  async renameSessionThread(sessionId: string, newName: string): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId)
    if (!session?.threadId) return
    await forumOps.renameSessionThread(this.guild, session.threadId, newName)
  }

  async deleteSessionThread(sessionId: string): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId)
    if (!session?.threadId) return
    await forumOps.deleteSessionThread(this.guild, session.threadId)
  }

  async sendSkillCommands(sessionId: string, commands: AgentCommand[]): Promise<void> {
    const thread = this.getSessionThread(sessionId)
    if (!thread) return
    await this.skillManager.send(sessionId, thread, commands)
  }

  async cleanupSkillCommands(sessionId: string): Promise<void> {
    await this.skillManager.cleanup(sessionId)
  }

  // --- Public helpers for commands ---

  getForumChannel(): ForumChannel | null { return this.forumChannel ?? null }
  getGuildId(): string { return this.discordConfig.guildId }
  getAssistantSessionId(): string | null { return this.assistantSession?.id ?? null }
  getAssistantThreadId(): string | null { return this.discordConfig.assistantThreadId }

  private getSessionThread(sessionId: string): TextChannel | ThreadChannel | null {
    const session = this.core.sessionManager.getSession(sessionId)
    if (!session?.threadId) return null
    const channel = this.guild.channels.cache.get(session.threadId)
    return (channel as TextChannel | ThreadChannel) ?? null
  }

  private getOrCreateTracker(sessionId: string, thread: TextChannel | ThreadChannel): ActivityTracker {
    let tracker = this.sessionTrackers.get(sessionId)
    if (!tracker) {
      tracker = new ActivityTracker(thread, this.sendQueue)
      this.sessionTrackers.set(sessionId, tracker)
    }
    return tracker
  }
}
```

- [ ] **Step 2: Verify `index.ts` export resolves**

The `src/adapters/discord/index.ts` created in Task 1 exports from `./adapter.js` — this should now work.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/discord/adapter.ts && git commit -m "feat(discord): add main DiscordAdapter class"
```

---

### Task 13: Integration — main.ts, core.ts, session-manager.ts, TopicManager

**Files:**
- Modify: `src/main.ts:72-94` (add Discord adapter registration)
- Modify: `src/main.ts:183-195` (guard TopicManager for Telegram-only)
- Modify: `src/core/core.ts:232-237` (make platform storage channel-aware)
- Modify: `src/core/session-manager.ts:74-79` (make getRecordByThread channel-aware)

- [ ] **Step 1: Fix platform storage in core.ts to be channel-aware**

In `src/core/core.ts` around line 232-237, the current code is:

```ts
if (session.threadId) {
  platform.topicId = Number(session.threadId);
}
```

This is Telegram-specific (integer topic IDs). Discord uses string snowflake IDs that exceed `Number.MAX_SAFE_INTEGER`. Replace with:

```ts
if (session.threadId) {
  if (params.channelId === 'telegram') {
    platform.topicId = Number(session.threadId);
  } else {
    platform.threadId = session.threadId;
  }
}
```

This preserves backward compatibility for Telegram while supporting Discord's string IDs.

- [ ] **Step 2: Fix getRecordByThread in session-manager.ts to handle Discord**

In `src/core/session-manager.ts` around line 74-79, the current code uses Telegram-specific `p.topicId` lookup:

```ts
getRecordByThread(channelId: string, threadId: string): SessionRecord | undefined {
  return this.store?.findByPlatform(
    channelId,
    (p) => String(p.topicId) === threadId,
  );
}
```

Replace with a channel-aware lookup:

```ts
getRecordByThread(channelId: string, threadId: string): SessionRecord | undefined {
  return this.store?.findByPlatform(
    channelId,
    (p) => String(p.topicId) === threadId || p.threadId === threadId,
  );
}
```

This checks both `topicId` (Telegram) and `threadId` (Discord) fields, maintaining backward compat.

- [ ] **Step 3: Add Discord adapter to main.ts registration loop**

In `src/main.ts` after the Telegram `if` block (line 78), add:

```ts
} else if (channelName === 'discord') {
  const { DiscordAdapter } = await import('./adapters/discord/index.js')
  core.registerAdapter('discord', new DiscordAdapter(core, channelConfig as any))
  log.info({ adapter: 'discord' }, 'Adapter registered')
}
```

Note: Use dynamic import to avoid loading discord.js when Discord is not enabled.

- [ ] **Step 4: Guard TopicManager creation**

In `src/main.ts` around lines 183-195, wrap `TopicManager` creation:

```ts
const telegramAdapter = core.adapters.get('telegram') ?? null
let topicManager: TopicManager | undefined
if (telegramAdapter) {
  const telegramCfg = updatedConfig.channels?.telegram as any
  topicManager = new TopicManager(
    core.sessionManager,
    telegramAdapter,
    {
      notificationTopicId: telegramCfg?.notificationTopicId ?? null,
      assistantTopicId: telegramCfg?.assistantTopicId ?? null,
    },
  )
}

apiServer = new ApiServer(core, config.api, undefined, topicManager ?? null)
```

Check if `ApiServer` constructor accepts `null` for `topicManager`. If not, make it optional.

- [ ] **Step 5: Build and verify**

```bash
pnpm build 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/core/core.ts src/core/session-manager.ts && git commit -m "feat(discord): integrate Discord adapter in main.ts, fix channel-aware platform storage"
```

---

### Task 14: Doctor Check

**Files:**
- Create: `src/core/doctor/checks/discord.ts`
- Modify: `src/core/doctor/engine.ts` (register Discord check)

- [ ] **Step 1: Create `src/core/doctor/checks/discord.ts`**

Follow the same `DoctorCheck` pattern as `telegram.ts`:

```ts
import type { DoctorCheck } from '../engine.js'

export const discordCheck: DoctorCheck = {
  name: 'Discord',
  async run(core) {
    const results = []
    const config = core.configManager.get()
    const discord = config.channels?.discord as any

    if (!discord?.enabled) {
      return [{ name: 'Discord', passed: true, message: 'Discord not enabled (skipped)' }]
    }

    // Check bot token format
    const token = discord.botToken
    if (!token || token === 'YOUR_DISCORD_BOT_TOKEN') {
      results.push({ name: 'Discord Bot Token', passed: false, message: 'Bot token not configured' })
      return results
    }
    results.push({ name: 'Discord Bot Token', passed: true, message: 'Token configured' })

    // Validate token via API
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
      })
      if (res.ok) {
        const user = await res.json() as { username: string }
        results.push({ name: 'Discord API', passed: true, message: `Bot: ${user.username}` })
      } else {
        results.push({ name: 'Discord API', passed: false, message: `API returned ${res.status}` })
        return results
      }
    } catch (err) {
      results.push({ name: 'Discord API', passed: false, message: `API unreachable: ${err}` })
      return results
    }

    // Check guild access
    if (discord.guildId) {
      try {
        const res = await fetch(`https://discord.com/api/v10/guilds/${discord.guildId}`, {
          headers: { Authorization: `Bot ${token}` },
        })
        if (res.ok) {
          results.push({ name: 'Discord Guild', passed: true, message: 'Guild accessible' })
        } else {
          results.push({ name: 'Discord Guild', passed: false, message: `Guild returned ${res.status}` })
        }
      } catch {
        results.push({ name: 'Discord Guild', passed: false, message: 'Guild check failed' })
      }
    } else {
      results.push({ name: 'Discord Guild', passed: false, message: 'Guild ID not configured' })
    }

    return results
  },
}
```

- [ ] **Step 2: Register in doctor engine**

Find where `telegramCheck` is registered in `src/core/doctor/engine.ts` and add `discordCheck` alongside it.

- [ ] **Step 3: Commit**

```bash
git add src/core/doctor/checks/discord.ts src/core/doctor/engine.ts && git commit -m "feat(discord): add Discord doctor health check"
```

---

### Task 15: Setup Flow

**Files:**
- Modify: `src/core/setup.ts`

- [ ] **Step 1: Add `setupDiscord()` function**

Add after `setupTelegram()`:

```ts
async function setupDiscord(): Promise<DiscordChannelConfig> {
  console.log('\n📱 Discord Setup\n')

  const botToken = await input({
    message: 'Discord Bot Token:',
    validate: (val) => val.length > 0 || 'Token is required',
  })

  // Validate token
  console.log('Validating token...')
  const res = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${botToken}` },
  })
  if (!res.ok) {
    throw new Error(`Invalid Discord bot token (HTTP ${res.status})`)
  }
  const botUser = await res.json() as { username: string }
  console.log(`✅ Bot: ${botUser.username}`)

  const guildId = await input({
    message: 'Guild (Server) ID:',
    validate: (val) => /^\d+$/.test(val) || 'Must be a numeric ID',
  })

  return {
    enabled: true,
    botToken,
    guildId,
    forumChannelId: null,
    notificationChannelId: null,
    assistantThreadId: null,
  }
}
```

- [ ] **Step 2: Add channel selection to `runSetup()`**

Before the Telegram setup step, add a channel selection prompt:

```ts
const { select } = await import('@inquirer/prompts')
const channelChoice = await select({
  message: 'Which channel to enable?',
  choices: [
    { name: 'Telegram', value: 'telegram' },
    { name: 'Discord', value: 'discord' },
    { name: 'Both', value: 'both' },
  ],
})
```

Then conditionally run `setupTelegram()` and/or `setupDiscord()` based on the choice. Construct the `channels` object accordingly.

- [ ] **Step 3: Build and verify**

```bash
pnpm build 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add src/core/setup.ts && git commit -m "feat(discord): add Discord to interactive setup flow"
```

---

### Task 16: Build, Test, Final Verification

- [ ] **Step 1: Full build**

```bash
pnpm build
```

Fix any TypeScript errors.

- [ ] **Step 2: Run all tests**

```bash
pnpm test
```

Ensure existing tests still pass and Discord formatting tests pass.

- [ ] **Step 3: Run linter if configured**

```bash
pnpm lint 2>&1 | tail -20
```

- [ ] **Step 4: Final commit**

```bash
git add -A && git commit -m "feat(discord): complete Discord adapter with full feature parity"
```
