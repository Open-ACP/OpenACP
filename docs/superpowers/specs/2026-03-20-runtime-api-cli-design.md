# Runtime API & CLI Design Spec

## Goal

Add an HTTP control API to the OpenACP daemon and a `openacp runtime` CLI subcommand to interact with it. This allows users to create sessions, cancel sessions, check status, and list agents from the terminal without using Telegram.

## Context

OpenACP currently manages sessions exclusively through the Telegram adapter. Bot commands like `/new`, `/cancel`, `/status`, `/agents` are only available in Telegram. This spec adds a parallel control path via HTTP API + CLI.

## Architecture

```
CLI (openacp runtime new)
  → reads ~/.openacp/api.port
  → fetch("http://127.0.0.1:{port}/api/sessions", { method: "POST" })
  → daemon's HTTP server receives request
  → calls core methods (sessionManager, agentManager)
  → CLI gets JSON response
```

The HTTP API is embedded in the daemon process alongside the Telegram bot. It uses Node.js native `http` module (zero new dependencies). The API listens only on `127.0.0.1` (localhost-only, no auth needed).

**Note:** API-created sessions do NOT create Telegram topics or wire adapter events. They are headless sessions — useful for triggering agent work programmatically. Session output goes to session logs only. In the future, a streaming endpoint could expose real-time output.

## 1. Config Schema Changes

Add `api` section to `ConfigSchema` in `src/core/config.ts`:

```typescript
api: z.object({
  port: z.number().default(21420),
  host: z.string().default('127.0.0.1'),
}).default({}),
```

Environment variable override: Add `['OPENACP_API_PORT', ['api', 'port']]` to the `applyEnvOverrides` array with numeric cast (same pattern as `chatId`).

## 2. API Server Module

**File:** `src/core/api-server.ts`

### Port Discovery

On start, the server writes the actual listening port to `~/.openacp/api.port`. On stop, it removes this file. This allows the CLI to discover the port even if it differs from config (e.g., fallback on port conflict).

### Endpoints

| Method | Path | Request Body | Response | Purpose |
|--------|------|-------------|----------|---------|
| `POST` | `/api/sessions` | `{"agent": "claude", "workspace": "/path"}` (both optional, `workspace` follows same resolution rules as `configManager.resolveWorkspace()`) | `{"sessionId": "abc", "agent": "claude", "status": "initializing"}` | Create new session |
| `DELETE` | `/api/sessions/:id` | — | `{"ok": true}` | Cancel session |
| `GET` | `/api/sessions` | — | `{"sessions": [{"id", "agent", "status", "name"}]}` | List all sessions (across all channels) |
| `GET` | `/api/agents` | — | `{"agents": [{"name", "command", "args"}], "default": "claude"}` | List agents |

### Error Responses

All errors return JSON with `{"error": "message"}`:

| Status | Condition |
|--------|-----------|
| 400 | Invalid JSON body |
| 404 | Session not found (cancel) |
| 429 | Max concurrent sessions reached |
| 500 | Internal server error |

### Server Lifecycle

```typescript
export class ApiServer {
  constructor(private core: OpenACPCore, private config: ApiConfig) {}

  async start(): Promise<void>
  // Creates http.Server, listens on config.host:config.port
  // Writes port to ~/.openacp/api.port
  // Logs "API server listening on {host}:{port}"

  async stop(): Promise<void>
  // Closes http.Server
  // Removes ~/.openacp/api.port file
}
```

### Request Routing

Simple URL-based routing using `req.url` and `req.method`:

```typescript
if (method === 'POST' && url === '/api/sessions') → handleCreateSession
if (method === 'DELETE' && url.match(/^\/api\/sessions\/(.+)$/)) → handleCancelSession
if (method === 'GET' && url === '/api/sessions') → handleListSessions
if (method === 'GET' && url === '/api/agents') → handleListAgents
else → 404
```

### Session Creation via API

When `POST /api/sessions` is called:

1. Parse optional `agent` and `workspace` from JSON body
2. Use `channelId = "api"` for API-created sessions
3. Call `core.handleNewSession("api", agent, workspace)` — this creates the session and spawns the agent subprocess
4. Since no adapter is registered for `"api"`, `wireSessionEvents` is a no-op — session events (text, errors) are not forwarded to any channel UI. The session runs headless with output going only to session logs.
5. Return session info as JSON

**No Telegram topic is created.** API sessions are independent of the Telegram adapter. This is intentional — the API is a control plane, not a chat interface.

