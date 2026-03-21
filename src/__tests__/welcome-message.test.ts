import { describe, it, expect } from "vitest";
import { buildWelcomeMessage, type WelcomeContext } from "../adapters/telegram/assistant.js";

describe("buildWelcomeMessage", () => {
  it("shows no-sessions variant when totalCount is 0", () => {
    const ctx: WelcomeContext = {
      activeCount: 0,
      errorCount: 0,
      totalCount: 0,
      agents: ["claude"],
      defaultAgent: "claude",
    };
    const msg = buildWelcomeMessage(ctx);
    expect(msg).toContain("OpenACP is ready");
    expect(msg).toContain("No sessions yet");
    expect(msg).not.toContain("Agents:");
  });

  it("shows active variant when there are active sessions and no errors", () => {
    const ctx: WelcomeContext = {
      activeCount: 2,
      errorCount: 0,
      totalCount: 5,
      agents: ["claude", "codex"],
      defaultAgent: "claude",
    };
    const msg = buildWelcomeMessage(ctx);
    expect(msg).toContain("2 active / 5 total");
    expect(msg).toContain("claude (default)");
    expect(msg).toContain("codex");
    expect(msg).not.toContain("errors");
  });

  it("shows error variant when there are error sessions", () => {
    const ctx: WelcomeContext = {
      activeCount: 1,
      errorCount: 2,
      totalCount: 5,
      agents: ["claude"],
      defaultAgent: "claude",
    };
    const msg = buildWelcomeMessage(ctx);
    expect(msg).toContain("1 active");
    expect(msg).toContain("2 errors");
    expect(msg).toContain("5 total");
    expect(msg).toContain("ask me to check");
  });

  it("shows fallback variant when all sessions are finished (0 active, 0 errors)", () => {
    const ctx: WelcomeContext = {
      activeCount: 0,
      errorCount: 0,
      totalCount: 3,
      agents: ["claude"],
      defaultAgent: "claude",
    };
    const msg = buildWelcomeMessage(ctx);
    expect(msg).toContain("0 active / 3 total");
    expect(msg).toContain("Agents:");
  });

  it("errors variant takes priority over active variant", () => {
    const ctx: WelcomeContext = {
      activeCount: 3,
      errorCount: 1,
      totalCount: 10,
      agents: ["claude"],
      defaultAgent: "claude",
    };
    const msg = buildWelcomeMessage(ctx);
    expect(msg).toContain("errors");
    expect(msg).toContain("ask me to check");
  });
});
