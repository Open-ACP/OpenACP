import { select, input } from '@inquirer/prompts'
import type { Config, ConfigManager } from './config.js'
import { validateBotToken, validateChatId } from './setup.js'
import { installAutoStart, uninstallAutoStart, isAutoStartInstalled, isAutoStartSupported } from './autostart.js'
import { expandHome } from './config.js'

// ANSI color helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
}

const ok = (msg: string) => `${c.green}${c.bold}✓${c.reset} ${c.green}${msg}${c.reset}`
const warn = (msg: string) => `${c.yellow}⚠ ${msg}${c.reset}`
const dim = (msg: string) => `${c.dim}${msg}${c.reset}`
const header = (title: string) => `\n${c.cyan}${c.bold}[${title}]${c.reset}\n`

type ConfigUpdates = Record<string, unknown>

// --- Edit: Telegram ---

async function editTelegram(config: Config, updates: ConfigUpdates): Promise<void> {
  const tg = (config.channels?.telegram ?? {}) as Record<string, unknown>
  const currentToken = (tg.botToken as string) ?? ''
  const currentChatId = (tg.chatId as number) ?? 0

  console.log(header('Telegram'))
  const tokenDisplay = currentToken.length > 12
    ? currentToken.slice(0, 6) + '...' + currentToken.slice(-6)
    : currentToken || dim('(not set)')
  console.log(`  Bot Token : ${tokenDisplay}`)
  console.log(`  Chat ID   : ${currentChatId || dim('(not set)')}`)
  console.log('')

  while (true) {
    const choice = await select({
      message: 'Telegram settings:',
      choices: [
        { name: 'Change Bot Token', value: 'token' },
        { name: 'Change Chat ID', value: 'chatid' },
        { name: 'Back', value: 'back' },
      ],
    })

    if (choice === 'back') break

    if (choice === 'token') {
      const token = await input({
        message: 'New bot token:',
        default: currentToken,
        validate: (val) => val.trim().length > 0 || 'Token cannot be empty',
      })

      const result = await validateBotToken(token.trim())
      if (result.ok) {
        console.log(ok(`Connected to @${result.botUsername}`))
      } else {
        console.log(warn(`Validation failed: ${result.error} — saving anyway`))
      }

      if (!updates.channels) updates.channels = {}
      if (!(updates.channels as Record<string, unknown>).telegram) {
        (updates.channels as Record<string, unknown>).telegram = {}
      }
      ;((updates.channels as Record<string, unknown>).telegram as Record<string, unknown>).botToken = token.trim()
    }

    if (choice === 'chatid') {
      const chatIdStr = await input({
        message: 'New chat ID (e.g. -1001234567890):',
        default: String(currentChatId),
        validate: (val) => {
          const n = Number(val.trim())
          if (isNaN(n) || !Number.isInteger(n)) return 'Chat ID must be an integer'
          return true
        },
      })

      const chatId = Number(chatIdStr.trim())

      // Use the current (or already-updated) token for validation
      const tokenForValidation = (() => {
        if (updates.channels) {
          const ch = updates.channels as Record<string, unknown>
          if (ch.telegram) {
            const tgUp = ch.telegram as Record<string, unknown>
            if (typeof tgUp.botToken === 'string') return tgUp.botToken
          }
        }
        return currentToken
      })()

      const result = await validateChatId(tokenForValidation, chatId)
      if (result.ok) {
        console.log(ok(`Group: ${result.title}${result.isForum ? '' : warn(' (topics not enabled)')}`))
      } else {
        console.log(warn(`Validation failed: ${result.error} — saving anyway`))
      }

      if (!updates.channels) updates.channels = {}
      if (!(updates.channels as Record<string, unknown>).telegram) {
        (updates.channels as Record<string, unknown>).telegram = {}
      }
      ;((updates.channels as Record<string, unknown>).telegram as Record<string, unknown>).chatId = chatId
    }
  }
}

// --- Edit: Agent ---

