# Logging System Design

## Problem

OpenACP currently uses a minimal console wrapper (`src/core/log.ts`) for logging. This provides no file persistence, no structured output for machine parsing, no per-session isolation, and limited contextual information. Operators cannot observe what the system is doing in production, and developers lack sufficient detail when debugging.

## Decision

Replace the existing console wrapper with a pino-based logging system that provides dual output (pretty terminal + JSON files), per-session log files, and contextual child loggers.

## Architecture

### Transport Layout

```
                            ┌─── pino-pretty ──→ stdout (human-readable, colored)
initLogger() ─→ pino root ──┤
                            └─── pino-roll ────→ ~/.openacp/logs/openacp.log (JSON lines)
```

Each session additionally creates a file transport writing to `~/.openacp/logs/sessions/<sessionId>.log`.

### Logger Hierarchy

```
root logger (level, transports)
  ├── child: { module: 'core' }
  ├── child: { module: 'session' }
  │     └── child: { sessionId: 'abc123' }  ← also writes to session file
  ├── child: { module: 'agent-instance' }
  ├── child: { module: 'telegram' }
  ├── child: { module: 'plugin-manager' }
  └── child: { module: 'config' }
```

Child loggers inherit the root level and transports. Session loggers add an additional file transport for the session-specific log file.

### Dependencies

| Package | Purpose | Type |
|---------|---------|------|
| `pino` | Core structured logger | dependency |
| `pino-pretty` | Colored terminal output | dependency (required at runtime for TTY detection) |
| `pino-roll` | File rotation transport | dependency |

## File Logging & Rotation

### Combined Log

- **Path:** `~/.openacp/logs/openacp.log`
- **Format:** JSON lines (one JSON object per line)
- **Rotation:** via `pino-roll`, rotate at **10m** (pino-roll size format), keep **7** rotated files max
- **Rotated files:** `openacp.log.1`, `openacp.log.2`, etc.

Example output:

```jsonl
{"level":30,"time":1710849600000,"module":"session","sessionId":"abc123","msg":"Prompt queued","promptLength":142}
{"level":50,"time":1710849601000,"module":"telegram","err":{"message":"Connection timeout","stack":"..."},"msg":"Bot error"}
```

### Per-Session Logs

- **Path:** `~/.openacp/logs/sessions/<sessionId>.log`
- **Format:** JSON lines (same schema as combined log)
- **Rotation:** none (session logs are typically small)
- **Cleanup:** on server start, delete session log files older than **30 days**

### Lifecycle

1. Session logger created when session starts — opens session file transport
2. All log calls from that session write to both combined log and session file
3. Session file transport closed when session ends

## Contextual Logging Coverage

### What Gets Logged

**Core lifecycle** — server start/stop, config loaded, adapter registered *(mostly exists, migrate to pino)*

**Session lifecycle** — session created/destroyed, auto-naming result, prompt queued/started/completed (with duration ms), queue depth

**Agent instance** — agent spawn/exit (with exit code), ACP connection open/close, command updates

**Message routing** — `handleMessage()` incoming with target session, `handleNewSession()` with requesting user

**Adapter events** — bot start/stop, message sent/received, topic created, permission request sent/responded (with result), notification delivered

**Error handling** — all errors include context: `sessionId`, `userId`, `adapterId`, full error stack

**Performance timing** — prompt execution duration, agent spawn time, message delivery time

### What Does NOT Change

- `setup.ts` and `cli.ts` keep using direct `console.log` for interactive CLI output
- These are user-facing terminal UI, not system logging

## Configuration

### Config Schema

Added to `~/.openacp/config.json` under a `logging` key:

```json
{
  "logging": {
    "level": "info",
    "logDir": "~/.openacp/logs",
    "maxFileSize": "10m",
    "maxFiles": 7,
    "sessionLogRetentionDays": 30
  }
}
```

All fields are optional with sensible defaults (values shown above are the defaults).

### Zod Schema Addition

```typescript
const loggingSchema = z.object({
  level: z.enum(['silent', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  logDir: z.string().default('~/.openacp/logs'),
  maxFileSize: z.union([z.string(), z.number()]).default('10m'),  // pino-roll format: '10m', '1g', or bytes as number
  maxFiles: z.number().default(7),
  sessionLogRetentionDays: z.number().default(30),
}).default({})
```

### Environment Variable Overrides

