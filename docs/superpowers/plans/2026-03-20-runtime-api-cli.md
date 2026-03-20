# Runtime API & CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an HTTP control API to the OpenACP daemon and `openacp runtime` CLI commands to create/cancel sessions, list sessions, and list agents.

**Architecture:** A lightweight HTTP server (`ApiServer`) using Node's native `http` module runs inside the daemon process alongside adapters. It exposes 4 JSON endpoints on localhost. The CLI reads a port file (`~/.openacp/api.port`) to discover the server and uses `fetch()` to call it.

**Tech Stack:** Node.js native `http` module, native `fetch()` (Node 18+), Zod for config validation, vitest for tests.

**Spec deviation:** The spec calls for a new `listAllSessions()` method on `SessionManager`. The existing `listSessions(channelId?: string)` already returns all sessions when called without args (`session-manager.ts:37-41`), so `listAllSessions()` is unnecessary. We use `listSessions()` directly.

**Task dependencies:** Tasks 1→2→3→4 must be sequential (each builds on prior). Tasks 5 and 6 are independent and can run after Task 2.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/core/config.ts` | **Modify:** Add `api` section to ConfigSchema + env override |
| `src/core/api-server.ts` | **Create:** HTTP server class with 4 endpoints, port file management |
| `src/core/api-client.ts` | **Create:** CLI utility for reading port file and calling API |
| `src/cli.ts` | **Modify:** Add `runtime` subcommand handler + help text |
| `src/main.ts` | **Modify:** Start/stop ApiServer in server lifecycle |
| `src/core/config-editor.ts` | **Modify:** Add API section to config editor menu |
| `src/core/index.ts` | **Modify:** Export ApiServer |
| `src/__tests__/config-schema.test.ts` | **Modify:** Add api config tests |
| `src/__tests__/api-server.test.ts` | **Create:** Unit tests for API server endpoints |
| `src/__tests__/cli-runtime.test.ts` | **Create:** Unit tests for CLI runtime commands |

---

### Task 1: Config Schema — Add `api` section

**Files:**
- Modify: `src/core/config.ts:32-47`
- Modify: `src/core/config.ts:164-183`
- Test: `src/__tests__/config-schema.test.ts`

- [ ] **Step 1: Write failing tests for api config**

Add to `src/__tests__/config-schema.test.ts`:

```typescript
describe('ConfigSchema - api', () => {
  const baseConfig = {
    channels: { telegram: { enabled: false } },
    agents: { claude: { command: 'claude-agent-acp', args: [], env: {} } },
    defaultAgent: 'claude',
  }

  it('defaults api.port to 21420 and api.host to 127.0.0.1', () => {
    const result = ConfigSchema.parse(baseConfig)
    expect(result.api.port).toBe(21420)
    expect(result.api.host).toBe('127.0.0.1')
  })

  it('accepts custom api port', () => {
    const result = ConfigSchema.parse({ ...baseConfig, api: { port: 9999 } })
    expect(result.api.port).toBe(9999)
    expect(result.api.host).toBe('127.0.0.1')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/config-schema.test.ts`
Expected: FAIL — `result.api` is undefined

- [ ] **Step 3: Add api section to ConfigSchema**

In `src/core/config.ts`, add to the `ConfigSchema` object (after `autoStart`):

```typescript
  api: z.object({
    port: z.number().default(21420),
    host: z.string().default('127.0.0.1'),
  }).default({}),
```

- [ ] **Step 4: Add OPENACP_API_PORT env override**

In `src/core/config.ts`, in the `applyEnvOverrides` method, add to the `overrides` array:

```typescript
      ['OPENACP_API_PORT', ['api', 'port']],
```

And update the numeric cast line to also handle `port`:

```typescript
        target[key] = (key === 'chatId' || key === 'port') ? Number(value) : value
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/config-schema.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/config.ts src/__tests__/config-schema.test.ts
git commit -m "feat(config): add api section with port and host defaults"
```

---

### Task 2: API Server — Core module

**Prerequisite:** Task 1 must be completed (config.api type must exist).

**Files:**
- Create: `src/core/api-server.ts`
- Create: `src/__tests__/api-server.test.ts`

**Context:** This is the main feature module. It creates an HTTP server that listens on localhost, handles 4 endpoints, manages the port file (`~/.openacp/api.port`), and interacts with `OpenACPCore` to create/cancel/list sessions and agents.

Key details from the codebase:
- `OpenACPCore` has `sessionManager`, `agentManager`, `configManager` as public properties
- `core.handleNewSession(channelId, agentName?, workspace?)` returns `Promise<Session>`. When `channelId` is `"api"`, no adapter is registered, so `wireSessionEvents` is a no-op — session runs headless.
- `core.sessionManager.getSession(id)` returns `Session | undefined`
- `core.sessionManager.listSessions()` (no args) returns all sessions across all channels (`session-manager.ts:37-41`)
- `session.cancel()` sets status to `'cancelled'` and cancels the agent subprocess
- `core.agentManager.getAvailableAgents()` returns `AgentDefinition[]` (name, command, args, workingDirectory, env)
- `core.configManager.get().defaultAgent` gives the default agent name
- `core.configManager.get().security.maxConcurrentSessions` gives the session limit
- Sessions have: `id`, `channelId`, `agentName`, `status` (`SessionStatus`), `name?`, `workingDirectory`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/api-server.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as net from 'node:net'

describe('ApiServer', () => {
  let tmpDir: string
  let portFilePath: string
  let server: any

  // Minimal mock of OpenACPCore
  const mockCore = {
    handleNewSession: vi.fn(),
    sessionManager: {
      getSession: vi.fn(),
      listSessions: vi.fn(() => []),
    },
    agentManager: {
      getAvailableAgents: vi.fn(() => []),
    },
    configManager: {
      get: vi.fn(() => ({
        defaultAgent: 'claude',
        security: { maxConcurrentSessions: 5 },
      })),
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-api-test-'))
    portFilePath = path.join(tmpDir, 'api.port')
  })

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function startServer(portOverride?: number) {
    const { ApiServer } = await import('../core/api-server.js')
    server = new ApiServer(mockCore as any, { port: portOverride ?? 0, host: '127.0.0.1' }, portFilePath)
    await server.start()
    return server.getPort()
  }

  function apiFetch(port: number, urlPath: string, options?: RequestInit) {
    return globalThis.fetch(`http://127.0.0.1:${port}${urlPath}`, options)
  }

  it('starts and writes port file', async () => {
    const port = await startServer()
    expect(fs.existsSync(portFilePath)).toBe(true)
    const writtenPort = parseInt(fs.readFileSync(portFilePath, 'utf-8').trim(), 10)
    expect(writtenPort).toBe(port)
  })

  it('stops and removes port file', async () => {
    await startServer()
    await server.stop()
    server = null
    expect(fs.existsSync(portFilePath)).toBe(false)
  })

  it('continues without API when port is in use (EADDRINUSE)', async () => {
    // Occupy a port
    const blocker = net.createServer()
    const blockerPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        resolve((blocker.address() as net.AddressInfo).port)
      })
    })

    try {
      await startServer(blockerPort)
      // Should not throw, server degrades gracefully
      expect(server.getPort()).toBe(0) // actualPort remains 0
      expect(fs.existsSync(portFilePath)).toBe(false) // no port file written
    } finally {
      blocker.close()
    }
  })

  it('POST /api/sessions creates a session', async () => {
    const mockSession = { id: 'abc123', agentName: 'claude', status: 'initializing' }
    mockCore.handleNewSession.mockResolvedValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'claude' }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.sessionId).toBe('abc123')
    expect(data.agent).toBe('claude')
    expect(data.status).toBe('initializing')
    expect(mockCore.handleNewSession).toHaveBeenCalledWith('api', 'claude', undefined)
  })

  it('POST /api/sessions with empty body uses defaults', async () => {
    const mockSession = { id: 'def456', agentName: 'claude', status: 'initializing' }
    mockCore.handleNewSession.mockResolvedValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(mockCore.handleNewSession).toHaveBeenCalledWith('api', undefined, undefined)
  })

  it('POST /api/sessions returns 429 when max sessions reached', async () => {
    // Mock 5 active sessions (matching maxConcurrentSessions: 5)
    mockCore.sessionManager.listSessions.mockReturnValueOnce([
      { status: 'active' }, { status: 'active' }, { status: 'active' },
      { status: 'active' }, { status: 'initializing' },
    ])
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions', { method: 'POST' })
    expect(res.status).toBe(429)
    const data = await res.json()
    expect(data.error).toContain('concurrent sessions')
  })

  it('DELETE /api/sessions/:id cancels a session', async () => {
    const mockSession = { id: 'abc123', cancel: vi.fn() }
    mockCore.sessionManager.getSession.mockReturnValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/abc123', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(mockSession.cancel).toHaveBeenCalled()
  })

  it('DELETE /api/sessions/:id returns 404 for unknown session', async () => {
    mockCore.sessionManager.getSession.mockReturnValueOnce(undefined)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/unknown', { method: 'DELETE' })
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain('not found')
  })

  it('GET /api/sessions returns session list', async () => {
    mockCore.sessionManager.listSessions.mockReturnValueOnce([
      { id: 'abc', agentName: 'claude', status: 'active', name: 'Fix bug' },
      { id: 'def', agentName: 'codex', status: 'initializing', name: undefined },
    ])
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.sessions).toHaveLength(2)
    expect(data.sessions[0]).toEqual({ id: 'abc', agent: 'claude', status: 'active', name: 'Fix bug' })
    expect(data.sessions[1]).toEqual({ id: 'def', agent: 'codex', status: 'initializing', name: null })
  })

  it('GET /api/agents returns agent list with default', async () => {
    mockCore.agentManager.getAvailableAgents.mockReturnValueOnce([
      { name: 'claude', command: 'claude-agent-acp', args: [] },
      { name: 'codex', command: 'codex', args: ['--acp'] },
    ])
    const port = await startServer()

    const res = await apiFetch(port, '/api/agents')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.default).toBe('claude')
    expect(data.agents).toHaveLength(2)
    expect(data.agents[0]).toEqual({ name: 'claude', command: 'claude-agent-acp', args: [] })
  })

  it('returns 404 for unknown routes', async () => {
    const port = await startServer()
    const res = await apiFetch(port, '/api/unknown')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/api-server.test.ts`
Expected: FAIL — module `../core/api-server.js` not found

- [ ] **Step 3: Implement ApiServer**

Create `src/core/api-server.ts`:

```typescript
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { OpenACPCore } from './core.js'
import { createChildLogger } from './log.js'

const log = createChildLogger({ module: 'api-server' })

const DEFAULT_PORT_FILE = path.join(os.homedir(), '.openacp', 'api.port')

export interface ApiConfig {
  port: number
  host: string
}

export class ApiServer {
  private server: http.Server | null = null
  private actualPort: number = 0
  private portFilePath: string

  constructor(
    private core: OpenACPCore,
    private config: ApiConfig,
    portFilePath?: string,
  ) {
    this.portFilePath = portFilePath ?? DEFAULT_PORT_FILE
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res))

    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log.warn({ port: this.config.port }, 'API port in use, continuing without API server')
          this.server = null
          // actualPort stays 0, port file not written — CLI will know API is unavailable
          resolve()
        } else {
          reject(err)
        }
      })

      this.server!.listen(this.config.port, this.config.host, () => {
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') {
          this.actualPort = addr.port
        }
        this.writePortFile()
        log.info({ host: this.config.host, port: this.actualPort }, 'API server listening')
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    this.removePortFile()
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
  }

  getPort(): number {
    return this.actualPort
  }

  private writePortFile(): void {
    const dir = path.dirname(this.portFilePath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.portFilePath, String(this.actualPort))
  }

  private removePortFile(): void {
    try {
      fs.unlinkSync(this.portFilePath)
    } catch {
      // ignore if already gone
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method?.toUpperCase()
    const url = req.url || ''

    try {
      if (method === 'POST' && url === '/api/sessions') {
        await this.handleCreateSession(req, res)
      } else if (method === 'DELETE' && url.match(/^\/api\/sessions\/(.+)$/)) {
        const sessionId = url.match(/^\/api\/sessions\/(.+)$/)![1]
        await this.handleCancelSession(sessionId, res)
      } else if (method === 'GET' && url === '/api/sessions') {
        await this.handleListSessions(res)
      } else if (method === 'GET' && url === '/api/agents') {
        await this.handleListAgents(res)
      } else {
        this.sendJson(res, 404, { error: 'Not found' })
      }
    } catch (err) {
      log.error({ err }, 'API request error')
      this.sendJson(res, 500, { error: 'Internal server error' })
    }
  }

  private async handleCreateSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    let agent: string | undefined
    let workspace: string | undefined

    if (body) {
      try {
        const parsed = JSON.parse(body)
        agent = parsed.agent
        workspace = parsed.workspace
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON body' })
        return
      }
    }

    // Check max concurrent sessions
    const config = this.core.configManager.get()
    const activeSessions = this.core.sessionManager.listSessions()
      .filter(s => s.status === 'active' || s.status === 'initializing')
    if (activeSessions.length >= config.security.maxConcurrentSessions) {
      this.sendJson(res, 429, {
        error: `Max concurrent sessions (${config.security.maxConcurrentSessions}) reached. Cancel a session first.`,
      })
      return
    }

    const session = await this.core.handleNewSession('api', agent, workspace)
    this.sendJson(res, 200, {
      sessionId: session.id,
      agent: session.agentName,
      status: session.status,
    })
  }

  private async handleCancelSession(sessionId: string, res: http.ServerResponse): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId)
    if (!session) {
      this.sendJson(res, 404, { error: `Session "${sessionId}" not found` })
      return
    }
    await session.cancel()
    this.sendJson(res, 200, { ok: true })
  }

  private async handleListSessions(res: http.ServerResponse): Promise<void> {
    const sessions = this.core.sessionManager.listSessions()
    this.sendJson(res, 200, {
      sessions: sessions.map(s => ({
        id: s.id,
        agent: s.agentName,
        status: s.status,
        name: s.name ?? null,
      })),
    })
  }

  private async handleListAgents(res: http.ServerResponse): Promise<void> {
    const agents = this.core.agentManager.getAvailableAgents()
    const defaultAgent = this.core.configManager.get().defaultAgent
    this.sendJson(res, 200, {
      agents: agents.map(a => ({
        name: a.name,
        command: a.command,
        args: a.args,
      })),
      default: defaultAgent,
    })
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => resolve(data))
      req.on('error', () => resolve(''))
    })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/api-server.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/api-server.ts src/__tests__/api-server.test.ts
