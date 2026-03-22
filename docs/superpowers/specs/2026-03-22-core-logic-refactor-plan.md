# Core Logic Refactor — Implementation Plan

**Based on:** `docs/superpowers/specs/2026-03-22-core-logic-refactor-design.md`
**Approach:** TDD — tests written BEFORE each implementation step
**Constraint:** Internal breaking changes allowed; external behavior preserved

---

## Step 0: Baseline — Run Existing Tests

**Goal:** Establish green baseline before any changes.

- Run `pnpm test` and confirm all existing tests pass
- Note affected test files:
  - `src/core/__tests__/session-events.test.ts`
  - `src/__tests__/api-server.test.ts`
  - `src/__tests__/lazy-resume.test.ts`
  - `src/__tests__/adopt-session.test.ts`

---

## Step 1: Session State Machine

**Dependencies:** None

### Step 1a: Write Tests First

**Create:** `src/core/__tests__/session-state-machine.test.ts`

Tests:
1. New Session starts in `initializing`
2. Valid transitions: `initializing→active`, `initializing→error`, `active→error`, `active→finished`, `active→cancelled`, `error→active`, `cancelled→active`
3. Invalid transitions throw: `initializing→finished`, `initializing→cancelled`, `finished→*`, `error→finished`, `error→cancelled`
4. `status_change` event emitted with `(from, to)` on every valid transition
5. `named` event emitted when auto-name completes
6. `abortPrompt()` clears queue, calls `agentInstance.cancel()`, stays `active`
7. `markCancelled()` transitions to `cancelled`
8. `status` is readonly getter
9. `session_end` backward compat — `finish()` emits both `status_change` and `session_end`

### Step 1b: Implement State Machine

**Modify:** `src/core/session.ts`

1. Add private `_status`, change `status` to getter
2. Add deprecated setter that logs warning + calls appropriate transition
3. Add transition methods: `activate()`, `fail(reason)`, `finish(reason)`, `markCancelled()`
4. Rename `cancel()` → `abortPrompt()`, keep `cancel()` as deprecated alias
5. Update `SessionEvents`: add `status_change`, `named`
6. In `autoName()`: emit `named` event instead of `adapter.renameSessionThread()`
7. In `processPrompt()`: use `this.activate()` instead of `this.status = "active"`
8. In `runWarmup()`: use `this.activate()`
9. In PromptQueue error handler: use `this.fail()`

### Step 1c: Update Internal Callers

**Modify:** `src/core/core.ts`
- `wireSessionEvents`: `session.status = "finished"` → `session.finish(event.reason)`
- `lazyResume`: `session.status = "active"` → `session.activate()`

**Modify:** `src/core/session-manager.ts`
- `cancelSession()`: call `session.abortPrompt()` then `session.markCancelled()`

**Modify:** `src/adapters/telegram/commands/session.ts`
- Mid-prompt cancel calls → `session.abortPrompt()`

**Modify:** `src/core/api-server.ts`
- DELETE endpoint → `session.abortPrompt()`

### Step 1d: Update Existing Tests

- `src/core/__tests__/session-events.test.ts` — add backward compat assertions
- `src/__tests__/api-server.test.ts` — update mock for `abortPrompt`

---

## Step 2: SessionBridge — Extract Event Wiring

**Dependencies:** Step 1

### Step 2a: Write Tests First

**Create:** `src/core/__tests__/session-bridge.test.ts`

Tests:
1. Agent event routing → `adapter.sendMessage()` via MessageTransformer
2. Permission flow → `permissionGate.setPending()` + `adapter.sendPermissionRequest()`
3. Session end → `session.finish()` + adapter + notification
4. Error → `session.fail()` + notification
5. Commands → `adapter.sendSkillCommands()`
6. Named event → `adapter.renameSessionThread()`
7. Status change persistence → `sessionManager.patchRecord()`
8. Auto-disconnect on terminal state
9. Manual `disconnect()` removes all listeners
10. `connect()` idempotent

### Step 2b: Implement SessionBridge

**Create:** `src/core/session-bridge.ts`

```ts
interface BridgeDeps {
  messageTransformer: MessageTransformer;
  notificationManager: NotificationManager;
  sessionManager: SessionManager;
}

class SessionBridge {
  constructor(session, adapter, deps) { ... }
  connect(): void { ... }
  disconnect(): void { ... }
  private wireAgentToSession(): void { ... }
  private wireSessionToAdapter(): void { ... }
  private wirePermissions(): void { ... }
  private wireLifecycle(): void { ... }
}
```

