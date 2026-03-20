import { serve } from '@hono/node-server'
import type { TunnelConfig } from '../core/config.js'
import { createChildLogger } from '../core/log.js'
import type { TunnelProvider } from './provider.js'
import { CloudflareTunnelProvider } from './providers/cloudflare.js'
import { ViewerStore } from './viewer-store.js'
import { createTunnelServer } from './server.js'

const log = createChildLogger({ module: 'tunnel' })

export class TunnelService {
  private provider: TunnelProvider
  private store: ViewerStore
  private server: ReturnType<typeof serve> | null = null
  private publicUrl = ''
  private config: TunnelConfig

  constructor(config: TunnelConfig) {
    this.config = config
    this.store = new ViewerStore(config.storeTtlMinutes)
    this.provider = this.createProvider(config.provider, config.options)
  }

  async start(): Promise<string> {
    // 1. Start HTTP server
    const authToken = this.config.auth.enabled ? this.config.auth.token : undefined
    const app = createTunnelServer(this.store, authToken)

    this.server = serve({ fetch: app.fetch, port: this.config.port })
    log.info({ port: this.config.port }, 'Tunnel HTTP server started')

    // 2. Start tunnel provider
    try {
      this.publicUrl = await this.provider.start(this.config.port)
      log.info({ url: this.publicUrl }, 'Tunnel public URL ready')
    } catch (err) {
      log.warn({ err }, 'Tunnel provider failed to start, running without public URL')
      this.publicUrl = `http://localhost:${this.config.port}`
    }

    return this.publicUrl
  }

  async stop(): Promise<void> {
    await this.provider.stop()
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.store.destroy()
    log.info('Tunnel service stopped')
  }

  getPublicUrl(): string {
    return this.publicUrl
  }

  getStore(): ViewerStore {
    return this.store
  }

  fileUrl(entryId: string): string {
    return `${this.publicUrl}/view/${entryId}`
  }

  diffUrl(entryId: string): string {
    return `${this.publicUrl}/diff/${entryId}`
  }

  private createProvider(name: string, options: Record<string, unknown>): TunnelProvider {
    switch (name) {
      case 'cloudflare':
        return new CloudflareTunnelProvider(options)
      default:
        log.warn({ provider: name }, 'Unknown tunnel provider, falling back to cloudflare')
        return new CloudflareTunnelProvider(options)
    }
  }
}
