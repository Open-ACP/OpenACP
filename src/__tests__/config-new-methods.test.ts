import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ConfigManager } from '../core/config.js'

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
