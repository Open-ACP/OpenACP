import { installPlugin, uninstallPlugin, listPlugins } from '../core/plugin-manager.js'
import { readApiPort, removeStalePortFile, apiCall } from '../core/api-client.js'
import { getCurrentVersion, getLatestVersion, compareVersions, runUpdate, checkAndPromptUpdate } from './version.js'

export function printHelp(): void {
  console.log(`
OpenACP - Self-hosted bridge for AI coding agents

Usage:
  openacp                              Start (mode from config)
  openacp start                        Start as background daemon
  openacp stop                         Stop background daemon
  openacp status                       Show daemon status
  openacp logs                         Tail daemon log file
  openacp config                       Edit configuration
  openacp reset                        Delete all data and start fresh
  openacp update                       Update to latest version
  openacp install <package>            Install a plugin adapter
  openacp uninstall <package>          Uninstall a plugin adapter
  openacp plugins                      List installed plugins
  openacp --foreground                 Force foreground mode
  openacp --version                    Show version
  openacp --help                       Show this help

Runtime (requires running daemon):
  openacp runtime new [agent] [workspace]  Create a new session
  openacp runtime cancel <id>              Cancel a session
  openacp runtime status                   Show active sessions
  openacp runtime agents                   List available agents

Note: "openacp status" shows daemon process health.
      "openacp runtime status" shows active agent sessions.

Install:
  npm install -g @openacp/cli

Examples:
  openacp
  openacp install @openacp/adapter-discord
  openacp uninstall @openacp/adapter-discord
`)
}

export async function cmdVersion(): Promise<void> {
  try {
    const { createRequire } = await import("node:module")
    const require = createRequire(import.meta.url)
    const pkg = require("../../package.json")
    console.log(`openacp v${pkg.version}`)
  } catch {
    console.log("openacp v0.0.0-dev")
  }
}

export async function cmdInstall(args: string[]): Promise<void> {
  const pkg = args[1]
  if (!pkg) {
    console.error("Usage: openacp install <package>")
    process.exit(1)
  }
  installPlugin(pkg)
}

export async function cmdUninstall(args: string[]): Promise<void> {
  const pkg = args[1]
  if (!pkg) {
    console.error("Usage: openacp uninstall <package>")
    process.exit(1)
  }
  uninstallPlugin(pkg)
}

export async function cmdPlugins(): Promise<void> {
  const plugins = listPlugins()
  const entries = Object.entries(plugins)
  if (entries.length === 0) {
    console.log("No plugins installed.")
  } else {
    console.log("Installed plugins:")
    for (const [name, version] of entries) {
      console.log(`  ${name}@${version}`)
    }
  }
}

