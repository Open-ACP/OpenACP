# Session Cost Tracking & Budget Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-session token usage and cost data, provide budget warnings, and expose a `/usage` Telegram command for on-demand reporting.

**Architecture:** A `UsageStore` in core persists `UsageRecord` entries to `~/.openacp/usage.json` (one record per ACP `usage` event). A `UsageBudget` checker compares monthly totals against a configurable budget and emits one-time warnings via `NotificationManager`. The Telegram adapter adds a `/usage` command that queries the store and formats a report with progress bars.

**Tech Stack:** TypeScript, Zod (config validation), Node.js fs (JSON file I/O), nanoid (record IDs), grammy (Telegram commands)

**Spec:** `docs/superpowers/specs/2026-03-22-cost-tracking-budget-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/core/usage-store.ts` | `UsageStore` class — append, query, cleanup, flush |
| Create | `src/core/usage-budget.ts` | `UsageBudget` class — threshold checking, de-duplication |
| Create | `src/__tests__/usage-store.test.ts` | Unit tests for `UsageStore` |
| Create | `src/__tests__/usage-budget.test.ts` | Unit tests for `UsageBudget` |
| Modify | `src/core/types.ts:34-40` | Add `'budget_warning'` to `NotificationMessage.type` union |
| Modify | `src/core/config.ts:58-87` | Add `usage` section to `ConfigSchema` |
| Modify | `src/core/config.ts:98-128` | Add `usage: {}` to `DEFAULT_CONFIG` |
| Modify | `src/core/core.ts:1-42` | Import UsageStore/UsageBudget, create in constructor |
| Modify | `src/core/core.ts:381-435` | Wire usage event to store + budget check in `wireSessionEvents()` |
| Modify | `src/core/core.ts:54-73` | Call `usageStore.destroy()` in `stop()` |
| Modify | `src/core/index.ts` | Export `UsageStore` and `UsageBudget` |
| Modify | `src/adapters/telegram/commands.ts:17-32` | Add `/usage` command handler |
| Modify | `src/adapters/telegram/commands.ts:587-597` | Add `usage` to `STATIC_COMMANDS` |
| Modify | `src/adapters/telegram/formatting.ts` | Add `formatUsageReport()` helper |
| Create | `src/__tests__/usage-command.test.ts` | Unit tests for `/usage` formatting |

---

### Task 1: UsageRecord and UsageSummary Types

**Files:**
- Modify: `src/core/types.ts:34-40`

- [ ] **Step 1: Add `'budget_warning'` to NotificationMessage type union**

In `src/core/types.ts`, find the `NotificationMessage` interface (line 34) and add `'budget_warning'` to the type union:

```typescript
export interface NotificationMessage {
  sessionId: string;
  sessionName?: string;
  type: "completed" | "error" | "permission" | "input_required" | "budget_warning";
  summary: string;
  deepLink?: string;
}
```

- [ ] **Step 2: Add UsageRecord and UsageSummary types**

Append at the end of `src/core/types.ts`:

```typescript
export interface UsageRecord {
  id: string;
  sessionId: string;
  agentName: string;
  tokensUsed: number;
  contextSize: number;
  cost?: { amount: number; currency: string };
  timestamp: string;
}

export interface UsageSummary {
  period: "today" | "week" | "month" | "all";
  totalTokens: number;
  totalCost: number;
  currency: string;
  sessionCount: number;
  recordCount: number;
}

export interface UsageBudgetConfig {
  enabled: boolean;
  monthlyBudget?: number;
  warningThreshold: number;
  currency: string;
  retentionDays: number;
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts
git commit -m "feat(types): add UsageRecord, UsageSummary, UsageBudgetConfig types and budget_warning notification"
```

---

### Task 2: UsageStore

