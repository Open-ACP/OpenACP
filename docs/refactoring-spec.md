# OpenACP Aggressive Refactoring Spec

## Overview

Refactor OpenACP codebase for clarity, maintainability, and extensibility while preserving all existing behavior. TDD approach — write tests before modifying code for high-risk changes.

## Phase 1: Event System — TypedEventEmitter

### Problem
- `AgentInstance` uses 2 callback properties: `onSessionUpdate`, `onPermissionRequest`
- `core.ts` wireSessionEvents() assigns callbacks directly — not extensible
- `Session.autoName()` and `warmup()` swap handlers temporarily (`prevHandler`) — fragile, race-prone
- Adding logging/filtering/transform requires modifying wireSessionEvents directly

### Design

**TypedEventEmitter<T>** — generic typed event emitter (no dependency on Node EventEmitter):

```typescript
interface SessionEvents {
  agent_event: (event: AgentEvent) => void
  permission_request: (request: PermissionRequest) => void
  session_end: (reason: string) => void
  error: (error: Error) => void
}
```

**Flow:**
```
AgentInstance  ──emit──►  Session (TypedEventEmitter)  ──►  Core subscribes  ──►  Adapter
```

**Key changes:**
- `AgentInstance` no longer holds `onSessionUpdate`/`onPermissionRequest` callbacks
- `AgentInstance` calls `session.emit('agent_event', event)` instead
- `Session` extends `TypedEventEmitter<SessionEvents>`
- `Session.pause()` / `Session.resume()` — suppress event delivery (buffer events during pause, replay on resume)
- `autoName()` uses pause/resume instead of handler swapping
- `warmup()` uses pause/resume instead of handler swapping
- Core subscribes via `session.on('agent_event', handler)`

**Tests (write BEFORE implementation):**
1. Session emits `agent_event` → listener receives correct payload
2. Session emits `permission_request` → listener receives correct payload
3. `session.pause()` → events buffered, not delivered
4. `session.resume()` → buffered events replayed in order
5. Multiple listeners all receive events
6. `session.removeListener()` stops delivery to that listener

### Files affected
- `src/core/session.ts` — major changes
- `src/core/agent-instance.ts` — remove callback properties
- `src/core/core.ts` — wireSessionEvents rewritten to use `.on()`
- NEW: `src/core/typed-emitter.ts` — TypedEventEmitter class
- NEW: `tests/core/typed-emitter.test.ts`
- NEW: `tests/core/session-events.test.ts`

---

## Phase 2: Session Decomposition

### Problem
- `Session` class holds too many responsibilities: prompt queue, auto-naming, dangerous mode, pending permission, lifecycle, adapter reference
- `pendingPermission` is a public mutable property — no encapsulation

### Design

Extract into focused components:

```
Session (lightweight coordinator)
  ├── PromptQueue       — serial prompt processing, queue management
  ├── AutoNamer         — summarize after first prompt, rename thread
  └── PermissionGate    — hold/resolve permission requests, typed API
```

**PromptQueue:**
```typescript
class PromptQueue {
  enqueue(prompt: string): void
  processNext(): Promise<void>
  clear(): void
  get pending(): number
  get isProcessing(): boolean
  dangerousMode: boolean  // skip permission prompts
}
```

**AutoNamer:**
```typescript
class AutoNamer {
  constructor(session: Session, onRename: (name: string) => void)
  // Listens to agent_event after first prompt
  // Sends summarize request using session.pause()/resume()
  // Calls onRename when name is determined
}
```

**PermissionGate:**
```typescript
class PermissionGate {
  setPending(request: PermissionRequest): Promise<string>  // returns optionId
  resolve(optionId: string): void
  reject(reason?: string): void
  get isPending(): boolean
  get currentRequest(): PermissionRequest | undefined
}
```

**Tests (write BEFORE implementation):**
1. PromptQueue: enqueue 3 prompts → processed serially (not concurrent)
2. PromptQueue: enqueue while processing → queued, not dropped
3. PromptQueue: clear() removes all pending, does not cancel active
4. AutoNamer: triggers rename after first prompt completion
5. AutoNamer: does not trigger on subsequent prompts
6. PermissionGate: setPending returns promise, resolve fulfills it
7. PermissionGate: double-resolve is no-op (no error)
8. PermissionGate: reject rejects the promise

### Files affected
- `src/core/session.ts` — slim down, delegate to components
- NEW: `src/core/prompt-queue.ts`
- NEW: `src/core/auto-namer.ts`
- NEW: `src/core/permission-gate.ts`
- NEW: `tests/core/prompt-queue.test.ts`
- NEW: `tests/core/auto-namer.test.ts`
- NEW: `tests/core/permission-gate.test.ts`

