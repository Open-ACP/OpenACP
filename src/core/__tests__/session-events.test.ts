import { describe, it, expect, vi } from 'vitest'
import { Session } from '../session.js'
import type { AgentEvent, PermissionRequest } from '../types.js'
import type { AgentInstance } from '../agent-instance.js'

/** Minimal mock AgentInstance for testing Session event wiring */
function createMockAgentInstance(): AgentInstance {
  return {
    sessionId: 'agent-session-1',
    agentName: 'test-agent',
    prompt: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentInstance
}

function createSession(overrides?: Partial<ConstructorParameters<typeof Session>[0]>): Session {
  return new Session({
    channelId: 'test-channel',
    agentName: 'test-agent',
    workingDirectory: '/tmp/test',
    agentInstance: createMockAgentInstance(),
    ...overrides,
  })
}

describe('Session events', () => {
  it('emits agent_event to registered listeners', () => {
    const session = createSession()
    const handler = vi.fn()
    session.on('agent_event', handler)

    const event: AgentEvent = { type: 'text', content: 'hello' }
    session.emit('agent_event', event)

    expect(handler).toHaveBeenCalledWith(event)
  })

  it('emits permission_request to registered listeners', () => {
    const session = createSession()
    const handler = vi.fn()
    session.on('permission_request', handler)

    const request: PermissionRequest = {
      id: 'req-1',
      description: 'Allow file write?',
      options: [{ id: 'yes', label: 'Allow', isAllow: true }],
    }
    session.emit('permission_request', request)

    expect(handler).toHaveBeenCalledWith(request)
  })

  it('emits session_end event', () => {
    const session = createSession()
    const handler = vi.fn()
    session.on('session_end', handler)

    session.emit('session_end', 'user_cancelled')

    expect(handler).toHaveBeenCalledWith('user_cancelled')
  })

  it('emits error event', () => {
    const session = createSession()
    const handler = vi.fn()
    session.on('error', handler)

    const err = new Error('test error')
    session.emit('error', err)

    expect(handler).toHaveBeenCalledWith(err)
  })

  it('supports multiple listeners', () => {
    const session = createSession()
    const h1 = vi.fn()
    const h2 = vi.fn()
    session.on('agent_event', h1)
    session.on('agent_event', h2)

    const event: AgentEvent = { type: 'text', content: 'multi' }
    session.emit('agent_event', event)

    expect(h1).toHaveBeenCalledWith(event)
    expect(h2).toHaveBeenCalledWith(event)
  })

  it('off() removes a specific listener', () => {
    const session = createSession()
    const handler = vi.fn()
    session.on('agent_event', handler)
    session.off('agent_event', handler)

    session.emit('agent_event', { type: 'text', content: 'nope' })

    expect(handler).not.toHaveBeenCalled()
  })

  describe('pause / resume', () => {
    it('buffers agent_event when paused', () => {
      const session = createSession()
      const handler = vi.fn()
      session.on('agent_event', handler)

      session.pause()
      session.emit('agent_event', { type: 'text', content: 'buffered' })

      expect(handler).not.toHaveBeenCalled()
    })

    it('replays buffered events in order on resume', () => {
      const session = createSession()
      const received: AgentEvent[] = []
      session.on('agent_event', (e) => received.push(e))

      session.pause()
      session.emit('agent_event', { type: 'text', content: 'first' })
      session.emit('agent_event', { type: 'thought', content: 'second' })

      session.resume()
      expect(received).toEqual([
        { type: 'text', content: 'first' },
        { type: 'thought', content: 'second' },
      ])
    })

    it('supports passthrough filter (e.g. let commands_update through during warmup)', () => {
      const session = createSession()
      const agentHandler = vi.fn()
      session.on('agent_event', agentHandler)

      // During warmup, only commands_update should pass through
      session.pause((_event, args) => {
        const agentEvent = args[0] as AgentEvent
        return agentEvent?.type === 'commands_update'
      })

      session.emit('agent_event', { type: 'text', content: 'suppress this' })
      session.emit('agent_event', { type: 'commands_update', commands: [{ name: '/test', description: 'test', input: undefined }] })

      expect(agentHandler).toHaveBeenCalledTimes(1)
      expect(agentHandler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'commands_update' }),
      )
    })
  })
})
