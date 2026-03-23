import { describe, it, expect, vi } from 'vitest'
import { MessageTransformer } from '../message-transformer.js'
import type { AgentEvent } from '../types.js'

describe('MessageTransformer - extended', () => {
  const transformer = new MessageTransformer()

  describe('text event', () => {
    it('transforms with content', () => {
      const event: AgentEvent = { type: 'text', content: 'Hello world' }
      const result = transformer.transform(event)
      expect(result).toEqual({ type: 'text', text: 'Hello world' })
    })

    it('transforms with empty content', () => {
      const event: AgentEvent = { type: 'text', content: '' }
      const result = transformer.transform(event)
      expect(result).toEqual({ type: 'text', text: '' })
    })
  })

  describe('thought event', () => {
    it('transforms with content', () => {
      const event: AgentEvent = { type: 'thought', content: 'I think...' }
      const result = transformer.transform(event)
      expect(result).toEqual({ type: 'thought', text: 'I think...' })
    })
  })

  describe('tool_call event', () => {
    it('transforms with full metadata', () => {
      const event: AgentEvent = {
        type: 'tool_call',
        id: 'tc-1',
        name: 'Read file.ts',
        kind: 'read',
        status: 'running',
        content: 'file content',
        locations: [{ path: '/src/file.ts' }],
      }
      const result = transformer.transform(event)
      expect(result.type).toBe('tool_call')
      expect(result.text).toBe('Read file.ts')
      expect(result.metadata).toMatchObject({
        id: 'tc-1',
        name: 'Read file.ts',
        kind: 'read',
        status: 'running',
        content: 'file content',
      })
    })

    it('handles missing optional fields', () => {
      const event: AgentEvent = {
        type: 'tool_call',
        id: 'tc-2',
        name: 'Unknown',
        status: 'running',
      }
      const result = transformer.transform(event)
      expect(result.metadata).toMatchObject({
        id: 'tc-2',
        name: 'Unknown',
      })
    })
  })

  describe('tool_update event', () => {
    it('transforms with metadata', () => {
      const event: AgentEvent = {
        type: 'tool_update',
        id: 'tc-1',
        name: 'Read',
        kind: 'read',
        status: 'completed',
        content: 'result',
      }
      const result = transformer.transform(event)
      expect(result.type).toBe('tool_update')
      expect(result.text).toBe('')
      expect(result.metadata).toMatchObject({
        id: 'tc-1',
        status: 'completed',
      })
    })
  })

  describe('plan event', () => {
    it('transforms with entries', () => {
      const event: AgentEvent = {
        type: 'plan',
        entries: [
          { content: 'Step 1', status: 'completed', priority: 'high' },
          { content: 'Step 2', status: 'in_progress', priority: 'medium' },
        ],
      }
      const result = transformer.transform(event)
      expect(result.type).toBe('plan')
      expect(result.metadata?.entries).toHaveLength(2)
    })
  })

  describe('usage event', () => {
    it('transforms with all fields', () => {
      const event: AgentEvent = {
        type: 'usage',
        tokensUsed: 1000,
        contextSize: 100000,
        cost: { amount: 0.05, currency: 'USD' },
      }
      const result = transformer.transform(event)
      expect(result.type).toBe('usage')
      expect(result.metadata).toMatchObject({
        tokensUsed: 1000,
        contextSize: 100000,
        cost: { amount: 0.05, currency: 'USD' },
      })
    })

    it('transforms with partial fields', () => {
      const event: AgentEvent = {
        type: 'usage',
        tokensUsed: 500,
      }
      const result = transformer.transform(event)
      expect(result.metadata?.tokensUsed).toBe(500)
    })
  })

  describe('session_end event', () => {
    it('includes reason in text', () => {
      const event: AgentEvent = { type: 'session_end', reason: 'user_cancelled' }
      const result = transformer.transform(event)
      expect(result).toEqual({
        type: 'session_end',
        text: 'Done (user_cancelled)',
      })
    })
  })

  describe('error event', () => {
    it('includes message in text', () => {
      const event: AgentEvent = { type: 'error', message: 'Something broke' }
      const result = transformer.transform(event)
      expect(result).toEqual({ type: 'error', text: 'Something broke' })
    })
  })

  describe('unknown event type', () => {
    it('returns empty text', () => {
      const event = { type: 'unknown_type' } as any
      const result = transformer.transform(event)
      expect(result).toEqual({ type: 'text', text: '' })
    })
  })

  describe('commands_update event', () => {
    it('falls through to default handler', () => {
      const event: AgentEvent = { type: 'commands_update', commands: [] }
      const result = transformer.transform(event)
      expect(result).toEqual({ type: 'text', text: '' })
    })
  })

  describe('enrichWithViewerLinks (tunnel integration)', () => {
    it('does nothing without tunnelService', () => {
      const event: AgentEvent = {
        type: 'tool_call',
        id: 'tc-1',
        name: 'Read',
        kind: 'read',
        status: 'completed',
        content: 'data',
      }
      const result = transformer.transform(event, { id: 'sess-1', workingDirectory: '/ws' })
      expect(result.metadata?.viewerLinks).toBeUndefined()
    })

    it('does nothing without sessionContext', () => {
      const tunnelService = {
        getStore: vi.fn().mockReturnValue({
          storeFile: vi.fn().mockReturnValue('id1'),
          storeDiff: vi.fn(),
        }),
        fileUrl: vi.fn().mockReturnValue('https://example.com/view/id1'),
        diffUrl: vi.fn(),
      } as any
      const t = new MessageTransformer(tunnelService)

      const event: AgentEvent = {
        type: 'tool_call',
        id: 'tc-1',
        name: 'Read',
        kind: 'read',
        status: 'completed',
        content: 'data',
      }
      const result = t.transform(event) // no sessionContext
      expect(result.metadata?.viewerLinks).toBeUndefined()
    })

    it('adds viewer links when tunnel available and file info extracted', () => {
      const tunnelStore = {
        storeFile: vi.fn().mockReturnValue('file-id'),
        storeDiff: vi.fn().mockReturnValue('diff-id'),
      }
      const tunnelService = {
        getStore: vi.fn().mockReturnValue(tunnelStore),
        fileUrl: vi.fn().mockReturnValue('https://tunnel.example/view/file-id'),
        diffUrl: vi.fn().mockReturnValue('https://tunnel.example/diff/diff-id'),
      } as any
      const t = new MessageTransformer(tunnelService)

      const event: AgentEvent = {
        type: 'tool_call',
        id: 'tc-1',
        name: 'Edit',
        kind: 'edit',
        status: 'completed',
        content: [{ type: 'diff', path: '/ws/file.ts', oldText: 'old', newText: 'new' }],
      }
      const result = t.transform(event, { id: 'sess-1', workingDirectory: '/ws' })
      expect(result.metadata?.viewerLinks).toBeDefined()
    })

    it('skips non-file tool kinds', () => {
      const tunnelStore = { storeFile: vi.fn(), storeDiff: vi.fn() }
      const tunnelService = {
        getStore: vi.fn().mockReturnValue(tunnelStore),
        fileUrl: vi.fn(),
        diffUrl: vi.fn(),
      } as any
      const t = new MessageTransformer(tunnelService)

      const event: AgentEvent = {
        type: 'tool_call',
        id: 'tc-1',
        name: 'Bash',
        kind: 'bash',
        status: 'completed',
        content: 'output',
      }
      const result = t.transform(event, { id: 'sess-1', workingDirectory: '/ws' })
      expect(tunnelStore.storeFile).not.toHaveBeenCalled()
    })
  })
})
