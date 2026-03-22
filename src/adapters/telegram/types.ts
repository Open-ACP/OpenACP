import type { Session } from "../../core/session.js";

export interface TelegramChannelConfig {
  enabled: boolean
  botToken: string
  chatId: number
  notificationTopicId: number | null
  assistantTopicId: number | null
}

export interface CommandsAssistantContext {
  topicId: number;
  getSession: () => Session | null;
  respawn: () => Promise<void>;
}
