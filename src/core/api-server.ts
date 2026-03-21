import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { OpenACPCore } from './core.js'
import type { TopicManager } from './topic-manager.js'
import { createChildLogger } from './log.js'
import { getAgentCapabilities } from './agent-registry.js'

const log = createChildLogger({ module: 'api-server' })

const DEFAULT_PORT_FILE = path.join(os.homedir(), '.openacp', 'api.port')

let cachedVersion: string | undefined

function getVersion(): string {
  if (cachedVersion) return cachedVersion
  try {
    const __filename = fileURLToPath(import.meta.url)
    const pkgPath = path.resolve(path.dirname(__filename), '../../package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    cachedVersion = pkg.version ?? '0.0.0-dev'
  } catch {
    cachedVersion = '0.0.0-dev'
  }
  return cachedVersion!
}

const SENSITIVE_KEYS = ['botToken', 'token', 'apiKey', 'secret', 'password', 'webhookSecret']

function redactConfig(config: unknown): unknown {
  const redacted = structuredClone(config)
  redactDeep(redacted as Record<string, unknown>)
  return redacted
}

function redactDeep(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.includes(key) && typeof value === 'string') {
      obj[key] = '***'
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      redactDeep(value as Record<string, unknown>)
    }
  }
}

export interface ApiConfig {
  port: number
  host: string
}

export class ApiServer {
  private server: http.Server | null = null
  private actualPort: number = 0
  private portFilePath: string
  private startedAt = Date.now()

  constructor(
    private core: OpenACPCore,
    private config: ApiConfig,
    portFilePath?: string,
    private topicManager?: TopicManager,
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
      if (method === 'POST' && url === '/api/sessions/adopt') {
        await this.handleAdoptSession(req, res)
      } else if (method === 'POST' && url === '/api/sessions') {
        await this.handleCreateSession(req, res)
      } else if (method === 'POST' && url.match(/^\/api\/sessions\/([^/]+)\/prompt$/)) {
        const sessionId = decodeURIComponent(url.match(/^\/api\/sessions\/([^/]+)\/prompt$/)![1])
        await this.handleSendPrompt(sessionId, req, res)
      } else if (method === 'PATCH' && url.match(/^\/api\/sessions\/([^/]+)\/dangerous$/)) {
        const sessionId = decodeURIComponent(url.match(/^\/api\/sessions\/([^/]+)\/dangerous$/)![1])
        await this.handleToggleDangerous(sessionId, req, res)
      } else if (method === 'GET' && url.match(/^\/api\/sessions\/([^/]+)$/)) {
        const sessionId = decodeURIComponent(url.match(/^\/api\/sessions\/([^/]+)$/)![1])
        await this.handleGetSession(sessionId, res)
      } else if (method === 'DELETE' && url.match(/^\/api\/sessions\/([^/]+)$/)) {
        const sessionId = decodeURIComponent(url.match(/^\/api\/sessions\/([^/]+)$/)![1])
        await this.handleCancelSession(sessionId, res)
      } else if (method === 'GET' && url === '/api/sessions') {
        await this.handleListSessions(res)
      } else if (method === 'GET' && url === '/api/agents') {
        await this.handleListAgents(res)
      } else if (method === 'GET' && url === '/api/health') {
        await this.handleHealth(res)
      } else if (method === 'GET' && url === '/api/version') {
        await this.handleVersion(res)
      } else if (method === 'GET' && url === '/api/config') {
        await this.handleGetConfig(res)
      } else if (method === 'PATCH' && url === '/api/config') {
        await this.handleUpdateConfig(req, res)
      } else if (method === 'GET' && url === '/api/adapters') {
        await this.handleListAdapters(res)
      } else if (method === 'GET' && url === '/api/tunnel') {
        await this.handleTunnelStatus(res)
      } else if (method === 'POST' && url === '/api/notify') {
        await this.handleNotify(req, res)
      } else if (method === 'POST' && url === '/api/restart') {
        await this.handleRestart(res)
      } else if (method === 'GET' && url.match(/^\/api\/topics(\?.*)?$/)) {
        await this.handleListTopics(url, res)
      } else if (method === 'POST' && url === '/api/topics/cleanup') {
        await this.handleCleanupTopics(req, res)
      } else if (method === 'DELETE' && url.match(/^\/api\/topics\/([^/?]+)/)) {
        const match = url.match(/^\/api\/topics\/([^/?]+)/)!
        await this.handleDeleteTopic(decodeURIComponent(match[1]), url, res)
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

  private async handleSendPrompt(sessionId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId)
    if (!session) {
      this.sendJson(res, 404, { error: `Session "${sessionId}" not found` })
      return
    }

    if (session.status === 'cancelled' || session.status === 'finished' || session.status === 'error') {
      this.sendJson(res, 400, { error: `Session is ${session.status}` })
      return
    }

    const body = await this.readBody(req)
    let prompt: string | undefined
    if (body) {
      try {
        const parsed = JSON.parse(body)
        prompt = parsed.prompt
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON body' })
        return
      }
    }

    if (!prompt) {
      this.sendJson(res, 400, { error: 'Missing prompt' })
      return
    }

    session.enqueuePrompt(prompt).catch(() => {})
    this.sendJson(res, 200, { ok: true, sessionId, queueDepth: session.queueDepth })
  }

  private async handleGetSession(sessionId: string, res: http.ServerResponse): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId)
    if (!session) {
      this.sendJson(res, 404, { error: `Session "${sessionId}" not found` })
      return
    }