export async function cmdRuntime(args: string[]): Promise<void> {
  const subCmd = args[1]

  const port = readApiPort()
  if (port === null) {
    console.error('OpenACP is not running. Start with `openacp start`')
    process.exit(1)
  }

  try {
    if (subCmd === 'new') {
      const agent = args[2]
      const workspaceIdx = args.indexOf('--workspace')
      const workspace = workspaceIdx !== -1 ? args[workspaceIdx + 1] : args[3]
      const body: Record<string, string> = {}
      if (agent) body.agent = agent
      if (workspace) body.workspace = workspace

      const res = await apiCall(port, '/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      console.log('Session created')
      console.log(`  ID        : ${data.sessionId}`)
      console.log(`  Agent     : ${data.agent}`)
      console.log(`  Workspace : ${data.workspace}`)
      console.log(`  Status    : ${data.status}`)

    } else if (subCmd === 'cancel') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Usage: openacp runtime cancel <session-id>')
        process.exit(1)
      }
      const res = await apiCall(port, `/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      })
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      console.log(`Session ${sessionId} cancelled`)

    } else if (subCmd === 'status') {
      const res = await apiCall(port, '/api/sessions')
      const data = await res.json() as { sessions: Array<{ id: string; agent: string; status: string; name: string | null }> }
      if (data.sessions.length === 0) {
        console.log('No active sessions.')
      } else {
        console.log(`Active sessions: ${data.sessions.length}\n`)
        for (const s of data.sessions) {
          const name = s.name ? `  "${s.name}"` : ''
          console.log(`  ${s.id}  ${s.agent}  ${s.status}${name}`)
        }
      }

    } else if (subCmd === 'agents') {
      const res = await apiCall(port, '/api/agents')
      const data = await res.json() as { agents: Array<{ name: string; command: string; args: string[] }>; default: string }
      console.log('Available agents:')
      for (const a of data.agents) {
        const isDefault = a.name === data.default ? ' (default)' : ''
        console.log(`  ${a.name}${isDefault}`)
      }

    } else {
      console.error(`Unknown runtime command: ${subCmd || '(none)'}\n`)
      console.log('Usage:')
      console.log('  openacp runtime new [agent] [workspace]  Create a new session')
      console.log('  openacp runtime cancel <id>         Cancel a session')
      console.log('  openacp runtime status              Show active sessions')
      console.log('  openacp runtime agents              List available agents')
      process.exit(1)
    }
  } catch (err) {
    if (err instanceof TypeError && (err as any).cause?.code === 'ECONNREFUSED') {
      console.error('OpenACP is not running (stale port file)')
      removeStalePortFile()
      process.exit(1)
    }
    throw err
  }
}

export async function cmdStart(): Promise<void> {
  await checkAndPromptUpdate()
  const { startDaemon, getPidPath } = await import('../core/daemon.js')
  const { ConfigManager } = await import('../core/config.js')
  const cm = new ConfigManager()
  if (await cm.exists()) {
    await cm.load()
    const config = cm.get()
    const result = startDaemon(getPidPath(), config.logging.logDir)
    if ('error' in result) {
      console.error(result.error)
      process.exit(1)
    }
    console.log(`OpenACP daemon started (PID ${result.pid})`)
  } else {
    console.error('No config found. Run "openacp" first to set up.')
    process.exit(1)
  }
}

export async function cmdStop(): Promise<void> {
  const { stopDaemon } = await import('../core/daemon.js')
  const result = stopDaemon()
  if (result.stopped) {
    console.log(`OpenACP daemon stopped (was PID ${result.pid})`)
  } else {
    console.error(result.error)
    process.exit(1)
  }
}

export async function cmdStatus(): Promise<void> {
  const { getStatus } = await import('../core/daemon.js')
  const status = getStatus()
  if (status.running) {
    console.log(`OpenACP is running (PID ${status.pid})`)
  } else {
    console.log('OpenACP is not running')
  }
}

export async function cmdLogs(): Promise<void> {
  const { spawn } = await import('node:child_process')
  const { ConfigManager, expandHome } = await import('../core/config.js')
  const pathMod = await import('node:path')
  const cm = new ConfigManager()
  let logDir = '~/.openacp/logs'
  if (await cm.exists()) {
    await cm.load()
    logDir = cm.get().logging.logDir
  }
  const logFile = pathMod.join(expandHome(logDir), 'openacp.log')
  const tail = spawn('tail', ['-f', '-n', '50', logFile], { stdio: 'inherit' })
  tail.on('error', (err: Error) => {
    console.error(`Cannot tail log file: ${err.message}`)
    process.exit(1)
  })
}

export async function cmdConfig(): Promise<void> {
  const { runConfigEditor } = await import('../core/config-editor.js')
  const { ConfigManager } = await import('../core/config.js')
  const cm = new ConfigManager()
  if (!(await cm.exists())) {
    console.error('No config found. Run "openacp" first to set up.')
    process.exit(1)
  }
  await runConfigEditor(cm)
}

export async function cmdReset(): Promise<void> {
  const { getStatus } = await import('../core/daemon.js')
  const status = getStatus()
  if (status.running) {
    console.error('OpenACP is running. Stop it first: openacp stop')
    process.exit(1)
  }

  const { confirm } = await import('@inquirer/prompts')
  const yes = await confirm({
    message: 'This will delete all OpenACP data (~/.openacp). You will need to set up again. Continue?',
    default: false,
  })
  if (!yes) {
    console.log('Aborted.')
    return
  }

  const { uninstallAutoStart } = await import('../core/autostart.js')
  uninstallAutoStart()

  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const openacpDir = path.join(os.homedir(), '.openacp')
  fs.rmSync(openacpDir, { recursive: true, force: true })

  console.log('Reset complete. Run `openacp` to set up again.')
}

export async function cmdUpdate(): Promise<void> {
  const current = getCurrentVersion()
  const latest = await getLatestVersion()
  if (!latest) {
    console.error('Could not check for updates. Check your internet connection.')
    process.exit(1)
  }
  if (compareVersions(current, latest) >= 0) {
    console.log(`Already up to date (v${current})`)
    return
  }
  console.log(`Update available: v${current} → v${latest}`)
  const ok = await runUpdate()
  if (ok) {
    console.log(`\x1b[32m✓ Updated to v${latest}\x1b[0m`)
  } else {
    console.error('Update failed. Try manually: npm install -g @openacp/cli@latest')
    process.exit(1)
  }
}

export async function cmdDefault(command: string | undefined): Promise<void> {
  const forceForeground = command === '--foreground'

  // Reject unknown commands
  if (command && !command.startsWith('-')) {
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exit(1)
  }

  await checkAndPromptUpdate()

  const { ConfigManager } = await import('../core/config.js')
  const cm = new ConfigManager()

  // If no config, run setup first
  if (!(await cm.exists())) {
    const { runSetup } = await import('../core/setup.js')
    const shouldStart = await runSetup(cm)
    if (!shouldStart) process.exit(0)
  }

  await cm.load()
  const config = cm.get()

  if (!forceForeground && config.runMode === 'daemon') {
    const { startDaemon, getPidPath } = await import('../core/daemon.js')
    const result = startDaemon(getPidPath(), config.logging.logDir)
    if ('error' in result) {
      console.error(result.error)
      process.exit(1)
    }
    console.log(`OpenACP daemon started (PID ${result.pid})`)
    return
  }

  const { markRunning } = await import('../core/daemon.js')
  markRunning()
  const { startServer } = await import('../main.js')
  await startServer()
}