**Files:**
- Create: `src/core/usage-store.ts`
- Create: `src/__tests__/usage-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/usage-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { UsageStore } from "../core/usage-store.js";
import type { UsageRecord } from "../core/types.js";

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "rec-1",
    sessionId: "sess-1",
    agentName: "claude",
    tokensUsed: 1000,
    contextSize: 200000,
    cost: { amount: 0.05, currency: "USD" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("UsageStore", () => {
  let tmpDir: string;
  let filePath: string;
  let store: UsageStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-usage-test-"));
    filePath = path.join(tmpDir, "usage.json");
    store = new UsageStore(filePath, 90);
  });

  afterEach(() => {
    store.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends and queries records", () => {
    const record = makeRecord();
    store.append(record);
    const summary = store.query("all");
    expect(summary.totalTokens).toBe(1000);
    expect(summary.totalCost).toBe(0.05);
    expect(summary.sessionCount).toBe(1);
    expect(summary.recordCount).toBe(1);
  });

  it("aggregates multiple records", () => {
    store.append(makeRecord({ id: "r1", sessionId: "s1", tokensUsed: 1000, cost: { amount: 0.05, currency: "USD" } }));
    store.append(makeRecord({ id: "r2", sessionId: "s1", tokensUsed: 2000, cost: { amount: 0.10, currency: "USD" } }));
    store.append(makeRecord({ id: "r3", sessionId: "s2", tokensUsed: 500, cost: { amount: 0.02, currency: "USD" } }));
    const summary = store.query("all");
    expect(summary.totalTokens).toBe(3500);
    expect(summary.totalCost).toBeCloseTo(0.17);
    expect(summary.sessionCount).toBe(2);
    expect(summary.recordCount).toBe(3);
  });

  it("filters by today", () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0); // midnight yesterday

    store.append(makeRecord({ id: "r1", timestamp: yesterday.toISOString(), tokensUsed: 500 }));
    store.append(makeRecord({ id: "r2", timestamp: now.toISOString(), tokensUsed: 1000 }));

    const summary = store.query("today");
    expect(summary.totalTokens).toBe(1000);
    expect(summary.recordCount).toBe(1);
  });

  it("filters by week", () => {
    const now = new Date();
    const twoWeeksAgo = new Date(now);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    store.append(makeRecord({ id: "r1", timestamp: twoWeeksAgo.toISOString(), tokensUsed: 500 }));
    store.append(makeRecord({ id: "r2", timestamp: now.toISOString(), tokensUsed: 1000 }));

    const summary = store.query("week");
    expect(summary.totalTokens).toBe(1000);
    expect(summary.recordCount).toBe(1);
  });

  it("filters by month", () => {
    const now = new Date();
    const twoMonthsAgo = new Date(now);
    twoMonthsAgo.setDate(twoMonthsAgo.getDate() - 60);

    store.append(makeRecord({ id: "r1", timestamp: twoMonthsAgo.toISOString(), tokensUsed: 500 }));
    store.append(makeRecord({ id: "r2", timestamp: now.toISOString(), tokensUsed: 1000 }));

    const summary = store.query("month");
    expect(summary.totalTokens).toBe(1000);
    expect(summary.recordCount).toBe(1);
  });

  it("handles records without cost", () => {
    store.append(makeRecord({ id: "r1", cost: undefined }));
    const summary = store.query("all");
    expect(summary.totalTokens).toBe(1000);
    expect(summary.totalCost).toBe(0);
  });

  it("flushes to disk synchronously", () => {
    store.append(makeRecord());
    store.flushSync();
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.records).toHaveLength(1);
    expect(raw.records[0].id).toBe("rec-1");
  });

  it("loads from existing file", () => {
    store.append(makeRecord());
    store.flushSync();
    store.destroy();

    const store2 = new UsageStore(filePath, 90);
    const summary = store2.query("all");
    expect(summary.recordCount).toBe(1);
    store2.destroy();
  });

  it("handles corrupt file gracefully", () => {
    fs.writeFileSync(filePath, "NOT VALID JSON{{{");
    const store2 = new UsageStore(filePath, 90);
    const summary = store2.query("all");
    expect(summary.recordCount).toBe(0);
    // Should create backup
    expect(fs.existsSync(filePath + ".bak")).toBe(true);
    store2.destroy();
  });

  it("cleans up old records", () => {
    const old = new Date();
    old.setDate(old.getDate() - 100); // older than 90 days
    store.append(makeRecord({ id: "old", timestamp: old.toISOString() }));
    store.append(makeRecord({ id: "new", timestamp: new Date().toISOString() }));
    store.cleanup();
    const summary = store.query("all");
    expect(summary.recordCount).toBe(1);
  });

  it("getMonthlyTotal returns current calendar month total", () => {
    const now = new Date();
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(15);

    store.append(makeRecord({ id: "r1", timestamp: lastMonth.toISOString(), cost: { amount: 5.00, currency: "USD" } }));
    store.append(makeRecord({ id: "r2", timestamp: now.toISOString(), cost: { amount: 3.00, currency: "USD" } }));

    const total = store.getMonthlyTotal();
    expect(total.totalCost).toBe(3.00);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/__tests__/usage-store.test.ts`
