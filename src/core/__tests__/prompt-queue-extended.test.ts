import { describe, it, expect, vi } from 'vitest'
import { PromptQueue } from '../prompt-queue.js'

describe('PromptQueue - extended edge cases', () => {
  it('isProcessing reflects active state', async () => {
    let resolvePrompt!: () => void
    const promise = new Promise<void>((r) => { resolvePrompt = r })
    const processor = vi.fn().mockImplementation(async () => promise)

    const queue = new PromptQueue(processor)
    expect(queue.isProcessing).toBe(false)

    const p = queue.enqueue('test')
    expect(queue.isProcessing).toBe(true)

    resolvePrompt()
    await p
    expect(queue.isProcessing).toBe(false)
  })

  it('pending count is accurate during processing', async () => {
    let resolveFirst!: () => void
    const firstPromise = new Promise<void>((r) => { resolveFirst = r })
    const processor = vi.fn().mockImplementation(async (text: string) => {
      if (text === 'first') await firstPromise
    })

    const queue = new PromptQueue(processor)
    queue.enqueue('first')
    queue.enqueue('second')
    queue.enqueue('third')
    queue.enqueue('fourth')

    expect(queue.pending).toBe(3) // second, third, fourth

    resolveFirst()
    await vi.waitFor(() => expect(queue.isProcessing).toBe(false))
    expect(queue.pending).toBe(0)
  })

  it('clear() resolves pending promises (does not leave them hanging)', async () => {
    let resolveFirst!: () => void
    const firstPromise = new Promise<void>((r) => { resolveFirst = r })
    const processor = vi.fn().mockImplementation(async (text: string) => {
      if (text === 'first') await firstPromise
    })

    const queue = new PromptQueue(processor)
    queue.enqueue('first')
    const p2 = queue.enqueue('second')
    const p3 = queue.enqueue('third')

    // Clear pending
    queue.clear()

    // Pending promises should resolve (not hang)
    resolveFirst()
    await p2
    await p3
    // If we get here, promises resolved successfully
  })

  it('multiple consecutive clears are safe', async () => {
    const processor = vi.fn().mockResolvedValue(undefined)
    const queue = new PromptQueue(processor)

    queue.enqueue('a')
    queue.clear()
    queue.clear()
    queue.clear()

    expect(queue.pending).toBe(0)
  })

  it('processes items added after clear', async () => {
    let resolveFirst!: () => void
    const firstPromise = new Promise<void>((r) => { resolveFirst = r })
    const calls: string[] = []

    const processor = vi.fn().mockImplementation(async (text: string) => {
      calls.push(text)
      if (text === 'first') await firstPromise
    })

    const queue = new PromptQueue(processor)
    queue.enqueue('first')
    queue.enqueue('should-be-cleared')
    queue.clear()

    const afterClear = queue.enqueue('after-clear')

    resolveFirst()
    await afterClear

    expect(calls).toContain('first')
    expect(calls).toContain('after-clear')
    expect(calls).not.toContain('should-be-cleared')
  })

  it('onError receives the actual error object', async () => {
    const error = new Error('specific error')
    const onError = vi.fn()
    const processor = vi.fn().mockRejectedValue(error)

    const queue = new PromptQueue(processor, onError)
    await queue.enqueue('fail')

    expect(onError).toHaveBeenCalledWith(error)
  })

  it('continues processing after multiple errors', async () => {
    const calls: string[] = []
    const onError = vi.fn()
    const processor = vi.fn().mockImplementation(async (text: string) => {
      calls.push(text)
      if (text.startsWith('fail')) throw new Error(text)
    })

    const queue = new PromptQueue(processor, onError)
    await queue.enqueue('fail-1')
    await queue.enqueue('fail-2')
    await queue.enqueue('success')

    expect(calls).toEqual(['fail-1', 'fail-2', 'success'])
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('handles synchronous processor', async () => {
    const calls: string[] = []
    const processor = vi.fn().mockImplementation((text: string) => {
      calls.push(text)
      return Promise.resolve()
    })

    const queue = new PromptQueue(processor)
    await queue.enqueue('sync-1')
    await queue.enqueue('sync-2')

    expect(calls).toEqual(['sync-1', 'sync-2'])
  })

  it('drains queue items in correct FIFO order', async () => {
    const order: string[] = []
    let resolveGate!: () => void
    const gate = new Promise<void>((r) => { resolveGate = r })

    const processor = vi.fn().mockImplementation(async (text: string) => {
      if (text === 'gate') await gate
      else order.push(text)
    })

    const queue = new PromptQueue(processor)
    queue.enqueue('gate')
    queue.enqueue('first')
    queue.enqueue('second')
    queue.enqueue('third')

    resolveGate()
    await vi.waitFor(() => expect(queue.isProcessing).toBe(false))

    expect(order).toEqual(['first', 'second', 'third'])
  })
})
