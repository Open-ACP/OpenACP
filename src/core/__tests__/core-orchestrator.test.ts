import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenACPCore } from '../core.js'
import type { ChannelAdapter } from '../channel.js'
import type { IncomingMessage } from '../types.js'

// Mock heavy dependencies
vi.mock('../agent-catalog.js', () => {
  const MockAgentCatalog = class {
    load = vi.fn()
    resolve = vi.fn().mockReturnValue({
      name: 'claude',
      command: 'claude-agent-acp',
      args: [],
      env: {},
    })
    refreshRegistryIfStale = vi.fn().mockResolvedValue(undefined)
    getInstalledEntries = vi.fn().mockReturnValue({
      claude: { command: 'claude-agent-acp', args: [], env: {} },
    })
  }
  return { AgentCatalog: MockAgentCatalog }
})

vi.mock('../session-store.js', () => {
  const MockJsonFileSessionStore = class {
    save = vi.fn().mockResolvedValue(undefined)
    get = vi.fn().mockReturnValue(undefined)
    findByPlatform = vi.fn().mockReturnValue(undefined)
    findByAgentSessionId = vi.fn().mockReturnValue(undefined)
    list = vi.fn().mockReturnValue([])
    remove = vi.fn().mockResolvedValue(undefined)
  }
  return { JsonFileSessionStore: MockJsonFileSessionStore }
})

vi.mock('../log.js', () => ({
  createChildLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createSessionLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

function mockConfigManager(config?: any) {
  const defaultConfig = {
    channels: { telegram: { enabled: true, botToken: 'test', chatId: 123 } },
    agents: { claude: { command: 'claude-agent-acp', args: [], env: {} } },
    defaultAgent: 'claude',
    workspace: { baseDir: '/tmp/workspace' },
    security: {
      allowedUserIds: [],
      maxConcurrentSessions: 5,
      sessionTimeoutMinutes: 60,
    },
    logging: { level: 'info', logDir: '/tmp/logs', maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 },
    runMode: 'foreground',
    autoStart: false,
    api: { port: 21420, host: '127.0.0.1' },
    sessionStore: { ttlDays: 30 },
    tunnel: { enabled: false, port: 3100, provider: 'cloudflare', options: {}, storeTtlMinutes: 60, auth: { enabled: false } },
    integrations: {},
  }

  return {
    get: vi.fn().mockReturnValue(config || defaultConfig),
    resolveWorkspace: vi.fn().mockReturnValue('/tmp/workspace'),
    on: vi.fn(),
    emit: vi.fn(),
  } as any
}

function mockAdapter(): ChannelAdapter {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPermissionRequest: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    createSessionThread: vi.fn().mockResolvedValue('thread-1'),
    renameSessionThread: vi.fn(),
    deleteSessionThread: vi.fn(),
    sendSkillCommands: vi.fn(),
    cleanupSkillCommands: vi.fn(),
  } as unknown as ChannelAdapter
}

describe('OpenACPCore', () => {
  let core: OpenACPCore
  let adapter: ChannelAdapter

  beforeEach(() => {
    core = new OpenACPCore(mockConfigManager())
    adapter = mockAdapter()
    core.registerAdapter('telegram', adapter)
  })

  describe('registerAdapter()', () => {
    it('adds adapter to map', () => {
      expect(core.adapters.get('telegram')).toBe(adapter)
    })

    it('can register multiple adapters', () => {
      const discord = mockAdapter()
      core.registerAdapter('discord', discord)
      expect(core.adapters.size).toBe(2)
    })
  })

  describe('handleMessage() - security checks', () => {
    it('allows all users when allowedUserIds is empty', async () => {
      // No sessions exist, so message will just not find a session
      const msg: IncomingMessage = {
        channelId: 'telegram',
        threadId: 'thread-1',
        userId: 'any-user',
        text: 'hello',
      }
      // Should not throw — just return (no session found)
      await core.handleMessage(msg)
    })

    it('rejects unauthorized users', async () => {
      const config = mockConfigManager({
        channels: { telegram: { enabled: true } },
        agents: {},
        defaultAgent: 'claude',
        workspace: { baseDir: '/tmp' },
        security: {
          allowedUserIds: ['user-1'],
          maxConcurrentSessions: 5,
          sessionTimeoutMinutes: 60,
        },
        sessionStore: { ttlDays: 30 },
        tunnel: { enabled: false, port: 3100, provider: 'cloudflare', options: {}, storeTtlMinutes: 60, auth: { enabled: false } },
        logging: { level: 'silent' },
        integrations: {},
      })
      const secureCore = new OpenACPCore(config)
      secureCore.registerAdapter('telegram', adapter)

      const msg: IncomingMessage = {
        channelId: 'telegram',
        threadId: 'thread-1',
        userId: 'unauthorized',
        text: 'hack',
      }

      await secureCore.handleMessage(msg)

      // Should not send any message (silently drops)
      expect(adapter.sendMessage).not.toHaveBeenCalled()
    })

    it('allows authorized users', async () => {
      const config = mockConfigManager({
        channels: { telegram: { enabled: true } },
        agents: {},
        defaultAgent: 'claude',
        workspace: { baseDir: '/tmp' },
        security: {
          allowedUserIds: ['user-1'],
          maxConcurrentSessions: 5,
          sessionTimeoutMinutes: 60,
        },
        sessionStore: { ttlDays: 30 },
        tunnel: { enabled: false, port: 3100, provider: 'cloudflare', options: {}, storeTtlMinutes: 60, auth: { enabled: false } },
        logging: { level: 'silent' },
        integrations: {},
      })
      const secureCore = new OpenACPCore(config)
      secureCore.registerAdapter('telegram', adapter)

      const msg: IncomingMessage = {
        channelId: 'telegram',
        threadId: 'thread-1',
        userId: 'user-1',
        text: 'hello',
      }

      // Should not throw (session won't be found but won't be blocked by auth)
      await secureCore.handleMessage(msg)
    })
  })

  describe('start()', () => {
    it('starts all adapters', async () => {
      await core.start()
      expect(adapter.start).toHaveBeenCalled()
    })

    it('starts multiple adapters', async () => {
      const discord = mockAdapter()
      core.registerAdapter('discord', discord)
      await core.start()
      expect(adapter.start).toHaveBeenCalled()
      expect(discord.start).toHaveBeenCalled()
    })
  })

  describe('stop()', () => {
    it('stops all adapters', async () => {
      await core.stop()
      expect(adapter.stop).toHaveBeenCalled()
    })

    it('sends shutdown notification', async () => {
      await core.stop()
      expect(adapter.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          summary: 'OpenACP is shutting down',
        }),
      )
    })
  })

  describe('tunnelService', () => {
    it('getter returns undefined by default', () => {
      expect(core.tunnelService).toBeUndefined()
    })

    it('setter updates messageTransformer', () => {
      const mockTunnel = { getStore: vi.fn() } as any
      core.tunnelService = mockTunnel
      expect(core.tunnelService).toBe(mockTunnel)
    })
  })

  describe('createBridge()', () => {
    it('returns a SessionBridge instance', () => {
      const mockSession = { id: 'test', on: vi.fn(), off: vi.fn() } as any
      const bridge = core.createBridge(mockSession, adapter)
      expect(bridge).toBeDefined()
    })
  })
})
