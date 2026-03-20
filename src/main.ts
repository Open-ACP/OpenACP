#!/usr/bin/env node

import { ConfigManager } from './core/config.js'
import { OpenACPCore } from './core/core.js'
import { loadAdapterFactory } from './core/plugin-manager.js'
import { initLogger, shutdownLogger, cleanupOldSessionLogs, log } from './core/log.js'
import { TelegramAdapter } from './adapters/telegram/index.js'

let shuttingDown = false

export async function startServer() {
  // 1. Check config exists, run setup if not
  const configManager = new ConfigManager()
  const configExists = await configManager.exists()

  if (!configExists) {
    const { runSetup } = await import('./core/setup.js')
    const shouldStart = await runSetup(configManager)
    if (!shouldStart) process.exit(0)
  }

  // 2. Load config (validates with Zod)
  await configManager.load()
  const config = configManager.get()
  initLogger(config.logging)
  log.info({ configPath: configManager.getConfigPath() }, 'Config loaded')

  // Async cleanup of old session logs (non-blocking)
  cleanupOldSessionLogs(config.logging.sessionLogRetentionDays).catch(err =>
    log.warn({ err }, 'Session log cleanup failed')
  )

  // 3. Create core
  const core = new OpenACPCore(configManager)

  // 3.5 Start tunnel if configured
  let tunnelService: import('./tunnel/tunnel-service.js').TunnelService | undefined
  if (config.tunnel.enabled) {
    const { TunnelService } = await import('./tunnel/tunnel-service.js')
    tunnelService = new TunnelService(config.tunnel)
    const publicUrl = await tunnelService.start()
    core.tunnelService = tunnelService
    log.info({ publicUrl }, 'Tunnel started')
  }

  // 4. Register adapters from config
  for (const [channelName, channelConfig] of Object.entries(config.channels)) {
    if (!channelConfig.enabled) continue

    if (channelName === 'telegram') {
      core.registerAdapter('telegram', new TelegramAdapter(core, channelConfig as any))
      log.info({ adapter: 'telegram' }, 'Adapter registered')
    } else if (channelConfig.adapter) {
      // Plugin adapter
      const factory = await loadAdapterFactory(channelConfig.adapter)
      if (factory) {
        const adapter = factory.createAdapter(core, channelConfig)
        core.registerAdapter(channelName, adapter)
        log.info({ adapter: channelName, plugin: channelConfig.adapter }, 'Adapter registered')
      } else {
        const name = channelName
        const err = channelConfig.adapter
        log.error({ adapter: name, err }, 'Failed to load adapter')
      }
    } else {
      log.error({ adapter: channelName }, 'Channel has no built-in adapter; set "adapter" field to a plugin package')
    }
  }

  if (core.adapters.size === 0) {
    log.error('No channels enabled. Enable at least one channel in config.')
    process.exit(1)
  }

  // 5. Start
  await core.start()

  // 6. Log ready
  const agents = Object.keys(config.agents)
  log.info({ agents }, 'OpenACP started')
  log.info('Press Ctrl+C to stop')

  // 7. Graceful shutdown
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'Signal received, shutting down')

    try {
      await core.stop()
      if (tunnelService) await tunnelService.stop()
    } catch (err) {
      log.error({ err }, 'Error during shutdown')
    }

    await shutdownLogger()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  process.on('uncaughtException', (err) => {
    log.error({ err }, 'Uncaught exception')
  })

  process.on('unhandledRejection', (err) => {
    log.error({ err }, 'Unhandled rejection')
  })
}

// Direct execution for dev (node dist/main.js)
const isDirectExecution = process.argv[1]?.endsWith('main.js')
if (isDirectExecution) {
  startServer().catch((err) => {
    log.error({ err }, 'Fatal error')
    process.exit(1)
  })
}