git commit -m "feat(api): add HTTP API server with session and agent endpoints"
```

---

### Task 3: CLI `runtime` subcommand + api-client

**Prerequisite:** Task 2 must be completed (API server must exist for integration).

**Files:**
- Create: `src/core/api-client.ts`
- Modify: `src/cli.ts:8-29` (help text)
- Modify: `src/cli.ts` (add runtime handler before `start` command)
- Create: `src/__tests__/cli-runtime.test.ts`

**Context:** The CLI entry point is `src/cli.ts`. Commands are handled via `if (command === '...')` blocks. The `runtime` subcommand reads `~/.openacp/api.port` to discover the daemon's API server, then uses `fetch()` to call it.

Key patterns from existing `cli.ts`:
- `const args = process.argv.slice(2)` — `args[0]` is the command
- Each command block does its work and `return`s
- Help text is in `printHelp()`
- Unknown commands are caught at line 170

- [ ] **Step 1: Write failing tests for api-client**

Create `src/__tests__/cli-runtime.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

describe('api-client', () => {
  let tmpDir: string
  let portFile: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-cli-runtime-'))
    portFile = path.join(tmpDir, 'api.port')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('readApiPort returns null when port file does not exist', async () => {
    const { readApiPort } = await import('../core/api-client.js')
    expect(readApiPort(portFile)).toBeNull()
  })

  it('readApiPort returns port number when file exists', async () => {
    fs.writeFileSync(portFile, '21420')
    const { readApiPort } = await import('../core/api-client.js')
    expect(readApiPort(portFile)).toBe(21420)
  })

  it('removeStalePortFile deletes the port file', async () => {
    fs.writeFileSync(portFile, '21420')
    const { removeStalePortFile } = await import('../core/api-client.js')
    removeStalePortFile(portFile)
    expect(fs.existsSync(portFile)).toBe(false)
  })

  it('apiCall builds correct URL and calls fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ sessions: [] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { apiCall } = await import('../core/api-client.js')
    const result = await apiCall(21420, '/api/sessions', { method: 'GET' })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:21420/api/sessions',
      expect.objectContaining({ method: 'GET' })
    )
    expect(result.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/cli-runtime.test.ts`
Expected: FAIL — module `../core/api-client.js` not found

- [ ] **Step 3: Create api-client module**

Create `src/core/api-client.ts`:

```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const DEFAULT_PORT_FILE = path.join(os.homedir(), '.openacp', 'api.port')

export function readApiPort(portFilePath: string = DEFAULT_PORT_FILE): number | null {
  try {
    const content = fs.readFileSync(portFilePath, 'utf-8').trim()
    const port = parseInt(content, 10)
    return isNaN(port) ? null : port
  } catch {
    return null
  }
}

export function removeStalePortFile(portFilePath: string = DEFAULT_PORT_FILE): void {
  try {
    fs.unlinkSync(portFilePath)
  } catch {
    // ignore
  }
}

export async function apiCall(
  port: number,
  urlPath: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, options)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/cli-runtime.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Add `runtime` command handler to cli.ts**

In `src/cli.ts`, add after the existing imports (line 3):

```typescript
import { readApiPort, removeStalePortFile, apiCall } from './core/api-client.js'
```

Update `printHelp()` — insert before the `Install:` section:

```
Runtime (requires running daemon):
  openacp runtime new [agent]       Create a new session
  openacp runtime cancel <id>       Cancel a session
  openacp runtime status            Show active sessions
  openacp runtime agents            List available agents

Note: "openacp status" shows daemon process health.
      "openacp runtime status" shows active agent sessions.
```

Add the `runtime` command handler — insert BEFORE the `if (command === 'start')` block:

```typescript
  if (command === 'runtime') {
    const subCmd = args[1]

    const port = readApiPort()
    if (port === null) {
      console.error('OpenACP is not running. Start with `openacp start`')
      process.exit(1)
    }

    try {
      if (subCmd === 'new') {
        const agent = args[2]
        const workspaceIdx = args.indexOf('--workspace')
        const workspace = workspaceIdx !== -1 ? args[workspaceIdx + 1] : undefined
        const body: Record<string, string> = {}
        if (agent) body.agent = agent
        if (workspace) body.workspace = workspace

        const res = await apiCall(port, '/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) {
          console.error(`Error: ${data.error}`)
          process.exit(1)
        }
        console.log('Session created')
        console.log(`  ID     : ${data.sessionId}`)
        console.log(`  Agent  : ${data.agent}`)
        console.log(`  Status : ${data.status}`)

      } else if (subCmd === 'cancel') {
        const sessionId = args[2]
        if (!sessionId) {
          console.error('Usage: openacp runtime cancel <session-id>')
          process.exit(1)
        }
        const res = await apiCall(port, `/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
        })
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) {
          console.error(`Error: ${data.error}`)
          process.exit(1)
        }
        console.log(`Session ${sessionId} cancelled`)

      } else if (subCmd === 'status') {
        const res = await apiCall(port, '/api/sessions')
        const data = await res.json() as { sessions: Array<{ id: string; agent: string; status: string; name: string | null }> }
        if (data.sessions.length === 0) {
          console.log('No active sessions.')
        } else {
          console.log(`Active sessions: ${data.sessions.length}\n`)
          for (const s of data.sessions) {
            const name = s.name ? `  "${s.name}"` : ''
            console.log(`  ${s.id}  ${s.agent}  ${s.status}${name}`)
          }
        }

      } else if (subCmd === 'agents') {
        const res = await apiCall(port, '/api/agents')
        const data = await res.json() as { agents: Array<{ name: string; command: string; args: string[] }>; default: string }
        console.log('Available agents:')
        for (const a of data.agents) {
          const isDefault = a.name === data.default ? ' (default)' : ''
          console.log(`  ${a.name}${isDefault}`)
        }

      } else {
        console.error(`Unknown runtime command: ${subCmd || '(none)'}\n`)
        console.log('Usage:')
        console.log('  openacp runtime new [agent]         Create a new session')
        console.log('  openacp runtime cancel <id>         Cancel a session')
        console.log('  openacp runtime status              Show active sessions')
        console.log('  openacp runtime agents              List available agents')
        process.exit(1)
      }
    } catch (err) {
      if (err instanceof TypeError && (err as any).cause?.code === 'ECONNREFUSED') {
        console.error('OpenACP is not running (stale port file)')
        removeStalePortFile()
        process.exit(1)
      }
      throw err
    }
    return
  }