    this.sendJson(res, 200, {
      session: {
        id: session.id,
        agent: session.agentName,
        status: session.status,
        name: session.name ?? null,
        workspace: session.workingDirectory,
        createdAt: session.createdAt.toISOString(),
        dangerousMode: session.dangerousMode,
        queueDepth: session.queueDepth,
        promptRunning: session.promptRunning,
        threadId: session.threadId,
        channelId: session.channelId,
        agentSessionId: session.agentSessionId,
      },
    })
  }

  private async handleToggleDangerous(sessionId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId)
    if (!session) {
      this.sendJson(res, 404, { error: `Session "${sessionId}" not found` })
      return
    }

    const body = await this.readBody(req)
    let enabled: boolean | undefined
    if (body) {
      try {
        const parsed = JSON.parse(body)
        enabled = parsed.enabled
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON body' })
        return
      }
    }

    if (typeof enabled !== 'boolean') {
      this.sendJson(res, 400, { error: 'Missing enabled boolean' })
      return
    }

    session.dangerousMode = enabled
    await this.core.sessionManager.updateSessionDangerousMode(sessionId, enabled)
    this.sendJson(res, 200, { ok: true, dangerousMode: enabled })
  }

  private async handleHealth(res: http.ServerResponse): Promise<void> {
    const activeSessions = this.core.sessionManager.listSessions()
    const allRecords = this.core.sessionManager.listRecords()
    const mem = process.memoryUsage()
    const tunnel = this.core.tunnelService

    this.sendJson(res, 200, {
      status: 'ok',
      uptime: Date.now() - this.startedAt,
      version: getVersion(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      sessions: {
        active: activeSessions.filter(s => s.status === 'active' || s.status === 'initializing').length,
        total: allRecords.length,
      },
      adapters: Array.from(this.core.adapters.keys()),
      tunnel: tunnel ? { enabled: true, url: tunnel.getPublicUrl() } : { enabled: false },
    })
  }

  private async handleVersion(res: http.ServerResponse): Promise<void> {
    this.sendJson(res, 200, { version: getVersion() })
  }

  private async handleGetConfig(res: http.ServerResponse): Promise<void> {
    const config = this.core.configManager.get()
    this.sendJson(res, 200, { config: redactConfig(config) })
  }

  private async handleUpdateConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    let configPath: string | undefined
    let value: unknown

    if (body) {
      try {
        const parsed = JSON.parse(body)
        configPath = parsed.path
        value = parsed.value
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON body' })
        return
      }
    }

    if (!configPath) {
      this.sendJson(res, 400, { error: 'Missing path' })
      return
    }

    // Pre-validate by cloning config and applying the change
    const currentConfig = this.core.configManager.get()
    const cloned = structuredClone(currentConfig) as Record<string, unknown>
    const parts = configPath.split('.')
    let target: Record<string, unknown> = cloned
    for (let i = 0; i < parts.length - 1; i++) {
      if (target[parts[i]] && typeof target[parts[i]] === 'object' && !Array.isArray(target[parts[i]])) {
        target = target[parts[i]] as Record<string, unknown>
      } else {
        this.sendJson(res, 400, { error: 'Invalid config path' })
        return
      }
    }

    const lastKey = parts[parts.length - 1]
    if (!(lastKey in target)) {
      this.sendJson(res, 400, { error: 'Invalid config path' })
      return
    }

    target[lastKey] = value

    // Validate with Zod
    const { ConfigSchema } = await import('./config.js')
    const result = ConfigSchema.safeParse(cloned)
    if (!result.success) {
      this.sendJson(res, 400, {
        error: 'Validation failed',
        details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      })
      return
    }

    // Convert dot-path to nested object for save
    const updates: Record<string, unknown> = {}
    let updateTarget = updates
    for (let i = 0; i < parts.length - 1; i++) {
      updateTarget[parts[i]] = {}
      updateTarget = updateTarget[parts[i]] as Record<string, unknown>
    }
    updateTarget[lastKey] = value

    await this.core.configManager.save(updates)

    const RESTART_PREFIXES = ['api.port', 'api.host', 'runMode', 'channels.', 'tunnel.', 'agents.']
    const needsRestart = RESTART_PREFIXES.some(prefix =>
      configPath!.startsWith(prefix) ||
      configPath === prefix.replace(/\.$/, '') // exact match for non-wildcard
    )

    this.sendJson(res, 200, {
      ok: true,
      needsRestart,
      config: redactConfig(this.core.configManager.get()),
    })
  }

  private async handleListAdapters(res: http.ServerResponse): Promise<void> {
    const adapters = Array.from(this.core.adapters.entries()).map(([name]) => ({
      name,
      type: 'built-in' as const,
    }))
    this.sendJson(res, 200, { adapters })
  }

  private async handleTunnelStatus(res: http.ServerResponse): Promise<void> {
    const tunnel = this.core.tunnelService
    if (tunnel) {
      this.sendJson(res, 200, { enabled: true, url: tunnel.getPublicUrl(), provider: this.core.configManager.get().tunnel.provider })
    } else {
      this.sendJson(res, 200, { enabled: false })
    }
  }

  private async handleNotify(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    let message: string | undefined
    if (body) {
      try {
        const parsed = JSON.parse(body)
        message = parsed.message
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON body' })
        return
      }
    }

    if (!message) {
      this.sendJson(res, 400, { error: 'Missing message' })
      return
    }

    await this.core.notificationManager.notifyAll({
      sessionId: 'system',
      type: 'completed',
      summary: message,
    })
    this.sendJson(res, 200, { ok: true })
  }

  private async handleRestart(res: http.ServerResponse): Promise<void> {
    if (!this.core.requestRestart) {
      this.sendJson(res, 501, { error: 'Restart not available' })
      return
    }

    this.sendJson(res, 200, { ok: true, message: 'Restarting...' })
    setImmediate(() => this.core.requestRestart!())
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

  private async handleAdoptSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    if (!body) {
      return this.sendJson(res, 400, { error: 'bad_request', message: 'Empty request body' })
    }

    let parsed: { agent?: string; agentSessionId?: string; cwd?: string }
    try {
      parsed = JSON.parse(body)
    } catch {
      return this.sendJson(res, 400, { error: 'bad_request', message: 'Invalid JSON' })
    }

    const { agent, agentSessionId, cwd } = parsed

    if (!agent || !agentSessionId) {
      return this.sendJson(res, 400, { error: 'bad_request', message: 'Missing required fields: agent, agentSessionId' })
    }

    const result = await this.core.adoptSession(agent, agentSessionId, cwd ?? process.cwd())

    if (result.ok) {
      return this.sendJson(res, 200, result)
    } else {
      const status = result.error === 'session_limit' ? 429 : result.error === 'agent_not_supported' ? 400 : 500
      return this.sendJson(res, status, result)
    }
  }

  private async handleListAgents(res: http.ServerResponse): Promise<void> {
    const agents = this.core.agentManager.getAvailableAgents()
    const defaultAgent = this.core.configManager.get().defaultAgent
    const agentsWithCaps = agents.map((a) => ({
      ...a,
      capabilities: getAgentCapabilities(a.name),
    }))
    this.sendJson(res, 200, { agents: agentsWithCaps, default: defaultAgent })
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private async handleListTopics(url: string, res: http.ServerResponse): Promise<void> {
    if (!this.topicManager) { this.sendJson(res, 501, { error: 'Topic management not available' }); return }
    const params = new URL(url, 'http://localhost').searchParams
    const statusParam = params.get('status')
    const filter = statusParam ? { statuses: statusParam.split(',') } : undefined
    const topics = this.topicManager.listTopics(filter)
    this.sendJson(res, 200, { topics })
  }

  private async handleDeleteTopic(sessionId: string, url: string, res: http.ServerResponse): Promise<void> {
    if (!this.topicManager) { this.sendJson(res, 501, { error: 'Topic management not available' }); return }
    const params = new URL(url, 'http://localhost').searchParams
    const force = params.get('force') === 'true'
    const result = await this.topicManager.deleteTopic(sessionId, force ? { confirmed: true } : undefined)
    if (result.ok) {
      this.sendJson(res, 200, result)
    } else if (result.needsConfirmation) {
      this.sendJson(res, 409, { error: 'Session is active', needsConfirmation: true, session: result.session })
    } else if (result.error === 'Cannot delete system topic') {
      this.sendJson(res, 403, { error: result.error })
    } else {
      this.sendJson(res, 404, { error: result.error ?? 'Not found' })
    }
  }

  private async handleCleanupTopics(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.topicManager) { this.sendJson(res, 501, { error: 'Topic management not available' }); return }
    const body = await this.readBody(req)
    let statuses: string[] | undefined
    if (body) {
      try { statuses = JSON.parse(body).statuses } catch { /* use defaults */ }
    }
    const result = await this.topicManager.cleanup(statuses)
    this.sendJson(res, 200, result)
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