async function editAgent(config: Config, updates: ConfigUpdates): Promise<void> {
  const agentNames = Object.keys(config.agents ?? {})
  const currentDefault = config.defaultAgent

  console.log(header('Agent'))
  console.log(`  Default agent : ${c.bold}${currentDefault}${c.reset}`)
  console.log(`  Available     : ${agentNames.join(', ') || dim('(none)')}`)
  console.log('')

  while (true) {
    const choice = await select({
      message: 'Agent settings:',
      choices: [
        { name: 'Change default agent', value: 'default' },
        { name: 'Back', value: 'back' },
      ],
    })

    if (choice === 'back') break

    if (choice === 'default') {
      if (agentNames.length === 0) {
        console.log(warn('No agents configured.'))
        continue
      }

      const chosen = await select({
        message: 'Select default agent:',
        choices: agentNames.map((name) => ({ name, value: name })),
      })

      updates.defaultAgent = chosen
      console.log(ok(`Default agent set to ${chosen}`))
    }
  }
}

// --- Edit: Workspace ---

async function editWorkspace(config: Config, updates: ConfigUpdates): Promise<void> {
  const currentDir = config.workspace?.baseDir ?? '~/openacp-workspace'

  console.log(header('Workspace'))
  console.log(`  Base directory : ${currentDir}`)
  console.log('')

  const newDir = await input({
    message: 'Workspace base directory:',
    default: currentDir,
    validate: (val) => val.trim().length > 0 || 'Path cannot be empty',
  })

  updates.workspace = { baseDir: newDir.trim() }
  console.log(ok(`Workspace set to ${newDir.trim()}`))
}

// --- Edit: Security ---

async function editSecurity(config: Config, updates: ConfigUpdates): Promise<void> {
  const sec = config.security ?? { allowedUserIds: [], maxConcurrentSessions: 20, sessionTimeoutMinutes: 60 }

  console.log(header('Security'))
  console.log(`  Allowed user IDs        : ${sec.allowedUserIds?.length ? sec.allowedUserIds.join(', ') : dim('(all users allowed)')}`)
  console.log(`  Max concurrent sessions : ${sec.maxConcurrentSessions}`)
  console.log(`  Session timeout (min)   : ${sec.sessionTimeoutMinutes}`)
  console.log('')

  while (true) {
    const choice = await select({
      message: 'Security settings:',
      choices: [
        { name: 'Max concurrent sessions', value: 'maxSessions' },
        { name: 'Session timeout (minutes)', value: 'timeout' },
        { name: 'Back', value: 'back' },
      ],
    })

    if (choice === 'back') break

    if (choice === 'maxSessions') {
      const val = await input({
        message: 'Max concurrent sessions:',
        default: String(sec.maxConcurrentSessions),
        validate: (v) => {
          const n = Number(v.trim())
          if (!Number.isInteger(n) || n < 1) return 'Must be a positive integer'
          return true
        },
      })

      if (!updates.security) updates.security = {}
      ;(updates.security as Record<string, unknown>).maxConcurrentSessions = Number(val.trim())
      console.log(ok(`Max concurrent sessions set to ${val.trim()}`))
    }

    if (choice === 'timeout') {
      const val = await input({
        message: 'Session timeout in minutes:',
        default: String(sec.sessionTimeoutMinutes),
        validate: (v) => {
          const n = Number(v.trim())
          if (!Number.isInteger(n) || n < 1) return 'Must be a positive integer'
          return true
        },
      })

      if (!updates.security) updates.security = {}
      ;(updates.security as Record<string, unknown>).sessionTimeoutMinutes = Number(val.trim())
      console.log(ok(`Session timeout set to ${val.trim()} minutes`))
    }
  }
}

// --- Edit: Logging ---

async function editLogging(config: Config, updates: ConfigUpdates): Promise<void> {
  const logging = config.logging ?? { level: 'info', logDir: '~/.openacp/logs', maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 }

  console.log(header('Logging'))
  console.log(`  Log level : ${logging.level}`)
  console.log(`  Log dir   : ${logging.logDir}`)
  console.log('')

  while (true) {
    const choice = await select({
      message: 'Logging settings:',
      choices: [
        { name: 'Log level', value: 'level' },
        { name: 'Log directory', value: 'logDir' },
        { name: 'Back', value: 'back' },
      ],
    })

    if (choice === 'back') break

    if (choice === 'level') {
      const level = await select({
        message: 'Select log level:',
        choices: [
          { name: 'silent', value: 'silent' },
          { name: 'debug', value: 'debug' },
          { name: 'info', value: 'info' },
          { name: 'warn', value: 'warn' },
          { name: 'error', value: 'error' },
          { name: 'fatal', value: 'fatal' },
        ],
      })

      if (!updates.logging) updates.logging = {}
      ;(updates.logging as Record<string, unknown>).level = level
      console.log(ok(`Log level set to ${level}`))
    }

    if (choice === 'logDir') {
      const dir = await input({
        message: 'Log directory:',
        default: logging.logDir,
        validate: (val) => val.trim().length > 0 || 'Path cannot be empty',
      })

      if (!updates.logging) updates.logging = {}
      ;(updates.logging as Record<string, unknown>).logDir = dir.trim()
      console.log(ok(`Log directory set to ${dir.trim()}`))
    }
  }
}

