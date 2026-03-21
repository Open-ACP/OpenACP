import { describe, it, expect, vi } from 'vitest'
import { PromptQueue } from '../prompt-queue.js'

describe('PromptQueue', () => {
  it('processes a single prompt immediately', async () => {
    const processor = vi.fn().mockResolvedValue(undefined)
    const queue = new PromptQueue(processor)

    await queue.enqueue('hello')

    expect(processor).toHaveBeenCalledWith('hello')
    expect(queue.pending).toBe(0)
    expect(queue.isProcessing).toBe(false)
  })

  it('processes prompts serially, not concurrently', async () => {
    const callOrder: string[] = []
    let resolveFirst!: () => void
    const firstPromise = new Promise<void>((r) => { resolveFirst = r })

    const processor = vi.fn().mockImplementation(async (text: string) => {
      callOrder.push(`start:${text}`)
      if (text === 'first') await firstPromise
      callOrder.push(`end:${text}`)
    })

    const queue = new PromptQueue(processor)

    const p1 = queue.enqueue('first')
    const p2 = queue.enqueue('second')
    const p3 = queue.enqueue('third')

    // second and third should be queued
    expect(queue.pending).toBe(2)

    resolveFirst()
    await Promise.all([p1, p2, p3])

    expect(callOrder).toEqual([
      'start:first', 'end:first',
      'start:second', 'end:second',
      'start:third', 'end:third',
    ])
  })

  it('enqueue while processing → queued, not dropped', async () => {
    let resolveFirst!: () => void
    const firstPromise = new Promise<void>((r) => { resolveFirst = r })
    const calls: string[] = []

    const processor = vi.fn().mockImplementation(async (text: string) => {
      calls.push(text)
      if (text === 'first') await firstPromise
    })

    const queue = new PromptQueue(processor)

    const p1 = queue.enqueue('first')
    queue.enqueue('second')

    expect(queue.isProcessing).toBe(true)
    expect(queue.pending).toBe(1)

    resolveFirst()
    await p1

    // Wait for second to process
    await vi.waitFor(() => expect(calls).toEqual(['first', 'second']))
  })

  it('clear() removes all pending, does not cancel active', async () => {
    let resolveFirst!: () => void
    const firstPromise = new Promise<void>((r) => { resolveFirst = r })
    const calls: string[] = []

    const processor = vi.fn().mockImplementation(async (text: string) => {
      calls.push(text)
      if (text === 'first') await firstPromise
    })

    const queue = new PromptQueue(processor)
    queue.enqueue('first')
    queue.enqueue('second')
    queue.enqueue('third')

    expect(queue.pending).toBe(2)
    queue.clear()
    expect(queue.pending).toBe(0)

    resolveFirst()
    // Wait for processing to finish
    await vi.waitFor(() => expect(queue.isProcessing).toBe(false))

    // Only first was processed (second/third were cleared)
    expect(calls).toEqual(['first'])
  })

  it('handles processor errors without breaking the queue', async () => {
    const calls: string[] = []
    const onError = vi.fn()
    const processor = vi.fn().mockImplementation(async (text: string) => {
      calls.push(text)
      if (text === 'fail') throw new Error('boom')
    })

    const queue = new PromptQueue(processor, onError)
    await queue.enqueue('fail')
    await queue.enqueue('after-fail')

    expect(calls).toEqual(['fail', 'after-fail'])
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })
})