### Step 2c: Add Factory Method to Core

**Modify:** `src/core/core.ts`
- Add `createBridge(session, adapter): SessionBridge`
- Replace `wireSessionEvents()` body to delegate to SessionBridge
- Keep `wireSessionEvents()` as wrapper for now (external callers)

### Step 2d: Export

**Modify:** `src/core/index.ts` — add `SessionBridge` export

---

## Step 3: Unified Session Creation Pipeline

**Dependencies:** Step 2

### Step 3a: Write Tests First

**Create:** `src/core/__tests__/create-session.test.ts`

Tests:
1. New session — spawns agent, registers, connects bridge, persists
2. Resume session — resumes agent, reuses session ID
3. Adopt session — resumes + creates thread
4. Spawn failure — not registered, error surfaces
5. Resume failure — error sent to adapter (not silent)
6. Thread creation when `createThread: true`
7. SessionBridge connected
8. Initial record persisted
9. Session starts in `initializing`

### Step 3b: Implement `core.createSession()`

**Modify:** `src/core/core.ts`

```ts
interface CreateSessionParams {
  channelId: string;
  agentName: string;
  workingDirectory: string;
  resumeAgentSessionId?: string;
  existingSessionId?: string;
  createThread?: boolean;
  initialName?: string;
}
```

### Step 3c–3f: Migrate Callers

- `handleNewSession()` → thin wrapper calling `createSession()`
- `lazyResume()` → find record + `createSession()` + error feedback
- `adoptSession()` → validation + `createSession({ createThread: true })`
- `api-server.ts` → `core.createSession()` (fix double-wiring bug)
- `assistant.ts` → `core.createSession()`

### Step 3g: Update Tests

- `src/__tests__/api-server.test.ts` — update mocks
- Add assistant spawn test if needed

---

## Step 4: SessionManager Cleanup

**Dependencies:** Step 3

### Step 4a: Write Tests First

**Create:** `src/core/__tests__/session-manager-patch.test.ts`

Tests:
1. Shallow merge — updates only specified fields
2. Nested field — replaces entire nested object
3. No-op when no store
4. No-op when record not found
5. Multiple fields at once

### Step 4b: Implement `patchRecord()`

**Modify:** `src/core/session-manager.ts`

### Step 4c: Migrate All Callers

| Old | New |
|-----|-----|
| `updateSessionActivity(id)` | `patchRecord(id, { lastActiveAt: ... })` |
| `updateSessionStatus(id, s)` | `patchRecord(id, { status: s })` |
| `updateSessionName(id, n)` | `patchRecord(id, { name: n })` |
| `updateSessionDangerousMode(id, d)` | `patchRecord(id, { dangerousMode: d })` |
| `updateSessionPlatform(id, p)` | `patchRecord(id, { platform: p })` |

Files: `core.ts`, `session-bridge.ts`, `adapter.ts`, `admin.ts`, `new-session.ts`, `api-server.ts`

Note: `patchRecord` does shallow merge. For nested `platform`, callers must spread existing value.

### Step 4d: Wire Auto-Persist in SessionBridge

**Modify:** `src/core/session-bridge.ts` — `wireLifecycle()`

### Step 4e: Remove Old Update Methods

**Modify:** `src/core/session-manager.ts` — remove 5 old methods

### Step 4f: Update Tests

---

## Step 5: Remove Deprecated Code

**Dependencies:** Steps 1–4 complete

### Step 5a: Remove from Session
- `adapter?` property
- `pendingPermission` compat getter/setter
- Deprecated `cancel()` alias
- Deprecated `status` setter

### Step 5b: Remove `wireSessionEvents` from Core

### Step 5c: Clean Up Imports/Exports

### Step 5d: Final Test Run

---

## Risk Mitigation

1. **Step 1:** Deprecated `status` setter still works → missed callers show warnings, don't crash
2. **Step 2:** `wireSessionEvents` stays as wrapper → external callers work until Step 3
3. **Step 1:** `cancel()` alias → no caller breaks until Step 5
4. **Step 4:** `patchRecord` added before old methods removed
5. **Step 5:** Pure cleanup, no behavioral changes
