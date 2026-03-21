/**
 * A minimal, generic typed event emitter.
 *
 * Usage:
 *   interface MyEvents {
 *     data: (payload: string) => void
 *     error: (err: Error) => void
 *   }
 *   const emitter = new TypedEmitter<MyEvents>()
 *   emitter.on('data', (payload) => { ... })
 *   emitter.emit('data', 'hello')
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class TypedEmitter<T extends Record<string & keyof T, (...args: any[]) => void>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners = new Map<keyof T, Set<(...args: any[]) => void>>()
  private paused = false
  private buffer: Array<{ event: keyof T; args: unknown[] }> = []

  on<K extends keyof T>(event: K, listener: T[K]): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  off<K extends keyof T>(event: K, listener: T[K]): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): void {
    if (this.paused) {
      // Check passthrough filter — some events may bypass the pause
      if (this.passthroughFn?.(event, args)) {
        this.deliver(event, args)
      } else {
        this.buffer.push({ event, args })
      }
      return
    }
    this.deliver(event, args)
  }

  /**
   * Pause event delivery. Events emitted while paused are buffered.
   * Optionally pass a filter to allow specific events through even while paused.
   */
  pause(passthrough?: (event: keyof T, args: unknown[]) => boolean): void {
    this.paused = true
    this.passthroughFn = passthrough
  }
  private passthroughFn?: (event: keyof T, args: unknown[]) => boolean

  /** Resume event delivery and replay buffered events in order. */
  resume(): void {
    this.paused = false
    this.passthroughFn = undefined
    const buffered = this.buffer.splice(0)
    for (const { event, args } of buffered) {
      this.deliver(event, args)
    }
  }

  /** Discard all buffered events without delivering them. */
  clearBuffer(): void {
    this.buffer.length = 0
  }

  get isPaused(): boolean {
    return this.paused
  }

  get bufferSize(): number {
    return this.buffer.length
  }

  removeAllListeners(event?: keyof T): void {
    if (event) {
      this.listeners.delete(event)
    } else {
      this.listeners.clear()
    }
  }

  private deliver(event: keyof T, args: unknown[]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) {
      (listener as (...a: unknown[]) => void)(...args)
    }
  }
}