// --- Edit: Run Mode ---

async function editRunMode(config: Config, updates: ConfigUpdates): Promise<void> {
  const currentMode = config.runMode ?? 'foreground'
  const currentAutoStart = config.autoStart ?? false
  const autoStartInstalled = isAutoStartInstalled()
  const autoStartSupported = isAutoStartSupported()

  console.log(header('Run Mode'))
  console.log(`  Current mode : ${c.bold}${currentMode}${c.reset}`)
  console.log(`  Auto-start   : ${currentAutoStart ? ok('enabled') : dim('disabled')}${autoStartInstalled ? ` ${dim('(installed)')}` : ''}`)
  console.log('')

  while (true) {
    const isDaemon = (() => {
      if ('runMode' in updates) return updates.runMode === 'daemon'
      return currentMode === 'daemon'
    })()

    const choices = [
      isDaemon
        ? { name: 'Switch to foreground mode', value: 'foreground' }
        : { name: 'Switch to daemon mode', value: 'daemon' },
    ]

    if (autoStartSupported) {
      const autoStartCurrent = (() => {
        if ('autoStart' in updates) return updates.autoStart as boolean
        return currentAutoStart
      })()
      choices.push({
        name: autoStartCurrent ? 'Disable auto-start' : 'Enable auto-start',
        value: 'toggleAutoStart',
      })
    }

    choices.push({ name: 'Back', value: 'back' })

    const choice = await select({
      message: 'Run mode settings:',
      choices,
    })

    if (choice === 'back') break

    if (choice === 'daemon') {
      updates.runMode = 'daemon'
      const logDir = (config.logging?.logDir) ?? '~/.openacp/logs'
      const result = installAutoStart(expandHome(logDir))
      if (result.success) {
        updates.autoStart = true
        console.log(ok('Switched to daemon mode with auto-start'))
      } else {
        console.log(warn(`Switched to daemon mode (auto-start failed: ${result.error})`))
      }
    }

    if (choice === 'foreground') {
      updates.runMode = 'foreground'
      updates.autoStart = false
      uninstallAutoStart()
      console.log(ok('Switched to foreground mode'))
    }

    if (choice === 'toggleAutoStart') {
      const autoStartCurrent = (() => {
        if ('autoStart' in updates) return updates.autoStart as boolean
        return currentAutoStart
      })()

      if (autoStartCurrent) {
        const result = uninstallAutoStart()
        updates.autoStart = false
        if (result.success) {
          console.log(ok('Auto-start disabled'))
        } else {
          console.log(warn(`Auto-start uninstall failed: ${result.error}`))
        }
      } else {
        const logDir = (config.logging?.logDir) ?? '~/.openacp/logs'
        const result = installAutoStart(expandHome(logDir))
        updates.autoStart = result.success
        if (result.success) {
          console.log(ok('Auto-start enabled'))
        } else {
          console.log(warn(`Auto-start install failed: ${result.error}`))
        }
      }
    }
  }
}

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

// --- Edit: Tunnel ---

