import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { nodeToWebWritable, nodeToWebReadable } from '../streams.js'

describe('nodeToWebWritable', () => {
  it('writes data to underlying node stream', async () => {
    const chunks: Buffer[] = []
    const node = new PassThrough()
    node.on('data', (chunk) => chunks.push(chunk))

    const web = nodeToWebWritable(node)
    const writer = web.getWriter()
    await writer.write(new Uint8Array([104, 101, 108, 108, 111])) // "hello"
    await writer.close()

    expect(Buffer.concat(chunks).toString()).toBe('hello')
  })

  it('writes multiple chunks sequentially', async () => {
    const chunks: Buffer[] = []
    const node = new PassThrough()
    node.on('data', (chunk) => chunks.push(chunk))

    const web = nodeToWebWritable(node)
    const writer = web.getWriter()
    await writer.write(new TextEncoder().encode('hello '))
    await writer.write(new TextEncoder().encode('world'))
    await writer.close()

    expect(Buffer.concat(chunks).toString()).toBe('hello world')
  })

  it('propagates write errors', async () => {
    const node = new PassThrough()
    // Suppress the error event from crashing the test runner
    node.on('error', () => {})
    node.destroy(new Error('write error'))

    const web = nodeToWebWritable(node)
    const writer = web.getWriter()

    await expect(writer.write(new Uint8Array([1]))).rejects.toThrow()
  })
})

describe('nodeToWebReadable', () => {
  it('reads data from underlying node stream', async () => {
    const node = new PassThrough()
    const web = nodeToWebReadable(node)
    const reader = web.getReader()

    node.write('hello')
    node.end()

    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const result = Buffer.from(
      chunks.reduce((acc, chunk) => {
        const merged = new Uint8Array(acc.length + chunk.length)
        merged.set(acc)
        merged.set(chunk, acc.length)
        return merged
      }, new Uint8Array(0)),
    ).toString()
    expect(result).toBe('hello')
  })

  it('handles multiple chunks', async () => {
    const node = new PassThrough()
    const web = nodeToWebReadable(node)
    const reader = web.getReader()

    node.write('chunk1')
    node.write('chunk2')
    node.end()

    const parts: string[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(Buffer.from(value).toString())
    }

    expect(parts.join('')).toBe('chunk1chunk2')
  })

  it('signals end when node stream ends', async () => {
    const node = new PassThrough()
    const web = nodeToWebReadable(node)
    const reader = web.getReader()

    node.end()

    const { done } = await reader.read()
    expect(done).toBe(true)
  })

  it('propagates errors from node stream', async () => {
    const node = new PassThrough()
    const web = nodeToWebReadable(node)
    const reader = web.getReader()

    node.destroy(new Error('read error'))

    await expect(reader.read()).rejects.toThrow('read error')
  })
})
