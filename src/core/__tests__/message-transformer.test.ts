import { describe, it, expect } from 'vitest'
import { MessageTransformer } from '../message-transformer.js'
import type { AgentEvent, OutgoingMessage } from '../types.js'

describe('MessageTransformer', () => {
  const transformer = new MessageTransformer()

  it('transforms text event', () => {
    const event: AgentEvent = { type: 'text', content: 'hello world' }
    const result = transformer.transform(event)

    expect(result).toEqual<OutgoingMessage>({
      type: 'text',
      text: 'hello world',
    })
  })

  it('transforms thought event', () => {
    const event: AgentEvent = { type: 'thought', content: 'thinking...' }
    const result = transformer.transform(event)

    expect(result).toEqual<OutgoingMessage>({
      type: 'thought',
      text: 'thinking...',
    })
  })

  it('transforms tool_call event with metadata', () => {
    const event: AgentEvent = {
      type: 'tool_call',
      id: 'tc-1',
      name: 'Read',
      kind: 'file',
      status: 'completed',
      content: 'file contents',
    }
    const result = transformer.transform(event)

    expect(result.type).toBe('tool_call')
    expect(result.text).toBe('Read')
    expect(result.metadata).toMatchObject({
      id: 'tc-1',
      name: 'Read',
      kind: 'file',
      status: 'completed',
      content: 'file contents',
    })
  })

  it('transforms tool_update event', () => {
    const event: AgentEvent = {
      type: 'tool_update',
      id: 'tc-1',
      name: 'Read',
      status: 'running',
    }
    const result = transformer.transform(event)

    expect(result.type).toBe('tool_update')
    expect(result.metadata).toMatchObject({
      id: 'tc-1',
      name: 'Read',
      status: 'running',
    })
  })

  it('transforms plan event', () => {
    const event: AgentEvent = {
      type: 'plan',
      entries: [
        { content: 'Step 1', status: 'completed', priority: 'high' },
        { content: 'Step 2', status: 'pending', priority: 'medium' },
      ],
    }
    const result = transformer.transform(event)

    expect(result.type).toBe('plan')
    expect(result.metadata?.entries).toHaveLength(2)
  })

  it('transforms usage event', () => {
    const event: AgentEvent = {
      type: 'usage',
      tokensUsed: 1000,
      contextSize: 50000,
      cost: { amount: 0.05, currency: 'USD' },
    }
    const result = transformer.transform(event)

    expect(result.type).toBe('usage')
    expect(result.metadata).toMatchObject({
      tokensUsed: 1000,
      contextSize: 50000,
      cost: { amount: 0.05, currency: 'USD' },
    })
  })

  it('transforms session_end event', () => {
    const event: AgentEvent = { type: 'session_end', reason: 'completed' }
    const result = transformer.transform(event)

    expect(result).toEqual<OutgoingMessage>({
      type: 'session_end',
      text: 'Done (completed)',
    })
  })

  it('transforms error event', () => {
    const event: AgentEvent = { type: 'error', message: 'Agent crashed' }
    const result = transformer.transform(event)

    expect(result).toEqual<OutgoingMessage>({
      type: 'error',
      text: 'Agent crashed',
    })
  })

  it('transforms unknown event to empty text', () => {
    const event = { type: 'commands_update', commands: [] } as AgentEvent
    const result = transformer.transform(event)

    expect(result).toEqual<OutgoingMessage>({ type: 'text', text: '' })
  })
})