Expected: FAIL — `UsageStore` does not exist yet

- [ ] **Step 3: Implement UsageStore**

Create `src/core/usage-store.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { UsageRecord, UsageSummary } from "./types.js";
import { createChildLogger } from "./log.js";

const log = createChildLogger({ module: "usage-store" });

interface StoreFile {
  version: number;
  records: UsageRecord[];
}

const DEBOUNCE_MS = 2000;

export class UsageStore {
  private records: UsageRecord[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private flushHandler: (() => void) | null = null;

  constructor(
    private filePath: string,
    private retentionDays: number,
  ) {
    this.load();
    this.cleanup();

    this.cleanupInterval = setInterval(
      () => this.cleanup(),
      24 * 60 * 60 * 1000,
    );

    this.flushHandler = () => this.flushSync();
    process.on("SIGTERM", this.flushHandler);
    process.on("SIGINT", this.flushHandler);
    process.on("exit", this.flushHandler);
  }

  append(record: UsageRecord): void {
    this.records.push(record);
    this.scheduleDiskWrite();
  }

  query(period: "today" | "week" | "month" | "all"): UsageSummary {
    const cutoff = this.getCutoff(period);
    const filtered = cutoff
      ? this.records.filter((r) => new Date(r.timestamp).getTime() >= cutoff)
      : this.records;

    const totalTokens = filtered.reduce((sum, r) => sum + r.tokensUsed, 0);
    const totalCost = filtered.reduce(
      (sum, r) => sum + (r.cost?.amount ?? 0),
      0,
    );
    const sessionIds = new Set(filtered.map((r) => r.sessionId));
    const currency =
      filtered.find((r) => r.cost?.currency)?.cost?.currency ?? "USD";

    return {
      period,
      totalTokens,
      totalCost,
      currency,
      sessionCount: sessionIds.size,
      recordCount: filtered.length,
    };
  }

  getMonthlyTotal(): { totalCost: number; currency: string } {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const cutoff = startOfMonth.getTime();

    const filtered = this.records.filter(
      (r) => new Date(r.timestamp).getTime() >= cutoff,
    );
    const totalCost = filtered.reduce(
      (sum, r) => sum + (r.cost?.amount ?? 0),
      0,
    );
    const currency =
      filtered.find((r) => r.cost?.currency)?.cost?.currency ?? "USD";

    return { totalCost, currency };
  }

  cleanup(): void {
    const cutoff =
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const before = this.records.length;
    this.records = this.records.filter(
      (r) => new Date(r.timestamp).getTime() >= cutoff,
    );
    const removed = before - this.records.length;
    if (removed > 0) {
      log.info({ removed }, "Cleaned up expired usage records");
      this.scheduleDiskWrite();
    }
  }

  flushSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const data: StoreFile = { version: 1, records: this.records };
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.flushHandler) {
      process.removeListener("SIGTERM", this.flushHandler);
      process.removeListener("SIGINT", this.flushHandler);
      process.removeListener("exit", this.flushHandler);
      this.flushHandler = null;
    }
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.filePath, "utf-8"),
      ) as StoreFile;
      if (raw.version !== 1) {
        log.warn(
          { version: raw.version },
          "Unknown usage store version, skipping load",
        );
        return;
      }
      this.records = raw.records || [];
      log.info({ count: this.records.length }, "Loaded usage records");
    } catch (err) {
      log.error({ err }, "Failed to load usage store, backing up corrupt file");
      try {
        fs.copyFileSync(this.filePath, this.filePath + ".bak");
      } catch {
        /* best effort */
      }
      this.records = [];
    }
  }

  private getCutoff(
    period: "today" | "week" | "month" | "all",
  ): number | null {
    const now = new Date();
    switch (period) {
      case "today": {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        return start.getTime();
      }
      case "week":
        return Date.now() - 7 * 24 * 60 * 60 * 1000;
      case "month":
        return Date.now() - 30 * 24 * 60 * 60 * 1000;
      case "all":
        return null;
    }
  }

  private scheduleDiskWrite(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flushSync();
    }, DEBOUNCE_MS);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/__tests__/usage-store.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/usage-store.ts src/__tests__/usage-store.test.ts
git commit -m "feat(core): add UsageStore with JSON persistence, query, and cleanup"
```

