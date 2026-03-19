import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { input, select } from '@inquirer/prompts'
import type { Config, ConfigManager } from './config.js'

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

// Commands listed in priority order — first match wins per agent
const KNOWN_AGENTS: Array<{ name: string; commands: string[] }> = [
  { name: 'claude', commands: ['claude-agent-acp', 'claude-code', 'claude'] },
  { name: 'codex', commands: ['codex'] },
]

function commandExists(cmd: string): boolean {
  // Check system PATH
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' })
    return true
  } catch {
    // not in PATH
  }
  // Check node_modules/.bin (walks up from cwd)
  let dir = process.cwd()
  while (true) {
    const binPath = path.join(dir, 'node_modules', '.bin', cmd)
    if (fs.existsSync(binPath)) return true
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return false
}

export async function detectAgents(): Promise<Array<{ name: string; command: string }>> {
  const found: Array<{ name: string; command: string }> = []
  for (const agent of KNOWN_AGENTS) {
    // Find all available commands for this agent (PATH + node_modules/.bin)
    const available: string[] = []
    for (const cmd of agent.commands) {
      if (commandExists(cmd)) {
        available.push(cmd)
      }
    }
    if (available.length > 0) {
      // Prefer claude-agent-acp over claude/claude-code (priority order)
      const preferred = available[0]
      found.push({ name: agent.name, command: preferred })
    }
  }
  return found
}

export async function validateAgentCommand(command: string): Promise<boolean> {
  try {
    execFileSync('which', [command], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// --- Setup steps ---

export async function setupTelegram(): Promise<Config['channels'][string]> {
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
      if (!result.isForum) {
        console.log(`⚠ Warning: "${result.title}" does not have Topics enabled.`)
        console.log('  Please enable Topics in group settings → Topics → Enable.')
      } else {
        console.log(`✓ Connected to "${result.title}" (Topics enabled)`)
      }
      break
    }
    console.log(`✗ Validation failed: ${result.error}`)
    if (result.error.includes('must be a supergroup')) {
      console.log('  Tip: Create a Supergroup in Telegram, then enable Topics in group settings.')
    }
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

export async function setupAgents(): Promise<{ agents: Config['agents']; defaultAgent: string }> {
  console.log('\n--- Step 2: Agent Setup ---\n')

  console.log('Detecting agents in PATH...')
  const detected = await detectAgents()

  const agents: Config['agents'] = {}

  if (detected.length > 0) {
    for (const agent of detected) {
      agents[agent.name] = { command: agent.command, args: [], env: {} }
    }
    console.log(`Found: ${detected.map(a => `${a.name} (${a.command})`).join(', ')}`)
  } else {
    // Fallback to claude-agent-acp as default
    agents['claude'] = { command: 'claude-agent-acp', args: [], env: {} }
    console.log('No agents detected. Using default: claude (claude-agent-acp)')
  }

  const defaultAgent = Object.keys(agents)[0]
  console.log(`Default agent: ${defaultAgent}`)

  return { agents, defaultAgent }
}

export async function setupWorkspace(): Promise<{ baseDir: string }> {
  console.log('\n--- Step 3: Workspace Setup ---\n')

  const baseDir = await input({
    message: 'Workspace base directory:',
    default: '~/openacp-workspace',
    validate: (val) => val.trim().length > 0 || 'Path cannot be empty',
  })

  return { baseDir: baseDir.trim() }
}

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

// --- Orchestrator ---

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
  const tg = config.channels.telegram as Record<string, any> | undefined
  if (tg) {
    const token = String(tg.botToken || '')
    console.log(`  Bot token: ${token.slice(0, 8)}...${token.slice(-4)}`)
    console.log(`  Chat ID: ${tg.chatId}`)
  }

  console.log('\nAgents:')
  for (const [name, agent] of Object.entries(config.agents)) {
    const marker = name === config.defaultAgent ? ' (default)' : ''
    console.log(`  ${name}: ${agent.command}${marker}`)
  }

  console.log(`\nWorkspace: ${config.workspace.baseDir}`)
}

export async function runSetup(configManager: ConfigManager): Promise<boolean> {
  printWelcomeBanner()

  try {
    const telegram = await setupTelegram()
    const { agents, defaultAgent } = await setupAgents()
    const workspace = await setupWorkspace()
    const security = { allowedUserIds: [] as string[], maxConcurrentSessions: 5, sessionTimeoutMinutes: 60 }

    const config: Config = {
      channels: { telegram },
      agents,
      defaultAgent,
      workspace,
      security,
    }

    printConfigSummary(config)

    try {
      await configManager.writeNew(config)
    } catch (writeErr) {
      console.error(`\n✗ Failed to write config to ${configManager.getConfigPath()}`)
      console.error(`  Error: ${(writeErr as Error).message}`)
      console.error('  Check that you have write permissions to this path.')
      return false
    }
    console.log(`\n✓ Config saved to ${configManager.getConfigPath()}`)
    console.log('Starting OpenACP...\n')

    return true
  } catch (err) {
    // Ctrl+C from inquirer throws ExitPromptError
    if ((err as Error).name === 'ExitPromptError') {
      console.log('\nSetup cancelled.')
      return false
    }
    throw err
  }
}
