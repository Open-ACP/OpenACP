import type { Session } from "./session.js";
import type { ChannelAdapter } from "./channel.js";
import type { MessageTransformer } from "./message-transformer.js";
import type { NotificationManager } from "./notification.js";
import type { SessionManager } from "./session-manager.js";
import type { AgentEvent, PermissionRequest, SessionStatus } from "./types.js";
import { createChildLogger } from "./log.js";

const log = createChildLogger({ module: "session-bridge" });

export interface BridgeDeps {
  messageTransformer: MessageTransformer;
  notificationManager: NotificationManager;
  sessionManager: SessionManager;
}

export class SessionBridge {
  private connected = false;
  private agentEventHandler?: (event: AgentEvent) => void;
  private statusChangeHandler?: (from: SessionStatus, to: SessionStatus) => void;
  private namedHandler?: (name: string) => void;

  constructor(
    private session: Session,
    private adapter: ChannelAdapter,
    private deps: BridgeDeps,
  ) {}

  connect(): void {
    if (this.connected) return;
    this.connected = true;

    this.wireAgentToSession();
    this.wireSessionToAdapter();
    this.wirePermissions();
    this.wireLifecycle();
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;

    if (this.agentEventHandler) {
      this.session.off("agent_event", this.agentEventHandler);
    }
    if (this.statusChangeHandler) {
      this.session.off("status_change", this.statusChangeHandler);
    }
    if (this.namedHandler) {
      this.session.off("named", this.namedHandler);
    }

    // Reset agent callbacks to no-op
    this.session.agentInstance.onSessionUpdate = () => {};
    this.session.agentInstance.onPermissionRequest = async () => "";
  }

  private wireAgentToSession(): void {
    this.session.agentInstance.onSessionUpdate = (event: AgentEvent) => {
      this.session.emit("agent_event", event);
    };
  }

  private wireSessionToAdapter(): void {
    const session = this.session;
    const ctx = {
      get id() { return session.id; },
      get workingDirectory() { return session.workingDirectory; },
    };

    this.agentEventHandler = (event: AgentEvent) => {
      switch (event.type) {
        case "text":
        case "thought":
        case "tool_call":
        case "tool_update":
        case "plan":
        case "usage":
          this.adapter.sendMessage(
            this.session.id,
            this.deps.messageTransformer.transform(event, ctx),
          );
          break;

        case "session_end":
          this.session.finish(event.reason);
          this.adapter.cleanupSkillCommands(this.session.id);
          this.adapter.sendMessage(
            this.session.id,
            this.deps.messageTransformer.transform(event),
          );
          this.deps.notificationManager.notify(this.session.channelId, {
            sessionId: this.session.id,
            sessionName: this.session.name,
            type: "completed",
            summary: `Session "${this.session.name || this.session.id}" completed`,
          });
          break;

        case "error":
          this.session.fail(event.message);
          this.adapter.cleanupSkillCommands(this.session.id);
          this.adapter.sendMessage(
            this.session.id,
            this.deps.messageTransformer.transform(event),
          );
          this.deps.notificationManager.notify(this.session.channelId, {
            sessionId: this.session.id,
            sessionName: this.session.name,
            type: "error",
            summary: event.message,
          });
          break;

        case "commands_update":
          log.debug({ commands: event.commands }, "Commands available");
          this.adapter.sendSkillCommands(this.session.id, event.commands);
          break;
      }
    };

    this.session.on("agent_event", this.agentEventHandler);
  }

  private wirePermissions(): void {
    this.session.agentInstance.onPermissionRequest = async (
      request: PermissionRequest,
    ) => {
      this.session.emit("permission_request", request);

      // Set pending BEFORE sending UI to avoid race condition
      const promise = this.session.permissionGate.setPending(request);

      // Send permission UI to session topic
      await this.adapter.sendPermissionRequest(this.session.id, request);

      // Wait for user response — adapter resolves this promise
      return promise;
    };
  }

  private wireLifecycle(): void {
    // Persist status changes and auto-disconnect on terminal states
    this.statusChangeHandler = (from: SessionStatus, to: SessionStatus) => {
      this.deps.sessionManager.patchRecord(this.session.id, {
        status: to,
        lastActiveAt: new Date().toISOString(),
      });

      // Auto-disconnect on terminal states
      if (to === "finished" || to === "cancelled") {
        // Disconnect on next tick so current event handlers can complete
        queueMicrotask(() => this.disconnect());
      }
    };
    this.session.on("status_change", this.statusChangeHandler);

    // Persist and relay name changes
    this.namedHandler = (name: string) => {
      this.deps.sessionManager.patchRecord(this.session.id, { name });
      this.adapter.renameSessionThread(this.session.id, name);
    };
    this.session.on("named", this.namedHandler);
  }
}