| Env Var | Overrides | Example |
|---------|-----------|---------|
| `OPENACP_LOG_LEVEL` | `logging.level` | `debug`, `info`, `warn`, `error` |
| `OPENACP_LOG_DIR` | `logging.logDir` | `/var/log/openacp` |
| `OPENACP_DEBUG` | Sets level to `debug` | `1` or `true` |

**Priority:** `OPENACP_LOG_LEVEL` > `OPENACP_DEBUG` > config file > defaults

If both `OPENACP_LOG_LEVEL=warn` and `OPENACP_DEBUG=1` are set, `OPENACP_LOG_LEVEL` wins (more specific).

## Public API

Exported from `src/core/log.ts`:

```typescript
// Initialize root logger with config (called once in main.ts)
initLogger(config: LoggingConfig): Logger

// Create a child logger scoped to a module
createChildLogger(context: { module: string; [key: string]: unknown }): Logger

// Create a session logger that also writes to a per-session file
createSessionLogger(sessionId: string, parentLogger: Logger): Logger

// Flush buffers and close file transports (called on shutdown)
shutdownLogger(): Promise<void>
```

A default logger instance is exported for backward compatibility. Before `initLogger()` is called, it logs to console only (same behavior as current implementation). After `initLogger()`, it upgrades to include file transports.

Plugin authors use `createChildLogger({ module: 'my-plugin' })` to get their own contextualized logger.

The `Logger` type is a re-export of `pino.Logger` for simplicity. Plugin authors can import it for typing.

The Zod enum includes `'silent'` for use in tests: `OPENACP_LOG_LEVEL=silent` suppresses all output.

## Bootstrap Ordering

`initLogger()` requires config, but `ConfigManager.load()` uses the logger. This is resolved by the default instance:

1. Server starts → default `log` instance is console-only (no file transports)
2. `ConfigManager.load()` runs → uses console-only logger → config validation errors appear in terminal but NOT in log files
3. `initLogger(config.logging)` runs → upgrades default instance with file transports
4. All subsequent logging goes to both terminal and files

This is intentional: config loading errors are visible in the terminal where the operator is watching. They will not appear in log files since the log directory may itself be misconfigured.

## Error Handling & Graceful Degradation

- If the log directory cannot be created or written to, the logger degrades to console-only and emits a warning to stderr
- If a session log file cannot be opened, that session logs to combined file only (no crash)
- `shutdownLogger()` flushes pino with a timeout (5s). If flush times out, remaining buffered logs may be lost. This is called in `main.ts` after `core.stop()` but before `process.exit()`
- File I/O errors never crash the process — logging is best-effort

## Session Log Cleanup

On server start, session log cleanup runs **asynchronously** (non-blocking):

- Reads `~/.openacp/logs/sessions/`, checks file mtime
- Deletes files older than `sessionLogRetentionDays`
- Individual deletion failures are logged as warnings, do not block startup
- If the directory does not exist, cleanup is a no-op

## Migration Strategy

### Backward Compatibility

- `import { log } from './log.js'` continues to work — exports a default instance
- Before `initLogger()` runs, default instance uses console-only output (matches current behavior)

### Calling Convention Change

The current codebase uses variadic arguments: `log.info('Config loaded from', path)`. Pino does not support this — its API is `logger.info(msg)` or `logger.info({ key: value }, msg)`.

The default `log` export provides a **thin wrapper** that joins variadic args into a single message string for pino, preserving backward compatibility for existing call sites. New code should use pino's native object-first form for structured data:

```typescript
// Existing code (still works via wrapper)
log.info('Config loaded from', configManager.getConfigPath())

// New code (preferred — structured data in first arg)
log.info({ sessionId, promptLength: 142 }, 'Prompt queued')
```

All call sites will be migrated to the object-first form during the migration, but the wrapper ensures nothing breaks if a call site is missed.

### Migration Steps

1. **Rewrite `src/core/log.ts`** — pino setup, dual transports, child logger factories, default instance
2. **Update `src/core/config.ts`** — add `logging` field to Zod config schema
3. **Update `src/main.ts`** — call `initLogger()` on start, `shutdownLogger()` on shutdown
4. **Update `src/core/session.ts`** — use `createSessionLogger()`, add session lifecycle logs
5. **Update each module** — replace `log` import with child logger including module context
6. **Add new log points** — cover the gaps listed in the Contextual Logging Coverage section
