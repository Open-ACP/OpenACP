export class TelegramSendQueue {
  private queue: Promise<void> = Promise.resolve()
  private lastExec: number = 0
  private minInterval: number

  constructor(minInterval = 100) {
    this.minInterval = minInterval
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    let resolve: (value: T) => void
    let reject: (err: unknown) => void
    const resultPromise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })

    this.queue = this.queue.then(async () => {
      // Only delay if not enough time has passed since last execution
      const elapsed = Date.now() - this.lastExec
      if (elapsed < this.minInterval) {
        await new Promise((r) => setTimeout(r, this.minInterval - elapsed))
      }
      try {
        const result = await fn()
        resolve!(result)
      } catch (err) {
        reject!(err)
      } finally {
        this.lastExec = Date.now()
      }
    })

    return resultPromise
  }
}
