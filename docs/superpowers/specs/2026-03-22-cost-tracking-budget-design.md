# Session Cost Tracking & Budget Limits — Design Spec

**Date**: 2026-03-22
**Status**: Reviewed
**Author**: peterparker

## Overview

Track per-session token usage and cost across all sessions. Store usage data locally, provide budget warnings when approaching limits, and expose a `/usage` Telegram command for on-demand reporting.

This feature fills a gap: the ACP `usage` event already provides `tokensUsed`, `contextSize`, and `cost` per prompt cycle, but the data is displayed once and discarded. Users have no way to know how much they've spent today, this week, or this month — and no way to set spending limits.

## Goals

- Persist usage data (tokens, cost) per session to local JSON file
- Aggregate usage by time period (today, week, month)
- Configurable monthly budget with warning threshold (soft limit, no blocking)
- Telegram `/usage` command for on-demand reporting
- Budget warning notifications via Notifications topic

## Non-Goals

- Hard blocking when budget exceeded (warning only)
- Multi-user / team quota management
- Per-agent budget limits
- CLI `openacp usage` command (Telegram only for now)
- External billing integration

## Architecture

```
usage event (ACP)
    │
    ▼
OpenACPCore.wireSessionEvents()
    │
    ├──► UsageStore.append(record)     ── ~/.openacp/usage.json
    │
    └──► UsageBudget.check()
              │
              └──► NotificationManager.notifyAll()  ── warning/exceeded
                        │
                        ▼
                   Telegram Notifications topic

/usage command (Telegram)
    │
    ▼
UsageStore.query(period)
    │
    ▼
UsageSummary → formatted message
```

## Data Model

### UsageRecord

```typescript
interface UsageRecord {
  id: string                // nanoid, unique per record
  sessionId: string         // links to session
  agentName: string         // which agent was used
  tokensUsed: number        // from usage event
  contextSize: number       // from usage event
  cost?: {
    amount: number          // e.g. 0.05
    currency: string        // e.g. 'USD'
  }
  timestamp: string         // ISO 8601
}
```

One record is appended per `usage` event (each prompt cycle emits one). A session with 5 prompts produces 5 records.

### UsageSummary

```typescript
interface UsageSummary {
  period: 'today' | 'week' | 'month' | 'all'
  totalTokens: number
  totalCost: number
  currency: string
  sessionCount: number       // unique sessionIds in period
  recordCount: number        // total records in period
}
```

### Config Schema

```typescript
// Added to existing config.ts Zod schema
usage: z.object({
  enabled: z.boolean().default(true),
  monthlyBudget: z.number().optional(),       // e.g. 10.00
  warningThreshold: z.number().default(0.8),  // 0.0–1.0, default 80%
  currency: z.string().default('USD'),
  retentionDays: z.number().default(90),
}).default({})
```

Backward compatible: `.default({})` means existing configs without `usage` section work without changes. No auto-migration needed (unlike `tunnel` section) because the feature works with all defaults — users opt in to budget by explicitly setting `monthlyBudget`.

Add `usage: {}` to `DEFAULT_CONFIG` in `config.ts` for discoverability in generated config files on first run.

## Components

### UsageStore (`core/usage-store.ts`)

JSON file store at `~/.openacp/usage.json`. Follows the same pattern as `JsonFileSessionStore`.

**File format** (versioned for forward compatibility, matching `session-store.ts`):
```json
{ "version": 1, "records": [...] }
```

