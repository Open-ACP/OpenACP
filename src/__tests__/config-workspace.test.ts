import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConfigManager, expandHome } from '../core/config.js'

describe('expandHome', () => {
  it('expands ~ to home directory', () => {
    const result = expandHome('~/test')
    expect(result).toBe(path.join(os.homedir(), 'test'))
  })

  it('does not modify absolute paths', () => {
    expect(expandHome('/absolute/path')).toBe('/absolute/path')
  })

  it('does not modify relative paths', () => {
    expect(expandHome('relative/path')).toBe('relative/path')
  })

  it('expands ~ at the start only', () => {
    const result = expandHome('~/Documents/code')
    expect(result).toBe(path.join(os.homedir(), 'Documents/code'))
  })
})

describe('ConfigManager.resolveWorkspace', () => {
  let configManager: ConfigManager
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-test-'))
    const configPath = path.join(tmpDir, 'config.json')
    process.env.OPENACP_CONFIG_PATH = configPath

    // Write a valid config
    const config = {
      channels: { telegram: { enabled: false, botToken: 'test', chatId: 0 } },
      defaultAgent: 'claude',
      workspace: { baseDir: path.join(tmpDir, 'workspace') },
      agents: {},
      security: { allowedUserIds: [], maxConcurrentSessions: 20, sessionTimeoutMinutes: 60 },
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

    configManager = new ConfigManager()
  })

  afterEach(() => {
    delete process.env.OPENACP_CONFIG_PATH
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resolves to baseDir when no input', async () => {
    await configManager.load()
    const result = configManager.resolveWorkspace()
    expect(result).toBe(path.join(tmpDir, 'workspace'))
    expect(fs.existsSync(result)).toBe(true)
  })

  it('resolves absolute path directly', async () => {
    await configManager.load()
    const absPath = path.join(tmpDir, 'custom-workspace')
    const result = configManager.resolveWorkspace(absPath)
    expect(result).toBe(absPath)
    expect(fs.existsSync(result)).toBe(true)
  })

  it('resolves tilde path', async () => {
    await configManager.load()
    const result = configManager.resolveWorkspace('~/test-workspace-openacp')
    expect(result).toBe(path.join(os.homedir(), 'test-workspace-openacp'))
    // Cleanup
    fs.rmSync(result, { recursive: true, force: true })
  })

  it('resolves named workspace under baseDir', async () => {
    await configManager.load()
    const result = configManager.resolveWorkspace('MyProject')
    expect(result).toBe(path.join(tmpDir, 'workspace', 'myproject'))
    expect(fs.existsSync(result)).toBe(true)
  })

  it('lowercases named workspace', async () => {
    await configManager.load()
    const result = configManager.resolveWorkspace('MyProject')
    expect(result).toContain('myproject')
    expect(result).not.toContain('MyProject')
  })

  it('creates directories recursively', async () => {
    await configManager.load()
    const result = configManager.resolveWorkspace()
    expect(fs.existsSync(result)).toBe(true)
  })
})

