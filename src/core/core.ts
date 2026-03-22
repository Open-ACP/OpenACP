import path from "node:path";
import os from "node:os";
import { ConfigManager } from "./config.js";
import { AgentManager } from "./agent-manager.js";
import { SessionManager } from "./session-manager.js";
import { SessionBridge } from "./session-bridge.js";
import { NotificationManager } from "./notification.js";
import { ChannelAdapter } from "./channel.js";
import { Session } from "./session.js";
import { MessageTransformer } from "./message-transformer.js";
import { JsonFileSessionStore, type SessionStore } from "./session-store.js";
import type { IncomingMessage } from "./types.js";
import type { TunnelService } from "../tunnel/tunnel-service.js";
import { getAgentCapabilities } from "./agent-registry.js";
import { createChildLogger } from "./log.js";
const log = createChildLogger({ module: "core" });

export class OpenACPCore {
  configManager: ConfigManager;
  agentManager: AgentManager;
  sessionManager: SessionManager;
  notificationManager: NotificationManager;
  messageTransformer: MessageTransformer;
  adapters: Map<string, ChannelAdapter> = new Map();
  /** Set by main.ts — triggers graceful shutdown with restart exit code */
  requestRestart: (() => Promise<void>) | null = null;
  private _tunnelService?: TunnelService;
  private sessionStore: SessionStore | null = null;
  private resumeLocks: Map<string, Promise<Session | null>> = new Map();

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
    const config = configManager.get();
    this.agentManager = new AgentManager(config);
    const storePath = path.join(os.homedir(), ".openacp", "sessions.json");
    this.sessionStore = new JsonFileSessionStore(
      storePath,
      config.sessionStore.ttlDays,
    );
    this.sessionManager = new SessionManager(this.sessionStore);
    this.notificationManager = new NotificationManager(this.adapters);
    this.messageTransformer = new MessageTransformer();

