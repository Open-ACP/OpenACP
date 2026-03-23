# Critical Fixes for Issue #21 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 4 critical security and reliability issues identified in the PR #19 code review (GitHub issue #21).

**Architecture:** Each fix is independent. We implement them in order of complexity: unused import removal → injection escaping → PID race condition → API authentication. Tests are written before implementation (TDD).

**Tech Stack:** TypeScript, Node.js `crypto` module, vitest for testing.

---

### Task 1: Remove unused `createRequire` import (Fix 3)

**Files:**
- Modify: `src/cli/version.ts:1`

- [ ] **Step 1: Remove the unused import**

In `src/cli/version.ts`, remove line 1:
```typescript
// DELETE this line:
import { createRequire } from 'node:module'
```

- [ ] **Step 2: Verify build succeeds**

Run: `pnpm build`
Expected: Clean compile with no errors.

- [ ] **Step 3: Run existing tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli/version.ts
git commit -m "fix: remove unused createRequire import in version.ts (issue #21)"
```

---

### Task 2: XML/Systemd injection escaping (Fix 2)

**Files:**
- Modify: `src/core/autostart.ts:17-58`
- Modify: `src/__tests__/autostart.test.ts`

- [ ] **Step 1: Write failing tests for escape helpers**

Add to `src/__tests__/autostart.test.ts`:

```typescript
describe('escapeXml', () => {
  it('escapes XML special characters', async () => {
    const { escapeXml } = await import('../core/autostart.js')
    expect(escapeXml('a & b')).toBe('a &amp; b')
    expect(escapeXml('<script>')).toBe('&lt;script&gt;')
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;')
    expect(escapeXml("it's")).toBe('it&apos;s')
    expect(escapeXml('/normal/path')).toBe('/normal/path')
  })
})

