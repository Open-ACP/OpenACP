#!/usr/bin/env node

import { ConfigManager } from './core/config.js'
import { OpenACPCore } from './core/core.js'
import { loadAdapterFactory } from './core/plugin-manager.js'
import { initLogger, shutdownLogger, cleanupOldSessionLogs, log } from './core/log.js'
import { TelegramAdapter } from './adapters/telegram/index.js'
import { ApiServer } from './core/api-server.js'

export const RESTART_EXIT_CODE = 75
let shuttingDown = false

export async function startServer() {
  // 0. If running as daemon child, check state and write PID file
  if (process.argv.includes('--daemon-child')) {
    const { writePidFile, readPidFile, getPidPath, shouldAutoStart } = await import('./core/daemon.js')

    // Only auto-start if the daemon was previously running (user started it)
    if (!shouldAutoStart()) {
      process.exit(0)
    }

    const pidPath = getPidPath()
    const existingPid = readPidFile(pidPath)
    if (existingPid !== null && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0)
        console.error(`Another OpenACP instance is already running (PID ${existingPid}). Exiting.`)
        process.exit(1)
      } catch {
        // Stale PID file — safe to overwrite
      }
    }
    writePidFile(pidPath, process.pid)
  }

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
  let apiServer: ApiServer | undefined

  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal, exitCode }, 'Signal received, shutting down')

    try {
      if (apiServer) await apiServer.stop()
      await core.stop()
      if (tunnelService) await tunnelService.stop()
    } catch (err) {
      log.error({ err }, 'Error during shutdown')
    }

    const isDaemon = process.argv.includes('--daemon-child')

    // Clean up PID file if running as daemon
    if (isDaemon) {
      const { removePidFile, getPidPath } = await import('./core/daemon.js')
      removePidFile(getPidPath())
    }

    // Self-respawn on restart
    if (exitCode === RESTART_EXIT_CODE) {
      if (isDaemon) {
        // Daemon mode: spawn detached child writing to log file
        const { spawn: spawnChild } = await import('node:child_process')
        const { expandHome } = await import('./core/config.js')
        const fs = await import('node:fs')
        const pathMod = await import('node:path')

        const cliPath = pathMod.resolve(process.argv[1])
        const resolvedLogDir = expandHome(config.logging.logDir)
        fs.mkdirSync(resolvedLogDir, { recursive: true })
        const logFile = pathMod.join(resolvedLogDir, 'openacp.log')
        const out = fs.openSync(logFile, 'a')
        const err = fs.openSync(logFile, 'a')

        const child = spawnChild(process.execPath, [cliPath, '--daemon-child'], {
          detached: true,
          stdio: ['ignore', out, err],
        })
        fs.closeSync(out)
        fs.closeSync(err)
        child.unref()
        log.info({ newPid: child.pid }, 'Respawned daemon for restart')
      } else if (!process.env.OPENACP_DEV_LOOP) {
        // Foreground production mode: spawn replacement process with inherited stdio
        const { spawn: spawnChild } = await import('node:child_process')
        const child = spawnChild(process.execPath, process.argv.slice(1), {
          stdio: 'inherit',
        })
        await shutdownLogger()
        child.on('exit', (code) => process.exit(code ?? 0))
        return
      }
    }

    await shutdownLogger()
    process.exit(exitCode)
  }

  // Expose restart trigger for adapters (e.g. /restart command)
  core.requestRestart = () => shutdown('restart', RESTART_EXIT_CODE)

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  process.on('uncaughtException', (err) => {
    log.error({ err }, 'Uncaught exception')
  })

  process.on('unhandledRejection', (err) => {
    log.error({ err }, 'Unhandled rejection')
  })

  await core.start()

  apiServer = new ApiServer(core, config.api)
  await apiServer.start()

  // 6. Log ready
  const agents = Object.keys(config.agents)
  log.info({ agents }, 'OpenACP started')
  log.info('Press Ctrl+C to stop')
}

// Direct execution for dev (node dist/main.js)
const isDirectExecution = process.argv[1]?.endsWith('main.js')
if (isDirectExecution) {
  startServer().catch((err) => {
    log.error({ err }, 'Fatal error')
    process.exit(1)
  })
}
