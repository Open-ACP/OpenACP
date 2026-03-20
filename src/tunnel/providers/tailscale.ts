import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { createChildLogger } from '../../core/log.js'
import type { TunnelProvider } from '../provider.js'

const log = createChildLogger({ module: 'tailscale-tunnel' })

export class TailscaleTunnelProvider implements TunnelProvider {
  private child: ChildProcess | null = null
  private publicUrl = ''
  private options: Record<string, unknown>

  constructor(options: Record<string, unknown> = {}) {
    this.options = options
  }

  async start(localPort: number): Promise<string> {
    let hostname = ''
    try {
      const statusJson = execSync('tailscale status --json', { encoding: 'utf-8' })
      const status = JSON.parse(statusJson)
      hostname = String(status.Self.DNSName).replace(/\.$/, '')
      log.debug({ hostname }, 'Resolved Tailscale hostname')
    } catch (err) {
      log.warn('Failed to resolve Tailscale hostname via status --json')
    }

    const args = ['funnel', String(localPort)]
    if (this.options.bg) {
      args.push('--bg')
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stop()
        reject(new Error('Tailscale funnel timed out after 30s. Is tailscale installed?'))
      }, 30_000)

      try {
        this.child = spawn('tailscale', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        clearTimeout(timeout)
        reject(new Error(
          'Failed to start tailscale. Install it from https://tailscale.com/download'
        ))
        return
      }

      const urlPattern = /https:\/\/[^\s]+/

      const onData = (data: Buffer) => {
        const line = data.toString()
        log.debug(line.trim())
        const match = line.match(urlPattern)
        if (match) {
          clearTimeout(timeout)
          this.publicUrl = match[0]
          log.info({ url: this.publicUrl }, 'Tailscale funnel ready')
          resolve(this.publicUrl)
        }
      }

      this.child.stdout?.on('data', onData)
      this.child.stderr?.on('data', onData)

      this.child.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(
          `tailscale failed to start: ${err.message}. Install it from https://tailscale.com/download`
        ))
      })

      this.child.on('exit', (code) => {
        if (!this.publicUrl) {
          clearTimeout(timeout)
          if (hostname) {
            this.publicUrl = `https://${hostname}`
            log.info({ url: this.publicUrl }, 'Tailscale funnel ready (constructed from hostname)')
            resolve(this.publicUrl)
          } else {
            reject(new Error(`tailscale exited with code ${code} before establishing funnel`))
          }
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
      log.info('Tailscale funnel stopped')
    }
  }

  getPublicUrl(): string {
    return this.publicUrl
  }
}
