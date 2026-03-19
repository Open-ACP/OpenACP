# CLI Onboarding Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add interactive first-run setup wizard that auto-detects missing config and walks users through Telegram, agents, workspace, and security configuration.

**Architecture:** Single new file `packages/core/src/setup.ts` with validation helpers and step functions orchestrated by `runSetup()`. Two existing files modified: `config.ts` gets `exists()`, `getConfigPath()`, and `writeNew()` methods; `main.ts` calls setup when config is missing.

**Tech Stack:** TypeScript, `@inquirer/prompts` for interactive CLI, `fetch()` (Node 20+ built-in) for Telegram API validation, `child_process.execSync` for `command -v` agent detection, `vitest` for testing.

**Spec:** `docs/superpowers/specs/2026-03-19-cli-onboarding-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/core/src/setup.ts` | Create | All setup logic: welcome banner, step functions (telegram, agents, workspace, security), validation helpers, review/confirm, orchestrator `runSetup()` |
| `packages/core/src/config.ts` | Modify | Add `exists()`, `getConfigPath()`, `writeNew()` methods |
| `packages/core/src/main.ts` | Modify | Detect missing config → call `runSetup()` instead of creating default |
| `packages/core/src/__tests__/setup.test.ts` | Create | Unit tests for validation functions and `detectAgents()` |
| `packages/core/src/__tests__/setup-integration.test.ts` | Create | Integration test: mock prompts, verify full flow produces correct config |
| `packages/core/src/__tests__/config-new-methods.test.ts` | Create | Unit tests for `exists()`, `getConfigPath()`, `writeNew()` |
| `packages/core/vitest.config.ts` | Create | Vitest config for core package |
| `packages/core/package.json` | Modify | Add `@inquirer/prompts` dep + `vitest` devDep + test script |

---

### Task 1: Set up test infrastructure

**Files:**
- Create: `packages/core/vitest.config.ts`
- Modify: `packages/core/package.json`

- [ ] **Step 1: Install vitest**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm add -D vitest --filter @openacp/core
```

- [ ] **Step 2: Create vitest config**

Create `packages/core/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
  },
})
```

- [ ] **Step 3: Add test script to package.json**

In `packages/core/package.json`, add to `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Verify vitest runs (no tests yet)**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm --filter @openacp/core test
```
Expected: exits with "No test files found" or similar (no error).

- [ ] **Step 5: Commit**

```bash
git add packages/core/vitest.config.ts packages/core/package.json pnpm-lock.yaml
git commit -m "chore: add vitest test infrastructure to core package"
```

---

### Task 2: Add `exists()`, `getConfigPath()`, and `writeNew()` to ConfigManager

**Files:**
- Create: `packages/core/src/__tests__/config-new-methods.test.ts`
- Modify: `packages/core/src/config.ts`

- [ ] **Step 1: Write failing tests for the three new methods**

Create `packages/core/src/__tests__/config-new-methods.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ConfigManager } from '../config.js'