async function editTunnel(config: Config, updates: ConfigUpdates): Promise<void> {
  const tunnel = config.tunnel ?? { enabled: false, port: 3100, provider: 'cloudflare', options: {}, storeTtlMinutes: 60, auth: { enabled: false } }
  const currentUpdates = (updates.tunnel ?? {}) as Record<string, unknown>

  const getVal = <T>(key: string, fallback: T): T =>
    (key in currentUpdates ? currentUpdates[key] : (tunnel as Record<string, unknown>)[key] ?? fallback) as T

  console.log(header('Tunnel'))
  console.log(`  Enabled  : ${getVal('enabled', false) ? ok('yes') : dim('no')}`)
  console.log(`  Provider : ${c.bold}${getVal('provider', 'cloudflare')}${c.reset}`)
  console.log(`  Port     : ${getVal('port', 3100)}`)
  const authEnabled = (getVal('auth', { enabled: false }) as { enabled: boolean }).enabled
  console.log(`  Auth     : ${authEnabled ? ok('enabled') : dim('disabled')}`)
  console.log('')

  while (true) {
    const choice = await select({
      message: 'Tunnel settings:',
      choices: [
        { name: getVal('enabled', false) ? 'Disable tunnel' : 'Enable tunnel', value: 'toggle' },
        { name: 'Change provider', value: 'provider' },
        { name: 'Change port', value: 'port' },
        { name: 'Provider options', value: 'options' },
        { name: authEnabled ? 'Disable auth' : 'Enable auth', value: 'auth' },
        { name: 'Back', value: 'back' },
      ],
    })

    if (choice === 'back') break

    if (!updates.tunnel) updates.tunnel = { ...tunnel }
    const tun = updates.tunnel as Record<string, unknown>

    if (choice === 'toggle') {
      const current = getVal('enabled', false)
      tun.enabled = !current
      console.log(!current ? ok('Tunnel enabled') : ok('Tunnel disabled'))
    }

    if (choice === 'provider') {
      const provider = await select({
        message: 'Select tunnel provider:',
        choices: [
          { name: 'Cloudflare (default)', value: 'cloudflare' },
          { name: 'ngrok', value: 'ngrok' },
          { name: 'bore', value: 'bore' },
          { name: 'Tailscale Funnel', value: 'tailscale' },
        ],
      })
      tun.provider = provider
      tun.options = {} // reset options when switching provider
      console.log(ok(`Provider set to ${provider}`))
    }

    if (choice === 'port') {
      const val = await input({
        message: 'Tunnel port:',
        default: String(getVal('port', 3100)),
        validate: (v) => {
          const n = Number(v.trim())
          if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Must be a valid port (1-65535)'
          return true
        },
      })
      tun.port = Number(val.trim())
      console.log(ok(`Tunnel port set to ${val.trim()}`))
    }

    if (choice === 'options') {
      const provider = getVal('provider', 'cloudflare')
      const currentOptions = getVal('options', {}) as Record<string, unknown>
      await editProviderOptions(provider, currentOptions, tun)
    }

    if (choice === 'auth') {
      const currentAuth = getVal('auth', { enabled: false }) as { enabled: boolean; token?: string }
      if (currentAuth.enabled) {
        tun.auth = { enabled: false }
        console.log(ok('Tunnel auth disabled'))
      } else {
        const token = await input({
          message: 'Auth token (leave empty to auto-generate):',
          default: '',
        })
        tun.auth = token.trim()
          ? { enabled: true, token: token.trim() }
          : { enabled: true }
        console.log(ok('Tunnel auth enabled'))
      }
    }
  }
}

async function editProviderOptions(
  provider: string,
  currentOptions: Record<string, unknown>,
  tun: Record<string, unknown>,
): Promise<void> {
  if (provider === 'cloudflare') {
    const domain = await input({
      message: 'Custom domain (leave empty for random):',
      default: (currentOptions.domain as string) ?? '',
    })
    tun.options = domain.trim() ? { domain: domain.trim() } : {}
    if (domain.trim()) console.log(ok(`Domain set to ${domain.trim()}`))
    else console.log(dim('Using random cloudflare domain'))
  } else if (provider === 'ngrok') {
    const authtoken = await input({
      message: 'ngrok authtoken (leave empty to skip):',
      default: (currentOptions.authtoken as string) ?? '',
    })
    const domain = await input({
      message: 'ngrok domain (leave empty for random):',
      default: (currentOptions.domain as string) ?? '',
    })
    const region = await input({
      message: 'ngrok region (us, eu, ap — leave empty for default):',
      default: (currentOptions.region as string) ?? '',
    })
    const opts: Record<string, string> = {}
    if (authtoken.trim()) opts.authtoken = authtoken.trim()
    if (domain.trim()) opts.domain = domain.trim()
    if (region.trim()) opts.region = region.trim()
    tun.options = opts
    console.log(ok('ngrok options saved'))
  } else if (provider === 'bore') {
    const server = await input({
      message: 'bore server:',
      default: (currentOptions.server as string) ?? 'bore.pub',
    })
    const port = await input({
      message: 'bore port (leave empty for auto):',
      default: currentOptions.port ? String(currentOptions.port) : '',
    })
    const secret = await input({
      message: 'bore secret (leave empty to skip):',
      default: (currentOptions.secret as string) ?? '',
    })
    const opts: Record<string, unknown> = { server: server.trim() }
    if (port.trim()) opts.port = Number(port.trim())
    if (secret.trim()) opts.secret = secret.trim()
    tun.options = opts
    console.log(ok('bore options saved'))
  } else if (provider === 'tailscale') {
    const bg = await select({
      message: 'Run Tailscale Funnel in background?',
      choices: [
        { name: 'No', value: 'no' },
        { name: 'Yes', value: 'yes' },
      ],
    })
    tun.options = bg === 'yes' ? { bg: true } : {}
    console.log(ok('Tailscale options saved'))
  } else {
    console.log(dim(`No configurable options for provider "${provider}"`))
  }
}

