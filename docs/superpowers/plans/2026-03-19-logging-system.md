# Logging System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the minimal console wrapper with a pino-based structured logging system that provides dual output (pretty terminal + JSON files), per-session log files, and contextual child loggers.

**Architecture:** Pino root logger with two transports (pino-pretty for stdout, pino-roll for JSON file rotation). Child loggers per module with context binding. Session loggers that write to both combined and per-session files. Backward-compatible wrapper preserving existing `log.info(...)` variadic call sites.

**Tech Stack:** pino, pino-pretty, pino-roll, zod (existing), vitest (existing)

**Spec:** `docs/superpowers/specs/2026-03-19-logging-system-design.md`

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install pino and pino-roll as dependencies, pino-pretty as dependency**

```bash
cd /Users/lucas/code/OpenACP && pnpm add pino pino-roll pino-pretty
```

- [ ] **Step 2: Add pino packages to tsup externals**

In `tsup.config.ts`, add `'pino'`, `'pino-pretty'`, `'pino-roll'` to the `external` array so they are not bundled but resolved from node_modules at runtime.

- [ ] **Step 3: Verify build still works**

```bash
pnpm build
```

Expected: Clean compile, no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml tsup.config.ts
git commit -m "chore: add pino, pino-pretty, pino-roll dependencies"
```

---

### Task 2: Add Logging Config Schema

**Files:**
- Modify: `src/core/config.ts` (lines 21-33, ConfigSchema)
- Test: `src/__tests__/logging-config.test.ts`

- [ ] **Step 1: Write failing test for logging config schema**

Create `src/__tests__/logging-config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ConfigSchema } from '../core/config.js'

