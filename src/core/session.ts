import { nanoid } from "nanoid";
import type { AgentInstance } from "./agent-instance.js";
import type { AgentEvent, PermissionRequest, SessionStatus } from "./types.js";
import { TypedEmitter } from "./typed-emitter.js";
import { PromptQueue } from "./prompt-queue.js";
import { PermissionGate } from "./permission-gate.js";
import { createChildLogger, createSessionLogger, type Logger } from "./log.js";
const moduleLog = createChildLogger({ module: "session" });

// Valid state transitions: from → Set<to>
const VALID_TRANSITIONS: Record<SessionStatus, Set<SessionStatus>> = {
  initializing: new Set(["active", "error"]),
  active: new Set(["error", "finished", "cancelled"]),
  error: new Set(["active"]),
  cancelled: new Set(["active"]),
  finished: new Set(),
};

export interface SessionEvents {
  agent_event: (event: AgentEvent) => void;
  permission_request: (request: PermissionRequest) => void;
  session_end: (reason: string) => void;
  status_change: (from: SessionStatus, to: SessionStatus) => void;
  named: (name: string) => void;
  error: (error: Error) => void;
}

export class Session extends TypedEmitter<SessionEvents> {
  id: string;
  channelId: string;
  threadId: string = "";
  agentName: string;
  workingDirectory: string;
  agentInstance: AgentInstance;
  agentSessionId: string = "";
  private _status: SessionStatus = "initializing";
  name?: string;
  createdAt: Date = new Date();
  dangerousMode: boolean = false;
  log: Logger;

  readonly permissionGate = new PermissionGate();
  private readonly queue: PromptQueue;

  constructor(opts: {
    id?: string;
    channelId: string;
    agentName: string;
    workingDirectory: string;
    agentInstance: AgentInstance;
  }) {
    super();
    this.id = opts.id || nanoid(12);
    this.channelId = opts.channelId;
    this.agentName = opts.agentName;
    this.workingDirectory = opts.workingDirectory;
    this.agentInstance = opts.agentInstance;
    this.log = createSessionLogger(this.id, moduleLog);
    this.log.info({ agentName: this.agentName }, "Session created");

    this.queue = new PromptQueue(
      (text) => this.processPrompt(text),
      (err) => {
        this.fail("Prompt execution failed");
        this.log.error({ err }, "Prompt execution failed");
      },
    );
  }

  // --- State Machine ---

  get status(): SessionStatus {
    return this._status;
  }


  /** Transition to active — from initializing, error, or cancelled */
  activate(): void {
    this.transition("active");
  }

  /** Transition to error — from initializing or active */
  fail(reason: string): void {
    this.transition("error");
    this.emit("error", new Error(reason));
  }

  /** Transition to finished — from active only. Emits session_end for backward compat. */
  finish(reason?: string): void {
    this.transition("finished");
    this.emit("session_end", reason ?? "completed");
  }

  /** Transition to cancelled — from active only (terminal session cancel) */
  markCancelled(): void {
    this.transition("cancelled");
  }

  private transition(to: SessionStatus): void {
    const from = this._status;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed?.has(to)) {
      throw new Error(
        `Invalid session transition: ${from} → ${to}`,
      );
    }
    this._status = to;
    this.log.debug({ from, to }, "Session status transition");
    this.emit("status_change", from, to);
  }

  /** Number of prompts waiting in queue */
  get queueDepth(): number {
    return this.queue.pending;
  }

  get promptRunning(): boolean {
    return this.queue.isProcessing;
  }

  // --- Public API ---

  async enqueuePrompt(text: string): Promise<void> {
    await this.queue.enqueue(text);
  }

  private async processPrompt(text: string): Promise<void> {
    // Handle warmup sentinel
    if (text === "\x00__warmup__") {
      await this.runWarmup();
      return;
    }

    if (this._status === "initializing") {
      this.activate();
    }
    const promptStart = Date.now();
    this.log.debug("Prompt execution started");

    await this.agentInstance.prompt(text);
    this.log.info(
      { durationMs: Date.now() - promptStart },
      "Prompt execution completed",
    );

    // Auto-name after first user prompt
    if (!this.name) {
      await this.autoName();
    }
  }

  // NOTE: This injects a summary prompt into the agent's conversation history.
  private async autoName(): Promise<void> {
    let title = "";

    // Intercept at the source — capture text before it reaches the emitter,
    // so adapter listeners never see auto-name output.
    const originalHandler = this.agentInstance.onSessionUpdate;
    this.agentInstance.onSessionUpdate = (event: AgentEvent) => {
      if (event.type === "text") title += event.content;
      // Swallow all events from auto-name prompt
    };

    try {
      await this.agentInstance.prompt(
        "Summarize this conversation in max 5 words for a topic title. Reply ONLY with the title, nothing else.",
      );
      this.name = title.trim().slice(0, 50) || `Session ${this.id.slice(0, 6)}`;
      this.log.info({ name: this.name }, "Session auto-named");

      // Emit named event — SessionBridge listens to rename the thread
      this.emit("named", this.name);
    } catch {
      this.name = `Session ${this.id.slice(0, 6)}`;
    } finally {
      this.agentInstance.onSessionUpdate = originalHandler;
    }
  }

  /** Fire-and-forget warm-up: primes model cache while user types their first message */
  async warmup(): Promise<void> {
    // Route through PromptQueue to prevent concurrent prompt execution.
    // Any user prompts arriving during warmup will be queued and drained after.
    await this.queue.enqueue("\x00__warmup__");
  }

  private async runWarmup(): Promise<void> {
    // Pause events but let commands_update pass through
    this.pause((_event, args) => {
      const agentEvent = args[0] as AgentEvent;
      return agentEvent?.type === "commands_update";
    });

    try {
      const start = Date.now();
      await this.agentInstance.prompt('Reply with only "ready".');
      this.activate();
      this.log.info({ durationMs: Date.now() - start }, "Warm-up complete");
    } catch (err) {
      this.log.error({ err }, "Warm-up failed");
    } finally {
      this.clearBuffer();
      this.resume();
    }
  }

  /** Cancel the current prompt and clear the queue. Stays in active state. */
  async abortPrompt(): Promise<void> {
    this.queue.clear();
    this.log.info("Prompt aborted");
    await this.agentInstance.cancel();
  }

  async destroy(): Promise<void> {
    this.log.info("Session destroyed");
    await this.agentInstance.destroy();
  }
}