describe('escapeSystemdValue', () => {
  it('quotes and escapes systemd special characters', async () => {
    const { escapeSystemdValue } = await import('../core/autostart.js')
    expect(escapeSystemdValue('/usr/bin/node')).toBe('"/usr/bin/node"')
    expect(escapeSystemdValue('/path with spaces/node')).toBe('"/path with spaces/node"')
    expect(escapeSystemdValue('/path"quote')).toBe('"/path\\"quote"')
    expect(escapeSystemdValue('/path\\back')).toBe('"/path\\\\back"')
    expect(escapeSystemdValue('/path%specifier')).toBe('"/path%%specifier"')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/autostart.test.ts`
Expected: FAIL — `escapeXml` and `escapeSystemdValue` not exported.

- [ ] **Step 3: Implement escape helpers and apply them**

In `src/core/autostart.ts`, add the escape functions and apply them to the templates:

```typescript
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function escapeSystemdValue(str: string): string {
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
  return `"${escaped}"`
}
```

Update `generateLaunchdPlist` — replace the three interpolated values:
```typescript
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(cliPath)}</string>
    // ...
  <string>${escapeXml(logFile)}</string>
  // ... (both StandardOutPath and StandardErrorPath)
```

Update `generateSystemdUnit` — replace the ExecStart line:
```typescript
ExecStart=${escapeSystemdValue(nodePath)} ${escapeSystemdValue(cliPath)} --daemon-child
```

- [ ] **Step 4: Add tests for escaped template output**

Add to `src/__tests__/autostart.test.ts`:

```typescript
describe('generateLaunchdPlist', () => {
  it('escapes special characters in paths', async () => {
    const { generateLaunchdPlist } = await import('../core/autostart.js')
    const plist = generateLaunchdPlist('/usr/bin/no<de', '/path/"cli".js', '/logs/a&b')
    expect(plist).toContain('<string>/usr/bin/no&lt;de</string>')
    expect(plist).toContain('<string>/path/&quot;cli&quot;.js</string>')
    expect(plist).toContain('<string>/logs/a&amp;b</string>')
    expect(plist).not.toContain('<de')  // should be escaped
  })
})

describe('generateSystemdUnit', () => {
  it('escapes special characters in paths', async () => {
    const { generateSystemdUnit } = await import('../core/autostart.js')
    const unit = generateSystemdUnit('/usr/bin/no de', '/path/"cli".js')
    expect(unit).toContain('ExecStart="/usr/bin/no de" "/path/\\"cli\\".js" --daemon-child')
  })

  it('escapes percent specifiers', async () => {
    const { generateSystemdUnit } = await import('../core/autostart.js')
    const unit = generateSystemdUnit('/usr/bin/node', '/home/%user/cli.js')
    expect(unit).toContain('%%user')
  })
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/autostart.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/autostart.ts src/__tests__/autostart.test.ts
git commit -m "fix(security): escape XML and systemd injection in autostart.ts (issue #21)"
```

---

### Task 3: PID file race condition in stopDaemon (Fix 4)

**Files:**
- Modify: `src/core/daemon.ts:104-126`
- Modify: `src/__tests__/daemon.test.ts`
- Modify: `src/cli/commands.ts:489-497` (caller)

- [ ] **Step 1: Write failing test for async stopDaemon**

Add to `src/__tests__/daemon.test.ts`:

```typescript
describe('stopDaemon', () => {
  it('waits for process exit before removing PID file', async () => {
    const { writePidFile, stopDaemon, readPidFile } = await import('../core/daemon.js')
    // Write PID of current process (which is alive)
    writePidFile(pidFile, process.pid)

    // Mock process.kill to simulate: alive, alive, then dead
    let callCount = 0
    const origKill = process.kill
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0) {
        callCount++
        if (callCount <= 2) return true // still alive
        const err = new Error('No such process') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      if (signal === 'SIGTERM') return true
      return origKill.call(process, pid, signal as any)
    })

    const result = await stopDaemon(pidFile)
    expect(result.stopped).toBe(true)
    expect(result.pid).toBe(process.pid)
    // PID file should be removed after process exit
    expect(readPidFile(pidFile)).toBeNull()

    vi.restoreAllMocks()
  })

  it('sends SIGKILL after timeout', async () => {
    const { writePidFile, stopDaemon } = await import('../core/daemon.js')
    writePidFile(pidFile, process.pid)

    // Mock: process never exits from SIGTERM
    const signals: (string | number)[] = []
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      signals.push(signal ?? 0)
      if (signal === 'SIGKILL') {
        // After SIGKILL, next check should show dead
        vi.spyOn(process, 'kill').mockImplementation(() => {
          const err = new Error('No such process') as NodeJS.ErrnoException
          err.code = 'ESRCH'
          throw err
        })
        return true
      }
      if (signal === 0) return true // always alive
      if (signal === 'SIGTERM') return true
      return true
    })

    const result = await stopDaemon(pidFile)
    expect(result.stopped).toBe(true)
    expect(signals).toContain('SIGKILL')

    vi.restoreAllMocks()
  })

  it('handles EPERM during polling (PID reuse)', async () => {
    const { writePidFile, stopDaemon, readPidFile } = await import('../core/daemon.js')
    writePidFile(pidFile, process.pid)

    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 'SIGTERM') return true
      if (signal === 0) {
        const err = new Error('Operation not permitted') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      return true
    })

    const result = await stopDaemon(pidFile)
    expect(result.stopped).toBe(true)
    // PID file should still be removed (EPERM = process is someone else's, treat as exited)
    expect(readPidFile(pidFile)).toBeNull()

    vi.restoreAllMocks()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/daemon.test.ts`
Expected: FAIL — `stopDaemon` is not async.

- [ ] **Step 3: Implement async stopDaemon with polling**

Replace `stopDaemon` in `src/core/daemon.ts`:

```typescript
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): 'alive' | 'dead' | 'eperm' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EPERM') return 'eperm'
    return 'dead' // ESRCH or other
  }
}