```

- [ ] **Step 6: Run full test suite + build check**

Run: `pnpm test && pnpm build`
Expected: ALL PASS, build clean

- [ ] **Step 7: Commit**

```bash
git add src/core/api-client.ts src/__tests__/cli-runtime.test.ts src/cli.ts
git commit -m "feat(cli): add runtime subcommand for session and agent management"
```

---

### Task 4: Integration — main.ts lifecycle

**Prerequisite:** Task 1 must be completed (config.api type exists).

**Files:**
- Modify: `src/main.ts`

**Context:** `main.ts` is the server startup file. After `core.start()` (line 66), we start the ApiServer. In the `shutdown` function (line 74), we stop the ApiServer before stopping core.

**Important:** The `apiServer` variable must be declared with `let` BEFORE the `shutdown` closure is defined, then assigned after `core.start()`. This avoids temporal dead zone issues.

- [ ] **Step 1: Add ApiServer import and variable declaration**

In `src/main.ts`, add the import after line 6 (`import { TelegramAdapter }...`):

```typescript
import { ApiServer } from './core/api-server.js'
```

Inside the `startServer()` function, add `let apiServer: ApiServer | undefined` BEFORE the `shutdown` function definition (i.e., before line 74). Place it after the core variable and adapter registration section:

```typescript
  // 5b. Start API server
  let apiServer: ApiServer | undefined