### Core Access Pattern

`ApiServer` accesses core functionality through these paths:

- **Create session**: `core.handleNewSession(channelId, agent, workspace)` — existing public method
- **Cancel session**: `core.sessionManager.getSession(id)` then `session.cancel()` — direct sub-manager access is acceptable since `ApiServer` is an internal module (not a plugin)
- **List sessions**: `core.sessionManager.listAllSessions()` — new method needed (existing `listSessions(channelId)` filters by channel; we need all sessions)
- **List agents**: `core.agentManager.getAvailableAgents()` for agent list, `core.configManager.get().defaultAgent` for default agent name

### Port Conflict Handling

If the configured port is in use:
- Log a warning
- Continue without API server (daemon still works via Telegram)
- Do NOT write `api.port` file (so CLI knows API is unavailable)

## 3. CLI `runtime` Subcommand

**File:** Changes to `src/cli.ts`

### Commands

```
openacp runtime new [agent] [--workspace path]   Create a new session
openacp runtime cancel <session-id>               Cancel a session
openacp runtime status                            Show active sessions
openacp runtime agents                            List available agents
```

### Implementation

Each runtime command:
1. Reads `~/.openacp/api.port` to get the port
2. If file missing: prints "OpenACP is not running. Start with `openacp start`" and exits with code 1
3. Uses native `fetch()` (Node 18+) to call `http://127.0.0.1:{port}/api/...`
4. If connection refused: prints "OpenACP is not running (stale port file)", **removes the stale `api.port` file**, and exits with code 1
5. Parses JSON response and formats output
6. Exits with code 0 on success, 1 on error

### Output Format

```
$ openacp runtime new claude
Session created
  ID     : abc123
  Agent  : claude
  Status : initializing

$ openacp runtime status
Active sessions: 2

  abc123  claude  active   "Fix login bug"
  def456  claude  active   "Add dark mode"

$ openacp runtime agents
Available agents:
  claude (default)
  python-agent

$ openacp runtime cancel abc123
Session abc123 cancelled
```

### Unknown Subcommand

```
$ openacp runtime foo
Unknown runtime command: foo

Usage:
  openacp runtime new [agent]         Create a new session
  openacp runtime cancel <id>         Cancel a session
  openacp runtime status              Show active sessions
  openacp runtime agents              List available agents
```

## 4. Integration Changes

### main.ts

The `adapters.size === 0` guard in `main.ts` remains — at least one channel adapter (e.g., Telegram) must still be configured. The API server is a control plane, not a replacement for channel adapters. If the user wants API-only mode, that's a future enhancement.

After `core.start()`:
```typescript
const apiServer = new ApiServer(core, config.api)
await apiServer.start()
```

In shutdown handler:
```typescript
await apiServer.stop()
```

### cli.ts Help Text

Add to `printHelp()`:
```
Runtime (requires running daemon):
  openacp runtime new [agent]         Create a new session
  openacp runtime cancel <id>         Cancel a session
  openacp runtime status              Show active sessions
  openacp runtime agents              List available agents

Note: "openacp status" shows daemon process health.
      "openacp runtime status" shows active agent sessions.
```

### Config Editor

Add "API" section to config editor menu in `src/core/config-editor.ts`:
- Edit API port

### Exports

Add to `src/core/index.ts` (the internal barrel export, not `src/index.ts`):
```typescript
export { ApiServer } from './api-server.js'
```

### SessionManager Addition

Add `listAllSessions()` method to `SessionManager` that returns all sessions across all channels (the existing `listSessions(channelId)` filters by channel).

## 5. Constraints

- **Localhost only**: API binds to `127.0.0.1`, never `0.0.0.0`
- **No auth**: Since localhost-only, no authentication needed
- **No new dependencies**: Uses Node.js native `http` module and `fetch()`
- **Graceful degradation**: If port is busy, daemon continues without API
- **ESM-only**: All imports use `.js` extension per project conventions
- **Requires channel adapter**: At least one channel (e.g., Telegram) must be configured. API-only mode is not supported in this version.

## 6. Testing Strategy

- **Unit tests** for API server: mock `OpenACPCore`, test each endpoint returns correct JSON and status codes
- **Unit tests** for CLI runtime commands: mock `fetch()`, test output formatting and error handling
- **Port file** tests: write/read/cleanup lifecycle
- **Port conflict** test: verify daemon continues without API when port is busy, and `api.port` file is NOT written
- **Stale port file** test: verify CLI removes `api.port` on connection refused