---

### Task 3: UsageBudget

**Files:**
- Create: `src/core/usage-budget.ts`
- Create: `src/__tests__/usage-budget.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/usage-budget.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { UsageStore } from "../core/usage-store.js";
import { UsageBudget } from "../core/usage-budget.js";
import type { UsageBudgetConfig, UsageRecord } from "../core/types.js";

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "rec-1",
    sessionId: "sess-1",
    agentName: "claude",
    tokensUsed: 1000,
    contextSize: 200000,
    cost: { amount: 0.05, currency: "USD" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("UsageBudget", () => {
  let tmpDir: string;
  let store: UsageStore;
  let config: UsageBudgetConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-budget-test-"));
    store = new UsageStore(path.join(tmpDir, "usage.json"), 90);
    config = {
      enabled: true,
      monthlyBudget: 10.0,
      warningThreshold: 0.8,
      currency: "USD",
      retentionDays: 90,
    };
  });

  afterEach(() => {
    store.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns ok when under threshold", () => {
    store.append(makeRecord({ cost: { amount: 5.0, currency: "USD" } }));
    const budget = new UsageBudget(store, config);
    const result = budget.check();
    expect(result.status).toBe("ok");
    expect(result.message).toBeUndefined();
  });

  it("returns warning when at threshold", () => {
    store.append(makeRecord({ cost: { amount: 8.5, currency: "USD" } }));
    const budget = new UsageBudget(store, config);
    const result = budget.check();
    expect(result.status).toBe("warning");
    expect(result.message).toContain("Budget Warning");
  });

  it("returns exceeded when over budget", () => {
    store.append(makeRecord({ cost: { amount: 11.0, currency: "USD" } }));
    const budget = new UsageBudget(store, config);
    const result = budget.check();
    expect(result.status).toBe("exceeded");
    expect(result.message).toContain("Budget Exceeded");
  });

  it("de-duplicates notifications (same status → no message second time)", () => {
    store.append(makeRecord({ cost: { amount: 8.5, currency: "USD" } }));
    const budget = new UsageBudget(store, config);
    const first = budget.check();
    expect(first.message).toBeDefined();
    const second = budget.check();
    expect(second.status).toBe("warning");
    expect(second.message).toBeUndefined();
  });

  it("sends new message when status escalates from warning to exceeded", () => {
    store.append(makeRecord({ id: "r1", cost: { amount: 8.5, currency: "USD" } }));
    const budget = new UsageBudget(store, config);
    budget.check(); // warning
    store.append(makeRecord({ id: "r2", cost: { amount: 2.0, currency: "USD" } }));
    const result = budget.check(); // now exceeded
    expect(result.status).toBe("exceeded");
    expect(result.message).toContain("Budget Exceeded");
  });

  it("returns ok when no monthlyBudget configured", () => {
    store.append(makeRecord({ cost: { amount: 100.0, currency: "USD" } }));
    const budget = new UsageBudget(store, { ...config, monthlyBudget: undefined });
    const result = budget.check();
    expect(result.status).toBe("ok");
    expect(result.message).toBeUndefined();
  });

  it("getStatus returns current state for display", () => {
    store.append(makeRecord({ cost: { amount: 5.0, currency: "USD" } }));
    const budget = new UsageBudget(store, config);
    const status = budget.getStatus();
    expect(status.status).toBe("ok");
    expect(status.used).toBe(5.0);
    expect(status.budget).toBe(10.0);
    expect(status.percent).toBe(50);
  });

  it("getStatus returns 0 percent when no budget set", () => {
    const budget = new UsageBudget(store, { ...config, monthlyBudget: undefined });
    const status = budget.getStatus();
    expect(status.percent).toBe(0);
    expect(status.budget).toBe(0);
  });

  it("resets de-duplication at month boundary", () => {
    store.append(makeRecord({ cost: { amount: 8.5, currency: "USD" } }));
    const budget = new UsageBudget(store, config);
    const first = budget.check();
    expect(first.message).toBeDefined(); // warning sent

    // Simulate month change by manipulating internal state
    // Access private field via bracket notation for testing
    (budget as any).lastNotifiedMonth = (new Date().getMonth() + 11) % 12; // previous month

    // Cost is still above threshold, but month changed → should re-notify
    const result = budget.check();
    expect(result.message).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/__tests__/usage-budget.test.ts`