```

- [ ] **Step 2: Start ApiServer after core.start()**

After `await core.start()` (line 66), AFTER the `let apiServer` declaration but before the `shutdown` function, add:

```typescript
  apiServer = new ApiServer(core, config.api)
  await apiServer.start()
```

- [ ] **Step 3: Add ApiServer stop in shutdown handler**

In the `shutdown` function, add BEFORE `await core.stop()`:

```typescript
      if (apiServer) await apiServer.stop()
```

- [ ] **Step 4: Run full test suite + build check**

Run: `pnpm test && pnpm build`
Expected: ALL PASS, build clean

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): integrate API server into daemon lifecycle"
```

---

### Task 5: Config editor — Add API section

**Files:**
- Modify: `src/core/config-editor.ts`

**Context:** The config editor in `src/core/config-editor.ts` has sub-menus for Telegram, Agent, Workspace, Security, Logging, Run Mode. We add an "API" option that lets users change the port. The `config.api` property is typed (from Task 1), with defaults `{ port: 21420, host: '127.0.0.1' }`.

- [ ] **Step 1: Add editApi function**

In `src/core/config-editor.ts`, add after the `editRunMode` function (before the main `runConfigEditor` export):

```typescript
// --- Edit: API ---

async function editApi(config: Config, updates: ConfigUpdates): Promise<void> {
  const api = config.api ?? { port: 21420, host: '127.0.0.1' }

  console.log(header('API'))
  console.log(`  Port : ${api.port}`)
  console.log(`  Host : ${api.host} ${dim('(localhost only)')}`)
  console.log('')

  const newPort = await input({
    message: 'API port:',
    default: String(api.port),
    validate: (v) => {
      const n = Number(v.trim())
      if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Must be a valid port (1-65535)'
      return true
    },
  })

  updates.api = { port: Number(newPort.trim()) }
  console.log(ok(`API port set to ${newPort.trim()}`))
}
```

