import path from "node:path";
import os from "node:os";
import { ConfigManager } from "./config.js";
import { AgentManager } from "./agent-manager.js";
import { SessionManager } from "./session-manager.js";
import { NotificationManager } from "./notification.js";
import { ChannelAdapter } from "./channel.js";
import { Session } from "./session.js";
import { MessageTransformer } from "./message-transformer.js";
import { JsonFileSessionStore, type SessionStore } from "./session-store.js";
import type {
  IncomingMessage,
  AgentEvent,
  PermissionRequest,
} from "./types.js";
import type { TunnelService } from "../tunnel/tunnel-service.js";
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
    this.sessionManager.updateSessionActivity(session.id);

    // Forward to session
    await session.enqueuePrompt(message.text);
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

    const session = await this.sessionManager.createSession(
      channelId,
      resolvedAgent,
      resolvedWorkspace,
      this.agentManager,
    );

    // Wire events
    const adapter = this.adapters.get(channelId);
    if (adapter) {
      this.wireSessionEvents(session, adapter);
    }

    return session;
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
        const agentInstance = await this.agentManager.resume(
          record.agentName,
          record.workingDir,
          record.agentSessionId,
        );

        const session = new Session({
          id: record.sessionId,
          channelId: record.channelId,
          agentName: record.agentName,
          workingDirectory: record.workingDir,
          agentInstance,
        });
        session.threadId = message.threadId;
        session.agentSessionId = agentInstance.sessionId;
        session.status = "active";
        session.name = record.name;

        this.sessionManager.registerSession(session);

        const adapter = this.adapters.get(message.channelId);
        if (adapter) {
          this.wireSessionEvents(session, adapter);
        }

        // Update store with new agentSessionId (may differ after resume)
        await store.save({
          ...record,
          agentSessionId: agentInstance.sessionId,
          status: "active",
          lastActiveAt: new Date().toISOString(),
        });

        log.info(
          { sessionId: session.id, threadId: message.threadId },
          "Lazy resume successful",
        );
        return session;
      } catch (err) {
        log.error({ err, record }, "Lazy resume failed");
        return null;
      } finally {
        this.resumeLocks.delete(lockKey);
      }
    })();

    this.resumeLocks.set(lockKey, resumePromise);
    return resumePromise;
  }

  // --- Event Wiring ---

  // Public — adapters call this for assistant session wiring
  wireSessionEvents(session: Session, adapter: ChannelAdapter): void {
    // Set adapter reference for autoName → renameSessionThread
    session.adapter = adapter;

    // Wire AgentInstance callbacks → Session event emitter
    session.agentInstance.onSessionUpdate = (event: AgentEvent) => {
      session.emit("agent_event", event);
    };

    session.agentInstance.onPermissionRequest = async (
      request: PermissionRequest,
    ) => {
      session.emit("permission_request", request);

      // Set pending BEFORE sending UI to avoid race condition
      const promise = session.permissionGate.setPending(request);

      // Send permission UI to session topic (notification is sent by adapter)
      await adapter.sendPermissionRequest(session.id, request);

      // Wait for user response — adapter resolves this promise
      return promise;
    };

    const sessionContext = {
      get id() { return session.id; },
      get workingDirectory() { return session.workingDirectory; },
    };

    // Subscribe to Session events for adapter delivery
    session.on("agent_event", (event: AgentEvent) => {
      switch (event.type) {
        case "text":
        case "thought":
        case "tool_call":
        case "tool_update":
        case "plan":
        case "usage":
          adapter.sendMessage(
            session.id,
            this.messageTransformer.transform(event, sessionContext),
          );
          break;

        case "session_end":
          session.status = "finished";
          this.sessionManager.updateSessionStatus(session.id, "finished");
          adapter.cleanupSkillCommands(session.id);
          adapter.sendMessage(
            session.id,
            this.messageTransformer.transform(event),
          );
          this.notificationManager.notify(session.channelId, {
            sessionId: session.id,
            sessionName: session.name,
            type: "completed",
            summary: `Session "${session.name || session.id}" completed`,
          });
          break;

        case "error":
          this.sessionManager.updateSessionStatus(session.id, "error");
          adapter.cleanupSkillCommands(session.id);
          adapter.sendMessage(
            session.id,
            this.messageTransformer.transform(event),
          );
          this.notificationManager.notify(session.channelId, {
            sessionId: session.id,
            sessionName: session.name,
            type: "error",
            summary: event.message,
          });
          break;

        case "commands_update":
          log.debug({ commands: event.commands }, "Commands available");
          adapter.sendSkillCommands(session.id, event.commands);
          break;
      }
    });
  }
}
