# Core Logic Refactor Design

**Date:** 2026-03-22
**Scope:** Core modules — Session, SessionManager, Core event wiring, session creation flows
**Approach:** Full core restructure (Approach B), core first then adapter refactor later
**Constraint:** TDD — write tests for existing behavior before refactoring. Internal breaking changes allowed; external behavior preserved.

---

## Problem Statement

The core logic has accumulated several structural issues:

1. **Session status is set from multiple locations** (session.ts, core.ts, session-manager.ts) with no state machine — any status can transition to any other status
2. **Lazy resume has race conditions** — resume failures drop messages silently with no user feedback
3. **wireSessionEvents is an 80-line method** doing 4 different things: callback wiring, permission flow, event routing, status management
4. **Session knows about adapter** (`session.adapter`) — reverse coupling that violates the architecture's unidirectional flow
5. **autoName monkey-patches** `agentInstance.onSessionUpdate` temporarily — fragile pattern
6. **5 separate session creation flows** (handleNewSession, lazyResume, adoptSession, api-server.ts, assistant.ts) duplicate logic — api-server.ts and assistant.ts bypass handleNewSession and call wireSessionEvents directly
7. **SessionManager has 6 copy-paste update methods** with identical get-spread-save pattern

---

## Design

### 1. Session State Machine

Replace free-form `session.status` assignment with explicit transition methods and validated state transitions.

**Valid transitions:**

```
                    ┌─────────────┐
                    │ initializing│
                    └──────┬──────┘
                           │ activate()
                           │ fail() ──► error
                           ▼
              ┌───── ► active ◄─────┐
              │            │         │
              │    ┌───────┼────┐    │
              │    │       │    │    │
              │    ▼       ▼    ▼    │
              │  error  finished cancelled
              │                      │
              └──── activate() ──────┘
              (only from error/cancelled)
```

**Valid transitions table:**

| From | To | Method |
|------|----|--------|
| `initializing` | `active` | `activate()` |
| `initializing` | `error` | `fail(reason)` — agent spawn failure |
| `active` | `error` | `fail(reason)` |
| `active` | `finished` | `finish(reason)` |
| `active` | `cancelled` | `markCancelled()` — terminal session cancel |
| `error` | `active` | `activate()` — resume |
| `cancelled` | `active` | `activate()` — resume |

**Cancel semantics clarification:**
- `Session.abortPrompt()` (renamed from current `cancel()`) — cancels the running prompt, clears the queue, stays in `active` state. This is what the /cancel button does mid-prompt.
- `Session.markCancelled()` — terminates the session entirely, transitions to `cancelled` state. This is what `SessionManager.cancelSession()` calls.

**New Session events:**

```ts
interface SessionEvents {
  agent_event: (event: AgentEvent) => void;
  permission_request: (request: PermissionRequest) => void;
  status_change: (from: SessionStatus, to: SessionStatus) => void;
  named: (name: string) => void;
  error: (error: Error) => void;
}
```

- `status_change` — emitted on every valid transition. Listeners use this for persistence and notifications.
- `named` — emitted after auto-name completes. Replaces `session.adapter.renameSessionThread()` coupling.
- Invalid transitions throw an error (or log warning in production).
- `session.status` becomes a readonly getter — no external code sets it directly.