    // Hot-reload: handle config changes that need side effects
    this.configManager.on('config:changed', async ({ path: configPath, value }: { path: string; value: unknown }) => {
      if (configPath === 'logging.level' && typeof value === 'string') {
        const { setLogLevel } = await import('./log.js')
        setLogLevel(value)
        log.info({ level: value }, 'Log level changed at runtime')
      }
    })
  }

  get tunnelService(): TunnelService | undefined {
    return this._tunnelService;
  }

  set tunnelService(service: TunnelService | undefined) {
    this._tunnelService = service;
    this.messageTransformer = new MessageTransformer(service);
  }

  registerAdapter(name: string, adapter: ChannelAdapter): void {
    this.adapters.set(name, adapter);
  }

  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start();
    }
  }

  async stop(): Promise<void> {
    // 1. Notify users
    try {
      await this.notificationManager.notifyAll({
        sessionId: "system",
        type: "error",
        summary: "OpenACP is shutting down",
      });
    } catch {
      /* best effort */
    }

    // 2. Destroy all sessions
    await this.sessionManager.destroyAll();

    // 3. Stop adapters
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  // --- Message Routing ---

  async handleMessage(message: IncomingMessage): Promise<void> {
    const config = this.configManager.get();
    log.debug(
      {
        channelId: message.channelId,
        threadId: message.threadId,
        userId: message.userId,
      },
      "Incoming message",
    );

    // Security: check allowed user IDs
    if (config.security.allowedUserIds.length > 0) {
      if (!config.security.allowedUserIds.includes(message.userId)) {
        log.warn(
          { userId: message.userId },
          "Rejected message from unauthorized user",
        );
        return;
      }
    }

    // Check concurrent session limit
    const activeSessions = this.sessionManager
      .listSessions()
      .filter((s) => s.status === "active" || s.status === "initializing");
    if (activeSessions.length >= config.security.maxConcurrentSessions) {
      log.warn(
        {
          userId: message.userId,
          currentCount: activeSessions.length,
          max: config.security.maxConcurrentSessions,
        },
        "Session limit reached",
      );
      const adapter = this.adapters.get(message.channelId);
      if (adapter) {
        await adapter.sendMessage(message.threadId, {
          type: "error",
          text: `⚠️ Session limit reached (${config.security.maxConcurrentSessions}). Please cancel existing sessions with /cancel before starting new ones.`,
        });
      }
      return;
    }

    // Find session by thread
    let session = this.sessionManager.getSessionByThread(
      message.channelId,
      message.threadId,
    );

    // Lazy resume: try to restore session from store
    if (!session) {
      session = (await this.lazyResume(message)) ?? undefined;
    }

    if (!session) return;

    // Update activity timestamp
    this.sessionManager.patchRecord(session.id, { lastActiveAt: new Date().toISOString() });

    // Forward to session
    await session.enqueuePrompt(message.text);
  }

  // --- Unified Session Creation Pipeline ---

  async createSession(params: {
    channelId: string;
    agentName: string;
    workingDirectory: string;
    resumeAgentSessionId?: string;
    existingSessionId?: string;
    createThread?: boolean;
    initialName?: string;
  }): Promise<Session> {
    // 1. Spawn or resume agent
    const agentInstance = params.resumeAgentSessionId
      ? await this.agentManager.resume(
          params.agentName,
          params.workingDirectory,
          params.resumeAgentSessionId,
        )
      : await this.agentManager.spawn(
          params.agentName,
          params.workingDirectory,
        );

    // 2. Create Session instance
    const session = new Session({
      id: params.existingSessionId,
      channelId: params.channelId,
      agentName: params.agentName,
      workingDirectory: params.workingDirectory,
      agentInstance,
    });
    session.agentSessionId = agentInstance.sessionId;
    if (params.initialName) {
      session.name = params.initialName;
    }

    // 3. Register in SessionManager
    this.sessionManager.registerSession(session);

    // 4. Create thread if needed
    const adapter = this.adapters.get(params.channelId);
    if (params.createThread && adapter) {
      const threadId = await adapter.createSessionThread(
        session.id,
        params.initialName ?? `🔄 ${params.agentName} — New Session`,
      );
      session.threadId = threadId;
    }

    // 5. Connect SessionBridge
    if (adapter) {
      const bridge = this.createBridge(session, adapter);
      bridge.connect();
    }

    // 6. Persist initial record
    await this.sessionManager.patchRecord(session.id, {
      sessionId: session.id,
      agentSessionId: agentInstance.sessionId,
      agentName: params.agentName,
      workingDir: params.workingDirectory,
      channelId: params.channelId,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: new Date().toISOString(),
      name: session.name,
      platform: {},
    });

    log.info(
      { sessionId: session.id, agentName: params.agentName },
      "Session created via pipeline",
    );
    return session;
  }

  async handleNewSession(
    channelId: string,
    agentName?: string,
    workspacePath?: string,
  ): Promise<Session> {
    const config = this.configManager.get();
    const resolvedAgent = agentName || config.defaultAgent;
    log.info({ channelId, agentName: resolvedAgent }, "New session request");
    const resolvedWorkspace = this.configManager.resolveWorkspace(
      workspacePath || config.agents[resolvedAgent]?.workingDirectory,
    );

    return this.createSession({
      channelId,
      agentName: resolvedAgent,
      workingDirectory: resolvedWorkspace,
    });
  }

  async adoptSession(
    agentName: string,
    agentSessionId: string,
    cwd: string,
  ): Promise<
    | { ok: true; sessionId: string; threadId: string; status: "adopted" | "existing" }
    | { ok: false; error: string; message: string }
  > {
    // 1. Validate agent supports resume
    const caps = getAgentCapabilities(agentName);
    if (!caps.supportsResume) {
      return { ok: false, error: "agent_not_supported", message: `Agent '${agentName}' does not support session resume` };
    }

    const agentDef = this.agentManager.getAgent(agentName);
    if (!agentDef) {
      return { ok: false, error: "agent_not_supported", message: `Agent '${agentName}' not found` };
    }

    // 2. Validate cwd
    const { existsSync } = await import("node:fs");
    if (!existsSync(cwd)) {
      return { ok: false, error: "invalid_cwd", message: `Directory does not exist: ${cwd}` };
    }

    // 3. Check session limit
    const maxSessions = this.configManager.get().security.maxConcurrentSessions;
    if (this.sessionManager.listSessions().length >= maxSessions) {
      return { ok: false, error: "session_limit", message: "Maximum concurrent sessions reached" };
    }

    // 4. Check if session already exists
    const existingRecord = this.sessionManager.getRecordByAgentSessionId(agentSessionId);
    if (existingRecord) {
      const platform = existingRecord.platform as { topicId?: number } | undefined;
      if (platform?.topicId) {
        const adapter = this.adapters.values().next().value;
        if (adapter) {
          try {
            await adapter.sendMessage(existingRecord.sessionId, {
              type: "text",
              text: "Session resumed from CLI.",
            });
          } catch { /* Topic may be deleted */ }
        }
        return {
          ok: true,
          sessionId: existingRecord.sessionId,
          threadId: String(platform.topicId),
          status: "existing",
        };
      }
    }

    // 5. Find default adapter
    const firstEntry = this.adapters.entries().next().value;
    if (!firstEntry) {
      return { ok: false, error: "no_adapter", message: "No channel adapter registered" };
    }
    const [adapterChannelId] = firstEntry;

    // 6. Create session via unified pipeline
    let session: Session;
    try {
      session = await this.createSession({
        channelId: adapterChannelId,
        agentName,
        workingDirectory: cwd,
        resumeAgentSessionId: agentSessionId,
        createThread: true,
        initialName: "Adopted session",
      });
    } catch (err) {
      return {
        ok: false,
        error: "resume_failed",
        message: `Failed to resume session: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 7. Update store with adopt-specific fields
    await this.sessionManager.patchRecord(session.id, {
      originalAgentSessionId: agentSessionId,
      platform: { topicId: Number(session.threadId) },
    });

    return {
      ok: true,
      sessionId: session.id,
      threadId: session.threadId,
      status: "adopted",
    };
  }

  async handleNewChat(
    channelId: string,
    currentThreadId: string,
  ): Promise<Session | null> {
    const currentSession = this.sessionManager.getSessionByThread(
      channelId,
      currentThreadId,
    );

    if (currentSession) {
      return this.handleNewSession(
        channelId,
        currentSession.agentName,
        currentSession.workingDirectory,
      );
    }

    // Fallback: look up from store (e.g. after restart before lazy resume)
    const record = this.sessionManager.getRecordByThread(channelId, currentThreadId);
    if (!record || record.status === "cancelled" || record.status === "error") return null;

    return this.handleNewSession(
      channelId,
      record.agentName,
      record.workingDir,
    );
  }

  // --- Lazy Resume ---

  private async lazyResume(message: IncomingMessage): Promise<Session | null> {
    const store = this.sessionStore;
    if (!store) return null;

    const lockKey = `${message.channelId}:${message.threadId}`;

    // Check for existing resume in progress
    const existing = this.resumeLocks.get(lockKey);
    if (existing) return existing;

    const record = store.findByPlatform(
      message.channelId,
      (p) => String(p.topicId) === message.threadId,
    );
    if (!record) return null;

    // Don't resume cancelled/error sessions
    if (record.status === "cancelled" || record.status === "error") return null;

    const resumePromise = (async (): Promise<Session | null> => {
      try {
        const session = await this.createSession({
          channelId: record.channelId,
          agentName: record.agentName,
          workingDirectory: record.workingDir,
          resumeAgentSessionId: record.agentSessionId,
          existingSessionId: record.sessionId,
          initialName: record.name,
        });
        session.threadId = message.threadId;
        session.activate();
        session.dangerousMode = record.dangerousMode ?? false;

        log.info(
          { sessionId: session.id, threadId: message.threadId },
          "Lazy resume successful",
        );
        return session;
      } catch (err) {
        log.error({ err, record }, "Lazy resume failed");
        // Send error feedback to user instead of silent drop
        const adapter = this.adapters.get(message.channelId);
        if (adapter) {
          try {
            await adapter.sendMessage(message.threadId, {
              type: "error",
              text: `⚠️ Failed to resume session: ${err instanceof Error ? err.message : String(err)}`,
            });
          } catch { /* best effort */ }
        }
        return null;
      } finally {
        this.resumeLocks.delete(lockKey);
      }
    })();

    this.resumeLocks.set(lockKey, resumePromise);
    return resumePromise;
  }

  // --- Event Wiring ---

  /** Create a SessionBridge for the given session and adapter */
  createBridge(session: Session, adapter: ChannelAdapter): SessionBridge {
    return new SessionBridge(session, adapter, {
      messageTransformer: this.messageTransformer,
      notificationManager: this.notificationManager,
      sessionManager: this.sessionManager,
    });
  }

}