// --- Main Config Editor ---

export async function runConfigEditor(
  configManager: ConfigManager,
  mode: 'file' | 'api' = 'file',
  apiPort?: number,
): Promise<void> {
  await configManager.load()
  const config = configManager.get()
  const updates: ConfigUpdates = {}

  console.log(`\n${c.cyan}${c.bold}OpenACP Config Editor${c.reset}`)
  console.log(dim(`Config: ${configManager.getConfigPath()}`))
  console.log('')

  try {
    while (true) {
      const hasChanges = mode === 'file' ? Object.keys(updates).length > 0 : false
      const choice = await select({
        message: `What would you like to edit?${hasChanges ? ` ${c.yellow}(unsaved changes)${c.reset}` : ''}`,
        choices: [
          { name: 'Telegram', value: 'telegram' },
          { name: 'Agent', value: 'agent' },
          { name: 'Workspace', value: 'workspace' },
          { name: 'Security', value: 'security' },
          { name: 'Logging', value: 'logging' },
          { name: 'Run Mode', value: 'runMode' },
          { name: 'API', value: 'api' },
          { name: 'Tunnel', value: 'tunnel' },
          { name: hasChanges ? 'Save & Exit' : 'Exit', value: 'exit' },
        ],
      })

      if (choice === 'exit') {
        if (mode === 'file' && hasChanges) {
          await configManager.save(updates)
          console.log(ok(`Config saved to ${configManager.getConfigPath()}`))
        } else if (mode === 'file') {
          console.log(dim('No changes made.'))
        }
        break
      }

      const sectionUpdates: ConfigUpdates = {}

      if (choice === 'telegram') await editTelegram(config, sectionUpdates)
      else if (choice === 'agent') await editAgent(config, sectionUpdates)
      else if (choice === 'workspace') await editWorkspace(config, sectionUpdates)
      else if (choice === 'security') await editSecurity(config, sectionUpdates)
      else if (choice === 'logging') await editLogging(config, sectionUpdates)
      else if (choice === 'runMode') await editRunMode(config, sectionUpdates)
      else if (choice === 'api') await editApi(config, sectionUpdates)
      else if (choice === 'tunnel') await editTunnel(config, sectionUpdates)

      if (mode === 'api' && Object.keys(sectionUpdates).length > 0) {
        await sendConfigViaApi(apiPort!, sectionUpdates)
        // Refresh in-memory config
        await configManager.load()
        Object.assign(config, configManager.get())
      } else {
        // Accumulate for file mode
        Object.assign(updates, sectionUpdates)
      }
    }
  } catch (err) {
    if ((err as Error).name === 'ExitPromptError') {
      console.log(dim('\nConfig editor cancelled. Changes discarded.'))
      return
    }
    throw err
  }
}

async function sendConfigViaApi(port: number, updates: ConfigUpdates): Promise<void> {
  const { apiCall: call } = await import('./api-client.js')

  const paths = flattenToPaths(updates)
  for (const { path, value } of paths) {
    const res = await call(port, '/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, value }),
    })
    const data = await res.json() as Record<string, unknown>
    if (!res.ok) {
      console.log(warn(`Failed to update ${path}: ${data.error}`))
    } else if (data.needsRestart) {
      console.log(warn(`${path} updated — restart required`))
    }
  }
}

function flattenToPaths(obj: Record<string, unknown>, prefix = ''): Array<{ path: string; value: unknown }> {
  const result: Array<{ path: string; value: unknown }> = []
  for (const [key, val] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      result.push(...flattenToPaths(val as Record<string, unknown>, fullPath))
    } else {
      result.push({ path: fullPath, value: val })
    }
  }
  return result
}