**autoName change:** Session emits `named` event instead of calling `adapter.renameSessionThread()`. The monkey-patching of `onSessionUpdate` stays internal to Session (it's an implementation detail of how auto-name works with the agent) but the adapter coupling is removed.

### 2. SessionBridge — Extract Event Wiring

New class replacing `wireSessionEvents()`. Each session gets one bridge instance. Created via factory method on core to avoid leaking internal dependencies.

```ts
// Factory method on OpenACPCore
createBridge(session: Session, adapter: ChannelAdapter): SessionBridge {
  return new SessionBridge(session, adapter, {
    messageTransformer: this.messageTransformer,
    notificationManager: this.notificationManager,
    sessionManager: this.sessionManager,
  });
}

class SessionBridge {
  constructor(
    private session: Session,
    private adapter: ChannelAdapter,
    private deps: BridgeDeps,
  ) {}

  /** Wire everything. Auto-cleans up on terminal status_change. */
  connect(): void {
    this.wireAgentToSession();
    this.wireSessionToAdapter();
    this.wirePermissions();
    this.wireLifecycle();
  }

  /** Remove all listeners and references */
  disconnect(): void { ... }
}
```

**Cleanup lifecycle:** SessionBridge listens for terminal `status_change` events (`finished`, `cancelled`, `error`) and auto-calls `disconnect()` to remove all listeners and prevent memory leaks. Can also be called manually via `bridge.disconnect()`.

**Responsibilities:**

- `wireAgentToSession()` — Set `agentInstance.onSessionUpdate` and `onPermissionRequest` callbacks to emit on Session
- `wireSessionToAdapter()` — Subscribe to `agent_event`, transform via MessageTransformer, deliver to adapter
- `wirePermissions()` — Set up PermissionGate flow: emit → setPending → send UI → wait for resolve
- `wireLifecycle()` — Listen to `status_change` for persistence/notifications, listen to `named` for topic rename

**Key change:** Session no longer holds an `adapter` reference. The `session.adapter` property is removed. All adapter interaction goes through SessionBridge.

**File:** `src/core/session-bridge.ts`

### 3. Unified Session Creation Pipeline

Consolidate `handleNewSession()`, `lazyResume()`, and `adoptSession()` into one pipeline in core.ts.

```ts
interface CreateSessionParams {
  channelId: string;
  agentName: string;
  workingDirectory: string;
  resumeAgentSessionId?: string;   // for resume/adopt
  existingSessionId?: string;      // keep same session ID (lazy resume)
  createThread?: boolean;          // adoptSession needs to create topic
  initialName?: string;            // "Adopted session" etc.
}

async createSession(params: CreateSessionParams): Promise<Session> {
  // 1. Spawn or resume agent
  // 2. Create Session instance (with state machine)
  // 3. Register in SessionManager
  // 4. Create thread if needed
  // 5. Connect SessionBridge
  // 6. Persist initial record
  return session;
}
```

**Callers become thin wrappers:**

- `handleNewSession(channelId, agentName?, workspacePath?)` → resolve agent/workspace, call `createSession()`
- `lazyResume(message)` → find record from store, call `createSession({ resumeAgentSessionId, existingSessionId })`
- `adoptSession(agentName, agentSessionId, cwd)` → validate, call `createSession({ resumeAgentSessionId, createThread: true })`
- `api-server.ts` session creation → call `core.createSession()` instead of `sessionManager.createSession()` + manual `wireSessionEvents()`
- `assistant.ts` session creation → call `core.createSession()` instead of manual wiring (also fixes existing double-wiring bug)

**Lazy resume error handling fix:**
- Resume failure sends error message to adapter (user sees feedback) instead of silent drop
- If resume fails and `resumeAgentSessionId` was provided, the error is surfaced — no silent fallback

**adoptSession simplification:** The 120-line method reduces to ~30 lines: validation + `createSession()` call.

### 4. SessionManager Cleanup

**4a. Replace 6 update methods with generic `patchRecord()`:**

```ts
async patchRecord(sessionId: string, patch: Partial<SessionRecord>): Promise<void> {
  if (!this.store) return;
  const record = this.store.get(sessionId);
  if (record) await this.store.save({ ...record, ...patch });
}
```

**Note:** `patchRecord` does shallow merge only. For nested fields like `platform`, callers must spread the existing value: `patchRecord(id, { platform: { ...record.platform, skillMsgId: 123 } })`.

Remove: `updateSessionActivity()`, `updateSessionStatus()`, `updateSessionName()`, `updateSessionDangerousMode()`, `updateSessionPlatform()`

All callers use `patchRecord(id, { status, lastActiveAt, ... })`.

**4b. Auto-persist via Session events (in SessionBridge):**

```ts
// SessionBridge.wireLifecycle()
session.on('status_change', (from, to) => {
  sessionManager.patchRecord(session.id, {
    status: to,
    lastActiveAt: new Date().toISOString(),
  });
});

session.on('named', (name) => {
  sessionManager.patchRecord(session.id, { name });
});
```

Core.ts no longer manually calls status/name updates — the bridge handles it reactively.

**4c. Responsibility clarification:**
- `SessionManager` — in-memory session registry (register, get, list, remove) + store delegation via `patchRecord()`
- `SessionStore` — disk persistence (unchanged)
- `SessionBridge` — event-driven sync between session state and store

---

## Implementation Order

Each step requires tests written BEFORE the refactor:

1. **Session state machine** — add transition methods + `status_change`/`named` events. Existing code keeps working (transition methods call internally, status setter logs deprecation warning).
2. **SessionBridge** — extract from wireSessionEvents. Core.ts uses SessionBridge instead.
3. **Session creation pipeline** — consolidate 3 flows into `createSession()`. Fix lazy resume error handling.
4. **SessionManager cleanup** — replace update methods with `patchRecord()`, wire auto-persist.
5. **Remove deprecated code** — delete `session.adapter`, `pendingPermission` compat getter, old wireSessionEvents.

---

## Files Changed

| File | Action |
|------|--------|
| `src/core/session.ts` | Major — state machine, new events, remove adapter ref |
| `src/core/session-bridge.ts` | **New** — extracted event wiring |
| `src/core/core.ts` | Major — createSession pipeline, remove wireSessionEvents |
| `src/core/session-manager.ts` | Moderate — patchRecord, remove update methods |
| `src/core/types.ts` | Minor — SessionEvents type update |
| `src/core/api-server.ts` | Moderate — use `core.createSession()` instead of manual wiring |
| `src/adapters/telegram/assistant.ts` | Moderate — use `core.createSession()`, fix double-wiring bug |
| `src/core/channel.ts` | No change |
| `src/core/agent-instance.ts` | No change |
| `src/core/session-store.ts` | No change |
| `src/core/prompt-queue.ts` | No change |
| `src/core/permission-gate.ts` | No change |

---

## Backward Compatibility

- **Config:** No changes
- **SessionStore format:** No changes to `sessions.json` schema — SessionRecord stays the same
- **CLI commands:** No changes
- **Plugin/Adapter API:** `ChannelAdapter` interface unchanged. `wireSessionEvents` is removed but callers (`api-server.ts`, `assistant.ts`) are migrated to `core.createSession()` in the same refactor.
- **pendingPermission compat getter:** Removed in step 5 (internal breaking change, as agreed)

---

## Testing Strategy

- **Before each refactor step:** Write tests for current behavior of the module being changed
- **Session state machine:** Unit tests for valid/invalid transitions, event emission
- **SessionBridge:** Integration tests — mock adapter + session, verify event flow
- **createSession pipeline:** Test each variant (new, resume, adopt) produces correct session state
- **SessionManager.patchRecord:** Unit test for merge behavior
- **Lazy resume error handling:** Test that failed resume sends error to adapter
- **autoName + bridge interaction:** Test that auto-name's temporary onSessionUpdate swap doesn't break bridge event delivery
- **Cancel semantics:** Test `abortPrompt()` stays active vs `markCancelled()` goes terminal