describe('logging config schema', () => {
  const baseConfig = {
    channels: {},
    agents: { claude: { command: 'claude' } },
    defaultAgent: 'claude',
  }

  it('provides defaults when logging key is absent', () => {
    const result = ConfigSchema.parse(baseConfig)
    expect(result.logging).toEqual({
      level: 'info',
      logDir: '~/.openacp/logs',
      maxFileSize: '10m',
      maxFiles: 7,
      sessionLogRetentionDays: 30,
    })
  })

  it('allows partial logging overrides', () => {
    const result = ConfigSchema.parse({
      ...baseConfig,
      logging: { level: 'debug', maxFiles: 3 },
    })
    expect(result.logging.level).toBe('debug')
    expect(result.logging.maxFiles).toBe(3)
    expect(result.logging.logDir).toBe('~/.openacp/logs')
  })

  it('accepts silent level for testing', () => {
    const result = ConfigSchema.parse({
      ...baseConfig,
      logging: { level: 'silent' },
    })
    expect(result.logging.level).toBe('silent')
  })

  it('rejects invalid log level', () => {
    expect(() =>
      ConfigSchema.parse({
        ...baseConfig,
        logging: { level: 'verbose' },
      })
    ).toThrow()
  })

  it('accepts numeric maxFileSize', () => {
    const result = ConfigSchema.parse({
      ...baseConfig,
      logging: { maxFileSize: 10485760 },
    })
    expect(result.logging.maxFileSize).toBe(10485760)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- src/__tests__/logging-config.test.ts
```

Expected: FAIL — `logging` property does not exist on ConfigSchema.

- [ ] **Step 3: Add logging schema to ConfigSchema**

In `src/core/config.ts`, add the logging schema before `ConfigSchema` and include it in the schema:

```typescript
const LoggingSchema = z.object({
  level: z.enum(['silent', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  logDir: z.string().default('~/.openacp/logs'),
  maxFileSize: z.union([z.string(), z.number()]).default('10m'),
  maxFiles: z.number().default(7),
  sessionLogRetentionDays: z.number().default(30),
}).default({})
```

Add `logging: LoggingSchema` to `ConfigSchema`.

Export the inferred type: `export type LoggingConfig = z.infer<typeof LoggingSchema>`

- [ ] **Step 4: Add env var overrides for logging in `applyEnvOverrides()`**

In the `applyEnvOverrides(raw)` method of ConfigManager (around line 150), add after the existing overrides loop:

```typescript
// Logging env var overrides
if (process.env.OPENACP_LOG_LEVEL) {
  raw.logging = raw.logging || {}
  ;(raw.logging as Record<string, unknown>).level = process.env.OPENACP_LOG_LEVEL
}
if (process.env.OPENACP_LOG_DIR) {
  raw.logging = raw.logging || {}
  ;(raw.logging as Record<string, unknown>).logDir = process.env.OPENACP_LOG_DIR
}
if (process.env.OPENACP_DEBUG && !process.env.OPENACP_LOG_LEVEL) {
  raw.logging = raw.logging || {}
  ;(raw.logging as Record<string, unknown>).level = 'debug'
}
```

Note: The parameter is `raw: Record<string, unknown>`, not `config`.

Note: `OPENACP_DEBUG` only sets debug if `OPENACP_LOG_LEVEL` is not set (priority rule).

- [ ] **Step 5: Run tests**

```bash
pnpm test -- src/__tests__/logging-config.test.ts
```

Expected: All PASS.

- [ ] **Step 6: Run full test suite to verify no regressions**

```bash
pnpm test
```

Expected: All existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/config.ts src/__tests__/logging-config.test.ts
git commit -m "feat: add logging configuration schema with env var overrides"
```

---

### Task 3: Rewrite Logger Core (`src/core/log.ts`)

**Files:**
- Rewrite: `src/core/log.ts`
- Test: `src/__tests__/logger.test.ts`

- [ ] **Step 1: Write failing tests for logger module**

Create `src/__tests__/logger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initLogger, shutdownLogger, createChildLogger, log } from '../core/log.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('logger', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-log-test-'))
  })

  afterEach(async () => {
    await shutdownLogger()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('default log instance works before initLogger (console-only)', () => {
    // Should not throw — logs to console only
    expect(() => log.info('test message')).not.toThrow()
  })

  it('initLogger creates log directory and file', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'info', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    log.info('hello from test')

    // Give pino a moment to flush
    await new Promise(r => setTimeout(r, 200))

    expect(fs.existsSync(logDir)).toBe(true)
    const files = fs.readdirSync(logDir)
    expect(files.some(f => f.startsWith('openacp'))).toBe(true)
  })

  it('createChildLogger adds module context', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'debug', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    const childLog = createChildLogger({ module: 'test-module' })
    childLog.info('child message')

    await new Promise(r => setTimeout(r, 200))

    const logFile = fs.readdirSync(logDir).find(f => f.startsWith('openacp'))
    const content = fs.readFileSync(path.join(logDir, logFile!), 'utf-8')
    const lines = content.trim().split('\n').map(l => JSON.parse(l))
    const entry = lines.find((l: any) => l.msg === 'child message')
    expect(entry).toBeDefined()
    expect(entry.module).toBe('test-module')
  })

  it('log wrapper supports variadic args for backward compat', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'info', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    log.info('loaded from', '/some/path')

    await new Promise(r => setTimeout(r, 200))

    const logFile = fs.readdirSync(logDir).find(f => f.startsWith('openacp'))
    const content = fs.readFileSync(path.join(logDir, logFile!), 'utf-8')
    expect(content).toContain('loaded from /some/path')
  })

  it('respects log level', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'warn', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    log.info('should not appear')
    log.warn('should appear')

    await new Promise(r => setTimeout(r, 200))

    const logFile = fs.readdirSync(logDir).find(f => f.startsWith('openacp'))
    const content = fs.readFileSync(path.join(logDir, logFile!), 'utf-8')
    expect(content).not.toContain('should not appear')
    expect(content).toContain('should appear')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- src/__tests__/logger.test.ts
```

Expected: FAIL — `initLogger`, `shutdownLogger`, `createChildLogger` do not exist.

- [ ] **Step 3: Implement the logger module**

Rewrite `src/core/log.ts` with the following structure:

```typescript
import pino from 'pino'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { LoggingConfig } from './config.js'

export type Logger = pino.Logger

// --- Default console-only logger (pre-init) ---
let rootLogger: pino.Logger = pino({ level: 'debug' })
let initialized = false
let logDir: string | undefined

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

// --- Variadic wrapper for backward compatibility ---
function wrapVariadic(logger: pino.Logger) {
  return {
    info: (...args: unknown[]) => {
      if (args.length === 0) return
      if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
        logger.info(args[0] as object, args.slice(1).join(' '))
      } else {
        logger.info(args.map(String).join(' '))
      }
    },
    warn: (...args: unknown[]) => {
      if (args.length === 0) return
      if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
        logger.warn(args[0] as object, args.slice(1).join(' '))
      } else {
        logger.warn(args.map(String).join(' '))
      }
    },
    error: (...args: unknown[]) => {
      if (args.length === 0) return
      if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
        logger.error(args[0] as object, args.slice(1).join(' '))
      } else {
        logger.error(args.map(String).join(' '))
      }
    },
    debug: (...args: unknown[]) => {
      if (args.length === 0) return
      if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
        logger.debug(args[0] as object, args.slice(1).join(' '))
      } else {
        logger.debug(args.map(String).join(' '))
      }
    },
    fatal: (...args: unknown[]) => {
      if (args.length === 0) return
      if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
        logger.fatal(args[0] as object, args.slice(1).join(' '))
      } else {
        logger.fatal(args.map(String).join(' '))
      }
    },
    child: (bindings: pino.Bindings) => logger.child(bindings),
  }
}

export const log = wrapVariadic(rootLogger)

// --- Public API ---

export function initLogger(config: LoggingConfig): Logger {
  if (initialized) return rootLogger

  const resolvedLogDir = expandHome(config.logDir)
  logDir = resolvedLogDir

  try {
    fs.mkdirSync(resolvedLogDir, { recursive: true })
    fs.mkdirSync(path.join(resolvedLogDir, 'sessions'), { recursive: true })
  } catch (err) {
    console.error(`[WARN] Failed to create log directory ${resolvedLogDir}, falling back to console-only:`, err)
    return rootLogger
  }

  const transports = pino.transport({
    targets: [
      {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
        level: config.level,
      },
      {
        target: 'pino-roll',
        options: {
          file: path.join(resolvedLogDir, 'openacp.log'),
          size: config.maxFileSize,
          limit: { count: config.maxFiles },
        },
        level: config.level,
      },
    ],
  })

  rootLogger = pino({ level: config.level }, transports)
  initialized = true

  // Update the default log wrapper to use the new root logger
  Object.assign(log, wrapVariadic(rootLogger))

  return rootLogger
}

export function createChildLogger(context: { module: string; [key: string]: unknown }): Logger {
  return rootLogger.child(context)
}

export function createSessionLogger(sessionId: string, parentLogger: Logger): Logger {
  const sessionLogDir = logDir ? path.join(logDir, 'sessions') : undefined
  if (!sessionLogDir) {
    return parentLogger.child({ sessionId })
  }

  try {
    const sessionLogPath = path.join(sessionLogDir, `${sessionId}.log`)
    const dest = pino.destination(sessionLogPath)
    const sessionFileLogger = pino({ level: parentLogger.level }, dest)

    // Create a logger that writes to both parent (combined) and session file
    const combinedChild = parentLogger.child({ sessionId })
    const originalInfo = combinedChild.info.bind(combinedChild)
    const originalWarn = combinedChild.warn.bind(combinedChild)
    const originalError = combinedChild.error.bind(combinedChild)
    const originalDebug = combinedChild.debug.bind(combinedChild)
    const originalFatal = combinedChild.fatal.bind(combinedChild)

    // Proxy log methods to write to both destinations
    combinedChild.info = ((...args: any[]) => {
      sessionFileLogger.info(...args)
      return originalInfo(...args)
    }) as any
    combinedChild.warn = ((...args: any[]) => {
      sessionFileLogger.warn(...args)
      return originalWarn(...args)
    }) as any
    combinedChild.error = ((...args: any[]) => {
      sessionFileLogger.error(...args)
      return originalError(...args)
    }) as any
    combinedChild.debug = ((...args: any[]) => {
      sessionFileLogger.debug(...args)
      return originalDebug(...args)
    }) as any
    combinedChild.fatal = ((...args: any[]) => {
      sessionFileLogger.fatal(...args)
      return originalFatal(...args)
    }) as any

    // Store dest for cleanup
    ;(combinedChild as any).__sessionDest = dest

    return combinedChild
  } catch (err) {
    // Graceful degradation: session file failed, just use combined log
    parentLogger.warn({ sessionId, err }, 'Failed to create session log file, using combined log only')
    return parentLogger.child({ sessionId })
  }
}

export async function shutdownLogger(): Promise<void> {
  if (!initialized) return

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      resolve()
    }, 5000)

    rootLogger.flush()
    // Give transports time to flush
    setTimeout(() => {
      clearTimeout(timeout)
      // Reset to console-only logger so tests can re-init
      rootLogger = pino({ level: 'debug' })
      Object.assign(log, wrapVariadic(rootLogger))
      logDir = undefined
      initialized = false
      resolve()
    }, 500)
  })
}

export async function cleanupOldSessionLogs(retentionDays: number): Promise<void> {
  if (!logDir) return

  const sessionsDir = path.join(logDir, 'sessions')
  try {
    const files = await fs.promises.readdir(sessionsDir)
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

    for (const file of files) {
      try {
        const filePath = path.join(sessionsDir, file)
        const stat = await fs.promises.stat(filePath)
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath)
          rootLogger.debug({ file }, 'Deleted old session log')
        }
      } catch (err) {
        rootLogger.warn({ file, err }, 'Failed to delete old session log')
      }
    }
  } catch {
    // Sessions directory doesn't exist — no-op
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- src/__tests__/logger.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Verify build compiles**

```bash
pnpm build
```

Expected: Clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/core/log.ts src/__tests__/logger.test.ts
git commit -m "feat: rewrite logger with pino, dual transports, child loggers"
```

---

### Task 4: Write Session Logger Tests and Implementation

**Files:**
- Test: `src/__tests__/session-logger.test.ts`
- Verify: `src/core/log.ts` (createSessionLogger already implemented in Task 3)

- [ ] **Step 1: Write tests for session logger**

Create `src/__tests__/session-logger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initLogger, shutdownLogger, createChildLogger, createSessionLogger } from '../core/log.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('session logger', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-session-log-'))
  })

  afterEach(async () => {
    await shutdownLogger()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a session log file', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'info', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    const parentLog = createChildLogger({ module: 'session' })
    const sessionLog = createSessionLogger('test-session-123', parentLog)
    sessionLog.info('session started')

    await new Promise(r => setTimeout(r, 200))

    const sessionFile = path.join(logDir, 'sessions', 'test-session-123.log')
    expect(fs.existsSync(sessionFile)).toBe(true)

    const content = fs.readFileSync(sessionFile, 'utf-8')
    expect(content).toContain('session started')
  })

  it('session log includes sessionId in context', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'debug', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    const parentLog = createChildLogger({ module: 'session' })
    const sessionLog = createSessionLogger('abc123', parentLog)
    sessionLog.info('prompt queued')

    await new Promise(r => setTimeout(r, 200))

    const sessionFile = path.join(logDir, 'sessions', 'abc123.log')
    const content = fs.readFileSync(sessionFile, 'utf-8')
    const entry = JSON.parse(content.trim().split('\n')[0])
    expect(entry.sessionId).toBe('abc123')
  })

  it('also writes to combined log', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'info', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    const parentLog = createChildLogger({ module: 'session' })
    const sessionLog = createSessionLogger('dual-write-test', parentLog)
    sessionLog.info('dual write message')

    await new Promise(r => setTimeout(r, 200))

    const combinedFile = fs.readdirSync(logDir).find(f => f.startsWith('openacp'))
    if (combinedFile) {
      const content = fs.readFileSync(path.join(logDir, combinedFile), 'utf-8')
      expect(content).toContain('dual write message')
    }
  })
})
```

- [ ] **Step 2: Run tests**

```bash
pnpm test -- src/__tests__/session-logger.test.ts
```

Expected: All PASS (implementation from Task 3).

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/session-logger.test.ts
git commit -m "test: add session logger tests"
```

---

### Task 5: Integrate Logger into main.ts

**Files:**
- Modify: `src/main.ts` (lines 1-100)

- [ ] **Step 1: Add initLogger call after config loads**

In `src/main.ts`, update imports:

```typescript
import { initLogger, shutdownLogger, cleanupOldSessionLogs, log } from './core/log.js'
```

Remove the existing `import { log } from './core/log.js'` line (replace with the above).

After config is loaded (around line 25, after `configManager.load()`), add:

```typescript
const config = configManager.get()
initLogger(config.logging)
log.info({ configPath: configManager.getConfigPath() }, 'Config loaded')

// Async cleanup of old session logs (non-blocking)
cleanupOldSessionLogs(config.logging.sessionLogRetentionDays).catch(err =>
  log.warn({ err }, 'Session log cleanup failed')
)
```

- [ ] **Step 2: Add shutdownLogger to graceful shutdown**

In the SIGINT/SIGTERM handler (around line 65), after `core.stop()` and before `process.exit(0)`, add:

```typescript
await shutdownLogger()
```

- [ ] **Step 3: Migrate existing log calls to structured format**

Update all existing `log.info(...)`, `log.error(...)` calls in main.ts to use pino's object-first form where appropriate. Examples:

```typescript
// Before: log.info('Starting OpenACP server...')
// After:
log.info('Starting OpenACP server')

// Before: log.info(`Registered adapter: ${name}`)
// After:
log.info({ adapter: name }, 'Adapter registered')

// Before: log.error('Failed to load adapter:', name, err)
// After:
log.error({ adapter: name, err }, 'Failed to load adapter')
```

- [ ] **Step 4: Verify build and existing tests**

```bash
pnpm build && pnpm test
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: integrate pino logger into server startup and shutdown"
```

---

### Task 6: Migrate Core Modules to Child Loggers

**Files:**
- Modify: `src/core/core.ts`
- Modify: `src/core/session.ts`
- Modify: `src/core/agent-instance.ts`
- Modify: `src/core/plugin-manager.ts`
- Modify: `src/core/config.ts`

- [ ] **Step 1: Migrate `core.ts`**

Replace `import { log } from './log.js'` with:
```typescript
import { createChildLogger } from './log.js'
const log = createChildLogger({ module: 'core' })
```

Update existing log calls to use structured format:
```typescript
// handleMessage:
log.info({ channelId: message.channelId, threadId: message.threadId, userId: message.userId }, 'Incoming message')

// handleNewSession:
log.info({ channelId, agentName }, 'New session requested')

// Security rejection:
log.warn({ userId: message.userId }, 'Message rejected: user not in allowedUserIds')

// Session limit:
log.warn({ userId: message.userId, current: activeSessions, max: maxConcurrentSessions }, 'Session limit reached')

// toOutgoingMessage — commands_update (line ~142):
log.debug({ commands: event.commands }, 'Commands update')

// wireSessionEvents — commands_update handler (line ~187):
log.debug({ commands: event.commands }, 'Commands available')
```

- [ ] **Step 2: Migrate `session.ts`**

Replace `import { log } from './log.js'` with:
```typescript
import { createChildLogger, createSessionLogger, type Logger } from './log.js'
const moduleLog = createChildLogger({ module: 'session' })
```

Add a `log` property to the Session class. In the constructor:
```typescript
this.log = createSessionLogger(this.id, moduleLog)
```

Add session lifecycle logging:
```typescript
// In constructor:
this.log.info({ agentName: this.agentName }, 'Session created')

// In enqueuePrompt:
this.log.debug({ queueDepth: this.promptQueue.length }, 'Prompt queued')

// In runPrompt — add timing:
const startTime = Date.now()
// ... existing prompt logic ...
this.log.info({ durationMs: Date.now() - startTime }, 'Prompt completed')

// In runPrompt catch:
this.log.error({ err }, 'Prompt execution failed')

// In autoName success:
this.log.info({ name: this.name }, 'Session auto-named')

// In cancel:
this.log.info('Session cancelled')

// In destroy:
this.log.info('Session destroyed')
```

- [ ] **Step 3: Migrate `agent-instance.ts`**

Replace `import { log } from './log.js'` with:
```typescript
import { createChildLogger } from './log.js'
const log = createChildLogger({ module: 'agent-instance' })
```

Update and add log calls:
```typescript
// In spawn — after successful creation:
log.info({ sessionId: instance.sessionId, agentName, command: resolvedCommand }, 'Agent spawned')

// Spawn time tracking:
const spawnStart = Date.now()
// ... spawn logic ...
log.info({ sessionId, durationMs: Date.now() - spawnStart }, 'Agent spawn complete')

// On agent exit:
log.info({ sessionId, exitCode: code, signal }, 'Agent process exited')

// On ACP connection close:
log.debug({ sessionId }, 'ACP connection closed')
```

- [ ] **Step 4: Migrate `plugin-manager.ts`**

Replace `import { log } from './log.js'` with:
```typescript
import { createChildLogger } from './log.js'
const log = createChildLogger({ module: 'plugin-manager' })
```

Update existing log calls to structured form.

- [ ] **Step 5: Migrate `config.ts`**

Replace `import { log } from './log.js'` with:
```typescript
import { createChildLogger } from './log.js'
const log = createChildLogger({ module: 'config' })
```

Update existing log calls to structured form. Remember: these calls happen before `initLogger()` runs, so they go to console-only. This is expected per the bootstrap ordering in the spec.

- [ ] **Step 6: Verify build and tests**

```bash
pnpm build && pnpm test
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/core.ts src/core/session.ts src/core/agent-instance.ts src/core/plugin-manager.ts src/core/config.ts
git commit -m "feat: migrate core modules to pino child loggers with structured context"
```

---

### Task 7: Add Logging to Telegram Adapter

**Files:**
- Modify: `src/adapters/telegram/adapter.ts`
- Modify: `src/adapters/telegram/commands.ts`
- Modify: `src/adapters/telegram/permissions.ts`

- [ ] **Step 1: Add child logger to adapter.ts**

**Important:** `adapter.ts` currently imports `log` from `'../../core/index.js'` as part of a destructured import (line 2). Remove `log` from that import statement to avoid naming conflict.

Add new import:
```typescript
import { createChildLogger } from '../../core/log.js'
const log = createChildLogger({ module: 'telegram' })
```

Replace existing `log.error` / `log.info` calls with structured logging:

```typescript
// In start():
log.info({ chatId: this.telegramConfig.chatId }, 'Telegram bot started')

// Bot error handler:
log.error({ err: error }, 'Telegram bot error')

// In sendMessage:
log.debug({ sessionId, type: content.type }, 'Sending message to Telegram')

// In sendPermissionRequest:
log.info({ sessionId, requestId: request.id }, 'Permission request sent')

// In sendNotification:
log.info({ sessionId: notification.sessionId, type: notification.type }, 'Notification sent')

// In createSessionThread:
log.info({ sessionId, name }, 'Session topic created')

// In stop():
log.info('Telegram bot stopped')
```

- [ ] **Step 2: Add logging to commands.ts**

Add import:
```typescript
import { createChildLogger } from '../../core/log.js'
const log = createChildLogger({ module: 'telegram-commands' })
```

Add logging for command execution:
```typescript
// /new command:
log.info({ userId: ctx.from?.id, agentName }, 'New session command')

// /cancel command:
log.info({ sessionId }, 'Cancel session command')
```

- [ ] **Step 3: Add logging to permissions.ts**

Add import:
```typescript
import { createChildLogger } from '../../core/log.js'
const log = createChildLogger({ module: 'telegram-permissions' })
```

```typescript
// Permission responded:
log.info({ requestId, optionId, isAllow }, 'Permission responded')
```

- [ ] **Step 4: Verify build**

```bash
pnpm build
```

Expected: Clean compile.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/telegram/adapter.ts src/adapters/telegram/commands.ts src/adapters/telegram/permissions.ts
git commit -m "feat: add structured logging to Telegram adapter"
```

---

### Task 8: Update Public API Exports

**Files:**
- Modify: `src/core/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Export logging API from core/index.ts**

Add to `src/core/index.ts`:
```typescript
export { log, initLogger, createChildLogger, createSessionLogger, shutdownLogger, cleanupOldSessionLogs, type Logger } from './log.js'
export type { LoggingConfig } from './config.js'
```

- [ ] **Step 2: Re-export from src/index.ts if needed**

Check if `src/index.ts` re-exports from core. If so, ensure the logging exports are included.

- [ ] **Step 3: Verify build**

```bash
pnpm build
```

Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add src/core/index.ts src/index.ts
git commit -m "feat: export logging API for plugin authors"
```

---

### Task 9: Final Integration Test and Cleanup

**Files:**
- Test: `src/__tests__/logger-integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `src/__tests__/logger-integration.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { initLogger, shutdownLogger, createChildLogger, createSessionLogger, cleanupOldSessionLogs, log } from '../core/log.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('logger integration', () => {
  let tmpDir: string

  afterEach(async () => {
    await shutdownLogger()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('full lifecycle: init → child → session → cleanup → shutdown', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-int-'))
    const logDir = path.join(tmpDir, 'logs')

    // 1. Init
    initLogger({ level: 'debug', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    // 2. Module child logger
    const coreLog = createChildLogger({ module: 'core' })
    coreLog.info('core started')

    // 3. Session logger
    const sessionLog = createSessionLogger('integration-sess', coreLog)
    sessionLog.info({ promptLength: 42 }, 'Prompt queued')
    sessionLog.warn('something iffy')
    sessionLog.error({ err: new Error('test error') }, 'Prompt failed')

    // 4. Wait for flush
    await new Promise(r => setTimeout(r, 300))

    // 5. Verify combined log
    const combinedFile = fs.readdirSync(logDir).find(f => f.startsWith('openacp'))
    expect(combinedFile).toBeDefined()
    const combined = fs.readFileSync(path.join(logDir, combinedFile!), 'utf-8')
    expect(combined).toContain('core started')
    expect(combined).toContain('Prompt queued')
    expect(combined).toContain('Prompt failed')

    // 6. Verify session log
    const sessionFile = path.join(logDir, 'sessions', 'integration-sess.log')
    expect(fs.existsSync(sessionFile)).toBe(true)
    const sessionContent = fs.readFileSync(sessionFile, 'utf-8')
    expect(sessionContent).toContain('Prompt queued')
    expect(sessionContent).toContain('integration-sess')

    // 7. Cleanup (should not delete fresh file)
    await cleanupOldSessionLogs(30)
    expect(fs.existsSync(sessionFile)).toBe(true)

    // 8. Shutdown
    await shutdownLogger()
  })

  it('gracefully degrades if log dir is not writable', () => {
    // /dev/null/subdir cannot be created on any platform
    expect(() => {
      initLogger({ level: 'info', logDir: '/dev/null/openacp-test-log', maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })
    }).not.toThrow()
  })
})
```

- [ ] **Step 2: Run all tests**

```bash
pnpm test
```

Expected: All PASS.

- [ ] **Step 3: Verify build**

```bash
pnpm build
```

Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/logger-integration.test.ts
git commit -m "test: add logger integration tests for full lifecycle"
```

---

### Task 10: Verify End-to-End

- [ ] **Step 1: Run full test suite one final time**

```bash
pnpm test
```

Expected: All PASS.

- [ ] **Step 2: Verify production build**

```bash
pnpm build && pnpm build:publish
```

Expected: Both succeed.

- [ ] **Step 3: Quick smoke test**

```bash
OPENACP_LOG_LEVEL=debug node dist/main.js
```

Expected: Pretty-printed logs in terminal, log files created in `~/.openacp/logs/`. Stop with Ctrl+C and verify files exist.