Expected: FAIL — `UsageBudget` does not exist yet

- [ ] **Step 3: Implement UsageBudget**

Create `src/core/usage-budget.ts`:

```typescript
import type { UsageBudgetConfig } from "./types.js";
import type { UsageStore } from "./usage-store.js";

export class UsageBudget {
  private lastNotifiedStatus: "ok" | "warning" | "exceeded" = "ok";
  private lastNotifiedMonth: number = new Date().getMonth();

  constructor(
    private store: UsageStore,
    private config: UsageBudgetConfig,
  ) {}

  check(): { status: "ok" | "warning" | "exceeded"; message?: string } {
    if (!this.config.monthlyBudget) {
      return { status: "ok" };
    }

    // Reset de-duplication at month boundary
    const currentMonth = new Date().getMonth();
    if (currentMonth !== this.lastNotifiedMonth) {
      this.lastNotifiedStatus = "ok";
      this.lastNotifiedMonth = currentMonth;
    }

    const { totalCost } = this.store.getMonthlyTotal();
    const budget = this.config.monthlyBudget;
    const threshold = this.config.warningThreshold;

    let status: "ok" | "warning" | "exceeded";
    if (totalCost >= budget) {
      status = "exceeded";
    } else if (totalCost >= threshold * budget) {
      status = "warning";
    } else {
      status = "ok";
    }

    // Only emit message on status change (prevents spam)
    let message: string | undefined;
    if (status !== "ok" && status !== this.lastNotifiedStatus) {
      const pct = Math.round((totalCost / budget) * 100);
      const filled = Math.round(Math.min(totalCost / budget, 1) * 10);
      const bar = "▓".repeat(filled) + "░".repeat(10 - filled);

      if (status === "warning") {
        message =
          `⚠️ <b>Budget Warning</b>\n` +
          `Monthly usage: $${totalCost.toFixed(2)} / $${budget.toFixed(2)} (${pct}%)\n` +
          `${bar} ${pct}%`;
      } else {
        message =
          `🚨 <b>Budget Exceeded</b>\n` +
          `Monthly usage: $${totalCost.toFixed(2)} / $${budget.toFixed(2)} (${pct}%)\n` +
          `${bar} ${pct}%\n` +
          `Sessions are NOT blocked — this is a warning only.`;
      }
    }

    this.lastNotifiedStatus = status;
    return { status, message };
  }

  getStatus(): {
    status: "ok" | "warning" | "exceeded";
    used: number;
    budget: number;
    percent: number;
  } {
    const { totalCost } = this.store.getMonthlyTotal();
    const budget = this.config.monthlyBudget ?? 0;

    let status: "ok" | "warning" | "exceeded" = "ok";
    if (budget > 0) {
      if (totalCost >= budget) {
        status = "exceeded";
      } else if (totalCost >= this.config.warningThreshold * budget) {
        status = "warning";
      }
    }

    const percent = budget > 0 ? Math.round((totalCost / budget) * 100) : 0;
    return { status, used: totalCost, budget, percent };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/__tests__/usage-budget.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/usage-budget.ts src/__tests__/usage-budget.test.ts
git commit -m "feat(core): add UsageBudget with threshold checking and de-duplication"
```

---

### Task 4: Config Schema