describe('ConfigManager new methods', () => {
  let tmpDir: string
  let configPath: string
  const originalEnv = process.env.OPENACP_CONFIG_PATH

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-test-'))
    configPath = path.join(tmpDir, 'config.json')
    process.env.OPENACP_CONFIG_PATH = configPath
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalEnv === undefined) {
      delete process.env.OPENACP_CONFIG_PATH
    } else {
      process.env.OPENACP_CONFIG_PATH = originalEnv
    }
  })

  describe('exists()', () => {
    it('returns false when config file does not exist', async () => {
      const cm = new ConfigManager()
      expect(await cm.exists()).toBe(false)
    })

    it('returns true when config file exists', async () => {
      fs.writeFileSync(configPath, '{}')
      const cm = new ConfigManager()
      expect(await cm.exists()).toBe(true)
    })
  })

  describe('getConfigPath()', () => {
    it('returns the resolved config path', () => {
      const cm = new ConfigManager()
      expect(cm.getConfigPath()).toBe(configPath)
    })

    it('respects OPENACP_CONFIG_PATH env var', () => {
      const customPath = path.join(tmpDir, 'custom.json')
      process.env.OPENACP_CONFIG_PATH = customPath
      const cm = new ConfigManager()
      expect(cm.getConfigPath()).toBe(customPath)
    })
  })

  describe('writeNew()', () => {
    it('writes a valid config to the config path', async () => {
      const cm = new ConfigManager()
      const config = {
        channels: {
          telegram: {
            enabled: true,
            botToken: 'test-token',
            chatId: -1001234567890,
            notificationTopicId: null,
            assistantTopicId: null,
          },
        },
        agents: {
          claude: { command: 'claude-agent-acp', args: [], env: {} },
        },
        defaultAgent: 'claude',
        workspace: { baseDir: '~/openacp-workspace' },
        security: {
          allowedUserIds: [],
          maxConcurrentSessions: 5,
          sessionTimeoutMinutes: 60,
        },
      }
      await cm.writeNew(config)

      expect(fs.existsSync(configPath)).toBe(true)
      const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      expect(written.channels.telegram.botToken).toBe('test-token')
      expect(written.defaultAgent).toBe('claude')
    })

    it('creates parent directory if it does not exist', async () => {
      const nestedPath = path.join(tmpDir, 'nested', 'dir', 'config.json')
      process.env.OPENACP_CONFIG_PATH = nestedPath
      const cm = new ConfigManager()
      await cm.writeNew({
        channels: { telegram: { enabled: true, botToken: 't', chatId: 1, notificationTopicId: null, assistantTopicId: null } },
        agents: { a: { command: 'a', args: [], env: {} } },
        defaultAgent: 'a',
        workspace: { baseDir: '~' },
        security: { allowedUserIds: [], maxConcurrentSessions: 1, sessionTimeoutMinutes: 1 },
      })

      expect(fs.existsSync(nestedPath)).toBe(true)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm --filter @openacp/core test
```
Expected: FAIL — `exists`, `getConfigPath`, `writeNew` are not defined on `ConfigManager`.

- [ ] **Step 3: Implement the three methods in config.ts**

In `packages/core/src/config.ts`, add these methods to the `ConfigManager` class (after the `resolveWorkspace` method, before `private applyEnvOverrides`):

```typescript
  async exists(): Promise<boolean> {
    return fs.existsSync(this.configPath)
  }

  getConfigPath(): string {
    return this.configPath
  }

  async writeNew(config: Config): Promise<void> {
    const dir = path.dirname(this.configPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2))
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm --filter @openacp/core test
```
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/__tests__/config-new-methods.test.ts
git commit -m "feat: add exists(), getConfigPath(), writeNew() to ConfigManager"
```

---

### Task 3: Add `@inquirer/prompts` dependency

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: Install @inquirer/prompts**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm add @inquirer/prompts --filter @openacp/core
```

- [ ] **Step 2: Verify it installed**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && node -e "import('@inquirer/prompts').then(() => console.log('OK'))"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml
git commit -m "chore: add @inquirer/prompts dependency to core"
```

---

### Task 4: Implement validation helpers (validateBotToken, validateChatId, detectAgents, validateAgentCommand)

**Files:**
- Create: `packages/core/src/setup.ts` (partial — validation helpers only)
- Create: `packages/core/src/__tests__/setup.test.ts`

- [ ] **Step 1: Write failing tests for validation helpers**

Create `packages/core/src/__tests__/setup.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { validateBotToken, validateChatId, detectAgents, validateAgentCommand } from '../setup.js'
import * as child_process from 'node:child_process'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

const mockedExecSync = vi.mocked(child_process.execSync)

describe('validateBotToken', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('returns ok with bot info for valid token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        result: { first_name: 'TestBot', username: 'test_bot' },
      }),
    }))

    const result = await validateBotToken('123:ABC')
    expect(result).toEqual({ ok: true, botName: 'TestBot', botUsername: 'test_bot' })
  })

  it('returns error for invalid token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: false,
        description: 'Unauthorized',
      }),
    }))

    const result = await validateBotToken('bad-token')
    expect(result).toEqual({ ok: false, error: 'Unauthorized' })
  })

  it('returns error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const result = await validateBotToken('123:ABC')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Network error')
  })
})

describe('validateChatId', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('returns ok for valid supergroup with forum', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        result: { title: 'My Group', type: 'supergroup', is_forum: true },
      }),
    }))

    const result = await validateChatId('token', -1001234)
    expect(result).toEqual({ ok: true, title: 'My Group', isForum: true })
  })

  it('returns ok with isForum false if topics not enabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        result: { title: 'My Group', type: 'supergroup', is_forum: false },
      }),
    }))

    const result = await validateChatId('token', -1001234)
    expect(result).toEqual({ ok: true, title: 'My Group', isForum: false })
  })

  it('returns error for non-supergroup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        result: { title: 'Private', type: 'private' },
      }),
    }))

    const result = await validateChatId('token', 12345)
    expect(result.ok).toBe(false)
  })
})

describe('detectAgents', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('returns detected agents from PATH', async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('claude-agent-acp')) {
        return Buffer.from('/usr/local/bin/claude-agent-acp\n')
      }
      throw new Error('not found')
    })

    const agents = await detectAgents()
    expect(agents.some(a => a.command === 'claude-agent-acp')).toBe(true)
  })

  it('returns empty array when no agents found', async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found')
    })

    const agents = await detectAgents()
    expect(agents).toEqual([])
  })
})

describe('validateAgentCommand', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('returns true when command exists', async () => {
    mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/node\n'))

    const result = await validateAgentCommand('node')
    expect(result).toBe(true)
  })

  it('returns false when command does not exist', async () => {
    mockedExecSync.mockImplementation(() => { throw new Error('not found') })

    const result = await validateAgentCommand('nonexistent-bin')
    expect(result).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm --filter @openacp/core test
```
Expected: FAIL — `setup.js` does not exist yet.

- [ ] **Step 3: Implement validation helpers in setup.ts**

Create `packages/core/src/setup.ts` (partial — only validation helpers for now):

```typescript
import { execSync } from 'node:child_process'

// --- Telegram validation ---

export async function validateBotToken(token: string): Promise<
  { ok: true; botName: string; botUsername: string } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const data = await res.json() as { ok: boolean; result?: { first_name: string; username: string }; description?: string }
    if (data.ok && data.result) {
      return { ok: true, botName: data.result.first_name, botUsername: data.result.username }
    }
    return { ok: false, error: data.description || 'Invalid token' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function validateChatId(token: string, chatId: number): Promise<
  { ok: true; title: string; isForum: boolean } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    })
    const data = await res.json() as {
      ok: boolean
      result?: { title: string; type: string; is_forum?: boolean }
      description?: string
    }
    if (!data.ok || !data.result) {
      return { ok: false, error: data.description || 'Invalid chat ID' }
    }
    if (data.result.type !== 'supergroup') {
      return { ok: false, error: `Chat is "${data.result.type}", must be a supergroup` }
    }
    return { ok: true, title: data.result.title, isForum: data.result.is_forum === true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// --- Agent detection ---

const KNOWN_AGENTS: Array<{ name: string; commands: string[] }> = [
  { name: 'claude', commands: ['claude-agent-acp', 'claude', 'claude-code'] },
  { name: 'codex', commands: ['codex'] },
]

export async function detectAgents(): Promise<Array<{ name: string; command: string }>> {
  const found: Array<{ name: string; command: string }> = []
  for (const agent of KNOWN_AGENTS) {
    for (const cmd of agent.commands) {
      try {
        execSync(`command -v ${cmd}`, { stdio: 'pipe' })
        found.push({ name: agent.name, command: cmd })
        break // found one for this agent, skip alternatives
      } catch {
        // not found, try next
      }
    }
  }
  return found
}

export async function validateAgentCommand(command: string): Promise<boolean> {
  try {
    execSync(`command -v ${command}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm --filter @openacp/core test
```
Expected: All validation tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/setup.ts packages/core/src/__tests__/setup.test.ts
git commit -m "feat: add Telegram and agent validation helpers for setup"
```

---

### Task 5: Implement setup step functions (setupTelegram, setupAgents, setupWorkspace, setupSecurity)

**Files:**
- Modify: `packages/core/src/setup.ts`

These functions use `@inquirer/prompts` for interactive input. They are difficult to unit test in isolation (interactive prompts), so they will be covered by the integration test in Task 8. Here we implement them and manually verify.

- [ ] **Step 1: Add setupTelegram()**

In `packages/core/src/setup.ts`, add at the top:

```typescript
import { input, confirm, select, checkbox } from '@inquirer/prompts'
import type { Config } from './config.js'
```

Then add:

```typescript
export async function setupTelegram(): Promise<NonNullable<Config['channels']['telegram']>> {
  console.log('\n--- Step 1: Telegram Setup ---\n')

  let botToken = ''
  let botUsername = ''
  let botName = ''

  while (true) {
    botToken = await input({
      message: 'Telegram bot token (from @BotFather):',
      validate: (val) => val.trim().length > 0 || 'Token cannot be empty',
    })
    botToken = botToken.trim()

    console.log('Validating bot token...')
    const result = await validateBotToken(botToken)
    if (result.ok) {
      botUsername = result.botUsername
      botName = result.botName
      console.log(`✓ Bot "${botName}" (@${botUsername}) connected`)
      break
    }
    console.log(`✗ Validation failed: ${result.error}`)
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Re-enter token', value: 'retry' },
        { name: 'Skip validation (use token as-is)', value: 'skip' },
      ],
    })
    if (action === 'skip') break
  }

  let chatId = 0
  let groupTitle = ''

  while (true) {
    const chatIdStr = await input({
      message: 'Telegram supergroup chat ID (e.g. -1001234567890):',
      validate: (val) => {
        const n = Number(val.trim())
        if (isNaN(n) || !Number.isInteger(n)) return 'Chat ID must be an integer'
        return true
      },
    })
    chatId = Number(chatIdStr.trim())

    console.log('Validating chat ID...')
    const result = await validateChatId(botToken, chatId)
    if (result.ok) {
      groupTitle = result.title
      if (!result.isForum) {
        console.log(`⚠ Warning: "${result.title}" does not have Topics enabled.`)
        console.log('  Please enable Topics in group settings → Topics → Enable.')
      } else {
        console.log(`✓ Connected to "${groupTitle}" (Topics enabled)`)
      }
      break
    }
    console.log(`✗ Validation failed: ${result.error}`)
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Re-enter chat ID', value: 'retry' },
        { name: 'Skip validation (use chat ID as-is)', value: 'skip' },
      ],
    })
    if (action === 'skip') break
  }

  return {
    enabled: true,
    botToken,
    chatId,
    notificationTopicId: null,
    assistantTopicId: null,
  }
}
```

- [ ] **Step 2: Add setupAgents()**

```typescript
export async function setupAgents(): Promise<{ agents: Config['agents']; defaultAgent: string }> {
  console.log('\n--- Step 2: Agent Setup ---\n')

  console.log('Detecting agents in PATH...')
  const detected = await detectAgents()

  const agents: Config['agents'] = {}

  if (detected.length > 0) {
    console.log(`Found: ${detected.map(a => `${a.name} (${a.command})`).join(', ')}`)

    const selected = await checkbox({
      message: 'Which agents do you want to enable?',
      choices: detected.map(a => ({
        name: `${a.name} (${a.command})`,
        value: a,
        checked: true,
      })),
    })

    if (selected.length === 0) {
      console.log('No agents selected from detected list.')
    }

    for (const agent of selected) {
      agents[agent.name] = { command: agent.command, args: [], env: {} }
    }
  } else {
    console.log('No known agents detected in PATH.')
  }

  // Offer manual agent entry
  let addMore = Object.keys(agents).length === 0
    ? true
    : await confirm({ message: 'Add a custom agent?', default: false })

  while (addMore) {
    const name = await input({
      message: 'Agent name (e.g. my-agent):',
      validate: (val) => val.trim().length > 0 || 'Name cannot be empty',
    })
    const command = await input({
      message: 'Agent command (binary name or path):',
      validate: (val) => val.trim().length > 0 || 'Command cannot be empty',
    })

    const exists = await validateAgentCommand(command.trim())
    if (!exists) {
      console.log(`⚠ Warning: "${command.trim()}" not found in PATH. It may need to be installed.`)
    }

    agents[name.trim()] = { command: command.trim(), args: [], env: {} }
    addMore = await confirm({ message: 'Add another agent?', default: false })
  }

  if (Object.keys(agents).length === 0) {
    throw new Error('Setup cancelled: at least one agent is required')
  }

  const agentNames = Object.keys(agents)
  let defaultAgent: string

  if (agentNames.length === 1) {
    defaultAgent = agentNames[0]
    console.log(`Default agent: ${defaultAgent}`)
  } else {
    defaultAgent = await select({
      message: 'Which agent should be the default?',
      choices: agentNames.map(n => ({ name: n, value: n })),
    })
  }

  return { agents, defaultAgent }
}
```

- [ ] **Step 3: Add setupWorkspace()**

```typescript
export async function setupWorkspace(): Promise<{ baseDir: string }> {
  console.log('\n--- Step 3: Workspace Setup ---\n')

  const baseDir = await input({
    message: 'Workspace base directory:',
    default: '~/openacp-workspace',
    validate: (val) => val.trim().length > 0 || 'Path cannot be empty',
  })

  return { baseDir: baseDir.trim() }
}
```

- [ ] **Step 4: Add setupSecurity()**

```typescript
export async function setupSecurity(): Promise<Config['security']> {
  console.log('\n--- Step 4: Security Setup ---\n')

  const userIdsStr = await input({
    message: 'Allowed Telegram user IDs (comma-separated, or leave empty to allow all):',
    default: '',
  })

  const allowedUserIds = userIdsStr.trim()
    ? userIdsStr.split(',').map(id => id.trim()).filter(id => id.length > 0)
    : []

  const maxConcurrentStr = await input({
    message: 'Max concurrent sessions:',
    default: '5',
    validate: (val) => {
      const n = Number(val)
      return (!isNaN(n) && Number.isInteger(n) && n > 0) || 'Must be a positive integer'
    },
  })

  const timeoutStr = await input({
    message: 'Session timeout (minutes):',
    default: '60',
    validate: (val) => {
      const n = Number(val)
      return (!isNaN(n) && Number.isInteger(n) && n > 0) || 'Must be a positive integer'
    },
  })

  return {
    allowedUserIds,
    maxConcurrentSessions: Number(maxConcurrentStr),
    sessionTimeoutMinutes: Number(timeoutStr),
  }
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm --filter @openacp/core build
```
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/setup.ts
git commit -m "feat: add interactive setup step functions (telegram, agents, workspace, security)"
```

---

### Task 6: Implement `runSetup()` orchestrator with welcome banner and review/confirm

**Files:**
- Modify: `packages/core/src/setup.ts`

- [ ] **Step 1: Add the welcome banner and runSetup() function**

At the bottom of `packages/core/src/setup.ts`, add the following. Note: consolidate the `import type { Config } from './config.js'` added in Task 5 into a single import: `import type { Config, ConfigManager } from './config.js'`.

```typescript
function printWelcomeBanner(): void {
  console.log(`
┌──────────────────────────────────────┐
│                                      │
│   Welcome to OpenACP!                │
│                                      │
│   Let's set up your configuration.   │
│                                      │
└──────────────────────────────────────┘
`)
}

function printConfigSummary(config: Config): void {
  console.log('\n--- Configuration Summary ---\n')

  console.log('Telegram:')
  const tg = config.channels.telegram
  if (tg) {
    console.log(`  Bot token: ${tg.botToken.slice(0, 8)}...${tg.botToken.slice(-4)}`)
    console.log(`  Chat ID: ${tg.chatId}`)
  }

  console.log('\nAgents:')
  for (const [name, agent] of Object.entries(config.agents)) {
    const marker = name === config.defaultAgent ? ' (default)' : ''
    console.log(`  ${name}: ${agent.command}${marker}`)
  }

  console.log(`\nWorkspace: ${config.workspace.baseDir}`)

  console.log('\nSecurity:')
  const sec = config.security
  console.log(`  Allowed users: ${sec.allowedUserIds.length === 0 ? 'all' : sec.allowedUserIds.join(', ')}`)
  console.log(`  Max concurrent sessions: ${sec.maxConcurrentSessions}`)
  console.log(`  Session timeout: ${sec.sessionTimeoutMinutes} minutes`)
}

export async function runSetup(configManager: ConfigManager): Promise<boolean> {
  printWelcomeBanner()

  try {
    const telegram = await setupTelegram()
    const { agents, defaultAgent } = await setupAgents()
    const workspace = await setupWorkspace()
    const security = await setupSecurity()

    const config: Config = {
      channels: { telegram },
      agents,
      defaultAgent,
      workspace,
      security,
    }

    printConfigSummary(config)

    const confirmed = await confirm({ message: '\nSave this configuration?', default: true })
    if (!confirmed) {
      console.log('Setup cancelled. No config file was created.')
      return false
    }

    try {
      await configManager.writeNew(config)
    } catch (writeErr) {
      console.error(`\n✗ Failed to write config to ${configManager.getConfigPath()}`)
      console.error(`  Error: ${(writeErr as Error).message}`)
      console.error('  Check that you have write permissions to this path.')
      return false
    }
    console.log(`\n✓ Config saved to ${configManager.getConfigPath()}`)

    const shouldStart = await confirm({ message: 'Start OpenACP now?', default: true })
    return shouldStart
  } catch (err) {
    // Ctrl+C from inquirer throws ExitPromptError
    if ((err as Error).name === 'ExitPromptError') {
      console.log('\nSetup cancelled.')
      return false
    }
    throw err
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm --filter @openacp/core build
```
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/setup.ts
git commit -m "feat: add runSetup() orchestrator with welcome banner and config review"
```

---

### Task 7: Integrate setup into main.ts

**Files:**
- Modify: `packages/core/src/main.ts`

- [ ] **Step 1: Modify main.ts to detect missing config and call runSetup()**

In `packages/core/src/main.ts`, replace lines 9-15:

```typescript
// Before:
async function main() {
  // 1. Load config
  const configManager = new ConfigManager()
  await configManager.load()  // exits if config missing/invalid

  const config = configManager.get()
  log.info('Config loaded from', configManager['configPath'])
```

With:

```typescript
async function main() {
  // 1. Check config exists, run setup if not
  const configManager = new ConfigManager()
  const configExists = await configManager.exists()

  if (!configExists) {
    const { runSetup } = await import('./setup.js')
    const shouldStart = await runSetup(configManager)
    if (!shouldStart) process.exit(0)
  }

  // 2. Load config (validates with Zod)
  await configManager.load()
  const config = configManager.get()
  log.info('Config loaded from', configManager.getConfigPath())
```

Note: Also change `configManager['configPath']` to `configManager.getConfigPath()` since we now have the public method.

- [ ] **Step 2: Verify TypeScript compiles**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm --filter @openacp/core build
```
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/main.ts
git commit -m "feat: integrate interactive setup into main.ts for first-run detection"
```

---

### Task 8: Integration test for full setup flow

**Files:**
- Create: `packages/core/src/__tests__/setup-integration.test.ts`

- [ ] **Step 1: Write integration test that mocks prompts and validates full config output**

Create `packages/core/src/__tests__/setup-integration.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ConfigManager } from '../config.js'

// Mock @inquirer/prompts before importing setup
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  checkbox: vi.fn(),
}))

// Mock child_process for agent detection
vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === 'string' && cmd.includes('claude-agent-acp')) {
      return Buffer.from('/usr/local/bin/claude-agent-acp\n')
    }
    throw new Error('not found')
  }),
}))

import { input, confirm, select, checkbox } from '@inquirer/prompts'
import { runSetup } from '../setup.js'

const mockedInput = vi.mocked(input)
const mockedConfirm = vi.mocked(confirm)
const mockedSelect = vi.mocked(select)
const mockedCheckbox = vi.mocked(checkbox)

describe('runSetup integration', () => {
  let tmpDir: string
  let configPath: string
  const originalEnv = process.env.OPENACP_CONFIG_PATH

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-setup-'))
    configPath = path.join(tmpDir, 'config.json')
    process.env.OPENACP_CONFIG_PATH = configPath

    // Mock fetch for Telegram API validation
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/getMe')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            result: { first_name: 'TestBot', username: 'test_bot' },
          }),
        })
      }
      if (url.includes('/getChat')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            result: { title: 'Test Group', type: 'supergroup', is_forum: true },
          }),
        })
      }
      return Promise.reject(new Error('unexpected URL'))
    }))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalEnv === undefined) {
      delete process.env.OPENACP_CONFIG_PATH
    } else {
      process.env.OPENACP_CONFIG_PATH = originalEnv
    }
    vi.restoreAllMocks()
  })

  it('creates valid config file from user input and returns true when user wants to start', async () => {
    // Simulate user responses in order:
    let inputCallIndex = 0
    mockedInput.mockImplementation((() => {
      const responses = [
        '123:FAKE_TOKEN',    // bot token
        '-1001234567890',    // chat ID
        '~/my-workspace',   // workspace dir
        '',                 // allowed user IDs (empty = all)
        '3',                // max concurrent sessions
        '30',               // session timeout
      ]
      return Promise.resolve(responses[inputCallIndex++])
    }) as any)

    // checkbox: select detected agents
    mockedCheckbox.mockResolvedValue([{ name: 'claude', command: 'claude-agent-acp' }] as any)

    // confirm calls: "Add custom agent?" → no, "Save config?" → yes, "Start now?" → yes
    let confirmCallIndex = 0
    mockedConfirm.mockImplementation((() => {
      const responses = [false, true, true]
      return Promise.resolve(responses[confirmCallIndex++])
    }) as any)

    const cm = new ConfigManager()
    const shouldStart = await runSetup(cm)

    expect(shouldStart).toBe(true)
    expect(fs.existsSync(configPath)).toBe(true)

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(written.channels.telegram.enabled).toBe(true)
    expect(written.channels.telegram.botToken).toBe('123:FAKE_TOKEN')
    expect(written.channels.telegram.chatId).toBe(-1001234567890)
    expect(written.agents.claude.command).toBe('claude-agent-acp')
    expect(written.defaultAgent).toBe('claude')
    expect(written.workspace.baseDir).toBe('~/my-workspace')
    expect(written.security.maxConcurrentSessions).toBe(3)
    expect(written.security.sessionTimeoutMinutes).toBe(30)
  })

  it('returns false when user declines to save', async () => {
    let inputCallIndex = 0
    mockedInput.mockImplementation((() => {
      const responses = ['123:TOKEN', '-100123', '~', '', '5', '60']
      return Promise.resolve(responses[inputCallIndex++])
    }) as any)

    mockedCheckbox.mockResolvedValue([{ name: 'claude', command: 'claude-agent-acp' }] as any)

    let confirmCallIndex = 0
    mockedConfirm.mockImplementation((() => {
      const responses = [false, false] // no custom agent, decline save
      return Promise.resolve(responses[confirmCallIndex++])
    }) as any)

    const cm = new ConfigManager()
    const shouldStart = await runSetup(cm)

    expect(shouldStart).toBe(false)
    expect(fs.existsSync(configPath)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm --filter @openacp/core test
```
Expected: All tests PASS including the integration tests.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/__tests__/setup-integration.test.ts
git commit -m "test: add integration test for full setup flow with mocked prompts"
```

---

### Task 9: Manual end-to-end verification

This task verifies the full flow works by temporarily moving any existing config.

- [ ] **Step 1: Build the project**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm build
```

- [ ] **Step 2: Backup existing config if present**

Run:
```bash
[ -f ~/.openacp/config.json ] && mv ~/.openacp/config.json ~/.openacp/config.json.bak
```

- [ ] **Step 3: Run openacp to trigger setup wizard**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && node packages/core/dist/main.js
```

Expected: Welcome banner appears, setup wizard starts with Telegram token prompt.

- [ ] **Step 4: Walk through the wizard manually**

Verify:
- Bot token validation works (enter a real or fake token)
- Chat ID validation works
- Agent detection finds agents in PATH
- Workspace and security prompts work
- Config summary displays correctly
- Config is saved to `~/.openacp/config.json`
- "Start OpenACP now?" prompt works

- [ ] **Step 5: Restore original config**

Run:
```bash
[ -f ~/.openacp/config.json.bak ] && mv ~/.openacp/config.json.bak ~/.openacp/config.json
```

- [ ] **Step 6: Run existing tests to ensure nothing is broken**

Run:
```bash
cd /Users/lab3/Documents/lab3/OpenACP && pnpm --filter @openacp/core test
```
Expected: All tests pass.