- [ ] **Step 2: Add API to main menu**

In the `runConfigEditor` function, add `{ name: 'API', value: 'api' }` to the choices array (after 'Run Mode', before the exit option), and add the handler in the if/else chain:

```typescript
      else if (choice === 'api') await editApi(config, updates)
```

- [ ] **Step 3: Run full test suite + build check**

Run: `pnpm test && pnpm build`
Expected: ALL PASS, build clean

- [ ] **Step 4: Commit**

```bash
git add src/core/config-editor.ts
git commit -m "feat(config-editor): add API port configuration"
```

---

### Task 6: Exports update

**Files:**
- Modify: `src/core/index.ts`

- [ ] **Step 1: Add ApiServer export**

In `src/core/index.ts`, add:

```typescript
export { ApiServer, type ApiConfig } from './api-server.js'
```

Note: `api-client.ts` is intentionally NOT exported from the barrel — it's an internal CLI utility, not part of the public API.

- [ ] **Step 2: Run build to verify exports resolve**

Run: `pnpm build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add src/core/index.ts
git commit -m "feat(exports): add ApiServer export"
```

---

### Task 7: Final verification

**Files:** No new files — verify everything works together.

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 2: Run build**

Run: `pnpm build`
Expected: Clean build, no errors

- [ ] **Step 3: Verify test count**

Check output shows tests from `api-server.test.ts` (11 tests) and `cli-runtime.test.ts` (4 tests) running alongside existing tests.

- [ ] **Step 4: Final commit (if any fixes needed)**

If any fixes were needed, commit them. Otherwise, all tasks are complete.
