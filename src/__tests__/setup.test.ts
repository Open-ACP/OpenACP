import { describe, it, expect, vi, afterEach } from 'vitest'
import * as child_process from 'node:child_process'
import * as fs from 'node:fs'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, existsSync: vi.fn(() => false) }
})

import { validateBotToken, validateChatId, detectAgents, validateAgentCommand } from '../core/setup.js'

const mockedExecFileSync = vi.mocked(child_process.execFileSync)
const mockedExistsSync = vi.mocked(fs.existsSync)

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
    mockedExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
      if (args && args[0] === 'claude-agent-acp') {
        return Buffer.from('/usr/local/bin/claude-agent-acp\n')
      }
      throw new Error('not found')
    })

    const agents = await detectAgents()
    expect(agents.some(a => a.command === 'claude-agent-acp')).toBe(true)
  })

  it('returns empty array when no agents found', async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })
    mockedExistsSync.mockReturnValue(false)

    const agents = await detectAgents()
    expect(agents).toEqual([])
  })
})

describe('validateAgentCommand', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('returns true when command exists', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('/usr/bin/node\n'))

    const result = await validateAgentCommand('node')
    expect(result).toBe(true)
  })

  it('returns false when command does not exist', async () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('not found') })

    const result = await validateAgentCommand('nonexistent-bin')
    expect(result).toBe(false)
  })
})
