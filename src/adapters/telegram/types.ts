export interface TelegramChannelConfig {
  enabled: boolean
  botToken: string
  chatId: number
  notificationTopicId: number | null
  assistantTopicId: number | null
  streamThrottleMs?: number
}
