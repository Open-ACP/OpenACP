import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SkillCommandManager } from '../adapters/telegram/skill-command-manager.js'
import type { AgentCommand } from '../core/types.js'

vi.mock('../adapters/telegram/commands/index.js', () => ({
  buildSkillMessages: vi.fn((commands: AgentCommand[]) =>
    commands.length > 0 ? [`<b>Skills:</b>\n${commands.map(c => `/${c.name}`).join('\n')}`] : [],
  ),
}))

vi.mock('../../core/log.js', () => ({
  createChildLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}))

function mockBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue({}),
      deleteMessage: vi.fn().mockResolvedValue(true),
      pinChatMessage: vi.fn().mockResolvedValue(true),
      unpinChatMessage: vi.fn().mockResolvedValue(true),
    },
  } as any
}

function mockSendQueue() {
  return {
    enqueue: vi.fn(async (fn: () => Promise<any>) => fn()),
  } as any
}

function mockSessionManager(records: Record<string, any> = {}) {
  return {
    getSessionRecord: vi.fn((id: string) => records[id]),
    patchRecord: vi.fn().mockResolvedValue(undefined),
  } as any
}

describe('SkillCommandManager', () => {
  let manager: SkillCommandManager
  let bot: ReturnType<typeof mockBot>
  let sessionManager: ReturnType<typeof mockSessionManager>

  beforeEach(() => {
    bot = mockBot()
    sessionManager = mockSessionManager()
    manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
  })

  describe('send()', () => {
    it('sends new skill commands message and pins it', async () => {
      const commands: AgentCommand[] = [
        { name: 'commit', description: 'Git commit' },
        { name: 'test', description: 'Run tests' },
      ]

      await manager.send('sess-1', 100, commands)

      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        12345,
        expect.stringContaining('/commit'),
        expect.objectContaining({
          message_thread_id: 100,
          parse_mode: 'HTML',
        }),
      )
      expect(bot.api.pinChatMessage).toHaveBeenCalledWith(12345, 42, expect.any(Object))
    })

    it('persists skillMsgId to session record', async () => {
      sessionManager.getSessionRecord.mockReturnValue({
        sessionId: 'sess-1',
        platform: { topicId: 100 },
      })

      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      expect(sessionManager.patchRecord).toHaveBeenCalledWith('sess-1', {
        platform: expect.objectContaining({ skillMsgId: 42 }),
      })
    })

    it('edits existing message instead of sending new one', async () => {
      // First send
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      // Second send — should edit
      await manager.send('sess-1', 100, [
        { name: 'test', description: 'Test' },
        { name: 'build', description: 'Build' },
      ])

      expect(bot.api.editMessageText).toHaveBeenCalledWith(
        12345,
        42,
        expect.stringContaining('/test'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      )
    })

    it('calls cleanup when commands is empty', async () => {
      // First send so there's a message
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      // Send empty — should cleanup
      await manager.send('sess-1', 100, [])

      expect(bot.api.editMessageText).toHaveBeenCalledWith(
        12345,
        42,
        expect.stringContaining('Session ended'),
        expect.any(Object),
      )
    })

    it('restores skillMsgId from persisted platform data', async () => {
      sessionManager.getSessionRecord.mockReturnValue({
        sessionId: 'sess-1',
        platform: { topicId: 100, skillMsgId: 99 },
      })

      // Update should use persisted msgId
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      expect(bot.api.editMessageText).toHaveBeenCalledWith(
        12345,
        99,
        expect.any(String),
        expect.any(Object),
      )
    })

    it('handles edit failure by sending new message', async () => {
      // First send
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      // Edit fails
      bot.api.editMessageText.mockRejectedValueOnce(new Error('message deleted'))

      await manager.send('sess-1', 100, [{ name: 'new', description: 'New' }])

      // Should have tried to delete old message and sent new one
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 42)
    })

    it('handles "message is not modified" error gracefully', async () => {
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      bot.api.editMessageText.mockRejectedValueOnce(new Error('message is not modified'))

      // Should not throw and should not send new message
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      // sendMessage should only have been called once (first time)
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    })
  })

  describe('cleanup()', () => {
    it('edits message to "Session ended" and unpins', async () => {
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      await manager.cleanup('sess-1')

      expect(bot.api.editMessageText).toHaveBeenCalledWith(
        12345,
        42,
        expect.stringContaining('Session ended'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      )
      expect(bot.api.unpinChatMessage).toHaveBeenCalledWith(12345, 42)
    })

    it('clears persisted skillMsgId', async () => {
      sessionManager.getSessionRecord.mockReturnValue({
        sessionId: 'sess-1',
        platform: { topicId: 100, skillMsgId: 42 },
      })

      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])
      await manager.cleanup('sess-1')

      expect(sessionManager.patchRecord).toHaveBeenCalledWith('sess-1', {
        platform: expect.not.objectContaining({ skillMsgId: expect.anything() }),
      })
    })

    it('does nothing when no message exists', async () => {
      await manager.cleanup('nonexistent')

      expect(bot.api.editMessageText).not.toHaveBeenCalled()
      expect(bot.api.unpinChatMessage).not.toHaveBeenCalled()
    })

    it('handles API errors gracefully', async () => {
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])
      bot.api.editMessageText.mockRejectedValueOnce(new Error('message deleted'))

      // Should not throw
      await manager.cleanup('sess-1')
    })
  })
})
