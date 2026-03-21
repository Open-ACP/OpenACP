export interface IncomingMessage {
  channelId: string;
  threadId: string;
  userId: string;
  text: string;
}

export interface OutgoingMessage {
  type:
    | "text"
    | "thought"
    | "tool_call"
    | "tool_update"
    | "plan"
    | "usage"
    | "session_end"
    | "error";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface PermissionRequest {
  id: string;
  description: string;
  options: PermissionOption[];
}

export interface PermissionOption {
  id: string;
  label: string;
  isAllow: boolean;
}

export interface NotificationMessage {
  sessionId: string;
  sessionName?: string;
  type: "completed" | "error" | "permission" | "input_required";
  summary: string;
  deepLink?: string;
}

export interface AgentCommand {
  name: string;
  description: string;
  input?: unknown;
}

export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "thought"; content: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      kind?: string;
      status: string;
      content?: unknown;
      locations?: unknown;
      rawInput?: unknown;
      meta?: unknown;
    }
  | {
      type: "tool_update";
      id: string;
      name?: string;
      kind?: string;
      status: string;
      content?: unknown;
      locations?: unknown;
      rawInput?: unknown;
      meta?: unknown;
    }
  | { type: "plan"; entries: PlanEntry[] }
  | {
      type: "usage";
      tokensUsed?: number;
      contextSize?: number;
      cost?: { amount: number; currency: string };
    }
  | { type: "commands_update"; commands: AgentCommand[] }
  | { type: "session_end"; reason: string }
  | { type: "error"; message: string };

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

export interface AgentDefinition {
  name: string;
  command: string;
  args: string[];
  workingDirectory?: string;
  env?: Record<string, string>;
}

export type SessionStatus =
  | "initializing"
  | "active"
  | "cancelled"
  | "finished"
  | "error";

export interface SessionRecord<P = Record<string, unknown>> {
  sessionId: string;
  agentSessionId: string;
  originalAgentSessionId?: string;
  agentName: string;
  workingDir: string;
  channelId: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  name?: string;
  dangerousMode?: boolean;
  platform: P;
}

export interface TelegramPlatformData {
  topicId: number;
  skillMsgId?: number;
}
