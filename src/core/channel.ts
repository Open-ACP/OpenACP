import type { OutgoingMessage, PermissionRequest, NotificationMessage, AgentCommand } from './types.js'

export interface ChannelConfig {
  enabled: boolean
  [key: string]: unknown
}

export interface IChannelAdapter {
  start(): Promise<void>
  stop(): Promise<void>

  // Outgoing: core → channel
  sendMessage(sessionId: string, content: OutgoingMessage): Promise<void>
  sendPermissionRequest(sessionId: string, request: PermissionRequest): Promise<void>
  sendNotification(notification: NotificationMessage): Promise<void>

  // Session lifecycle on channel side
  createSessionThread(sessionId: string, name: string): Promise<string>  // returns threadId
  renameSessionThread(sessionId: string, newName: string): Promise<void>

  // Skill commands — optional
  sendSkillCommands(sessionId: string, commands: AgentCommand[]): Promise<void>
  cleanupSkillCommands(sessionId: string): Promise<void>
}

/**
 * Base class providing default no-op implementations for optional methods.
 * Adapters can extend this or implement IChannelAdapter directly.
 */
export abstract class ChannelAdapter<TCore = unknown> implements IChannelAdapter {
  constructor(protected core: TCore, protected config: ChannelConfig) {}

  abstract start(): Promise<void>
  abstract stop(): Promise<void>

  // Outgoing: core → channel
  abstract sendMessage(sessionId: string, content: OutgoingMessage): Promise<void>
  abstract sendPermissionRequest(sessionId: string, request: PermissionRequest): Promise<void>
  abstract sendNotification(notification: NotificationMessage): Promise<void>

  // Session lifecycle on channel side
  abstract createSessionThread(sessionId: string, name: string): Promise<string>  // returns threadId
  abstract renameSessionThread(sessionId: string, newName: string): Promise<void>

  // Skill commands — override in adapters that support dynamic commands
  async sendSkillCommands(_sessionId: string, _commands: AgentCommand[]): Promise<void> {}
  async cleanupSkillCommands(_sessionId: string): Promise<void> {}
}
