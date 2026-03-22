import { describe, it, expect, vi } from "vitest";
import { Session } from "../session.js";
import type { AgentInstance } from "../agent-instance.js";
import type { SessionStatus } from "../types.js";

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

function createSession(
  overrides?: Partial<ConstructorParameters<typeof Session>[0]>,
): Session {
  return new Session({
    channelId: "test-channel",
    agentName: "test-agent",
    workingDirectory: "/tmp/test",
    agentInstance: createMockAgentInstance(),
    ...overrides,
  });
}

describe("Session state machine", () => {
  describe("initial state", () => {
    it("starts in initializing status", () => {
      const session = createSession();
      expect(session.status).toBe("initializing");
    });
  });

  describe("valid transitions", () => {
    it("initializing → active via activate()", () => {
      const session = createSession();
      session.activate();
      expect(session.status).toBe("active");
    });

    it("initializing → error via fail()", () => {
      const session = createSession();
      session.fail("spawn failed");
      expect(session.status).toBe("error");
    });

    it("active → error via fail()", () => {
      const session = createSession();
      session.activate();
      session.fail("crash");
      expect(session.status).toBe("error");
    });

    it("active → finished via finish()", () => {
      const session = createSession();
      session.activate();
      session.finish("done");
      expect(session.status).toBe("finished");
    });

    it("active → cancelled via markCancelled()", () => {
      const session = createSession();
      session.activate();
      session.markCancelled();
      expect(session.status).toBe("cancelled");
    });

    it("error → active via activate() (resume)", () => {
      const session = createSession();
      session.activate();
      session.fail("crash");
      session.activate();
      expect(session.status).toBe("active");
    });

    it("cancelled → active via activate() (resume)", () => {
      const session = createSession();
      session.activate();
      session.markCancelled();
      session.activate();
      expect(session.status).toBe("active");
    });
  });

  describe("invalid transitions", () => {
    it("initializing → finished throws", () => {
      const session = createSession();
      expect(() => session.finish("done")).toThrow();
    });

    it("initializing → cancelled throws", () => {
      const session = createSession();
      expect(() => session.markCancelled()).toThrow();
    });

    it("finished → active throws", () => {
      const session = createSession();
      session.activate();
      session.finish("done");
      expect(() => session.activate()).toThrow();
    });

    it("finished → error throws", () => {
      const session = createSession();
      session.activate();
      session.finish("done");
      expect(() => session.fail("err")).toThrow();
    });

    it("finished → cancelled throws", () => {
      const session = createSession();
      session.activate();
      session.finish("done");
      expect(() => session.markCancelled()).toThrow();
    });

    it("error → finished throws", () => {
      const session = createSession();
      session.fail("err");
      expect(() => session.finish("done")).toThrow();
    });

    it("error → cancelled throws", () => {
      const session = createSession();
      session.fail("err");
      expect(() => session.markCancelled()).toThrow();
    });
  });

  describe("status_change event", () => {
    it("emits on valid transition with (from, to)", () => {
      const session = createSession();
      const handler = vi.fn();
      session.on("status_change", handler);

      session.activate();

      expect(handler).toHaveBeenCalledWith("initializing", "active");
    });

    it("emits for every transition in sequence", () => {
      const session = createSession();
      const transitions: [SessionStatus, SessionStatus][] = [];
      session.on("status_change", (from, to) => transitions.push([from, to]));

      session.activate();
      session.fail("crash");
      session.activate();

      expect(transitions).toEqual([
        ["initializing", "active"],
        ["active", "error"],
        ["error", "active"],
      ]);
    });

    it("does not emit on invalid transition", () => {
      const session = createSession();
      const handler = vi.fn();
      session.on("status_change", handler);

      expect(() => session.finish("done")).toThrow();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("named event", () => {
    it("emits when session name is set via autoName", async () => {
      const agent = createMockAgentInstance();
      // Make prompt resolve immediately (auto-name prompt)
      (agent.prompt as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const session = createSession({ agentInstance: agent });
      session.activate();

      const handler = vi.fn();
      session.on("named", handler);

      // Simulate first prompt completing (triggers autoName)
      // autoName is private, so we trigger it by enqueuing a prompt
      // The agent.prompt mock returns {} and onSessionUpdate will be swapped
      // during autoName, so the title will be empty → fallback name
      await session.enqueuePrompt("hello");

      expect(handler).toHaveBeenCalled();
      expect(session.name).toBeDefined();
    });
  });

  describe("abortPrompt()", () => {
    it("clears queue and calls agentInstance.cancel()", async () => {
      const agent = createMockAgentInstance();
      const session = createSession({ agentInstance: agent });
      session.activate();

      await session.abortPrompt();

      expect(agent.cancel).toHaveBeenCalled();
    });

    it("stays in active state", async () => {
      const session = createSession();
      session.activate();

      await session.abortPrompt();

      expect(session.status).toBe("active");
    });
  });

  describe("markCancelled()", () => {
    it("transitions to cancelled (terminal)", () => {
      const session = createSession();
      session.activate();
      session.markCancelled();
      expect(session.status).toBe("cancelled");
    });
  });

  describe("finish() backward compat", () => {
    it("emits both status_change and session_end", () => {
      const session = createSession();
      session.activate();

      const statusHandler = vi.fn();
      const endHandler = vi.fn();
      session.on("status_change", statusHandler);
      session.on("session_end", endHandler);

      session.finish("completed");

      expect(statusHandler).toHaveBeenCalledWith("active", "finished");
      expect(endHandler).toHaveBeenCalledWith("completed");
    });
  });
});
