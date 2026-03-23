import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Session } from '../session.js'

function mockAgentInstance() {
  return {
    sessionId: 'agent-sess-1',
    prompt: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onSessionUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
  } as any
}

function createTestSession(agentInstance?: any) {
  return new Session({
    channelId: 'telegram',
    agentName: 'claude',
    workingDirectory: '/workspace',
    agentInstance: agentInstance || mockAgentInstance(),
  })
}

describe('Session - Lifecycle & Prompt Processing', () => {
  describe('constructor', () => {
    it('generates id when not provided', () => {
      const session = createTestSession()
      expect(session.id).toBeTruthy()
      expect(session.id.length).toBeGreaterThan(0)
    })

    it('uses provided id', () => {
      const session = new Session({
        id: 'custom-id',
        channelId: 'telegram',
        agentName: 'claude',
        workingDirectory: '/workspace',
        agentInstance: mockAgentInstance(),
      })
      expect(session.id).toBe('custom-id')
    })

    it('starts in initializing status', () => {
      const session = createTestSession()
      expect(session.status).toBe('initializing')
    })

    it('initializes with correct properties', () => {
      const session = createTestSession()
      expect(session.channelId).toBe('telegram')
      expect(session.agentName).toBe('claude')
      expect(session.workingDirectory).toBe('/workspace')
      expect(session.threadId).toBe('')
      expect(session.name).toBeUndefined()
      expect(session.dangerousMode).toBe(false)
    })
  })

  describe('enqueuePrompt()', () => {
    it('processes prompt through agent', async () => {
      const agent = mockAgentInstance()
      const session = createTestSession(agent)

      await session.enqueuePrompt('hello')

      expect(agent.prompt).toHaveBeenCalledWith('hello')
    })

    it('activates session on first user prompt from initializing', async () => {
      const session = createTestSession()
      const statusChanges: [string, string][] = []
      session.on('status_change', (from, to) => statusChanges.push([from, to]))

      await session.enqueuePrompt('hello')

      expect(session.status).toBe('active')
      expect(statusChanges).toContainEqual(['initializing', 'active'])
    })

    it('auto-names session after first prompt', async () => {
      const agent = mockAgentInstance()
      // Simulate agent responding with title during auto-name prompt
      agent.prompt.mockImplementation(async (text: string) => {
        if (text.includes('Summarize')) {
          // Simulate the onSessionUpdate being intercepted
          // The auto-name intercepts onSessionUpdate, so we need to call it
          agent.onSessionUpdate({ type: 'text', content: 'Test Title' })
        }
      })

      const session = createTestSession(agent)
      const names: string[] = []
      session.on('named', (name) => names.push(name))

      await session.enqueuePrompt('hello world')

      // Agent should have been called twice: once for user prompt, once for auto-name
      expect(agent.prompt).toHaveBeenCalledTimes(2)
      expect(agent.prompt).toHaveBeenCalledWith(
        expect.stringContaining('Summarize'),
      )
    })

    it('does not auto-name if already named', async () => {
      const agent = mockAgentInstance()
      const session = createTestSession(agent)
      session.name = 'Already Named'

      await session.enqueuePrompt('hello')

      // Only the user prompt, no auto-name
      expect(agent.prompt).toHaveBeenCalledTimes(1)
    })

    it('processes prompts serially through queue', async () => {
      const order: string[] = []
      let resolve1!: () => void
      const p1 = new Promise<void>((r) => { resolve1 = r })
      const agent = mockAgentInstance()
      agent.prompt.mockImplementation(async (text: string) => {
        order.push(`start:${text}`)
        if (text === 'first') await p1
        order.push(`end:${text}`)
      })

      const session = createTestSession(agent)
      session.name = 'skip-autoname' // prevent auto-name interfering

      const e1 = session.enqueuePrompt('first')
      const e2 = session.enqueuePrompt('second')

      expect(session.queueDepth).toBe(1)
      expect(session.promptRunning).toBe(true)

      resolve1()
      await Promise.all([e1, e2])

      expect(order).toEqual([
        'start:first', 'end:first',
        'start:second', 'end:second',
      ])
    })
  })

  describe('warmup()', () => {
    it('sends warmup prompt through queue', async () => {
      const agent = mockAgentInstance()
      const session = createTestSession(agent)

      await session.warmup()

      expect(agent.prompt).toHaveBeenCalledWith(
        expect.stringContaining('ready'),
      )
    })

    it('activates session after warmup', async () => {
      const session = createTestSession()

      await session.warmup()

      expect(session.status).toBe('active')
    })

    it('pauses events during warmup and clears buffer after', async () => {
      const agent = mockAgentInstance()
      const events: any[] = []
      const session = createTestSession(agent)

      session.on('agent_event', (e) => events.push(e))

      // Simulate agent emitting events during warmup
      agent.prompt.mockImplementation(async () => {
        session.emit('agent_event', { type: 'text', content: 'warmup noise' })
      })

      await session.warmup()

      // Warmup events should have been buffered and cleared
      // Events list should be empty since buffer was cleared before resume
      expect(events).toHaveLength(0)
    })

    it('lets commands_update pass through during warmup', async () => {
      const agent = mockAgentInstance()
      const events: any[] = []
      const session = createTestSession(agent)

      session.on('agent_event', (e) => events.push(e))

      agent.prompt.mockImplementation(async () => {
        // commands_update should pass through the pause filter
        session.emit('agent_event', { type: 'commands_update', commands: [] })
      })

      await session.warmup()

      // commands_update should have passed through
      expect(events.some(e => e.type === 'commands_update')).toBe(true)
    })

    it('handles warmup failure gracefully', async () => {
      const agent = mockAgentInstance()
      agent.prompt.mockRejectedValue(new Error('warmup failed'))

      const session = createTestSession(agent)

      // Should not throw
      await session.warmup()

      // Session should still be usable (resume calls resume -> unpause)
      expect(session.isPaused).toBe(false)
    })
  })

  describe('abortPrompt()', () => {
    it('clears queue and cancels agent', async () => {
      const agent = mockAgentInstance()
      const session = createTestSession(agent)
      session.activate()

      await session.abortPrompt()

      expect(agent.cancel).toHaveBeenCalled()
    })
  })

  describe('destroy()', () => {
    it('destroys agent instance', async () => {
      const agent = mockAgentInstance()
      const session = createTestSession(agent)

      await session.destroy()

      expect(agent.destroy).toHaveBeenCalled()
    })
  })

  describe('permissionGate', () => {
    it('exposes a PermissionGate instance', () => {
      const session = createTestSession()
      expect(session.permissionGate).toBeDefined()
      expect(session.permissionGate.isPending).toBe(false)
    })
  })

  describe('autoName edge cases', () => {
    it('falls back to session ID prefix if agent returns empty', async () => {
      const agent = mockAgentInstance()
      agent.prompt.mockResolvedValue(undefined) // Agent returns nothing for auto-name
      const session = createTestSession(agent)
      const names: string[] = []
      session.on('named', (n) => names.push(n))

      await session.enqueuePrompt('hello')

      // Name should be set to fallback
      expect(session.name).toBeTruthy()
      expect(session.name).toContain('Session')
    })

    it('truncates long names to 50 chars', async () => {
      const agent = mockAgentInstance()
      const longTitle = 'A'.repeat(100)
      agent.prompt.mockImplementation(async (text: string) => {
        if (text.includes('Summarize')) {
          agent.onSessionUpdate({ type: 'text', content: longTitle })
        }
      })

      const session = createTestSession(agent)
      await session.enqueuePrompt('hello')

      expect(session.name!.length).toBeLessThanOrEqual(50)
    })

    it('falls back if auto-name prompt throws', async () => {
      const agent = mockAgentInstance()
      let callCount = 0
      agent.prompt.mockImplementation(async (text: string) => {
        callCount++
        if (callCount === 2) throw new Error('auto-name error')
      })

      const session = createTestSession(agent)
      await session.enqueuePrompt('hello')

      expect(session.name).toContain('Session')
    })

    it('restores original onSessionUpdate after auto-name', async () => {
      const agent = mockAgentInstance()
      const originalHandler = agent.onSessionUpdate
      const session = createTestSession(agent)
      session.name = 'skip' // skip auto-name on first call

      // After processing, the handler should be the original
      await session.enqueuePrompt('hello')
      expect(agent.onSessionUpdate).toBe(originalHandler)
    })
  })
})
