/**
 * Serial prompt queue — ensures prompts are processed one at a time.
 */
export class PromptQueue {
  private queue: Array<{ text: string; resolve: () => void }> = []
  private processing = false

  constructor(
    private processor: (text: string) => Promise<void>,
    private onError?: (err: unknown) => void,
  ) {}

  async enqueue(text: string): Promise<void> {
    if (this.processing) {
      return new Promise<void>((resolve) => {
        this.queue.push({ text, resolve })
      })
    }
    await this.process(text)
  }

  private async process(text: string): Promise<void> {
    this.processing = true
    try {
      await this.processor(text)
    } catch (err) {
      this.onError?.(err)
    } finally {
      this.processing = false
      this.drainNext()
    }
  }

  private drainNext(): void {
    const next = this.queue.shift()
    if (next) {
      this.process(next.text).then(next.resolve)
    }
  }

  clear(): void {
    // Resolve pending promises so callers don't hang
    for (const item of this.queue) {
      item.resolve()
    }
    this.queue = []
  }

  get pending(): number {
    return this.queue.length
  }

  get isProcessing(): boolean {
    return this.processing
  }
}
