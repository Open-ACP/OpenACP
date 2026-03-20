import { spawn, execSync, type ChildProcess } from "node:child_process";
import { Transform } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  Agent,
  Client,
  PromptResponse,
  PermissionOption as SdkPermissionOption,
} from "@agentclientprotocol/sdk";
import { nodeToWebWritable, nodeToWebReadable } from "./streams.js";
import { StderrCapture } from "./stderr-capture.js";
import type {
  AgentDefinition,
  AgentEvent,
  PermissionRequest,
} from "./types.js";
import { createChildLogger } from "./log.js";
const log = createChildLogger({ module: "agent-instance" });

/** Find the nearest ancestor directory containing package.json */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return startDir;
}

/** Resolve an agent command to a directly executable form (avoids shell wrappers) */
function resolveAgentCommand(cmd: string): { command: string; args: string[] } {
  // Directories to search for node_modules: cwd AND the package's own directory
  const searchRoots = [process.cwd()];
  // Add the directory where this package is installed (for global installs)
  // Use findPackageRoot instead of hardcoded "../.." to handle both tsc (dist/core/)
  // and tsup bundle (dist/) directory structures correctly
  const ownDir = findPackageRoot(import.meta.dirname);
  if (ownDir !== process.cwd()) {
    searchRoots.push(ownDir);
  }

  // 1. Check node_modules for the package's actual JS entry point
  for (const root of searchRoots) {
    const packageDirs = [
      path.resolve(root, "node_modules", "@zed-industries", cmd, "dist", "index.js"),
      path.resolve(root, "node_modules", cmd, "dist", "index.js"),
    ];
    for (const jsPath of packageDirs) {
      if (fs.existsSync(jsPath)) {
        return { command: process.execPath, args: [jsPath] };
      }
    }
  }

  // 2. Check .bin — if it's a JS file with shebang, run with node directly
  for (const root of searchRoots) {
    const localBin = path.resolve(root, "node_modules", ".bin", cmd);
    if (fs.existsSync(localBin)) {
      const content = fs.readFileSync(localBin, "utf-8");
      if (content.startsWith("#!/usr/bin/env node")) {
        return { command: process.execPath, args: [localBin] };
      }
      // Shell wrapper — try to find the target JS file
      const match = content.match(/"([^"]+\.js)"/);
      if (match) {
        const target = path.resolve(path.dirname(localBin), match[1]);
        if (fs.existsSync(target)) {
          return { command: process.execPath, args: [target] };
        }
      }
    }
  }

  // 3. Try resolving from PATH using which
  try {
    const fullPath = execSync(`which ${cmd}`, { encoding: "utf-8" }).trim();
    if (fullPath) {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.startsWith("#!/usr/bin/env node")) {
        return { command: process.execPath, args: [fullPath] };
      }
    }
  } catch {
    // which failed
  }

  // 4. Fallback: use command as-is
  return { command: cmd, args: [] };
}

interface TerminalState {
  process: ChildProcess;
  output: string;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
}

export class AgentInstance {
  private connection!: ClientSideConnection;
  private child!: ChildProcess;
  private stderrCapture!: StderrCapture;
  private terminals: Map<string, TerminalState> = new Map();

  sessionId!: string;
  agentName: string;

  // Callbacks — set by core when wiring events
  onSessionUpdate: (event: AgentEvent) => void = () => {};
  onPermissionRequest: (request: PermissionRequest) => Promise<string> =
    async () => "";

  private constructor(agentName: string) {
    this.agentName = agentName;
  }

  private static async spawnSubprocess(
    agentDef: AgentDefinition,
    workingDirectory: string,
  ): Promise<AgentInstance> {
    const instance = new AgentInstance(agentDef.name);
    const resolved = resolveAgentCommand(agentDef.command);
    log.debug(
      {
        agentName: agentDef.name,
        command: resolved.command,
        args: resolved.args,
      },
      "Resolved agent command",
    );

    instance.child = spawn(
      resolved.command,
      [...resolved.args, ...agentDef.args],
      {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: workingDirectory,
        env: { ...process.env, ...agentDef.env },
      },
    );

    await new Promise<void>((resolve, reject) => {
      instance.child.on("error", (err) => {
        reject(
          new Error(
            `Failed to spawn agent "${agentDef.name}": ${err.message}. Is "${agentDef.command}" installed?`,
          ),
        );
      });
      instance.child.on("spawn", () => resolve());
    });

    instance.stderrCapture = new StderrCapture(50);
    instance.child.stderr!.on("data", (chunk: Buffer) => {
      instance.stderrCapture.append(chunk.toString());
    });

    const stdinLogger = new Transform({
      transform(chunk, _enc, cb) {
        log.debug(
          { direction: "send", raw: chunk.toString().trimEnd() },
          "ACP raw",
        );
        cb(null, chunk);
      },
    });
    stdinLogger.pipe(instance.child.stdin!);

    const stdoutLogger = new Transform({
      transform(chunk, _enc, cb) {
        log.debug(
          { direction: "recv", raw: chunk.toString().trimEnd() },
          "ACP raw",
        );
        cb(null, chunk);
      },
    });
    instance.child.stdout!.pipe(stdoutLogger);

    const toAgent = nodeToWebWritable(stdinLogger);
    const fromAgent = nodeToWebReadable(stdoutLogger);
    const stream = ndJsonStream(toAgent, fromAgent);

    instance.connection = new ClientSideConnection(
      (_agent: Agent): Client => instance.createClient(_agent),
      stream,
    );

    await instance.connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    return instance;
  }

