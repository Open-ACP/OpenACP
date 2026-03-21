import { describe, it, expect } from "vitest";
import { getAgentCapabilities } from "../core/agent-registry.js";

describe("AgentRegistry", () => {
  it("returns capabilities for claude", () => {
    const caps = getAgentCapabilities("claude");
    expect(caps.supportsResume).toBe(true);
    expect(caps.resumeCommand).toBeDefined();
    expect(caps.resumeCommand!("abc123")).toBe("claude --resume abc123");
  });

  it("returns default capabilities for unknown agent", () => {
    const caps = getAgentCapabilities("unknown-agent");
    expect(caps.supportsResume).toBe(false);
    expect(caps.resumeCommand).toBeUndefined();
  });
});
