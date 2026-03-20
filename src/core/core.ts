import { ConfigManager } from './config.js'
import { AgentManager } from './agent-manager.js'
import { SessionManager } from './session-manager.js'
import { NotificationManager } from './notification.js'
import { ChannelAdapter } from './channel.js'
import { Session } from './session.js'
import type { IncomingMessage, AgentEvent, OutgoingMessage, PermissionRequest } from './types.js'
import type { TunnelService } from '../tunnel/tunnel-service.js'
import { extractFileInfo } from '../tunnel/extract-file-info.js'
import { createChildLogger } from './log.js'
const log = createChildLogger({ module: 'core' })

export class OpenACPCore {
  configManager: ConfigManager
  agentManager: AgentManager
  sessionManager: SessionManager
  notificationManager: NotificationManager
  adapters: Map<string, ChannelAdapter> = new Map()
  tunnelService?: TunnelService

  constructor(configManager: ConfigManager) {
    this.configManager = configManager
    const config = configManager.get()
    this.agentManager = new AgentManager(config)
    this.sessionManager = new SessionManager()
    this.notificationManager = new NotificationManager(this.adapters)
  }

  registerAdapter(name: string, adapter: ChannelAdapter): void {
    this.adapters.set(name, adapter)
  }

  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start()
    }
  }

  async stop(): Promise<void> {
    // 1. Notify users
    try {
      await this.notificationManager.notifyAll({
        sessionId: 'system',
        type: 'error',
        summary: 'OpenACP is shutting down',
      })
    } catch { /* best effort */ }

    // 2. Destroy all sessions
    await this.sessionManager.destroyAll()

    // 3. Stop adapters
    for (const adapter of this.adapters.values()) {
      await adapter.stop()
    }
  }

  // --- Message Routing ---

  async handleMessage(message: IncomingMessage): Promise<void> {
    const config = this.configManager.get()
    log.debug({ channelId: message.channelId, threadId: message.threadId, userId: message.userId }, 'Incoming message')

    // Security: check allowed user IDs
    if (config.security.allowedUserIds.length > 0) {
      if (!config.security.allowedUserIds.includes(message.userId)) {
        log.warn({ userId: message.userId }, 'Rejected message from unauthorized user')
        return
      }
    }

    // Check concurrent session limit
    const activeSessions = this.sessionManager.listSessions()
      .filter(s => s.status === 'active' || s.status === 'initializing')
    if (activeSessions.length >= config.security.maxConcurrentSessions) {
      log.warn({ userId: message.userId, currentCount: activeSessions.length, max: config.security.maxConcurrentSessions }, 'Session limit reached')
      const adapter = this.adapters.get(message.channelId)
      if (adapter) {
        await adapter.sendMessage('system', {
          type: 'error',
          text: `Max concurrent sessions (${config.security.maxConcurrentSessions}) reached. Cancel a session first.`,
        })
      }
      return
    }

    // Find session by thread
    const session = this.sessionManager.getSessionByThread(message.channelId, message.threadId)
    if (!session) return

    // Forward to session
    await session.enqueuePrompt(message.text)
  }

  async handleNewSession(
    channelId: string,
    agentName?: string,
    workspacePath?: string,
  ): Promise<Session> {
    const config = this.configManager.get()
    const resolvedAgent = agentName || config.defaultAgent
    log.info({ channelId, agentName: resolvedAgent }, 'New session request')
    const resolvedWorkspace = this.configManager.resolveWorkspace(
      workspacePath || config.agents[resolvedAgent]?.workingDirectory
    )

    const session = await this.sessionManager.createSession(
      channelId, resolvedAgent, resolvedWorkspace, this.agentManager
    )

    // Wire events
    const adapter = this.adapters.get(channelId)
    if (adapter) {
      this.wireSessionEvents(session, adapter)
    }

    return session
  }

  async handleNewChat(
    channelId: string,
    currentThreadId: string,
  ): Promise<Session | null> {
    const currentSession = this.sessionManager.getSessionByThread(channelId, currentThreadId)
    if (!currentSession) return null

    return this.handleNewSession(
      channelId,
      currentSession.agentName,
      currentSession.workingDirectory,
    )
  }

  // --- Event Wiring ---

  private toOutgoingMessage(event: AgentEvent, session?: Session): OutgoingMessage {
    switch (event.type) {
      case 'text':
        return { type: 'text', text: event.content }
      case 'thought':
        return { type: 'thought', text: event.content }
      case 'tool_call': {
        const metadata: Record<string, unknown> = { id: event.id, kind: event.kind, status: event.status, content: event.content, locations: event.locations }
        this.enrichWithViewerLinks(event, metadata, session)
        return { type: 'tool_call', text: event.name, metadata }
      }
      case 'tool_update': {
        const metadata: Record<string, unknown> = { id: event.id, status: event.status, content: event.content }
        this.enrichWithViewerLinks(event, metadata, session)
        return { type: 'tool_update', text: '', metadata }
      }
      case 'plan':
        return { type: 'plan', text: '', metadata: { entries: event.entries } }
      case 'usage':
        return { type: 'usage', text: '', metadata: { tokensUsed: event.tokensUsed, contextSize: event.contextSize, cost: event.cost } }
      default:
        return { type: 'text', text: '' }
    }
  }

  private enrichWithViewerLinks(
    event: AgentEvent & { type: 'tool_call' | 'tool_update' },
    metadata: Record<string, unknown>,
    session?: Session,
  ): void {
    if (!this.tunnelService || !session) return

    const name = 'name' in event ? (event.name || '') : ''
    const kind = 'kind' in event ? event.kind : undefined

    log.debug({ name, kind, status: event.status, hasContent: !!event.content }, 'enrichWithViewerLinks: inspecting event')

    const fileInfo = extractFileInfo(name, kind, event.content)
    if (!fileInfo) return

    log.info({ name, kind, filePath: fileInfo.filePath, hasOldContent: !!fileInfo.oldContent }, 'enrichWithViewerLinks: extracted file info')

    const store = this.tunnelService.getStore()
    const viewerLinks: Record<string, string> = {}

    // For edits/writes with diff data (oldText + newText)
    if (fileInfo.oldContent) {
      const id = store.storeDiff(session.id, fileInfo.filePath, fileInfo.oldContent, fileInfo.content, session.workingDirectory)
      if (id) viewerLinks.diff = this.tunnelService.diffUrl(id)
    }

    // Always store as file view (new file creation or read)
    const id = store.storeFile(session.id, fileInfo.filePath, fileInfo.content, session.workingDirectory)
    if (id) viewerLinks.file = this.tunnelService.fileUrl(id)

    if (Object.keys(viewerLinks).length > 0) {
      metadata.viewerLinks = viewerLinks
    }
  }

  // Public — adapters call this for assistant session wiring
  wireSessionEvents(session: Session, adapter: ChannelAdapter): void {
    // Set adapter reference for autoName → renameSessionThread
    session.adapter = adapter

    session.agentInstance.onSessionUpdate = (event: AgentEvent) => {
      switch (event.type) {
        case 'text':
        case 'thought':
        case 'tool_call':
        case 'tool_update':
        case 'plan':
        case 'usage':
          adapter.sendMessage(session.id, this.toOutgoingMessage(event, session))
          break

        case 'session_end':
          session.status = 'finished'
          adapter.cleanupSkillCommands(session.id)
          adapter.sendMessage(session.id, { type: 'session_end', text: `Done (${event.reason})` })
          this.notificationManager.notify(session.channelId, {
            sessionId: session.id,
            sessionName: session.name,
            type: 'completed',
            summary: `Session "${session.name || session.id}" completed`,
          })
          break

        case 'error':
          adapter.cleanupSkillCommands(session.id)
          adapter.sendMessage(session.id, { type: 'error', text: event.message })
          this.notificationManager.notify(session.channelId, {
            sessionId: session.id,
            sessionName: session.name,
            type: 'error',
            summary: event.message,
          })
          break

        case 'commands_update':
          log.debug({ commands: event.commands }, 'Commands available')
          adapter.sendSkillCommands(session.id, event.commands)
          break
      }
    }

    session.agentInstance.onPermissionRequest = async (request: PermissionRequest) => {
      // Set pending BEFORE sending UI to avoid race condition
      const promise = new Promise<string>((resolve) => {
        session.pendingPermission = { requestId: request.id, resolve }
      })

      // Send permission UI to session topic (notification is sent by adapter)
      await adapter.sendPermissionRequest(session.id, request)

      // Wait for user response — adapter resolves this promise
      return promise
    }
  }
}
