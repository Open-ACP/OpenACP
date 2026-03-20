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

    vi.mocked(select)
      .mockResolvedValueOnce('workspace')
      .mockResolvedValueOnce('exit')

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
