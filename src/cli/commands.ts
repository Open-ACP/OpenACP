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
  adopt <agent> <id>                   Adopt an external agent session into OpenACP
  integrate <agent>                    Install/uninstall CLI integration for an agent

API (requires running daemon):
  openacp api status                       Show active sessions
  openacp api session <id>                 Show session details
  openacp api new [agent] [workspace]      Create a new session
  openacp api send <id> <prompt>           Send prompt to session
  openacp api cancel <id>                  Cancel a session
  openacp api dangerous <id> [on|off]      Toggle dangerous mode
  openacp api agents                       List available agents
  openacp api topics [--status s1,s2]      List topics
  openacp api delete-topic <id> [--force]  Delete a topic
  openacp api cleanup [--status s1,s2]     Cleanup finished topics
  openacp api health                       Show system health
  openacp api adapters                     List registered adapters
  openacp api tunnel                       Show tunnel status
  openacp api config                       Show runtime config
  openacp api config set <key> <value>     Update config value
  openacp api restart                      Restart daemon
  openacp api notify <message>             Send notification to all channels
  openacp api version                      Show daemon version

Note: "openacp status" shows daemon process health.
      "openacp api status" shows active agent sessions.
      "openacp --version" shows CLI version.
      "openacp api version" shows running daemon version.

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