```typescript
class UsageStore {
  private records: UsageRecord[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private flushHandler: (() => void) | null = null

  constructor(private filePath: string, private retentionDays: number)
  // Constructor calls load() and cleanup() synchronously (same as JsonFileSessionStore).
  // Registers flushSync() on SIGTERM, SIGINT, exit (same pattern as session-store.ts).
  // Starts daily cleanup interval.

  private load(): void
  // Synchronous read into memory. If file doesn't exist, start empty.
  // If file is corrupt, backup as usage.json.bak, start empty.

  append(record: UsageRecord): void
  // Push to in-memory array, schedule debounced write (2s).

  query(period: 'today' | 'week' | 'month' | 'all'): UsageSummary
  // Filter records by timestamp:
  //   today  → since 00:00 local time
  //   week   → last 7 days
  //   month  → last 30 days
  //   all    → everything
  // Return aggregated UsageSummary.
  // O(n) scan — acceptable for personal use (~9,000 records at 100 prompts/day × 90 days).

  cleanup(): void
  // Remove records older than retentionDays. All records are eligible (no "active" guard needed,
  // unlike session-store which skips active sessions).

  flushSync(): void
  // Synchronous write to disk using fs.writeFileSync (matching JsonFileSessionStore.flushSync).
  // Must be synchronous because 'exit' event cannot await async operations.

  destroy(): void
  // Clear debounce timer, cleanup interval, remove signal handlers.

  getMonthlyTotal(): { totalCost: number; currency: string }
  // Convenience method for budget checking. Returns current calendar month's total.
}
```

**Debounced write**: 2s timer (matching `DEBOUNCE_MS` in session-store). If new append arrives before timer fires, reset timer. This batches rapid usage events without losing data.

**Cleanup**: On startup, remove records older than `retentionDays`. Start a daily `setInterval` for ongoing cleanup. Clear interval on `destroy()`.

### UsageBudget (`core/usage-budget.ts`)

Stateless checker — reads from UsageStore, decides if warning needed.

```typescript
class UsageBudget {
  private lastNotifiedStatus: 'ok' | 'warning' | 'exceeded' = 'ok'

  constructor(
    private store: UsageStore,
    private config: UsageBudgetConfig,
  )

  check(): { status: 'ok' | 'warning' | 'exceeded'; message?: string }
  // 1. If !config.monthlyBudget → return { status: 'ok' }
  // 2. Get store.getMonthlyTotal()
  // 3. If totalCost >= monthlyBudget → 'exceeded'
  // 4. If totalCost >= warningThreshold * monthlyBudget → 'warning'
  // 5. Otherwise → 'ok'
  // 6. Only return message if status changed from lastNotifiedStatus
  //    (prevents spamming same warning every prompt)

  getStatus(): { status: 'ok' | 'warning' | 'exceeded'; used: number; budget: number; percent: number }
  // For display in /usage command. Always returns current state.
}
```

**De-duplication**: `lastNotifiedStatus` ensures each threshold crossing triggers exactly one notification. Tracks `lastNotifiedMonth: number` (0–11) — when `check()` detects the current month differs from `lastNotifiedMonth`, it resets `lastNotifiedStatus` to `'ok'` and updates the month. This handles process running across month boundaries correctly.

### Warning Messages

Sent via `NotificationManager` to Notifications topic:

**Warning (80%)**:
```
⚠️ Budget Warning
Monthly usage: $8.50 / $10.00 (85%)
▓▓▓▓▓▓▓▓░░ 85%
```

**Exceeded (100%)**:
```
🚨 Budget Exceeded
Monthly usage: $10.20 / $10.00 (102%)
▓▓▓▓▓▓▓▓▓▓ 102%
Sessions are NOT blocked — this is a warning only.
```

## Core Wiring

### Initialization inside `OpenACPCore` constructor

Following the existing pattern where `OpenACPCore` creates its own `JsonFileSessionStore`, `SessionManager`, and `NotificationManager` internally (see `core.ts` lines 31–41), the `UsageStore` and `UsageBudget` are also created inside the constructor:

```typescript
// In OpenACPCore constructor (core.ts)
constructor(configManager: ConfigManager) {
  // ... existing initialization ...

  // NEW: Usage tracking
  const usageConfig = config.usage
  if (usageConfig.enabled) {
    const usagePath = path.join(os.homedir(), '.openacp', 'usage.json')
    this.usageStore = new UsageStore(usagePath, usageConfig.retentionDays)
    this.usageBudget = new UsageBudget(this.usageStore, usageConfig)
  }
}
```