**Files:**
- Modify: `src/core/config.ts:58-87` (ConfigSchema)
- Modify: `src/core/config.ts:98-128` (DEFAULT_CONFIG)

- [ ] **Step 1: Add UsageSchema to ConfigSchema**

In `src/core/config.ts`, add the usage schema before the `ConfigSchema` definition (before line 58). Add it after the `TunnelSchema` block:

```typescript
const UsageSchema = z
  .object({
    enabled: z.boolean().default(true),
    monthlyBudget: z.number().optional(),
    warningThreshold: z.number().default(0.8),
    currency: z.string().default("USD"),
    retentionDays: z.number().default(90),
  })
  .default({});

export type UsageConfig = z.infer<typeof UsageSchema>;
```

Then add `usage: UsageSchema,` to the `ConfigSchema` object (after the `tunnel` field, line 86):

```typescript
  tunnel: TunnelSchema,
  usage: UsageSchema,
```

- [ ] **Step 2: Add `usage: {}` to DEFAULT_CONFIG**

In `DEFAULT_CONFIG` (line 98), add after the `tunnel` block:

```typescript
  usage: {},
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 4: Run existing tests**

Run: `pnpm test`
Expected: All existing tests still pass (backward compatible)

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts
git commit -m "feat(config): add usage tracking schema with budget and retention settings"
```

---

### Task 5: Core Wiring

**Files:**
- Modify: `src/core/core.ts:1-42` (imports and constructor)
- Modify: `src/core/core.ts:381-435` (wireSessionEvents)
- Modify: `src/core/core.ts:54-73` (stop method)
- Modify: `src/core/index.ts` (exports)

- [ ] **Step 1: Add imports to core.ts**

At the top of `src/core/core.ts`, add imports (after line 9):

```typescript
import { UsageStore } from "./usage-store.js";
import { UsageBudget } from "./usage-budget.js";
import type { UsageRecord } from "./types.js";
import { nanoid } from "nanoid";
```

- [ ] **Step 2: Add properties and constructor initialization**

Add properties to `OpenACPCore` class (after `private resumeLocks` line 29):

```typescript
  usageStore: UsageStore | null = null;
  usageBudget: UsageBudget | null = null;
```

Add initialization at the end of the constructor (after `this.notificationManager` line 41, before the closing `}`):

```typescript
    // Usage tracking
    const usageConfig = config.usage;
    if (usageConfig.enabled) {
      const usagePath = path.join(os.homedir(), ".openacp", "usage.json");
      this.usageStore = new UsageStore(usagePath, usageConfig.retentionDays);
      this.usageBudget = new UsageBudget(this.usageStore, usageConfig);
    }
```

- [ ] **Step 3: Add usage store destroy to stop()**

In the `stop()` method, add before the final `}` (after stopping adapters, around line 72):

```typescript
    // 4. Cleanup usage store
    if (this.usageStore) {
      this.usageStore.destroy();
    }
```

- [ ] **Step 4: Wire usage event in wireSessionEvents()**

In `wireSessionEvents()`, find the `case "usage":` block inside `onSessionUpdate` (around line 392). The existing code just forwards to adapter. Add usage tracking after the existing `adapter.sendMessage()` call.

Replace the usage case in the switch statement. Find this block:

```typescript
        case "usage":
```

The existing code handles `usage` as part of the text/thought/tool_call/etc group (lines 387-397) which just does `adapter.sendMessage()`. After the `adapter.sendMessage()` call for usage, add the tracking logic.

Change the switch to handle usage separately. Replace the combined case block:

```typescript
        case "text":
        case "thought":
        case "tool_call":
        case "tool_update":
        case "plan":
        case "usage":
          adapter.sendMessage(
            session.id,
            this.toOutgoingMessage(event, session),
          );
          break;
```

With:

```typescript
        case "text":
        case "thought":
        case "tool_call":
        case "tool_update":
        case "plan":
          adapter.sendMessage(
            session.id,
            this.toOutgoingMessage(event, session),
          );
          break;

        case "usage":
          adapter.sendMessage(
            session.id,
            this.toOutgoingMessage(event, session),
          );
          // Persist usage and check budget
          if (this.usageStore) {
            const record: UsageRecord = {
              id: nanoid(),
              sessionId: session.id,
              agentName: session.agentName,
              tokensUsed: event.tokensUsed ?? 0,
              contextSize: event.contextSize ?? 0,
              cost: event.cost,
              timestamp: new Date().toISOString(),
            };
            this.usageStore.append(record);

            if (this.usageBudget) {
              const result = this.usageBudget.check();
              if (result.message) {
                this.notificationManager.notifyAll({
                  sessionId: session.id,
                  sessionName: session.name,
                  type: "budget_warning",
                  summary: result.message,
                });
              }
            }
          }
          break;
```

- [ ] **Step 5: Export from core/index.ts**

Add to `src/core/index.ts`:

```typescript
export { UsageStore } from './usage-store.js'
export { UsageBudget } from './usage-budget.js'
```

- [ ] **Step 6: Verify build**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 7: Run all tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/core/core.ts src/core/index.ts
git commit -m "feat(core): wire UsageStore and UsageBudget into OpenACPCore event loop"
```

---

### Task 6: Usage Report Formatter

**Files:**
- Modify: `src/adapters/telegram/formatting.ts`
- Create: `src/__tests__/usage-command.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/usage-command.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatUsageReport } from "../adapters/telegram/formatting.js";
import type { UsageSummary } from "../core/types.js";