  private setupCrashDetection(): void {
    this.child.on("exit", (code, signal) => {
      log.info(
        { sessionId: this.sessionId, exitCode: code, signal },
        "Agent process exited",
      );
      if (code !== 0 && code !== null) {
        const stderr = this.stderrCapture.getLastLines();
        this.onSessionUpdate({
          type: "error",
          message: `Agent crashed (exit code ${code})\n${stderr}`,
        });
      }
    });

    this.connection.closed.then(() => {
      log.debug({ sessionId: this.sessionId }, "ACP connection closed");
    });
  }

  static async spawn(
    agentDef: AgentDefinition,
    workingDirectory: string,
  ): Promise<AgentInstance> {
    log.debug(
      { agentName: agentDef.name, command: agentDef.command },
      "Spawning agent",
    );
    const spawnStart = Date.now();

    const instance = await AgentInstance.spawnSubprocess(
      agentDef,
      workingDirectory,
    );

    const response = await instance.connection.newSession({
      cwd: workingDirectory,
      mcpServers: [],
    });
    instance.sessionId = response.sessionId;
    instance.setupCrashDetection();

    log.info(
      { sessionId: response.sessionId, durationMs: Date.now() - spawnStart },
      "Agent spawn complete",
    );
    return instance;
  }

  static async resume(
    agentDef: AgentDefinition,
    workingDirectory: string,
    agentSessionId: string,
  ): Promise<AgentInstance> {
    log.debug({ agentName: agentDef.name, agentSessionId }, "Resuming agent");
    const spawnStart = Date.now();

    const instance = await AgentInstance.spawnSubprocess(
      agentDef,
      workingDirectory,
    );

    try {
      const response = await instance.connection.unstable_resumeSession({
        sessionId: agentSessionId,
        cwd: workingDirectory,
      });
      instance.sessionId = response.sessionId;
      log.info(
        { sessionId: response.sessionId, durationMs: Date.now() - spawnStart },
        "Agent resume complete",
      );
    } catch (err) {
      log.warn(
        { err, agentSessionId },
        "Resume failed, falling back to new session",
      );
      const response = await instance.connection.newSession({
        cwd: workingDirectory,
        mcpServers: [],
      });
      instance.sessionId = response.sessionId;
      log.info(
        { sessionId: response.sessionId, durationMs: Date.now() - spawnStart },
        "Agent fallback spawn complete",
      );
    }

    instance.setupCrashDetection();
    return instance;
  }

