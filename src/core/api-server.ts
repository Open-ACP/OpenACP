import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { OpenACPCore } from './core.js'
import { createChildLogger } from './log.js'

const log = createChildLogger({ module: 'api-server' })

const DEFAULT_PORT_FILE = path.join(os.homedir(), '.openacp', 'api.port')

export interface ApiConfig {
  port: number
  host: string
}

export class ApiServer {
  private server: http.Server | null = null
  private actualPort: number = 0
  private portFilePath: string

  constructor(
    private core: OpenACPCore,
    private config: ApiConfig,
    portFilePath?: string,
  ) {
    this.portFilePath = portFilePath ?? DEFAULT_PORT_FILE
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res))

    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log.warn({ port: this.config.port }, 'API port in use, continuing without API server')
          this.server = null
          // actualPort stays 0, port file not written
          resolve()
        } else {
          reject(err)
        }
      })

      this.server!.listen(this.config.port, this.config.host, () => {
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') {
          this.actualPort = addr.port
        }
        this.writePortFile()
        log.info({ host: this.config.host, port: this.actualPort }, 'API server listening')
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    this.removePortFile()
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
  }

  getPort(): number {
    return this.actualPort
  }

  private writePortFile(): void {
    const dir = path.dirname(this.portFilePath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.portFilePath, String(this.actualPort))
  }

  private removePortFile(): void {
    try { fs.unlinkSync(this.portFilePath) } catch { /* ignore */ }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method?.toUpperCase()
    const url = req.url || ''

    try {
      if (method === 'POST' && url === '/api/sessions') {
        await this.handleCreateSession(req, res)
      } else if (method === 'DELETE' && url.match(/^\/api\/sessions\/(.+)$/)) {
        const sessionId = url.match(/^\/api\/sessions\/(.+)$/)![1]
        await this.handleCancelSession(sessionId, res)
      } else if (method === 'GET' && url === '/api/sessions') {
        await this.handleListSessions(res)
      } else if (method === 'GET' && url === '/api/agents') {
        await this.handleListAgents(res)
      } else {
        this.sendJson(res, 404, { error: 'Not found' })
      }
    } catch (err) {
      log.error({ err }, 'API request error')
      this.sendJson(res, 500, { error: 'Internal server error' })
    }
  }

  private async handleCreateSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    let agent: string | undefined
    let workspace: string | undefined

    if (body) {
      try {
        const parsed = JSON.parse(body)
        agent = parsed.agent
        workspace = parsed.workspace
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON body' })
        return
      }
    }

    // Check max concurrent sessions
    const config = this.core.configManager.get()
    const activeSessions = this.core.sessionManager.listSessions()
      .filter(s => s.status === 'active' || s.status === 'initializing')
    if (activeSessions.length >= config.security.maxConcurrentSessions) {
      this.sendJson(res, 429, {
        error: `Max concurrent sessions (${config.security.maxConcurrentSessions}) reached. Cancel a session first.`,
      })
      return
    }

    // Use the first registered adapter (e.g. Telegram) so API sessions appear in the channel
    const [adapterId, adapter] = this.core.adapters.entries().next().value ?? [null, null]
    const channelId = adapterId ?? 'api'

    const session = await this.core.handleNewSession(channelId, agent, workspace)

    // If an adapter is available, create a session thread (Telegram topic) and wire events
    if (adapter) {
      try {
        const threadId = await adapter.createSessionThread(session.id, `🔄 ${session.agentName} — New Session`)
        session.threadId = threadId
        this.core.wireSessionEvents(session, adapter)
      } catch (err) {
        log.warn({ err, sessionId: session.id }, 'Failed to create session thread on adapter, running headless')
      }
    }

    // If no adapter wired events (headless), auto-approve permissions
    if (!adapter) {
      session.agentInstance.onPermissionRequest = async (request) => {
        const allowOption = request.options.find(o => o.isAllow)
        log.debug({ sessionId: session.id, permissionId: request.id, option: allowOption?.id }, 'Auto-approving permission for API session')
        return allowOption?.id ?? request.options[0]?.id ?? ''
      }
    }

    // Warmup in background so session moves from 'initializing' to 'active'
    session.warmup().catch(err => log.warn({ err, sessionId: session.id }, 'API session warmup failed'))

    this.sendJson(res, 200, {
      sessionId: session.id,
      agent: session.agentName,
      status: session.status,
      workspace: session.workingDirectory,
    })
  }

  private async handleCancelSession(sessionId: string, res: http.ServerResponse): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId)
    if (!session) {
      this.sendJson(res, 404, { error: `Session "${sessionId}" not found` })
      return
    }
    await session.cancel()
    this.sendJson(res, 200, { ok: true })
  }

  private async handleListSessions(res: http.ServerResponse): Promise<void> {
    const sessions = this.core.sessionManager.listSessions()
    this.sendJson(res, 200, {
      sessions: sessions.map(s => ({
        id: s.id,
        agent: s.agentName,
        status: s.status,
        name: s.name ?? null,
        workspace: s.workingDirectory,
      })),
    })
  }

  private async handleListAgents(res: http.ServerResponse): Promise<void> {
    const agents = this.core.agentManager.getAvailableAgents()
    const defaultAgent = this.core.configManager.get().defaultAgent
    this.sendJson(res, 200, {
      agents: agents.map(a => ({
        name: a.name,
        command: a.command,
        args: a.args,
      })),
      default: defaultAgent,
    })
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => resolve(data))
      req.on('error', () => resolve(''))
    })
  }
}
