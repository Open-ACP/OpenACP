import { spawn, type ChildProcess } from 'node:child_process'
import { createChildLogger } from '../../core/log.js'
import type { TunnelProvider } from '../provider.js'

const log = createChildLogger({ module: 'bore-tunnel' })

export class BoreTunnelProvider implements TunnelProvider {
  private child: ChildProcess | null = null
  private publicUrl = ''
  private options: Record<string, unknown>

  constructor(options: Record<string, unknown> = {}) {
    this.options = options
  }

  async start(localPort: number): Promise<string> {
    const server = String(this.options.server || 'bore.pub')
    const args = ['local', String(localPort), '--to', server]
    if (this.options.port) {
      args.push('--port', String(this.options.port))
    }
    if (this.options.secret) {
      args.push('--secret', String(this.options.secret))
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stop()
        reject(new Error('Bore tunnel timed out after 30s. Is bore installed?'))
      }, 30_000)

      try {
        this.child = spawn('bore', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        clearTimeout(timeout)
        reject(new Error(
          'Failed to start bore. Install it from https://github.com/ekzhang/bore'
        ))
        return
      }

      const urlPattern = /listening at ([^\s]+):(\d+)/

      const onData = (data: Buffer) => {
        const line = data.toString()
        log.debug(line.trim())
        const match = line.match(urlPattern)
        if (match) {
          clearTimeout(timeout)
          this.publicUrl = `http://${match[1]}:${match[2]}`
          log.info({ url: this.publicUrl }, 'Bore tunnel ready')
          resolve(this.publicUrl)
        }
      }

      this.child.stdout?.on('data', onData)
      this.child.stderr?.on('data', onData)

      this.child.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(
          `bore failed to start: ${err.message}. Install it from https://github.com/ekzhang/bore`
        ))
      })

      this.child.on('exit', (code) => {
        if (!this.publicUrl) {
          clearTimeout(timeout)
          reject(new Error(`bore exited with code ${code} before establishing tunnel`))
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
      log.info('Bore tunnel stopped')
    }
  }

  getPublicUrl(): string {
    return this.publicUrl
  }
}