Properties exposed on `OpenACPCore` so Telegram adapter can access for `/usage` command:
```typescript
usageStore: UsageStore | null = null
usageBudget: UsageBudget | null = null
```

Shutdown: `UsageStore.destroy()` called from `core.stop()`. The store also self-registers `flushSync()` on SIGTERM/SIGINT/exit (same as `JsonFileSessionStore`).

### Event wiring in `wireSessionEvents()`

```typescript
// Inside the usage event handler (already exists for ActivityTracker)
case 'usage':
  // Existing: adapter activity tracker display
  // NEW: persist and check budget
  if (this.usageStore) {
    const record: UsageRecord = {
      id: nanoid(),
      sessionId: session.id,
      agentName: session.agentName,
      tokensUsed: event.tokensUsed ?? 0,
      contextSize: event.contextSize ?? 0,
      cost: event.cost,
      timestamp: new Date().toISOString(),
    }
    this.usageStore.append(record)

    if (this.usageBudget) {
      const result = this.usageBudget.check()
      if (result.message) {
        // Use notifyAll() with proper NotificationMessage structure
        // Extends NotificationMessage.type with 'budget_warning'
        this.notificationManager.notifyAll({
          sessionId: session.id,
          sessionName: session.name,
          type: 'budget_warning',
          summary: result.message,
        })
      }
    }
  }
  break
```

### NotificationMessage type extension

Add `'budget_warning'` to the existing `NotificationMessage.type` union in `types.ts`:

```typescript
export interface NotificationMessage {
  sessionId: string;
  sessionName?: string;
  type: "completed" | "error" | "permission" | "input_required" | "budget_warning";
  summary: string;
  deepLink?: string;
}
```

## Telegram Integration

### `/usage` Command

Register in `commands.ts` alongside existing commands. The handler accesses usage data via `core.usageStore` (exposed as public property on `OpenACPCore`). Reuse existing `progressBar()` and `formatTokens()` helpers from `formatting.ts` for consistent visual style.

```
/usage          — show all periods (today + week + month)
/usage today    — today only
/usage week     — this week only
/usage month    — this month only
```

**Output format**:

```
📊 Usage Report

── This Month ──
💰 $5.40 · 🔤 1,234,567 tokens · 📋 23 sessions
Budget: $5.40 / $10.00 (54%)
▓▓▓▓▓░░░░░ 54%

── This Week ──
💰 $3.20 · 🔤 756,123 tokens · 📋 12 sessions

── Today ──
💰 $0.80 · 🔤 189,234 tokens · 📋 3 sessions
```

If no `monthlyBudget` configured, omit the budget/progress bar lines.

If no usage data exists: `"No usage data yet."`

### Static Command Registration

Add to `setMyCommands()`:
```typescript
{ command: 'usage', description: 'View token usage and cost report' }
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Store file write fails | Log warning, keep in-memory data, retry next debounce |
| Store file corrupt on load | Backup as `usage.json.bak`, start with empty array |
| Usage event missing `cost` | Record with `cost: undefined`, count tokens only |
| Usage event missing `tokensUsed` | Record with `tokensUsed: 0` |
| Budget check fails | Log warning, skip notification, session continues |
| `/usage` query fails | Reply with "Failed to load usage data" |

All errors are non-critical. Usage tracking must never crash the application or block session operations.

## Testing Strategy

- **Unit tests** for `UsageStore`: append, query periods, cleanup, flush, corrupt file recovery
- **Unit tests** for `UsageBudget`: threshold detection, de-duplication, month boundary reset
- **Unit tests** for `/usage` command: message formatting, period parsing
- **Integration test**: usage event → store append → budget check → notification flow
