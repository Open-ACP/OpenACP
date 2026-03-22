import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionBridge } from "../session-bridge.js";
import { Session } from "../session.js";
import type { AgentInstance } from "../agent-instance.js";
import type { ChannelAdapter } from "../channel.js";
import type { MessageTransformer } from "../message-transformer.js";
import type { NotificationManager } from "../notification.js";
import type { SessionManager } from "../session-manager.js";
import type { AgentEvent } from "../types.js";

function createMockAgentInstance(): AgentInstance {
  return {
    sessionId: "agent-session-1",
    agentName: "test-agent",
    prompt: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onSessionUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
  } as unknown as AgentInstance;
}

function createMockAdapter(): ChannelAdapter {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPermissionRequest: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendSkillCommands: vi.fn().mockResolvedValue(undefined),
    cleanupSkillCommands: vi.fn().mockResolvedValue(undefined),
    renameSessionThread: vi.fn().mockResolvedValue(undefined),
    createSessionThread: vi.fn().mockResolvedValue("thread-1"),
    deleteSessionThread: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChannelAdapter;
}

function createMockDeps() {
  return {
    messageTransformer: {
      transform: vi.fn().mockReturnValue({ type: "text", text: "transformed" }),
    } as unknown as MessageTransformer,
    notificationManager: {
      notify: vi.fn().mockResolvedValue(undefined),
      notifyAll: vi.fn().mockResolvedValue(undefined),
    } as unknown as NotificationManager,
    sessionManager: {
      patchRecord: vi.fn().mockResolvedValue(undefined),
      updateSessionStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionManager,
  };
}

function createSession(
  agentInstance?: AgentInstance,
): Session {
  return new Session({
    channelId: "test-channel",
    agentName: "test-agent",
    workingDirectory: "/tmp/test",
    agentInstance: agentInstance ?? createMockAgentInstance(),
  });
}

describe("SessionBridge", () => {
  let agent: AgentInstance;
  let session: Session;
  let adapter: ChannelAdapter;
  let deps: ReturnType<typeof createMockDeps>;
  let bridge: SessionBridge;

  beforeEach(() => {
    agent = createMockAgentInstance();
    session = createSession(agent);
    adapter = createMockAdapter();
    deps = createMockDeps();
    bridge = new SessionBridge(session, adapter, deps);
  });

  describe("connect()", () => {
    it("wires agentInstance.onSessionUpdate to session events", () => {
      bridge.connect();

      // Trigger agent event via the callback
      const event: AgentEvent = { type: "text", content: "hello" };
      agent.onSessionUpdate(event);

      // Should have been transformed and sent to adapter
      expect(deps.messageTransformer.transform).toHaveBeenCalledWith(
        event,
        expect.objectContaining({ id: session.id }),
      );
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        session.id,
        { type: "text", text: "transformed" },
      );
    });

    it("routes text/thought/tool_call/tool_update/plan/usage to adapter.sendMessage", () => {
      bridge.connect();

      const eventTypes: AgentEvent["type"][] = [
        "text",
        "thought",
        "plan",
        "usage",
      ];

      for (const type of eventTypes) {
        let event: AgentEvent;
        if (type === "text" || type === "thought") {
          event = { type, content: "test" };
        } else if (type === "plan") {
          event = { type, entries: [] };
        } else {
          event = { type: "usage", tokensUsed: 100 };
        }
        agent.onSessionUpdate(event);
      }

      expect(adapter.sendMessage).toHaveBeenCalledTimes(4);
    });

    it("routes commands_update to adapter.sendSkillCommands", () => {
      bridge.connect();

      const commands = [{ name: "/test", description: "test", input: undefined }];
      agent.onSessionUpdate({ type: "commands_update", commands });

      expect(adapter.sendSkillCommands).toHaveBeenCalledWith(
        session.id,
        commands,
      );
    });

    it("handles session_end: finish session + cleanup + notify", () => {
      bridge.connect();
      session.activate();

      agent.onSessionUpdate({ type: "session_end", reason: "done" });

      expect(session.status).toBe("finished");
      expect(adapter.cleanupSkillCommands).toHaveBeenCalledWith(session.id);
      expect(adapter.sendMessage).toHaveBeenCalled();
      expect(deps.notificationManager.notify).toHaveBeenCalledWith(
        session.channelId,
        expect.objectContaining({ type: "completed" }),
      );
    });

    it("handles error: update status + cleanup + notify", () => {
      bridge.connect();
      session.activate();

      agent.onSessionUpdate({ type: "error", message: "crash" });

      expect(session.status).toBe("error");
      expect(adapter.cleanupSkillCommands).toHaveBeenCalledWith(session.id);
      expect(deps.notificationManager.notify).toHaveBeenCalledWith(
        session.channelId,
        expect.objectContaining({ type: "error" }),
      );
    });
  });

  describe("permission flow", () => {
    it("sets up permissionGate and sends UI to adapter", async () => {
      bridge.connect();

      const request = {
        id: "req-1",
        description: "Allow?",
        options: [{ id: "yes", label: "Allow", isAllow: true }],
      };

      // Trigger permission request — resolve it immediately
      const resultPromise = agent.onPermissionRequest(request);

      expect(adapter.sendPermissionRequest).toHaveBeenCalledWith(
        session.id,
        request,
      );
      expect(session.permissionGate.isPending).toBe(true);

      // Resolve the permission
      session.permissionGate.resolve("yes");
      const result = await resultPromise;
      expect(result).toBe("yes");
    });
  });

  describe("lifecycle events", () => {
    it("persists status changes via sessionManager.patchRecord", () => {
      bridge.connect();
      session.activate();

      expect(deps.sessionManager.patchRecord).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ status: "active" }),
      );
    });

    it("renames thread on named event", () => {
      bridge.connect();
      session.activate();

      session.emit("named", "My Topic");

      expect(adapter.renameSessionThread).toHaveBeenCalledWith(
        session.id,
        "My Topic",
      );
    });

    it("persists name on named event", () => {
      bridge.connect();
      session.activate();

      session.emit("named", "My Topic");

      expect(deps.sessionManager.patchRecord).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ name: "My Topic" }),
      );
    });
  });

  describe("disconnect()", () => {
    it("removes all listeners — no more events routed", () => {
      bridge.connect();
      bridge.disconnect();

      // Events should no longer be routed
      const event: AgentEvent = { type: "text", content: "hello" };
      session.emit("agent_event", event);

      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("auto-disconnects on terminal status (finished)", async () => {
      bridge.connect();
      session.activate();
      session.finish("done");

      // Wait for microtask (disconnect is queued)
      await Promise.resolve();

      vi.mocked(adapter.sendMessage).mockClear();

      session.emit("agent_event", { type: "text", content: "after" });
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("auto-disconnects on terminal status (cancelled)", async () => {
      bridge.connect();
      session.activate();
      session.markCancelled();

      await Promise.resolve();

      vi.mocked(adapter.sendMessage).mockClear();

      session.emit("agent_event", { type: "text", content: "after" });
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });
  });
});