export async function stopDaemon(pidPath: string = DEFAULT_PID_PATH): Promise<{ stopped: boolean; pid?: number; error?: string }> {
  const pid = readPidFile(pidPath)
  if (pid === null) return { stopped: false, error: 'Not running (no PID file)' }

  const status = isProcessAlive(pid)
  if (status === 'dead') {
    removePidFile(pidPath)
    return { stopped: false, error: 'Not running (stale PID file removed)' }
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    return { stopped: false, error: `Failed to stop: ${(e as Error).message}` }
  }

  clearRunning()

  // Poll for process exit (5 second timeout)
  const POLL_INTERVAL = 100
  const TIMEOUT = 5000
  const start = Date.now()

  while (Date.now() - start < TIMEOUT) {
    await sleep(POLL_INTERVAL)
    const s = isProcessAlive(pid)
    if (s === 'dead' || s === 'eperm') {
      removePidFile(pidPath)
      return { stopped: true, pid }
    }
  }

  // Timeout — try SIGKILL
  try {
    process.kill(pid, 'SIGKILL')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EPERM') {
      return { stopped: false, pid, error: 'PID may have been reused by another process. Run `openacp status` to verify, or manually delete the PID file.' }
    }
  }

  // Wait for SIGKILL to take effect
  const killStart = Date.now()
  while (Date.now() - killStart < 1000) {
    await sleep(POLL_INTERVAL)
    const s = isProcessAlive(pid)
    if (s === 'dead' || s === 'eperm') {
      removePidFile(pidPath)
      return { stopped: true, pid }
    }
  }

  removePidFile(pidPath)
  return { stopped: true, pid }
}
```

- [ ] **Step 4: Update caller in commands.ts**

In `src/cli/commands.ts`, update `cmdStop()`:

```typescript
export async function cmdStop(): Promise<void> {
  const { stopDaemon } = await import('../core/daemon.js')
  const result = await stopDaemon()  // add await
  if (result.stopped) {
    console.log(`OpenACP daemon stopped (was PID ${result.pid})`)
  } else {
    console.error(result.error)
    process.exit(1)
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/daemon.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/daemon.ts src/__tests__/daemon.test.ts src/cli/commands.ts
git commit -m "fix: wait for process exit before removing PID file in stopDaemon (issue #21)"
```

---

### Task 4: API server authentication (Fix 1)

**Files:**
- Modify: `src/core/api-server.ts:1-176`
- Modify: `src/core/api-client.ts`
- Modify: `src/cli/commands.ts:676` (adopt raw fetch)
- Modify: `src/__tests__/api-server.test.ts`

- [ ] **Step 1: Write failing tests for auth**

Add to `src/__tests__/api-server.test.ts`:

```typescript
describe('authentication', () => {
  it('returns 401 for requests without auth token', async () => {
    const port = await startServer()
    const res = await apiFetch(port, '/api/sessions')
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 for requests with wrong token', async () => {
    const port = await startServer()
    const res = await apiFetch(port, '/api/sessions', {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(res.status).toBe(401)
  })

  it('allows health endpoint without auth', async () => {
    mockCore.sessionManager.listSessions.mockReturnValueOnce([])
    mockCore.sessionManager.listRecords.mockReturnValueOnce([])
    const port = await startServer()
    const res = await apiFetch(port, '/api/health')
    expect(res.status).toBe(200)
  })

  it('allows version endpoint without auth', async () => {
    const port = await startServer()
    const res = await apiFetch(port, '/api/version')
    expect(res.status).toBe(200)
  })

  it('accepts requests with valid auth token', async () => {
    mockCore.sessionManager.listSessions.mockReturnValueOnce([])
    const port = await startServer()
    const token = readTestSecret()
    const res = await apiFetch(port, '/api/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })
})
```

Note: `readTestSecret()` helper reads the secret file created by the server during test setup. The `startServer` function creates the server which generates the secret. Need to add a `secretFilePath` to the test setup and pass to `ApiServer` constructor.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/api-server.test.ts`
Expected: FAIL — no auth check exists yet.

- [ ] **Step 3: Add secret file management to ApiServer**

In `src/core/api-server.ts`:

Add imports at top:
```typescript
import * as crypto from 'node:crypto'
```

Add to `ApiServer` class:
```typescript
private secret: string = ''
private secretFilePath: string

constructor(
  private core: OpenACPCore,
  private config: ApiConfig,
  portFilePath?: string,
  private topicManager?: TopicManager,
  secretFilePath?: string,
) {
  this.portFilePath = portFilePath ?? DEFAULT_PORT_FILE
  this.secretFilePath = secretFilePath ?? path.join(os.homedir(), '.openacp', 'api-secret')
}
```

Add methods:
```typescript
private loadOrCreateSecret(): void {
  const dir = path.dirname(this.secretFilePath)
  fs.mkdirSync(dir, { recursive: true })

  try {
    this.secret = fs.readFileSync(this.secretFilePath, 'utf-8').trim()
    if (this.secret) return
  } catch {
    // File doesn't exist, create it
  }

  this.secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(this.secretFilePath, this.secret, { mode: 0o600 })
}

private authenticate(req: http.IncomingMessage): boolean {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return false
  const token = authHeader.slice(7)
  if (token.length !== this.secret.length) return false
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.secret))
}
```

- [ ] **Step 4: Add auth check to handleRequest**

In `handleRequest()`, add auth check after URL parsing, before routing:

```typescript
private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method?.toUpperCase()
  const url = req.url || ''

  // Exempt routes from auth
  const isExempt = (method === 'GET' && (url === '/api/health' || url === '/api/version'))
  if (!isExempt && !this.authenticate(req)) {
    this.sendJson(res, 401, { error: 'Unauthorized' })
    return
  }

  try {
    // ... existing routing
```

Call `loadOrCreateSecret()` at the start of `start()`:
```typescript
async start(): Promise<void> {
  this.loadOrCreateSecret()
  // ... rest of start
```

- [ ] **Step 5: Add auth token to api-client.ts**

Update `src/core/api-client.ts`:

```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const DEFAULT_PORT_FILE = path.join(os.homedir(), '.openacp', 'api.port')
const DEFAULT_SECRET_FILE = path.join(os.homedir(), '.openacp', 'api-secret')

export function readApiPort(portFilePath: string = DEFAULT_PORT_FILE): number | null {
  try {
    const content = fs.readFileSync(portFilePath, 'utf-8').trim()
    const port = parseInt(content, 10)
    return isNaN(port) ? null : port
  } catch {
    return null
  }
}

export function readApiSecret(secretFilePath: string = DEFAULT_SECRET_FILE): string | null {
  try {
    const content = fs.readFileSync(secretFilePath, 'utf-8').trim()
    return content || null
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
  const secret = readApiSecret()
  const headers = new Headers(options?.headers)
  if (secret) {
    headers.set('Authorization', `Bearer ${secret}`)
  }
  return fetch(`http://127.0.0.1:${port}${urlPath}`, { ...options, headers })
}
```

- [ ] **Step 6: Migrate raw fetch in commands.ts adopt**

In `src/cli/commands.ts`, replace the raw `fetch` at ~line 676 with `apiCall`:

```typescript
// Before:
const res = await fetch(`http://127.0.0.1:${port}/api/sessions/adopt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ agent, agentSessionId: sessionId, cwd }),
});

// After:
const { apiCall } = await import('../core/api-client.js')
const res = await apiCall(port, '/api/sessions/adopt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agent, agentSessionId: sessionId, cwd }),
})
```

- [ ] **Step 7: Update test setup for auth**

Update `src/__tests__/api-server.test.ts`:

Add `secretFilePath` to test setup:
```typescript
let secretFilePath: string

beforeEach(() => {
  // ... existing setup
  secretFilePath = path.join(tmpDir, 'api-secret')
})
```

Update `startServer`:
```typescript
async function startServer(portOverride?: number) {
  const { ApiServer } = await import('../core/api-server.js')
  server = new ApiServer(mockCore as any, { port: portOverride ?? 0, host: '127.0.0.1' }, portFilePath, mockTopicManager as any, secretFilePath)
  await server.start()
  return server.getPort()
}
```

Add helper to read the test secret:
```typescript
function readTestSecret(): string {
  return fs.readFileSync(secretFilePath, 'utf-8').trim()
}
```

Update `apiFetch` to include auth by default:
```typescript
function apiFetch(port: number, urlPath: string, options?: RequestInit) {
  const token = fs.existsSync(secretFilePath) ? fs.readFileSync(secretFilePath, 'utf-8').trim() : ''
  const headers = new Headers(options?.headers)
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  return globalThis.fetch(`http://127.0.0.1:${port}${urlPath}`, { ...options, headers })
}
```

For the auth-specific tests, override the Authorization header explicitly (pass empty or wrong token).

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/api-server.test.ts`
Expected: All tests pass (existing tests use auth by default, new auth tests validate 401/200).

- [ ] **Step 9: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/core/api-server.ts src/core/api-client.ts src/cli/commands.ts src/__tests__/api-server.test.ts
git commit -m "fix(security): add file-based token authentication to API server (issue #21)"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run full build**

Run: `pnpm build`
Expected: Clean compile.

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 3: Review all changes**

Run: `git log --oneline worktree-fix-critical-issues-21 ^develop`
Verify 4 commits, one per fix.
