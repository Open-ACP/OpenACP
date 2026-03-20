import { spawn, type ChildProcess } from 'node:child_process'
import { createChildLogger } from '../../core/log.js'
import type { TunnelProvider } from '../provider.js'

const log = createChildLogger({ module: 'ngrok-tunnel' })

export class NgrokTunnelProvider implements TunnelProvider {
  private child: ChildProcess | null = null
  private publicUrl = ''
  private options: Record<string, unknown>

  constructor(options: Record<string, unknown> = {}) {
    this.options = options
  }

  async start(localPort: number): Promise<string> {
    const args = ['http', String(localPort), '--log', 'stdout', '--log-format', 'json']
    if (this.options.authtoken) {
      args.push('--authtoken', String(this.options.authtoken))
    }
    if (this.options.domain) {
      args.push('--domain', String(this.options.domain))
    }
    if (this.options.region) {
      args.push('--region', String(this.options.region))
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stop()
        reject(new Error('ngrok tunnel timed out after 30s. Is ngrok installed?'))
      }, 30_000)

      try {
        this.child = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        clearTimeout(timeout)
        reject(new Error(
          'Failed to start ngrok. Install it from https://ngrok.com/download'
        ))
        return
      }

      const urlPattern = /https:\/\/[a-zA-Z0-9-]+\.ngrok(-free)?\.app/

      const onData = (data: Buffer) => {
        const line = data.toString()
        log.debug(line.trim())
        const match = line.match(urlPattern)
        if (match) {
          clearTimeout(timeout)
          this.publicUrl = match[0]
          log.info({ url: this.publicUrl }, 'ngrok tunnel ready')
          resolve(this.publicUrl)
        }
      }

      this.child.stdout?.on('data', onData)
      this.child.stderr?.on('data', onData)

      this.child.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(
          `ngrok failed to start: ${err.message}. Install it from https://ngrok.com/download`
        ))
      })

      this.child.on('exit', (code) => {
        if (!this.publicUrl) {
          clearTimeout(timeout)
          reject(new Error(`ngrok exited with code ${code} before establishing tunnel`))
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
      log.info('ngrok tunnel stopped')
    }
  }

  getPublicUrl(): string {
    return this.publicUrl
  }
}