describe('ConfigManager.applyEnvOverrides', () => {
  let tmpDir: string

  function createConfigAndManager(config: Record<string, unknown>): ConfigManager {
    const configPath = path.join(tmpDir, 'config.json')
    process.env.OPENACP_CONFIG_PATH = configPath
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    return new ConfigManager()
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-env-test-'))
  })

  afterEach(() => {
    delete process.env.OPENACP_CONFIG_PATH
    delete process.env.OPENACP_TELEGRAM_BOT_TOKEN
    delete process.env.OPENACP_TELEGRAM_CHAT_ID
    delete process.env.OPENACP_DEFAULT_AGENT
    delete process.env.OPENACP_RUN_MODE
    delete process.env.OPENACP_API_PORT
    delete process.env.OPENACP_LOG_LEVEL
    delete process.env.OPENACP_LOG_DIR
    delete process.env.OPENACP_DEBUG
    delete process.env.OPENACP_TUNNEL_ENABLED
    delete process.env.OPENACP_TUNNEL_PORT
    delete process.env.OPENACP_TUNNEL_PROVIDER
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const baseConfig = {
    channels: { telegram: { enabled: false, botToken: 'test', chatId: 0 } },
    defaultAgent: 'claude',
    agents: {},
    security: { allowedUserIds: [], maxConcurrentSessions: 20, sessionTimeoutMinutes: 60 },
  }

  it('overrides defaultAgent from env', async () => {
    process.env.OPENACP_DEFAULT_AGENT = 'codex'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    expect(manager.get().defaultAgent).toBe('codex')
  })

  it('overrides Telegram bot token from env', async () => {
    process.env.OPENACP_TELEGRAM_BOT_TOKEN = 'env-token'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    const telegram = manager.get().channels.telegram as any
    expect(telegram.botToken).toBe('env-token')
  })

  it('overrides Telegram chat ID from env (as number)', async () => {
    process.env.OPENACP_TELEGRAM_CHAT_ID = '123456789'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    const telegram = manager.get().channels.telegram as any
    expect(telegram.chatId).toBe(123456789)
  })

  it('overrides runMode from env', async () => {
    process.env.OPENACP_RUN_MODE = 'daemon'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    expect(manager.get().runMode).toBe('daemon')
  })

  it('overrides API port from env (as number)', async () => {
    process.env.OPENACP_API_PORT = '9999'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    expect(manager.get().api.port).toBe(9999)
  })

  it('overrides log level from env', async () => {
    process.env.OPENACP_LOG_LEVEL = 'debug'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    expect(manager.get().logging.level).toBe('debug')
  })

  it('overrides log dir from env', async () => {
    process.env.OPENACP_LOG_DIR = '/tmp/custom-logs'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    expect(manager.get().logging.logDir).toBe('/tmp/custom-logs')
  })

  it('OPENACP_DEBUG sets log level to debug when OPENACP_LOG_LEVEL not set', async () => {
    process.env.OPENACP_DEBUG = '1'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    expect(manager.get().logging.level).toBe('debug')
  })

  it('OPENACP_DEBUG does NOT override explicit OPENACP_LOG_LEVEL', async () => {
    process.env.OPENACP_DEBUG = '1'
    process.env.OPENACP_LOG_LEVEL = 'warn'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    expect(manager.get().logging.level).toBe('warn')
  })

  it('overrides tunnel enabled from env', async () => {
    process.env.OPENACP_TUNNEL_ENABLED = 'true'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    expect(manager.get().tunnel.enabled).toBe(true)
  })

  it('overrides tunnel port from env', async () => {
    process.env.OPENACP_TUNNEL_PORT = '4000'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    expect(manager.get().tunnel.port).toBe(4000)
  })

  it('overrides tunnel provider from env', async () => {
    process.env.OPENACP_TUNNEL_PROVIDER = 'ngrok'
    const manager = createConfigAndManager(baseConfig)
    await manager.load()
    expect(manager.get().tunnel.provider).toBe('ngrok')
  })
})

describe('ConfigManager.save and hot-reload', () => {
  let configManager: ConfigManager
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-save-test-'))
    const configPath = path.join(tmpDir, 'config.json')
    process.env.OPENACP_CONFIG_PATH = configPath

    const config = {
      channels: { telegram: { enabled: false, botToken: 'test', chatId: 0 } },
      defaultAgent: 'claude',
      agents: {},
      security: { allowedUserIds: [], maxConcurrentSessions: 20, sessionTimeoutMinutes: 60 },
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    configManager = new ConfigManager()
    await configManager.load()
  })

  afterEach(() => {
    delete process.env.OPENACP_CONFIG_PATH
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('saves updates and persists to disk', async () => {
    await configManager.save({ defaultAgent: 'codex' })
    expect(configManager.get().defaultAgent).toBe('codex')

    // Verify on disk
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'))
    expect(raw.defaultAgent).toBe('codex')
  })

  it('emits config:changed event with path and value', async () => {
    const events: any[] = []
    configManager.on('config:changed', (e) => events.push(e))

    await configManager.save(
      { security: { maxConcurrentSessions: 10 } },
      'security.maxConcurrentSessions',
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      path: 'security.maxConcurrentSessions',
      value: 10,
    })
  })

  it('does not emit event when changePath not provided', async () => {
    const events: any[] = []
    configManager.on('config:changed', (e) => events.push(e))

    await configManager.save({ defaultAgent: 'codex' })

    expect(events).toHaveLength(0)
  })

  it('deep merges nested config', async () => {
    await configManager.save({ security: { maxConcurrentSessions: 5 } })
    // Other security fields should still exist
    expect(configManager.get().security.sessionTimeoutMinutes).toBe(60)
    expect(configManager.get().security.maxConcurrentSessions).toBe(5)
  })
})
