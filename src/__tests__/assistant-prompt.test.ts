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
  it("includes product context", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("OpenACP Assistant");
    expect(prompt).toContain("Agent Client Protocol");
  });

  it("includes current state", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("Active sessions: 2");
    expect(prompt).toContain("claude");
    expect(prompt).toContain("codex");
  });

  it("includes action playbook", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("openacp api status");
    expect(prompt).toContain("openacp api cancel");
    expect(prompt).toContain("openacp api health");
    expect(prompt).toContain("openacp api cleanup");
    expect(prompt).toContain("openacp api config");
  });

  it("includes guidelines about self-execution", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("openacp api");
    expect(prompt).toContain("confirm");
    expect(prompt).toContain("same language");
  });

  it("does not include old Telegram bot commands section", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).not.toContain("Session Management Commands");
    expect(prompt).not.toContain("These are Telegram bot commands");
  });

  it("includes workspace explanation in create session playbook", () => {
    const prompt = buildAssistantSystemPrompt(makeCtx());
    expect(prompt).toContain("workspace");
    expect(prompt).toContain("project directory");
  });
});