export async function cmdApi(args: string[]): Promise<void> {
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
        console.error('Usage: openacp api cancel <session-id>')
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

    } else if (subCmd === 'topics') {
      const statusIdx = args.indexOf('--status')
      const statusParam = statusIdx !== -1 ? args[statusIdx + 1] : undefined
      const query = statusParam ? `?status=${encodeURIComponent(statusParam)}` : ''
      const res = await apiCall(port, `/api/topics${query}`)
      const data = await res.json() as { topics: Array<{ sessionId: string; topicId: number | null; name: string | null; status: string; agentName: string; lastActiveAt: string }> }
      if (data.topics.length === 0) {
        console.log('No topics found.')
      } else {
        console.log(`Topics: ${data.topics.length}\n`)
        for (const t of data.topics) {
          const name = t.name ? `  "${t.name}"` : ''
          const topic = t.topicId ? `Topic #${t.topicId}` : 'headless'
          console.log(`  ${t.sessionId}  ${t.agentName}  ${t.status}${name}      ${topic}`)
        }
      }

    } else if (subCmd === 'delete-topic') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Usage: openacp api delete-topic <session-id> [--force]')
        process.exit(1)
      }
      const force = args.includes('--force')
      const query = force ? '?force=true' : ''
      const res = await apiCall(port, `/api/topics/${encodeURIComponent(sessionId)}${query}`, { method: 'DELETE' })
      const data = await res.json() as Record<string, unknown>
      if (res.status === 409) {
        console.error(`Session "${sessionId}" is active (${(data.session as any)?.status}). Use --force to delete.`)
        process.exit(1)
      }
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      const topicLabel = data.topicId ? `Topic #${data.topicId}` : 'headless session'
      console.log(`${topicLabel} deleted (session ${sessionId})`)

    } else if (subCmd === 'cleanup') {
      const statusIdx = args.indexOf('--status')
      const statusParam = statusIdx !== -1 ? args[statusIdx + 1] : undefined
      const body: Record<string, unknown> = {}
      if (statusParam) body.statuses = statusParam.split(',')
      const res = await apiCall(port, '/api/topics/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json() as { deleted: string[]; failed: Array<{ sessionId: string; error: string }> }
      if (data.deleted.length === 0 && data.failed.length === 0) {
        console.log('Nothing to clean up.')
      } else {
        console.log(`Cleaned up ${data.deleted.length} topics${data.deleted.length ? ': ' + data.deleted.join(', ') : ''} (${data.failed.length} failed)`)
        for (const f of data.failed) {
          console.error(`  Failed: ${f.sessionId} — ${f.error}`)
        }
      }

    } else if (subCmd === 'send') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Usage: openacp api send <session-id> <prompt>')
        process.exit(1)
      }
      const prompt = args.slice(3).join(' ')
      if (!prompt) {
        console.error('Usage: openacp api send <session-id> <prompt>')
        process.exit(1)
      }
      const res = await apiCall(port, `/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      console.log(`Prompt sent to session ${sessionId} (queue depth: ${data.queueDepth})`)

    } else if (subCmd === 'session') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Usage: openacp api session <session-id>')
        process.exit(1)
      }
      const res = await apiCall(port, `/api/sessions/${encodeURIComponent(sessionId)}`)
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      console.log(`Session details:`)
      console.log(`  ID             : ${data.id}`)
      console.log(`  Agent          : ${data.agent}`)
      console.log(`  Status         : ${data.status}`)
      console.log(`  Name           : ${data.name ?? '(none)'}`)
      console.log(`  Workspace      : ${data.workspace}`)
      console.log(`  Created        : ${data.createdAt}`)
      console.log(`  Dangerous      : ${data.dangerous}`)
      console.log(`  Queue depth    : ${data.queueDepth}`)
      console.log(`  Prompt active  : ${data.promptActive}`)
      console.log(`  Channel        : ${data.channelId ?? '(none)'}`)
      console.log(`  Thread         : ${data.threadId ?? '(none)'}`)

    } else if (subCmd === 'dangerous') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Usage: openacp api dangerous <session-id> [on|off]')
        process.exit(1)
      }
      const toggle = args[3]
      if (!toggle || (toggle !== 'on' && toggle !== 'off')) {
        console.error('Usage: openacp api dangerous <session-id> [on|off]')
        process.exit(1)
      }
      const res = await apiCall(port, `/api/sessions/${encodeURIComponent(sessionId)}/dangerous`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: toggle === 'on' }),
      })
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      const state = toggle === 'on' ? 'enabled' : 'disabled'
      console.log(`Dangerous mode ${state} for session ${sessionId}`)

    } else if (subCmd === 'health') {
      const res = await apiCall(port, '/api/health')
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      const uptimeSeconds = typeof data.uptimeSeconds === 'number' ? data.uptimeSeconds : 0
      const hours = Math.floor(uptimeSeconds / 3600)
      const minutes = Math.floor((uptimeSeconds % 3600) / 60)
      const memoryBytes = typeof data.memoryUsage === 'number' ? data.memoryUsage : 0
      const memoryMB = (memoryBytes / 1024 / 1024).toFixed(1)
      const sessions = data.sessions as Record<string, unknown> ?? {}
      console.log(`Status   : ${data.status}`)
      console.log(`Uptime   : ${hours}h ${minutes}m`)
      console.log(`Version  : ${data.version}`)
      console.log(`Memory   : ${memoryMB} MB`)
      console.log(`Sessions : ${sessions.active ?? 0} active / ${sessions.total ?? 0} total`)
      console.log(`Adapters : ${data.adapters}`)
      console.log(`Tunnel   : ${data.tunnel}`)

    } else if (subCmd === 'restart') {
      const res = await apiCall(port, '/api/restart', { method: 'POST' })
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      console.log('Restart signal sent. OpenACP is restarting...')

    } else if (subCmd === 'config') {
      const subSubCmd = args[2]
      if (!subSubCmd) {
        const res = await apiCall(port, '/api/config')
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) {
          console.error(`Error: ${data.error}`)
          process.exit(1)
        }
        console.log(JSON.stringify(data.config, null, 2))
      } else if (subSubCmd === 'set') {
        const configPath = args[3]
        const configValue = args[4]
        if (!configPath || configValue === undefined) {
          console.error('Usage: openacp api config set <path> <value>')
          process.exit(1)
        }
        let value: unknown = configValue
        try {
          value = JSON.parse(configValue)
        } catch {
          // keep as string
        }
        const res = await apiCall(port, '/api/config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: configPath, value }),
        })
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) {
          console.error(`Error: ${data.error}`)
          process.exit(1)
        }
        console.log(`Config updated: ${configPath} = ${JSON.stringify(value)}`)
        if (data.needsRestart) {
          console.log('Note: restart required for this change to take effect.')
        }
      } else {
        console.error(`Unknown config subcommand: ${subSubCmd}`)
        console.log('  openacp api config                       Show runtime config')
        console.log('  openacp api config set <key> <value>     Update config value')
        process.exit(1)
      }

    } else if (subCmd === 'adapters') {
      const res = await apiCall(port, '/api/adapters')
      const data = await res.json() as { adapters: Array<{ name: string; type: string }> }
      if (!res.ok) {
        console.error(`Error: ${(data as any).error}`)
        process.exit(1)
      }
      console.log('Registered adapters:')
      for (const a of data.adapters) {
        console.log(`  ${a.name}  (${a.type})`)
      }

    } else if (subCmd === 'tunnel') {
      const res = await apiCall(port, '/api/tunnel')
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      if (data.enabled) {
        console.log(`Tunnel provider : ${data.provider}`)
        console.log(`Tunnel URL      : ${data.url}`)
      } else {
        console.log('Tunnel: not enabled')
      }

    } else if (subCmd === 'notify') {
      const message = args.slice(2).join(' ')
      if (!message) {
        console.error('Usage: openacp api notify <message>')
        process.exit(1)
      }
      const res = await apiCall(port, '/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      console.log('Notification sent to all channels.')

    } else if (subCmd === 'version') {
      const res = await apiCall(port, '/api/version')
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        console.error(`Error: ${data.error}`)
        process.exit(1)
      }
      console.log(`Daemon version: ${data.version}`)

    } else {
      console.error(`Unknown api command: ${subCmd || '(none)'}\n`)
      console.log('Usage:')
      console.log('  openacp api status                       Show active sessions')
      console.log('  openacp api session <id>                 Show session details')
      console.log('  openacp api new [agent] [workspace]      Create a new session')
      console.log('  openacp api send <id> <prompt>           Send prompt to session')
      console.log('  openacp api cancel <id>                  Cancel a session')
      console.log('  openacp api dangerous <id> [on|off]      Toggle dangerous mode')
      console.log('  openacp api agents                       List available agents')
      console.log('  openacp api topics [--status s1,s2]      List topics')
      console.log('  openacp api delete-topic <id> [--force]  Delete a topic')
      console.log('  openacp api cleanup [--status s1,s2]     Cleanup finished topics')
      console.log('  openacp api health                       Show system health')
      console.log('  openacp api adapters                     List registered adapters')
      console.log('  openacp api tunnel                       Show tunnel status')
      console.log('  openacp api config                       Show runtime config')
      console.log('  openacp api config set <key> <value>     Update config value')
      console.log('  openacp api restart                      Restart daemon')
      console.log('  openacp api notify <message>             Send notification to all channels')
      console.log('  openacp api version                      Show daemon version')
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

export async function cmdAdopt(args: string[]): Promise<void> {
  const agent = args[1];
  const sessionId = args[2];

  if (!agent || !sessionId) {
    console.log("Usage: openacp adopt <agent> <session_id> [--cwd <path>]");
    console.log("Example: openacp adopt claude abc123-def456 --cwd /path/to/project");
    process.exit(1);
  }

  const cwdIdx = args.indexOf("--cwd");
  const cwd = cwdIdx !== -1 && args[cwdIdx + 1] ? args[cwdIdx + 1] : process.cwd();

  const port = readApiPort();
  if (!port) {
    console.log("OpenACP is not running. Start it with: openacp start");
    process.exit(1);
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, agentSessionId: sessionId, cwd }),
    });
    const data = await res.json() as Record<string, unknown>;

    if (data.ok) {
      if (data.status === "existing") {
        console.log(`Session already on Telegram. Topic pinged.`);
      } else {
        console.log(`Session transferred to Telegram.`);
      }
      console.log(`  Session ID: ${data.sessionId}`);
      console.log(`  Thread ID:  ${data.threadId}`);
    } else {
      console.log(`Error: ${(data.message as string) || (data.error as string)}`);
      process.exit(1);
    }
  } catch (err) {
    console.log(`Failed to connect to OpenACP: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export async function cmdIntegrate(args: string[]): Promise<void> {
  const { getIntegration, listIntegrations } = await import("./integrate.js");

  const agent = args[1];
  const uninstall = args.includes("--uninstall");

  if (!agent) {
    console.log("Usage: openacp integrate <agent> [--uninstall]");
    console.log(`Available integrations: ${listIntegrations().join(", ")}`);
    process.exit(1);
  }

  const integration = getIntegration(agent);
  if (!integration) {
    console.log(`No integration available for '${agent}'.`);
    console.log(`Available: ${listIntegrations().join(", ")}`);
    process.exit(1);
  }

  try {
    if (uninstall) {
      console.log(`Removing ${agent} CLI integration...`);
      await integration.uninstall();
      console.log(`\n${agent} CLI integration removed.`);
    } else {
      console.log(`Installing ${agent} CLI integration...`);
      await integration.install();
      console.log(`\n${agent} CLI integration installed.`);
      console.log(`  Use /openacp:handoff in Claude CLI to hand off sessions.`);
    }
  } catch (err) {
    console.log(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
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
