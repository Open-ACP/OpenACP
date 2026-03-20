# Config Editor & Daemon Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `openacp config` (menu-based config editor) and daemon mode with auto-start on boot, including onboarding integration.

**Architecture:** Three new modules — `daemon.ts` (PID management, spawn), `autostart.ts` (launchd/systemd service files), `config-editor.ts` (interactive menu). Config schema extended with `runMode` and `autoStart` fields. CLI updated with `start`, `stop`, `status`, `logs`, `config` commands. Onboarding adds run mode step.

**Tech Stack:** TypeScript (ESM), @inquirer/prompts, Zod, child_process, pino

**Spec:** `docs/superpowers/specs/2026-03-20-config-editor-daemon-mode-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/core/config.ts` | Modify | Add `runMode`, `autoStart` to schema + env override |
| `src/core/daemon.ts` | Create | PID file management, daemon spawn, stop, status |
| `src/core/autostart.ts` | Create | LaunchAgent (macOS) / systemd (Linux) install/uninstall |
| `src/core/config-editor.ts` | Create | Menu-based interactive config editor |
| `src/core/setup.ts` | Modify | Add run mode step [3/3], update step numbering |
| `src/cli.ts` | Modify | Add start/stop/status/logs/config commands + --foreground/--daemon-child flags |
| `src/main.ts` | Modify | Support --daemon-child PID cleanup on shutdown |
| `src/core/index.ts` | Modify | Export new modules |
| `src/__tests__/daemon.test.ts` | Create | Tests for daemon module |
| `src/__tests__/autostart.test.ts` | Create | Tests for autostart module |
| `src/__tests__/config-editor.test.ts` | Create | Tests for config editor |
| `src/__tests__/config-schema.test.ts` | Create | Tests for new config fields |

---

### Task 1: Extend Config Schema

**Files:**
- Modify: `src/core/config.ts`
- Create: `src/__tests__/config-schema.test.ts`

- [ ] **Step 1: Write failing tests for new config fields**

Create `src/__tests__/config-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ConfigSchema } from '../core/config.js'

describe('ConfigSchema - runMode and autoStart', () => {
  const baseConfig = {
    channels: { telegram: { enabled: false } },
    agents: { claude: { command: 'claude-agent-acp', args: [], env: {} } },
    defaultAgent: 'claude',
  }

  it('defaults runMode to foreground', () => {
    const result = ConfigSchema.parse(baseConfig)
    expect(result.runMode).toBe('foreground')
  })

  it('defaults autoStart to false', () => {
    const result = ConfigSchema.parse(baseConfig)
    expect(result.autoStart).toBe(false)
  })

  it('accepts runMode daemon', () => {
    const result = ConfigSchema.parse({ ...baseConfig, runMode: 'daemon' })
    expect(result.runMode).toBe('daemon')
  })

  it('accepts autoStart true', () => {
    const result = ConfigSchema.parse({ ...baseConfig, autoStart: true })
    expect(result.autoStart).toBe(true)
  })

  it('rejects invalid runMode', () => {
    expect(() => ConfigSchema.parse({ ...baseConfig, runMode: 'invalid' })).toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/config-schema.test.ts`
Expected: FAIL — `runMode` and `autoStart` not in schema yet

- [ ] **Step 3: Add runMode and autoStart to ConfigSchema**

In `src/core/config.ts`, add to `ConfigSchema` (after `logging`):

```typescript
runMode: z.enum(['foreground', 'daemon']).default('foreground'),
autoStart: z.boolean().default(false),
```

Also add `OPENACP_RUN_MODE` to `applyEnvOverrides`:

```typescript
['OPENACP_RUN_MODE', ['runMode']],
```

Add it to the `overrides` array in the same pattern as existing entries.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/config-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/__tests__/config-schema.test.ts
git commit -m "feat(config): add runMode and autoStart fields to schema"
```

---

### Task 2: Daemon Module (PID Management)

**Files:**
- Create: `src/core/daemon.ts`
- Create: `src/__tests__/daemon.test.ts`

- [ ] **Step 1: Write failing tests for daemon module**

Create `src/__tests__/daemon.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Mock child_process before importing daemon
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
  })),
}))

