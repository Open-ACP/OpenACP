import { describe, it, expect, vi } from 'vitest'
import { TypedEmitter } from '../typed-emitter.js'

interface TestEvents {
  data: (payload: string) => void
  error: (err: Error) => void
  count: (n: number) => void
}

describe('TypedEmitter', () => {
  it('delivers events to registered listeners', () => {
    const emitter = new TypedEmitter<TestEvents>()
    const handler = vi.fn()
    emitter.on('data', handler)
    emitter.emit('data', 'hello')
    expect(handler).toHaveBeenCalledWith('hello')
  })

  it('supports multiple listeners on the same event', () => {
    const emitter = new TypedEmitter<TestEvents>()
    const h1 = vi.fn()
    const h2 = vi.fn()
    emitter.on('data', h1)
    emitter.on('data', h2)
    emitter.emit('data', 'test')
    expect(h1).toHaveBeenCalledWith('test')
    expect(h2).toHaveBeenCalledWith('test')
  })

  it('does not deliver to unregistered listeners', () => {
    const emitter = new TypedEmitter<TestEvents>()
    const handler = vi.fn()
    emitter.on('data', handler)
    emitter.off('data', handler)
    emitter.emit('data', 'should-not-receive')
    expect(handler).not.toHaveBeenCalled()
  })

  it('delivers different event types to correct listeners', () => {
    const emitter = new TypedEmitter<TestEvents>()
    const dataHandler = vi.fn()
    const errorHandler = vi.fn()
    emitter.on('data', dataHandler)
    emitter.on('error', errorHandler)

    emitter.emit('data', 'msg')
    emitter.emit('error', new Error('oops'))

    expect(dataHandler).toHaveBeenCalledWith('msg')
    expect(errorHandler).toHaveBeenCalledWith(expect.any(Error))
    expect(dataHandler).toHaveBeenCalledTimes(1)
    expect(errorHandler).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when emitting with no listeners', () => {
    const emitter = new TypedEmitter<TestEvents>()
    expect(() => emitter.emit('data', 'no-one-listening')).not.toThrow()
  })

  it('removeAllListeners for a specific event', () => {
    const emitter = new TypedEmitter<TestEvents>()
    const h1 = vi.fn()
    const h2 = vi.fn()
    emitter.on('data', h1)
    emitter.on('count', h2)
    emitter.removeAllListeners('data')

    emitter.emit('data', 'x')
    emitter.emit('count', 42)
    expect(h1).not.toHaveBeenCalled()
    expect(h2).toHaveBeenCalledWith(42)
  })

  it('removeAllListeners without argument clears everything', () => {
    const emitter = new TypedEmitter<TestEvents>()
    const h1 = vi.fn()
    const h2 = vi.fn()
    emitter.on('data', h1)
    emitter.on('count', h2)
    emitter.removeAllListeners()

    emitter.emit('data', 'x')
    emitter.emit('count', 42)
    expect(h1).not.toHaveBeenCalled()
    expect(h2).not.toHaveBeenCalled()
  })

  describe('pause / resume', () => {
    it('buffers events when paused', () => {
      const emitter = new TypedEmitter<TestEvents>()
      const handler = vi.fn()
      emitter.on('data', handler)

      emitter.pause()
      emitter.emit('data', 'buffered-1')
      emitter.emit('data', 'buffered-2')

      expect(handler).not.toHaveBeenCalled()
      expect(emitter.bufferSize).toBe(2)
    })

    it('replays buffered events in order on resume', () => {
      const emitter = new TypedEmitter<TestEvents>()
      const received: string[] = []
      emitter.on('data', (msg) => received.push(msg))

      emitter.pause()
      emitter.emit('data', 'first')
      emitter.emit('data', 'second')
      emitter.emit('data', 'third')

      emitter.resume()
      expect(received).toEqual(['first', 'second', 'third'])
    })

    it('clears buffer after resume', () => {
      const emitter = new TypedEmitter<TestEvents>()
      emitter.on('data', () => {})
      emitter.pause()
      emitter.emit('data', 'x')
      emitter.resume()
      expect(emitter.bufferSize).toBe(0)
    })

    it('delivers normally after resume', () => {
      const emitter = new TypedEmitter<TestEvents>()
      const handler = vi.fn()
      emitter.on('data', handler)

      emitter.pause()
      emitter.resume()
      emitter.emit('data', 'after-resume')
      expect(handler).toHaveBeenCalledWith('after-resume')
    })

    it('supports passthrough filter during pause', () => {
      const emitter = new TypedEmitter<TestEvents>()
      const dataHandler = vi.fn()
      const countHandler = vi.fn()
      emitter.on('data', dataHandler)
      emitter.on('count', countHandler)

      // Only let 'count' events through during pause
      emitter.pause((event) => event === 'count')

      emitter.emit('data', 'should-buffer')
      emitter.emit('count', 42)

      expect(dataHandler).not.toHaveBeenCalled()
      expect(countHandler).toHaveBeenCalledWith(42)
      expect(emitter.bufferSize).toBe(1)

      emitter.resume()
      expect(dataHandler).toHaveBeenCalledWith('should-buffer')
    })

    it('clearBuffer discards buffered events', () => {
      const emitter = new TypedEmitter<TestEvents>()
      const handler = vi.fn()
      emitter.on('data', handler)

      emitter.pause()
      emitter.emit('data', 'x')
      emitter.emit('data', 'y')
      emitter.clearBuffer()
      emitter.resume()

      expect(handler).not.toHaveBeenCalled()
    })

    it('isPaused reflects current state', () => {
      const emitter = new TypedEmitter<TestEvents>()
      expect(emitter.isPaused).toBe(false)
      emitter.pause()
      expect(emitter.isPaused).toBe(true)
      emitter.resume()
      expect(emitter.isPaused).toBe(false)
    })
  })
})