  // createClient — implemented in Task 6b
  private createClient(_agent: Agent): Client {
    const self = this;
    const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB cap

    return {
      // ── Session updates ──────────────────────────────────────────────────
      async sessionUpdate(params) {
        const update = params.update;
        let event: AgentEvent | null = null;

        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            if (update.content.type === "text") {
              event = { type: "text", content: update.content.text };
            }
            break;
          case "agent_thought_chunk":
            if (update.content.type === "text") {
              event = { type: "thought", content: update.content.text };
            }
            break;
          case "tool_call":
            event = {
              type: "tool_call",
              id: update.toolCallId,
              name: update.title,
              kind: update.kind ?? undefined,
              status: update.status ?? "pending",
              content: update.content ?? undefined,
              rawInput: (update as any).rawInput ?? undefined,
              meta: (update as any)._meta ?? undefined,
            };
            break;
          case "tool_call_update":
            event = {
              type: "tool_update",
              id: update.toolCallId,
              name: update.title ?? undefined,
              kind: update.kind ?? undefined,
              status: update.status ?? "pending",
              content: update.content ?? undefined,
              rawInput: (update as any).rawInput ?? undefined,
              meta: (update as any)._meta ?? undefined,
            };
            break;
          case "plan":
            event = { type: "plan", entries: update.entries };
            break;
          case "usage_update":
            event = {
              type: "usage",
              tokensUsed: update.used,
              contextSize: update.size,
              cost: update.cost ?? undefined,
            };
            break;
          case "available_commands_update":
            event = {
              type: "commands_update",
              commands: update.availableCommands,
            };
            break;
          default:
            // Unknown update type — ignore
            return;
        }

        if (event !== null) {
          self.onSessionUpdate(event);
        }
      },

      // ── Permission requests ──────────────────────────────────────────────
      async requestPermission(params) {
        const permissionRequest: PermissionRequest = {
          id: params.toolCall.toolCallId,
          description: params.toolCall.title ?? params.toolCall.toolCallId,
          options: params.options.map((opt: SdkPermissionOption) => ({
            id: opt.optionId,
            label: opt.name,
            isAllow: opt.kind === "allow_once" || opt.kind === "allow_always",
          })),
        };

        const selectedOptionId =
          await self.onPermissionRequest(permissionRequest);
        return {
          outcome: { outcome: "selected" as const, optionId: selectedOptionId },
        };
      },

      // ── File operations ──────────────────────────────────────────────────
      async readTextFile(params) {
        const content = await fs.promises.readFile(params.path, "utf-8");
        return { content };
      },

      async writeTextFile(params) {
        await fs.promises.mkdir(path.dirname(params.path), { recursive: true });
        await fs.promises.writeFile(params.path, params.content, "utf-8");
        return {};
      },

      // ── Terminal operations ──────────────────────────────────────────────
      async createTerminal(params) {
        const terminalId = randomUUID();
        const args = params.args ?? [];
        const env: Record<string, string> = {};
        for (const ev of params.env ?? []) {
          env[ev.name] = ev.value;
        }

        const childProcess = spawn(params.command, args, {
          cwd: params.cwd ?? undefined,
          env: { ...process.env, ...env },
          shell: false,
        });

        const state: TerminalState = {
          process: childProcess,
          output: "",
          exitStatus: null,
        };
        self.terminals.set(terminalId, state);

        const outputByteLimit = params.outputByteLimit ?? MAX_OUTPUT_BYTES;

        const appendOutput = (chunk: string) => {
          state.output += chunk;
          // Truncate from the beginning if over limit
          const bytes = Buffer.byteLength(state.output, "utf-8");
          if (bytes > outputByteLimit) {
            // Find truncation point at character boundary
            const excess = bytes - outputByteLimit;
            state.output = state.output.slice(excess);
          }
        };

        childProcess.stdout?.on("data", (chunk: Buffer) =>
          appendOutput(chunk.toString()),
        );
        childProcess.stderr?.on("data", (chunk: Buffer) =>
          appendOutput(chunk.toString()),
        );

        childProcess.on("exit", (code, signal) => {
          state.exitStatus = { exitCode: code, signal };
        });

        return { terminalId };
      },

      async terminalOutput(params) {
        const state = self.terminals.get(params.terminalId);
        if (!state) {
          throw new Error(`Terminal not found: ${params.terminalId}`);
        }
        return {
          output: state.output,
          truncated: false,
          exitStatus: state.exitStatus
            ? {
                exitCode: state.exitStatus.exitCode,
                signal: state.exitStatus.signal,
              }
            : undefined,
        };
      },

      async waitForTerminalExit(params) {
        const state = self.terminals.get(params.terminalId);
        if (!state) {
          throw new Error(`Terminal not found: ${params.terminalId}`);
        }
        if (state.exitStatus !== null) {
          return {
            exitCode: state.exitStatus.exitCode,
            signal: state.exitStatus.signal,
          };
        }
        return new Promise((resolve) => {
          state.process.on("exit", (code, signal) => {
            resolve({ exitCode: code, signal });
          });
        });
      },

      async killTerminal(params) {
        const state = self.terminals.get(params.terminalId);
        if (!state) {
          throw new Error(`Terminal not found: ${params.terminalId}`);
        }
        state.process.kill("SIGTERM");
        return {};
      },

      async releaseTerminal(params) {
        const state = self.terminals.get(params.terminalId);
        if (!state) {
          return;
        }
        state.process.kill("SIGKILL");
        self.terminals.delete(params.terminalId);
      },
    };
  }

  async prompt(text: string): Promise<PromptResponse> {
    return this.connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  async cancel(): Promise<void> {
    await this.connection.cancel({ sessionId: this.sessionId });
  }

  async destroy(): Promise<void> {
    // Cleanup terminals
    for (const [, t] of this.terminals) {
      t.process.kill("SIGKILL");
    }
    this.terminals.clear();

    // Kill agent subprocess
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (!this.child.killed) this.child.kill("SIGKILL");
    }, 10_000);
  }
}