describe('daemon', () => {
  let tmpDir: string
  let pidFile: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-daemon-test-'))
    pidFile = path.join(tmpDir, 'openacp.pid')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('isProcessRunning', () => {
    it('returns false when PID file does not exist', async () => {
      const { isProcessRunning } = await import('../core/daemon.js')
      expect(isProcessRunning(pidFile)).toBe(false)
    })

    it('returns false for stale PID file', async () => {
      fs.writeFileSync(pidFile, '999999999') // unlikely to be a real process
      const { isProcessRunning } = await import('../core/daemon.js')
      expect(isProcessRunning(pidFile)).toBe(false)
    })
  })

  describe('writePidFile / removePidFile', () => {
    it('writes and reads PID', async () => {
      const { writePidFile, readPidFile } = await import('../core/daemon.js')
      writePidFile(pidFile, 42)
      expect(readPidFile(pidFile)).toBe(42)
    })

    it('removePidFile deletes the file', async () => {
      const { writePidFile, removePidFile } = await import('../core/daemon.js')
      writePidFile(pidFile, 42)
      removePidFile(pidFile)
      expect(fs.existsSync(pidFile)).toBe(false)
    })
  })

  describe('getStatus', () => {
    it('returns stopped when no PID file', async () => {
      const { getStatus } = await import('../core/daemon.js')
      expect(getStatus(pidFile)).toEqual({ running: false })
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/daemon.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement daemon.ts**

Create `src/core/daemon.ts`:

```typescript
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { expandHome } from './config.js'

const DEFAULT_PID_PATH = path.join(os.homedir(), '.openacp', 'openacp.pid')
const DEFAULT_LOG_DIR = path.join(os.homedir(), '.openacp', 'logs')

export function writePidFile(pidPath: string, pid: number): void {
  const dir = path.dirname(pidPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(pidPath, String(pid))
}

export function readPidFile(pidPath: string): number | null {
  try {
    const content = fs.readFileSync(pidPath, 'utf-8').trim()
    const pid = parseInt(content, 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

export function removePidFile(pidPath: string): void {
  try {
    fs.unlinkSync(pidPath)
  } catch {
    // ignore if already gone
  }
}

export function isProcessRunning(pidPath: string): boolean {
  const pid = readPidFile(pidPath)
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // Process not running, clean up stale PID file
    removePidFile(pidPath)
    return false
  }
}

export function getStatus(pidPath: string = DEFAULT_PID_PATH): { running: boolean; pid?: number } {
  const pid = readPidFile(pidPath)
  if (pid === null) return { running: false }
  try {
    process.kill(pid, 0)
    return { running: true, pid }
  } catch {
    removePidFile(pidPath)
    return { running: false }
  }
}

export function startDaemon(pidPath: string = DEFAULT_PID_PATH, logDir?: string): { pid: number } | { error: string } {
  // Check if already running
  if (isProcessRunning(pidPath)) {
    const pid = readPidFile(pidPath)!
    return { error: `Already running (PID ${pid})` }
  }

  const resolvedLogDir = logDir ? expandHome(logDir) : DEFAULT_LOG_DIR
  fs.mkdirSync(resolvedLogDir, { recursive: true })
  const logFile = path.join(resolvedLogDir, 'openacp.log')

  // Find the CLI entry point
  const cliPath = path.resolve(process.argv[1])
  const nodePath = process.execPath

  const out = fs.openSync(logFile, 'a')
  const err = fs.openSync(logFile, 'a')

  const child = spawn(nodePath, [cliPath, '--daemon-child'], {
    detached: true,
    stdio: ['ignore', out, err],
  })

  // Close file descriptors in parent — child has its own copies
  fs.closeSync(out)
  fs.closeSync(err)

  if (!child.pid) {
    return { error: 'Failed to spawn daemon process' }
  }

  writePidFile(pidPath, child.pid)
  child.unref()

  return { pid: child.pid }
}

export function stopDaemon(pidPath: string = DEFAULT_PID_PATH): { stopped: boolean; pid?: number; error?: string } {
  const pid = readPidFile(pidPath)
  if (pid === null) return { stopped: false, error: 'Not running (no PID file)' }

  try {
    process.kill(pid, 0) // check alive
  } catch {
    removePidFile(pidPath)
    return { stopped: false, error: 'Not running (stale PID file removed)' }
  }

  try {
    process.kill(pid, 'SIGTERM')
    // PID file is cleaned up by the child process on SIGTERM (see main.ts shutdown handler).
    // Give the child a moment, then remove PID file if it's still there (child may have crashed).
    setTimeout(() => removePidFile(pidPath), 2000)
    return { stopped: true, pid }
  } catch (e) {
    return { stopped: false, error: `Failed to stop: ${(e as Error).message}` }
  }
}

export function getPidPath(): string {
  return DEFAULT_PID_PATH
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/daemon.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon.ts src/__tests__/daemon.test.ts
git commit -m "feat(daemon): add PID management and daemon spawn/stop"
```

---

### Task 3: Auto-start Module

**Files:**
- Create: `src/core/autostart.ts`
- Create: `src/__tests__/autostart.test.ts`

- [ ] **Step 1: Write failing tests for autostart module**

Create `src/__tests__/autostart.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

describe('autostart', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-autostart-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('generateLaunchdPlist', () => {
    it('generates valid plist with absolute paths', async () => {
      const { generateLaunchdPlist } = await import('../core/autostart.js')
      const plist = generateLaunchdPlist('/usr/local/bin/node', '/usr/local/lib/cli.js', '/Users/test/.openacp/logs')
      expect(plist).toContain('/usr/local/bin/node')
      expect(plist).toContain('/usr/local/lib/cli.js')
      expect(plist).toContain('--daemon-child')
      expect(plist).toContain('com.openacp.daemon')
      expect(plist).not.toContain('~')
    })
  })

  describe('generateSystemdUnit', () => {
    it('generates valid unit file with absolute paths', async () => {
      const { generateSystemdUnit } = await import('../core/autostart.js')
      const unit = generateSystemdUnit('/usr/bin/node', '/usr/lib/cli.js')
      expect(unit).toContain('/usr/bin/node')
      expect(unit).toContain('/usr/lib/cli.js')
      expect(unit).toContain('--daemon-child')
      expect(unit).toContain('Restart=on-failure')
    })
  })

  describe('isAutoStartSupported', () => {
    it('returns true on darwin', async () => {
      const { isAutoStartSupported } = await import('../core/autostart.js')
      // This test runs on whatever platform we're on
      const supported = isAutoStartSupported()
      if (process.platform === 'darwin' || process.platform === 'linux') {
        expect(supported).toBe(true)
      } else {
        expect(supported).toBe(false)
      }
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/autostart.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement autostart.ts**

Create `src/core/autostart.ts`:

```typescript
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createChildLogger } from './log.js'

const log = createChildLogger({ module: 'autostart' })

const LAUNCHD_LABEL = 'com.openacp.daemon'
const LAUNCHD_PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
const SYSTEMD_SERVICE_PATH = path.join(os.homedir(), '.config', 'systemd', 'user', 'openacp.service')

export function isAutoStartSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux'
}

export function generateLaunchdPlist(nodePath: string, cliPath: string, logDir: string): string {
  const logFile = path.join(logDir, 'openacp.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>--daemon-child</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`
}

export function generateSystemdUnit(nodePath: string, cliPath: string): string {
  return `[Unit]
Description=OpenACP Daemon

[Service]
ExecStart=${nodePath} ${cliPath} --daemon-child
Restart=on-failure

[Install]
WantedBy=default.target
`
}

export function installAutoStart(logDir: string): { success: boolean; error?: string } {
  if (!isAutoStartSupported()) {
    return { success: false, error: 'Auto-start not supported on this platform' }
  }

  const nodePath = process.execPath
  const cliPath = path.resolve(process.argv[1])
  const resolvedLogDir = logDir.startsWith('~')
    ? path.join(os.homedir(), logDir.slice(1))
    : logDir

  try {
    if (process.platform === 'darwin') {
      const plist = generateLaunchdPlist(nodePath, cliPath, resolvedLogDir)
      const dir = path.dirname(LAUNCHD_PLIST_PATH)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(LAUNCHD_PLIST_PATH, plist)
      execFileSync('launchctl', ['load', LAUNCHD_PLIST_PATH], { stdio: 'pipe' })
      log.info('LaunchAgent installed')
      return { success: true }
    }

    if (process.platform === 'linux') {
      const unit = generateSystemdUnit(nodePath, cliPath)
      const dir = path.dirname(SYSTEMD_SERVICE_PATH)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(SYSTEMD_SERVICE_PATH, unit)
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' })
      execFileSync('systemctl', ['--user', 'enable', 'openacp'], { stdio: 'pipe' })
      log.info('systemd user service installed')
      return { success: true }
    }

    return { success: false, error: 'Unsupported platform' }
  } catch (e) {
    const msg = (e as Error).message
    log.error({ err: msg }, 'Failed to install auto-start')
    return { success: false, error: msg }
  }
}

export function uninstallAutoStart(): { success: boolean; error?: string } {
  if (!isAutoStartSupported()) {
    return { success: false, error: 'Auto-start not supported on this platform' }
  }

  try {
    if (process.platform === 'darwin') {
      if (fs.existsSync(LAUNCHD_PLIST_PATH)) {
        try {
          execFileSync('launchctl', ['unload', LAUNCHD_PLIST_PATH], { stdio: 'pipe' })
        } catch {
          // may already be unloaded
        }
        fs.unlinkSync(LAUNCHD_PLIST_PATH)
        log.info('LaunchAgent removed')
      }
      return { success: true }
    }

    if (process.platform === 'linux') {
      if (fs.existsSync(SYSTEMD_SERVICE_PATH)) {
        try {
          execFileSync('systemctl', ['--user', 'disable', 'openacp'], { stdio: 'pipe' })
        } catch {
          // may already be disabled
        }
        fs.unlinkSync(SYSTEMD_SERVICE_PATH)
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' })
        log.info('systemd user service removed')
      }
      return { success: true }
    }

    return { success: false, error: 'Unsupported platform' }
  } catch (e) {
    const msg = (e as Error).message
    log.error({ err: msg }, 'Failed to uninstall auto-start')
    return { success: false, error: msg }
  }
}

export function isAutoStartInstalled(): boolean {
  if (process.platform === 'darwin') {
    return fs.existsSync(LAUNCHD_PLIST_PATH)
  }
  if (process.platform === 'linux') {
    return fs.existsSync(SYSTEMD_SERVICE_PATH)
  }
  return false
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/autostart.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/autostart.ts src/__tests__/autostart.test.ts
git commit -m "feat(autostart): add launchd and systemd auto-start support"
```

---

### Task 4: Config Editor Module

**Files:**
- Create: `src/core/config-editor.ts`
- Create: `src/__tests__/config-editor.test.ts`

- [ ] **Step 1: Write failing tests for config editor**

Create `src/__tests__/config-editor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @inquirer/prompts
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input: vi.fn(),
}))

// Mock autostart
vi.mock('../core/autostart.js', () => ({
  installAutoStart: vi.fn(() => ({ success: true })),
  uninstallAutoStart: vi.fn(() => ({ success: true })),
  isAutoStartInstalled: vi.fn(() => false),
  isAutoStartSupported: vi.fn(() => true),
}))

// Mock setup validators
vi.mock('../core/setup.js', () => ({
  validateBotToken: vi.fn(() => ({ ok: true, botName: 'Test', botUsername: 'testbot' })),
  validateChatId: vi.fn(() => ({ ok: true, title: 'Test Group', isForum: true })),
}))

describe('config-editor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exports runConfigEditor function', async () => {
    const mod = await import('../core/config-editor.js')
    expect(typeof mod.runConfigEditor).toBe('function')
  })

  it('exits without saving when no changes are made', async () => {
    const { select } = await import('@inquirer/prompts')
    const { runConfigEditor } = await import('../core/config-editor.js')

    // Mock: user immediately exits
    vi.mocked(select).mockResolvedValueOnce('exit')

    const mockConfigManager = {
      load: vi.fn(),
      get: vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'token', chatId: -100 } },
        agents: { claude: { command: 'claude-agent-acp', args: [], env: {} } },
        defaultAgent: 'claude',
        workspace: { baseDir: '~/workspace' },
        security: { allowedUserIds: [], maxConcurrentSessions: 5, sessionTimeoutMinutes: 60 },
        logging: { level: 'info', logDir: '~/.openacp/logs', maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 },
        runMode: 'foreground',
        autoStart: false,
      })),
      save: vi.fn(),
      getConfigPath: vi.fn(() => '/tmp/config.json'),
    }

    await runConfigEditor(mockConfigManager as any)
    expect(mockConfigManager.save).not.toHaveBeenCalled()
  })

  it('saves changes when user edits workspace and exits', async () => {
    const { select, input } = await import('@inquirer/prompts')
    const { runConfigEditor } = await import('../core/config-editor.js')

    // Mock: user selects workspace, edits it, then exits
    vi.mocked(select)
      .mockResolvedValueOnce('workspace')  // main menu
      .mockResolvedValueOnce('exit')        // main menu again

    vi.mocked(input).mockResolvedValueOnce('~/new-workspace')

    const mockConfigManager = {
      load: vi.fn(),
      get: vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'token', chatId: -100 } },
        agents: { claude: { command: 'claude-agent-acp', args: [], env: {} } },
        defaultAgent: 'claude',
        workspace: { baseDir: '~/workspace' },
        security: { allowedUserIds: [], maxConcurrentSessions: 5, sessionTimeoutMinutes: 60 },
        logging: { level: 'info', logDir: '~/.openacp/logs', maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 },
        runMode: 'foreground',
        autoStart: false,
      })),
      save: vi.fn(),
      getConfigPath: vi.fn(() => '/tmp/config.json'),
    }

    await runConfigEditor(mockConfigManager as any)
    expect(mockConfigManager.save).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: { baseDir: '~/new-workspace' } })
    )
  })

  it('discards changes on Ctrl+C (ExitPromptError)', async () => {
    const { select } = await import('@inquirer/prompts')
    const { runConfigEditor } = await import('../core/config-editor.js')

    const exitError = new Error('User cancelled')
    exitError.name = 'ExitPromptError'
    vi.mocked(select).mockRejectedValueOnce(exitError)

    const mockConfigManager = {
      load: vi.fn(),
      get: vi.fn(() => ({
        channels: {}, agents: { claude: { command: 'c', args: [], env: {} } },
        defaultAgent: 'claude', workspace: { baseDir: '~' },
        security: { allowedUserIds: [], maxConcurrentSessions: 5, sessionTimeoutMinutes: 60 },
        logging: { level: 'info', logDir: '~/.openacp/logs', maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 },
        runMode: 'foreground', autoStart: false,
      })),
      save: vi.fn(),
      getConfigPath: vi.fn(() => '/tmp/config.json'),
    }

    await runConfigEditor(mockConfigManager as any)
    expect(mockConfigManager.save).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/config-editor.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement config-editor.ts**

Create `src/core/config-editor.ts`:

```typescript
import { select, input } from '@inquirer/prompts'
import type { Config, ConfigManager } from './config.js'
import { validateBotToken, validateChatId } from './setup.js'
import { installAutoStart, uninstallAutoStart, isAutoStartInstalled, isAutoStartSupported } from './autostart.js'
import { expandHome } from './config.js'

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
}

const ok = (msg: string) => `${c.green}${c.bold}✓${c.reset} ${c.green}${msg}${c.reset}`
const dim = (msg: string) => `${c.dim}${msg}${c.reset}`
const header = (title: string) => `\n${c.cyan}${c.bold}[${title}]${c.reset}\n`

type ConfigUpdates = Record<string, unknown>

async function editTelegram(config: Config, updates: ConfigUpdates): Promise<void> {
  const tg = config.channels.telegram as Record<string, unknown> | undefined
  const currentToken = (tg?.botToken as string) || ''
  const currentChatId = (tg?.chatId as number) || 0

  while (true) {
    console.log(header('Telegram'))
    console.log(dim(`  Bot Token: ${currentToken ? currentToken.slice(0, 8) + '...' : '(not set)'}`))
    console.log(dim(`  Chat ID: ${currentChatId || '(not set)'}`))
    console.log('')

    const action = await select({
      message: 'What to edit?',
      choices: [
        { name: 'Change Bot Token', value: 'token' },
        { name: 'Change Chat ID', value: 'chatId' },
        { name: '← Back', value: 'back' },
      ],
    })

    if (action === 'back') return

    if (action === 'token') {
      const token = await input({
        message: 'Bot token:',
        default: currentToken,
        validate: (val) => val.trim().length > 0 || 'Token cannot be empty',
      })
      const result = await validateBotToken(token.trim())
      if (result.ok) {
        console.log(ok(`Connected to @${result.botUsername}`))
        if (!updates.channels) updates.channels = {}
        if (!(updates.channels as Record<string, unknown>).telegram) (updates.channels as Record<string, unknown>).telegram = {}
        ;((updates.channels as Record<string, unknown>).telegram as Record<string, unknown>).botToken = token.trim()
      } else {
        console.log(`${c.yellow}⚠ Validation failed: ${result.error}. Token saved anyway.${c.reset}`)
        if (!updates.channels) updates.channels = {}
        if (!(updates.channels as Record<string, unknown>).telegram) (updates.channels as Record<string, unknown>).telegram = {}
        ;((updates.channels as Record<string, unknown>).telegram as Record<string, unknown>).botToken = token.trim()
      }
    }

    if (action === 'chatId') {
      const chatIdStr = await input({
        message: 'Chat ID:',
        default: String(currentChatId),
        validate: (val) => {
          const n = Number(val.trim())
          if (isNaN(n) || !Number.isInteger(n)) return 'Chat ID must be an integer'
          return true
        },
      })
      const chatId = Number(chatIdStr.trim())
      const token = ((updates.channels as Record<string, unknown>)?.telegram as Record<string, unknown>)?.botToken as string || currentToken
      if (token) {
        const result = await validateChatId(token, chatId)
        if (result.ok) {
          console.log(ok(`Group: ${result.title}`))
        } else {
          console.log(`${c.yellow}⚠ ${result.error}. Chat ID saved anyway.${c.reset}`)
        }
      }
      if (!updates.channels) updates.channels = {}
      if (!(updates.channels as Record<string, unknown>).telegram) (updates.channels as Record<string, unknown>).telegram = {}
      ;((updates.channels as Record<string, unknown>).telegram as Record<string, unknown>).chatId = chatId
    }
  }
}

async function editAgent(config: Config, updates: ConfigUpdates): Promise<void> {
  console.log(header('Agent'))
  const agents = Object.entries(config.agents)
  for (const [name, agent] of agents) {
    console.log(dim(`  ${name}: ${agent.command} ${agent.args.join(' ')}`))
  }
  console.log(dim(`  Default: ${config.defaultAgent}`))
  console.log('')

  const action = await select({
    message: 'What to edit?',
    choices: [
      { name: 'Change default agent', value: 'default' },
      { name: '← Back', value: 'back' },
    ],
  })

  if (action === 'back') return

  if (action === 'default') {
    const agentName = await input({
      message: 'Default agent name:',
      default: config.defaultAgent,
    })
    updates.defaultAgent = agentName.trim()
    console.log(ok(`Default agent: ${agentName.trim()}`))
  }
}

async function editWorkspace(config: Config, updates: ConfigUpdates): Promise<void> {
  console.log(header('Workspace'))
  console.log(dim(`  Base directory: ${config.workspace.baseDir}`))
  console.log('')

  const baseDir = await input({
    message: 'Base directory:',
    default: config.workspace.baseDir,
    validate: (val) => val.trim().length > 0 || 'Path cannot be empty',
  })

  updates.workspace = { baseDir: baseDir.trim() }
  console.log(ok(`Workspace: ${baseDir.trim()}`))
}

async function editSecurity(config: Config, updates: ConfigUpdates): Promise<void> {
  console.log(header('Security'))
  console.log(dim(`  Allowed user IDs: ${config.security.allowedUserIds.length === 0 ? '(any)' : config.security.allowedUserIds.join(', ')}`))
  console.log(dim(`  Max concurrent sessions: ${config.security.maxConcurrentSessions}`))
  console.log(dim(`  Session timeout (min): ${config.security.sessionTimeoutMinutes}`))
  console.log('')

  const action = await select({
    message: 'What to edit?',
    choices: [
      { name: 'Max concurrent sessions', value: 'maxSessions' },
      { name: 'Session timeout (minutes)', value: 'timeout' },
      { name: '← Back', value: 'back' },
    ],
  })

  if (action === 'back') return

  if (action === 'maxSessions') {
    const val = await input({
      message: 'Max concurrent sessions:',
      default: String(config.security.maxConcurrentSessions),
      validate: (v) => { const n = Number(v); return (!isNaN(n) && n > 0) || 'Must be a positive number' },
    })
    if (!updates.security) updates.security = {}
    ;(updates.security as Record<string, unknown>).maxConcurrentSessions = Number(val.trim())
  }

  if (action === 'timeout') {
    const val = await input({
      message: 'Session timeout (minutes):',
      default: String(config.security.sessionTimeoutMinutes),
      validate: (v) => { const n = Number(v); return (!isNaN(n) && n > 0) || 'Must be a positive number' },
    })
    if (!updates.security) updates.security = {}
    ;(updates.security as Record<string, unknown>).sessionTimeoutMinutes = Number(val.trim())
  }
}

async function editLogging(config: Config, updates: ConfigUpdates): Promise<void> {
  console.log(header('Logging'))
  console.log(dim(`  Level: ${config.logging.level}`))
  console.log(dim(`  Log dir: ${config.logging.logDir}`))
  console.log('')

  const action = await select({
    message: 'What to edit?',
    choices: [
      { name: 'Log level', value: 'level' },
      { name: 'Log directory', value: 'logDir' },
      { name: '← Back', value: 'back' },
    ],
  })

  if (action === 'back') return

  if (action === 'level') {
    const level = await select({
      message: 'Log level:',
      choices: [
        { name: 'silent', value: 'silent' },
        { name: 'debug', value: 'debug' },
        { name: 'info', value: 'info' },
        { name: 'warn', value: 'warn' },
        { name: 'error', value: 'error' },
      ],
    })
    if (!updates.logging) updates.logging = {}
    ;(updates.logging as Record<string, unknown>).level = level
  }

  if (action === 'logDir') {
    const dir = await input({
      message: 'Log directory:',
      default: config.logging.logDir,
    })
    if (!updates.logging) updates.logging = {}
    ;(updates.logging as Record<string, unknown>).logDir = dir.trim()
  }
}

async function editRunMode(config: Config, updates: ConfigUpdates): Promise<void> {
  while (true) {
    const currentMode = (updates.runMode as string) || config.runMode
    const currentAutoStart = updates.autoStart !== undefined ? updates.autoStart as boolean : config.autoStart
    const autoStartInstalled = isAutoStartInstalled()

    console.log(header('Run Mode'))
    console.log(dim(`  Mode: ${currentMode}`))
    console.log(dim(`  Auto-start: ${currentAutoStart ? 'on' : 'off'}${autoStartInstalled ? ' (installed)' : ''}`))
    console.log('')

    const choices: Array<{ name: string; value: string }> = []

    if (currentMode === 'foreground') {
      choices.push({ name: 'Switch to daemon', value: 'daemon' })
    } else {
      choices.push({ name: 'Switch to foreground', value: 'foreground' })
    }

    if (isAutoStartSupported()) {
      choices.push({
        name: currentAutoStart ? 'Disable auto-start' : 'Enable auto-start',
        value: 'toggleAutoStart',
      })
    }

    choices.push({ name: '← Back', value: 'back' })

    const action = await select({ message: 'What to change?', choices })

    if (action === 'back') return

    if (action === 'daemon') {
      updates.runMode = 'daemon'
      if (isAutoStartSupported()) {
        updates.autoStart = true
        const result = installAutoStart(expandHome(config.logging.logDir))
        if (result.success) {
          console.log(ok('Switched to daemon mode with auto-start'))
        } else {
          console.log(ok('Switched to daemon mode'))
          console.log(`${c.yellow}⚠ Auto-start failed: ${result.error}${c.reset}`)
        }
      } else {
        console.log(ok('Switched to daemon mode'))
        console.log(`${c.yellow}⚠ Auto-start not available on this platform${c.reset}`)
      }
    }

    if (action === 'foreground') {
      updates.runMode = 'foreground'
      updates.autoStart = false
      uninstallAutoStart()
      console.log(ok('Switched to foreground mode'))
    }

    if (action === 'toggleAutoStart') {
      if (currentAutoStart) {
        updates.autoStart = false
        uninstallAutoStart()
        console.log(ok('Auto-start disabled'))
      } else {
        updates.autoStart = true
        const result = installAutoStart(expandHome(config.logging.logDir))
        if (result.success) {
          console.log(ok('Auto-start enabled'))
        } else {
          console.log(`${c.yellow}⚠ Failed: ${result.error}${c.reset}`)
        }
      }
    }
  }
}

export async function runConfigEditor(configManager: ConfigManager): Promise<void> {
  await configManager.load()
  const config = configManager.get()
  const updates: ConfigUpdates = {}

  try {
    while (true) {
      console.log(`\n${c.cyan}${c.bold}  OpenACP Configuration${c.reset}\n`)

      const group = await select({
        message: 'Select a section to edit:',
        choices: [
          { name: 'Telegram', value: 'telegram' },
          { name: 'Agent', value: 'agent' },
          { name: 'Workspace', value: 'workspace' },
          { name: 'Security', value: 'security' },
          { name: 'Logging', value: 'logging' },
          { name: 'Run Mode', value: 'runMode' },
          { name: '← Exit (save)', value: 'exit' },
        ],
      })

      if (group === 'exit') break

      if (group === 'telegram') await editTelegram(config, updates)
      if (group === 'agent') await editAgent(config, updates)
      if (group === 'workspace') await editWorkspace(config, updates)
      if (group === 'security') await editSecurity(config, updates)
      if (group === 'logging') await editLogging(config, updates)
      if (group === 'runMode') await editRunMode(config, updates)
    }

    // Save accumulated updates
    if (Object.keys(updates).length > 0) {
      await configManager.save(updates)
      console.log(ok(`Config saved to ${c.bold}${configManager.getConfigPath()}`))
      console.log(dim('Restart OpenACP for changes to take effect.'))
    } else {
      console.log(dim('No changes made.'))
    }
  } catch (err) {
    if ((err as Error).name === 'ExitPromptError') {
      console.log(dim('\nConfig editor cancelled. Changes discarded.'))
      return
    }
    throw err
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/config-editor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/config-editor.ts src/__tests__/config-editor.test.ts
git commit -m "feat(config-editor): add menu-based interactive config editor"
```

---

### Task 5: Update CLI with New Commands

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Update help text and add all new commands**

Replace the entire `src/cli.ts` with the updated version that adds: `start`, `stop`, `status`, `logs`, `config`, `--foreground`, `--daemon-child`.

In `printHelp()`, update to:

```typescript
function printHelp(): void {
  console.log(`
OpenACP - Self-hosted bridge for AI coding agents

Usage:
  openacp                              Start (mode from config)
  openacp start                        Start as background daemon
  openacp stop                         Stop background daemon
  openacp status                       Show daemon status
  openacp logs                         Tail daemon log file
  openacp config                       Edit configuration
  openacp install <package>            Install a plugin adapter
  openacp uninstall <package>          Uninstall a plugin adapter
  openacp plugins                      List installed plugins
  openacp --foreground                 Force foreground mode
  openacp --version                    Show version
  openacp --help                       Show this help

Install:
  npm install -g @openacp/cli
`)
}
```

- [ ] **Step 2: Add command handlers in main()**

After the existing `plugins` command handler and before the default server start block, add handlers for `start`, `stop`, `status`, `logs`, `config` commands:

```typescript
  if (command === 'start') {
    const { startDaemon, getPidPath } = await import('./core/daemon.js')
    const { ConfigManager } = await import('./core/config.js')
    const cm = new ConfigManager()
    if (await cm.exists()) {
      await cm.load()
      const config = cm.get()
      const result = startDaemon(getPidPath(), config.logging.logDir)
      if ('error' in result) {
        console.error(result.error)
        process.exit(1)
      }
      console.log(`OpenACP daemon started (PID ${result.pid})`)
    } else {
      console.error('No config found. Run "openacp" first to set up.')
      process.exit(1)
    }
    return
  }

  if (command === 'stop') {
    const { stopDaemon } = await import('./core/daemon.js')
    const result = stopDaemon()
    if (result.stopped) {
      console.log(`OpenACP daemon stopped (was PID ${result.pid})`)
    } else {
      console.error(result.error)
      process.exit(1)
    }
    return
  }

  if (command === 'status') {
    const { getStatus } = await import('./core/daemon.js')
    const status = getStatus()
    if (status.running) {
      console.log(`OpenACP is running (PID ${status.pid})`)
    } else {
      console.log('OpenACP is not running')
    }
    return
  }

  if (command === 'logs') {
    const { spawn } = await import('node:child_process')
    const { ConfigManager, expandHome } = await import('./core/config.js')
    const pathMod = await import('node:path')
    const cm = new ConfigManager()
    let logDir = '~/.openacp/logs'
    if (await cm.exists()) {
      await cm.load()
      logDir = cm.get().logging.logDir
    }
    const logFile = pathMod.join(expandHome(logDir), 'openacp.log')
    const tail = spawn('tail', ['-f', '-n', '50', logFile], { stdio: 'inherit' })
    tail.on('error', (err: Error) => {
      console.error(`Cannot tail log file: ${err.message}`)
      process.exit(1)
    })
    return
  }

  if (command === 'config') {
    const { runConfigEditor } = await import('./core/config-editor.js')
    const { ConfigManager } = await import('./core/config.js')
    const cm = new ConfigManager()
    if (!(await cm.exists())) {
      console.error('No config found. Run "openacp" first to set up.')
      process.exit(1)
    }
    await runConfigEditor(cm)
    return
  }
```

- [ ] **Step 3: Update the default (no args) server start to handle runMode**

Replace the default server start block (after the unknown command check) with:

```typescript
  // Handle --daemon-child (internal flag for background server)
  if (command === '--daemon-child') {
    const { startServer } = await import('./main.js')
    await startServer()
    return
  }

  // Handle --foreground flag
  const forceForeground = command === '--foreground'

  // Reject unknown commands
  if (command && !command.startsWith('-')) {
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exit(1)
  }

  // Default: start server based on config runMode
  const { ConfigManager } = await import('./core/config.js')
  const cm = new ConfigManager()

  // If no config, run setup (which will decide mode)
  if (!(await cm.exists())) {
    const { startServer } = await import('./main.js')
    await startServer()
    return
  }

  await cm.load()
  const config = cm.get()

  if (!forceForeground && config.runMode === 'daemon') {
    // Daemon mode: spawn background process
    const { startDaemon, getPidPath } = await import('./core/daemon.js')
    const result = startDaemon(getPidPath(), config.logging.logDir)
    if ('error' in result) {
      console.error(result.error)
      process.exit(1)
    }
    console.log(`OpenACP daemon started (PID ${result.pid})`)
    return
  }

  // Foreground mode
  const { startServer } = await import('./main.js')
  await startServer()
```

- [ ] **Step 4: Build and verify no TypeScript errors**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): add start/stop/status/logs/config commands and daemon mode"
```

---

### Task 6: Update Setup (Onboarding) with Run Mode Step

**Files:**
- Modify: `src/core/setup.ts`

- [ ] **Step 1: Update step numbering**

In `src/core/setup.ts`, change the `step()` function calls:
- Line 290: `step(1, "Telegram Bot")` → keep as `step(1, "Telegram Bot")` (step 1 of 3)
- Line 317: `step(2, "Group Chat")` → **remove this step header** (Group Chat is part of the Telegram step, not its own step)
- Line 355: `step(3, "Workspace")` → change to `step(2, "Workspace")`

Also update the `step` helper to show total 3:

```typescript
const step = (n: number, title: string) =>
  `\n${c.cyan}${c.bold}[${n}/3]${c.reset} ${c.bold}${title}${c.reset}\n`
```

- [ ] **Step 2: Add setupRunMode function**

Add after `setupWorkspace()`:

```typescript
export async function setupRunMode(): Promise<{ runMode: 'foreground' | 'daemon'; autoStart: boolean }> {
  console.log(step(3, 'Run Mode'))

  // Don't show daemon option on Windows
  if (process.platform === 'win32') {
    console.log(dim('  (Daemon mode not available on Windows)'))
    return { runMode: 'foreground', autoStart: false }
  }

  const mode = await select({
    message: 'How would you like to run OpenACP?',
    choices: [
      {
        name: 'Background (daemon)',
        value: 'daemon' as const,
        description: 'Runs silently, auto-starts on boot. Manage with: openacp status | stop | logs',
      },
      {
        name: 'Foreground (terminal)',
        value: 'foreground' as const,
        description: 'Runs in current terminal session. Start with: openacp',
      },
    ],
  })

  if (mode === 'daemon') {
    const { installAutoStart, isAutoStartSupported } = await import('./autostart.js')
    const autoStart = isAutoStartSupported()
    if (autoStart) {
      const result = installAutoStart(expandHome('~/.openacp/logs'))
      if (result.success) {
        console.log(ok('Auto-start on boot enabled'))
      } else {
        console.log(warn(`Auto-start failed: ${result.error}`))
      }
    }
    return { runMode: 'daemon', autoStart }
  }

  return { runMode: 'foreground', autoStart: false }
}
```

Note: Import `expandHome` is already available in setup.ts since it's from config.ts. Add the import at the top if needed:

```typescript
import { expandHome } from './config.js'
```

- [ ] **Step 3: Update runSetup to include run mode and handle daemon start**

In `runSetup()`, after `setupWorkspace()`, add the run mode step and include results in config:

```typescript
  const { runMode, autoStart } = await setupRunMode()
```

Update the config object to include the new fields:

```typescript
    const config: Config = {
      channels: { telegram },
      agents,
      defaultAgent,
      workspace,
      security: { ... },
      logging: { ... },
      runMode,
      autoStart,
    }
```

After saving config, if daemon mode was chosen, update the post-save logic. Change the return value handling — `runSetup` currently returns `boolean` (true = start server). For daemon mode, the setup should start daemon instead:

Add a return type change. Instead of returning just `boolean`, return `{ shouldStart: boolean; runMode: 'foreground' | 'daemon' }`:

Actually, to keep changes minimal: keep returning `boolean`. In `main.ts`, after setup completes, re-read the config to check `runMode`. The daemon spawn will be handled by `cli.ts` based on config. So `runSetup` just returns `true` and `cli.ts` handles the mode.

No change to return type needed. Just add the fields to the config object.

- [ ] **Step 4: Build and verify**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 5: Run existing setup tests to make sure nothing broke**

Run: `pnpm test -- src/__tests__/setup.test.ts src/__tests__/setup-integration.test.ts`
Expected: PASS (may need minor adjustments if tests verify config shape or step numbering)

- [ ] **Step 6: Commit**

```bash
git add src/core/setup.ts
git commit -m "feat(setup): add run mode step to onboarding wizard"
```

---

### Task 7: Update main.ts for --daemon-child PID Cleanup

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add PID cleanup to shutdown handler**

In `src/main.ts`, inside the `shutdown` function, add PID file removal before `process.exit(0)`:

```typescript
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'Signal received, shutting down')

    try {
      await core.stop()
    } catch (err) {
      log.error({ err }, 'Error during shutdown')
    }

    // Clean up PID file if running as daemon
    if (process.argv.includes('--daemon-child')) {
      const { removePidFile, getPidPath } = await import('./core/daemon.js')
      removePidFile(getPidPath())
    }

    await shutdownLogger()
    process.exit(0)
  }
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): clean up PID file on daemon shutdown"
```

---

### Task 8: Update Exports

**Files:**
- Modify: `src/core/index.ts`

- [ ] **Step 1: Add exports for new modules**

In `src/core/index.ts`, add:

```typescript
export { startDaemon, stopDaemon, getStatus, getPidPath } from './daemon.js'
export { installAutoStart, uninstallAutoStart, isAutoStartInstalled, isAutoStartSupported } from './autostart.js'
export { runConfigEditor } from './config-editor.js'
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/core/index.ts
git commit -m "feat(exports): expose daemon, autostart, config-editor in public API"
```

---

### Task 9: Integration Testing & Final Verification

**Files:**
- All test files

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 2: Build project**

Run: `pnpm build`
Expected: Clean build with no errors

- [ ] **Step 3: Verify CLI help output**

Run: `node dist/cli.js --help`
Expected: Shows all new commands (start, stop, status, logs, config)

- [ ] **Step 4: Verify status command works**

Run: `node dist/cli.js status`
Expected: "OpenACP is not running" (since we haven't started a daemon)

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address integration test issues"
```

Only commit if there were actual fixes. Skip if everything passed.
