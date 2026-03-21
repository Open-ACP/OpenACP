import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ConfigManager } from '../core/config.js'

// Mock @inquirer/prompts before importing setup
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}))

// Mock child_process for agent detection
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_cmd: string, args?: string[]) => {
    if (args && args[0] === 'claude-agent-acp') {
      return Buffer.from('/usr/local/bin/claude-agent-acp\n')
    }
    throw new Error('not found')
  }),
}))

// Mock autostart module
vi.mock('../core/autostart.js', () => ({
  isAutoStartSupported: vi.fn(() => false),
  installAutoStart: vi.fn(() => ({ success: true })),
}))

import { input, select, confirm } from '@inquirer/prompts'
import { runSetup } from '../core/setup.js'

const mockedInput = vi.mocked(input)
const mockedSelect = vi.mocked(select)
const mockedConfirm = vi.mocked(confirm)

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
            result: { id: 123456, first_name: 'TestBot', username: 'test_bot' },
          }),
        })
      }
      if (url.includes('/getChatMember')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            result: { status: 'administrator' },
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
      if (url.includes('/getUpdates')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  chat: { id: -1001234567890, title: 'Test Group', type: 'supergroup' },
                },
              },
            ],
          }),
        })
      }
      return Promise.reject(new Error(`unexpected URL: ${url}`))
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

  it('creates valid config file and auto-starts', async () => {
    // Input call order:
    // 1. setupTelegram: bot token
    // 2. setupWorkspace: workspace base dir
    let inputCallIndex = 0
    mockedInput.mockImplementation((() => {
      const responses = [
        '123:FAKE_TOKEN',    // bot token
        '~/my-workspace',   // workspace dir
      ]
      return Promise.resolve(responses[inputCallIndex++])
    }) as any)

    // Confirm call order:
    // 1. Claude CLI integration prompt (decline to avoid needing ClaudeIntegration mock)
    mockedConfirm.mockResolvedValueOnce(false as any)

    // Select call order:
    // 1. setupRunMode: run mode selection
    mockedSelect.mockResolvedValueOnce('foreground' as any)

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
    expect(written.security.maxConcurrentSessions).toBe(20)
    expect(written.security.sessionTimeoutMinutes).toBe(60)
  })
})
