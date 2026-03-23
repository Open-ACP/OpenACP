import { describe, it, expect, vi } from 'vitest'
import { NotificationManager } from '../notification.js'
import type { ChannelAdapter } from '../channel.js'
import type { NotificationMessage } from '../types.js'

function mockAdapter(): ChannelAdapter {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn(),
    sendPermissionRequest: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    createSessionThread: vi.fn(),
    renameSessionThread: vi.fn(),
    deleteSessionThread: vi.fn(),
    sendSkillCommands: vi.fn(),
    cleanupSkillCommands: vi.fn(),
  } as unknown as ChannelAdapter
}

describe('NotificationManager', () => {
  const notification: NotificationMessage = {
    sessionId: 'sess-1',
    type: 'completed',
    summary: 'Test notification',
  }

  describe('notify()', () => {
    it('sends notification to specified adapter', async () => {
      const adapter = mockAdapter()
      const adapters = new Map([['telegram', adapter]])
      const manager = new NotificationManager(adapters)

      await manager.notify('telegram', notification)

      expect(adapter.sendNotification).toHaveBeenCalledWith(notification)
    })

    it('does nothing when adapter not found', async () => {
      const adapters = new Map<string, ChannelAdapter>()
      const manager = new NotificationManager(adapters)

      // Should not throw
      await manager.notify('unknown', notification)
    })

    it('does not notify other adapters', async () => {
      const telegram = mockAdapter()
      const discord = mockAdapter()
      const adapters = new Map([
        ['telegram', telegram],
        ['discord', discord],
      ])
      const manager = new NotificationManager(adapters)

      await manager.notify('telegram', notification)

      expect(telegram.sendNotification).toHaveBeenCalledWith(notification)
      expect(discord.sendNotification).not.toHaveBeenCalled()
    })
  })

  describe('notifyAll()', () => {
    it('sends notification to all adapters', async () => {
      const telegram = mockAdapter()
      const discord = mockAdapter()
      const adapters = new Map([
        ['telegram', telegram],
        ['discord', discord],
      ])
      const manager = new NotificationManager(adapters)

      await manager.notifyAll(notification)

      expect(telegram.sendNotification).toHaveBeenCalledWith(notification)
      expect(discord.sendNotification).toHaveBeenCalledWith(notification)
    })

    it('handles empty adapter map', async () => {
      const adapters = new Map<string, ChannelAdapter>()
      const manager = new NotificationManager(adapters)

      // Should not throw
      await manager.notifyAll(notification)
    })

    it('sends to single adapter when only one registered', async () => {
      const adapter = mockAdapter()
      const adapters = new Map([['telegram', adapter]])
      const manager = new NotificationManager(adapters)

      await manager.notifyAll(notification)

      expect(adapter.sendNotification).toHaveBeenCalledTimes(1)
    })
  })
})
