import { describe, it, expect } from "vitest";
import { buildAssistantSystemPrompt, type AssistantContext } from "../adapters/telegram/assistant.js";

function makeCtx(overrides?: Partial<AssistantContext>): AssistantContext {
  return {
    config: {
      agents: { claude: { command: "claude", args: [] }, codex: { command: "codex", args: [] } },
      defaultAgent: "claude",
      workspace: { baseDir: "~/openacp-workspace" },
    } as any,
    activeSessionCount: 2,
    totalSessionCount: 5,
    topicSummary: [
      { status: "active", count: 2 },
      { status: "finished", count: 3 },
    ],
    ...overrides,
  };
}

describe("buildAssistantSystemPrompt", () => {
  it("includes identity and product guide", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("OpenACP Assistant");
    expect(prompt).toContain("Product Reference");
    expect(prompt).toContain("AI coding agents");
  });

  it("includes current state", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("Active sessions: 2");
    expect(prompt).toContain("claude");
    expect(prompt).toContain("codex");
  });

  it("includes product guide with CLI commands and features", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("openacp api");
    expect(prompt).toContain("cancel");
    expect(prompt).toContain("cleanup");
    expect(prompt).toContain("Handoff");
    expect(prompt).toContain("Dangerous");
  });

  it("includes guidelines about self-execution", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("NEVER show");
    expect(prompt).toContain("confirm");
    expect(prompt).toContain("same language");
  });

  it("does not include old Telegram bot commands section", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).not.toContain("Session Management Commands");
    expect(prompt).not.toContain("These are Telegram bot commands");
  });

  it("includes workspace and project folder explanation", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("workspace");
    expect(prompt).toContain("project folder");
  });
});