---

## Phase 3: Core ↔ Adapter Contract

### Problem
- `ChannelAdapter` is abstract class with `protected core: any` — not type-safe
- Adapter must `extends ChannelAdapter` — tight coupling, hard to test
- `core.ts` wireSessionEvents contains enrichment logic (`enrichWithViewerLinks`, `toOutgoingMessage`) — transform concern, not orchestration

### Design

**Interface replaces abstract class:**

```typescript
interface IChannelAdapter {
  readonly id: string
  sendMessage(sessionId: string, message: OutgoingMessage): Promise<void>
  sendPermissionRequest(session: Session, request: PermissionRequest): Promise<void>
  sendNotification(notification: NotificationMessage): Promise<void>
  createSessionThread(session: Session): Promise<string>
  renameSessionThread(session: Session, name: string): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

interface ICoreForAdapter {
  handleNewSession(adapterId: string, opts: NewSessionOpts): Promise<Session>
  handlePrompt(sessionId: string, prompt: string): Promise<void>
  getSession(sessionId: string): Session | undefined
  getSessions(): Session[]
  endSession(sessionId: string): Promise<void>
}
```

**MessageTransformer** — extracted from core.ts:

```typescript
class MessageTransformer {
  transform(event: AgentEvent, session: Session): OutgoingMessage
  // Handles: enrichWithViewerLinks, toOutgoingMessage, format conversion
}
```

**Pipeline:**
```
AgentEvent → MessageTransformer.transform() → OutgoingMessage → adapter.sendMessage()
```

**Tests:**
1. MessageTransformer: text event → correct OutgoingMessage
2. MessageTransformer: tool_use event → enriched with viewer links
3. MessageTransformer: completion event → includes usage data
4. Mock adapter implementing IChannelAdapter — verify contract compliance
5. ICoreForAdapter mock — adapter can call core methods type-safely

### Files affected
- `src/core/channel.ts` — abstract class → interface
- `src/core/core.ts` — extract enrichment logic
- NEW: `src/core/message-transformer.ts`
- NEW: `tests/core/message-transformer.test.ts`
- `src/adapters/telegram/adapter.ts` — implements interface instead of extends

---

## Phase 4: Config Migration Pipeline

### Problem
- `config.ts` load() contains inline migration logic mixed with validation
- Adding new migrations requires modifying load() directly

### Design

```typescript
interface Migration {
  version: number
  up: (raw: Record<string, unknown>) => Record<string, unknown>
}

const migrations: Migration[] = [
  { version: 1, up: (config) => { /* ... */ } },
  { version: 2, up: (config) => { /* ... */ } },
]

function applyMigrations(raw: Record<string, unknown>, migrations: Migration[]): Record<string, unknown>
```

Config file gets a `version` field. `load()` becomes:
```
readFile → JSON.parse → applyMigrations → zodValidate → Config
```

**Tests:**
1. Each migration function: input fixture → expected output
2. applyMigrations skips already-applied migrations
3. applyMigrations applies in order
4. Invalid config after migration → zod validation error (not silent corruption)

### Files affected
- `src/core/config.ts` — extract migrations, add version field
- NEW: `src/core/config-migrations.ts`
- NEW: `tests/core/config-migrations.test.ts`

---

## Phase 5: CLI Command Modules

### Problem
- `cli.ts` is one big if/else chain for all commands

### Design

```
src/cli/
  index.ts      — parse args, dispatch to command module
  start.ts      — start command
  install.ts    — plugin install
  uninstall.ts  — plugin uninstall
  plugins.ts    — list plugins
  setup.ts      — interactive setup
```

Each command: `(args: string[], config: ConfigManager) => Promise<void>`

CLI index parses argv, resolves command, calls handler.

**Tests (optional — low risk):**
- Each command module callable independently with mock dependencies

### Files affected
- `src/cli.ts` → `src/cli/index.ts` + individual command files

---

## Execution Order

```
Phase 1 (Event System)
    ↓
Phase 2 (Session Decomposition)  — depends on Phase 1 events
    ↓
Phase 3 (Core ↔ Adapter)         — can overlap with Phase 2
    ↓
Phase 4 (Config Migration)       — independent
Phase 5 (CLI Commands)           — independent
```

## Branch Strategy
- Branch: `refactor/aggressive-cleanup`
- Each phase gets its own commits
- Tests written and passing BEFORE implementation changes
- Existing tests must continue to pass after each phase

## Risk Mitigation
- TDD for Phases 1-4: tests first, then refactor
- Each phase is independently deployable
- If a phase causes issues, it can be reverted without affecting others