describe("formatUsageReport", () => {
  it("formats all periods with budget", () => {
    const today: UsageSummary = {
      period: "today", totalTokens: 189234, totalCost: 0.80,
      currency: "USD", sessionCount: 3, recordCount: 5,
    };
    const week: UsageSummary = {
      period: "week", totalTokens: 756123, totalCost: 3.20,
      currency: "USD", sessionCount: 12, recordCount: 25,
    };
    const month: UsageSummary = {
      period: "month", totalTokens: 1234567, totalCost: 5.40,
      currency: "USD", sessionCount: 23, recordCount: 60,
    };
    const budgetStatus = { status: "ok" as const, used: 5.40, budget: 10.0, percent: 54 };

    const result = formatUsageReport([month, week, today], budgetStatus);
    expect(result).toContain("Usage Report");
    expect(result).toContain("$5.40");
    expect(result).toContain("$10.00");
    expect(result).toContain("54%");
    expect(result).toContain("189k");
    expect(result).toContain("3 sessions");
  });

  it("formats single period", () => {
    const today: UsageSummary = {
      period: "today", totalTokens: 1000, totalCost: 0.05,
      currency: "USD", sessionCount: 1, recordCount: 1,
    };
    const budgetStatus = { status: "ok" as const, used: 0.05, budget: 10.0, percent: 1 };

    const result = formatUsageReport([today], budgetStatus);
    expect(result).toContain("Usage Report");
    expect(result).toContain("Today");
    expect(result).not.toContain("This Month");
    expect(result).not.toContain("This Week");
  });

  it("formats without budget", () => {
    const today: UsageSummary = {
      period: "today", totalTokens: 1000, totalCost: 0.05,
      currency: "USD", sessionCount: 1, recordCount: 1,
    };
    const budgetStatus = { status: "ok" as const, used: 0.05, budget: 0, percent: 0 };

    const result = formatUsageReport([today], budgetStatus);
    expect(result).toContain("Usage Report");
    expect(result).not.toContain("Budget");
  });

  it("returns empty message when no data", () => {
    const empty: UsageSummary = {
      period: "today", totalTokens: 0, totalCost: 0,
      currency: "USD", sessionCount: 0, recordCount: 0,
    };
    const budgetStatus = { status: "ok" as const, used: 0, budget: 0, percent: 0 };

    const result = formatUsageReport([empty], budgetStatus);
    expect(result).toContain("No usage data yet");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/__tests__/usage-command.test.ts`
Expected: FAIL — `formatUsageReport` does not exist

- [ ] **Step 3: Implement formatUsageReport**

Add the import at the top of `src/adapters/telegram/formatting.ts` (line 1, before any existing code):

```typescript
import type { UsageSummary } from '../../core/types.js'
```

Then add this function at the end of the file. It reuses the existing `formatTokens()` and `progressBar()` helpers already defined in the same file:

```typescript
const PERIOD_LABEL: Record<string, string> = {
  today: 'Today',
  week: 'This Week',
  month: 'This Month',
  all: 'All Time',
}

export function formatUsageReport(
  summaries: UsageSummary[],
  budgetStatus: { status: string; used: number; budget: number; percent: number },
): string {
  const hasData = summaries.some((s) => s.recordCount > 0)
  if (!hasData) {
    return '📊 <b>Usage Report</b>\n\nNo usage data yet.'
  }

  const formatCost = (n: number) => `$${n.toFixed(2)}`
  const lines: string[] = ['📊 <b>Usage Report</b>']

  for (const summary of summaries) {
    lines.push('')
    lines.push(`── <b>${PERIOD_LABEL[summary.period] ?? summary.period}</b> ──`)
    lines.push(
      `💰 ${formatCost(summary.totalCost)} · 🔤 ${formatTokens(summary.totalTokens)} tokens · 📋 ${summary.sessionCount} sessions`,
    )

    // Show budget bar only on the first (month) section
    if (summary.period === 'month' && budgetStatus.budget > 0) {
      const bar = progressBar(budgetStatus.used / budgetStatus.budget)
      lines.push(`Budget: ${formatCost(budgetStatus.used)} / ${formatCost(budgetStatus.budget)} (${budgetStatus.percent}%)`)
      lines.push(`${bar} ${budgetStatus.percent}%`)
    }
  }

  return lines.join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/__tests__/usage-command.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/telegram/formatting.ts src/__tests__/usage-command.test.ts
git commit -m "feat(telegram): add formatUsageReport helper for /usage command"
```

---

### Task 7: Telegram /usage Command

**Files:**
- Modify: `src/adapters/telegram/commands.ts:17-32` (setupCommands)
- Modify: `src/adapters/telegram/commands.ts:587-597` (STATIC_COMMANDS)

- [ ] **Step 1: Add import for formatUsageReport**

At the top of `src/adapters/telegram/commands.ts`, add:

```typescript
import { escapeHtml, formatUsageReport } from "./formatting.js";
```

(Replace the existing `import { escapeHtml } from "./formatting.js";` on line 5.)

- [ ] **Step 2: Register /usage command in setupCommands**

In the `setupCommands` function (line 17-32), add after the existing commands (before the closing `}`):

```typescript
  bot.command("usage", (ctx) => handleUsage(ctx, core));
```

- [ ] **Step 3: Implement handleUsage**

Add the handler function after `handleDisableDangerous` (before `botFromCtx`):

```typescript
async function handleUsage(ctx: Context, core: OpenACPCore): Promise<void> {
  if (!core.usageStore) {
    await ctx.reply("📊 Usage tracking is disabled.", { parse_mode: "HTML" });
    return;
  }

  const rawMatch = (ctx as Context & { match: unknown }).match;
  const period = typeof rawMatch === "string" ? rawMatch.trim().toLowerCase() : "";

  let summaries: ReturnType<typeof core.usageStore.query>[];

  if (period === "today" || period === "week" || period === "month") {
    summaries = [core.usageStore.query(period)];
  } else {
    // Default: show all periods (month → week → today)
    summaries = [
      core.usageStore.query("month"),
      core.usageStore.query("week"),
      core.usageStore.query("today"),
    ];
  }

  const budgetStatus = core.usageBudget
    ? core.usageBudget.getStatus()
    : { status: "ok" as const, used: 0, budget: 0, percent: 0 };

  const text = formatUsageReport(summaries, budgetStatus);
  await ctx.reply(text, { parse_mode: "HTML" });
}
```

- [ ] **Step 4: Add to STATIC_COMMANDS**

In `STATIC_COMMANDS` array (line 587), add:

```typescript
  { command: "usage", description: "View token usage and cost report" },
```

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 6: Run all tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/adapters/telegram/commands.ts
git commit -m "feat(telegram): add /usage command for on-demand cost reporting"
```

---

### Task 8: Smoke Test & Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: Clean build with no errors

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass (existing + new)

- [ ] **Step 3: Verify TypeScript strict mode**

Run: `pnpm build 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: final cleanup for cost tracking feature"
```
