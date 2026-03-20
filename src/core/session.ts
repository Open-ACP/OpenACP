import { nanoid } from "nanoid";
import type { AgentInstance } from "./agent-instance.js";
import type { ChannelAdapter } from "./channel.js";
import type { SessionStatus } from "./types.js";
import { createChildLogger, createSessionLogger, type Logger } from "./log.js";
const moduleLog = createChildLogger({ module: "session" });

export class Session {
  id: string;
  channelId: string;
  threadId: string = "";
  agentName: string;
  workingDirectory: string;
  agentInstance: AgentInstance;
  agentSessionId: string = "";
  status: SessionStatus = "initializing";
  name?: string;
  promptQueue: string[] = [];
  promptRunning: boolean = false;
  createdAt: Date = new Date();
  adapter?: ChannelAdapter; // Set by wireSessionEvents for renaming
  pendingPermission?: {
    requestId: string;
    resolve: (optionId: string) => void;
  };
  log: Logger;

  constructor(opts: {
    id?: string;
    channelId: string;
    agentName: string;
    workingDirectory: string;
    agentInstance: AgentInstance;
  }) {
    this.id = opts.id || nanoid(12);
    this.channelId = opts.channelId;
    this.agentName = opts.agentName;
    this.workingDirectory = opts.workingDirectory;
    this.agentInstance = opts.agentInstance;
    this.log = createSessionLogger(this.id, moduleLog);
    this.log.info({ agentName: this.agentName }, "Session created");
  }

  async enqueuePrompt(text: string): Promise<void> {
    if (this.promptRunning) {
      this.promptQueue.push(text);
      this.log.debug({ queueDepth: this.promptQueue.length }, "Prompt queued");
      return;
    }
    await this.runPrompt(text);
  }

  private async runPrompt(text: string): Promise<void> {
    this.promptRunning = true;
    this.status = "active";
    const promptStart = Date.now();
    this.log.debug("Prompt execution started");

    try {
      await this.agentInstance.prompt(text);
      this.log.info(
        { durationMs: Date.now() - promptStart },
        "Prompt execution completed",
      );

      // Auto-name after first user prompt
      if (!this.name) {
        await this.autoName();
      }
    } catch (err) {
      this.status = "error";
      this.log.error({ err }, "Prompt execution failed");
    } finally {
      this.promptRunning = false;

      // Process next queued prompt
      if (this.promptQueue.length > 0) {
        const next = this.promptQueue.shift()!;
        await this.runPrompt(next);
      }
    }
  }

  // NOTE: This injects a summary prompt into the agent's conversation history.
  // Known Phase 1 limitation — the agent sees this prompt in its context.
  private async autoName(): Promise<void> {
    let title = "";
    const prevHandler = this.agentInstance.onSessionUpdate;
    this.agentInstance.onSessionUpdate = (event) => {
      if (event.type === "text") title += event.content;
    };

    try {
      await this.agentInstance.prompt(
        "Summarize this conversation in max 5 words for a topic title. Reply ONLY with the title, nothing else.",
      );
      this.name = title.trim().slice(0, 50);
      this.log.info({ name: this.name }, "Session auto-named");

      // Rename the topic on the channel
      if (this.adapter && this.name) {
        await this.adapter.renameSessionThread(this.id, this.name);
      }
    } catch {
      this.name = `Session ${this.id.slice(0, 6)}`;
    } finally {
      this.agentInstance.onSessionUpdate = prevHandler;
    }
  }

  /** Fire-and-forget warm-up: primes model cache while user types their first message */
  async warmup(): Promise<void> {
    this.promptRunning = true;
    const prevHandler = this.agentInstance.onSessionUpdate;
    this.agentInstance.onSessionUpdate = () => {}; // suppress warm-up output

    try {
      const start = Date.now();
      await this.agentInstance.prompt('Reply with only "ready".');
      this.status = 'active';
      this.log.info({ durationMs: Date.now() - start }, "Warm-up complete");
    } catch (err) {
      this.log.error({ err }, "Warm-up failed");
    } finally {
      this.agentInstance.onSessionUpdate = prevHandler;
      this.promptRunning = false;

      // Drain any prompts queued while warming up
      if (this.promptQueue.length > 0) {
        const next = this.promptQueue.shift()!;
        await this.runPrompt(next);
      }
    }
  }

  async cancel(): Promise<void> {
    this.status = "cancelled";
    this.log.info("Session cancelled");
    await this.agentInstance.cancel();
  }

  async destroy(): Promise<void> {
    this.log.info("Session destroyed");
    await this.agentInstance.destroy();
  }
}
