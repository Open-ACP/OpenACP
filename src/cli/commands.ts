import { installPlugin, uninstallPlugin, listPlugins } from '../core/plugin-manager.js'
import { readApiPort, removeStalePortFile, apiCall } from '../core/api-client.js'
import { getCurrentVersion, getLatestVersion, compareVersions, runUpdate, checkAndPromptUpdate } from './version.js'

function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h')
}

export function printHelp(): void {
  console.log(`
\x1b[1mOpenACP\x1b[0m — Self-hosted bridge for AI coding agents
Connect Telegram (and more) to 28+ AI coding agents via ACP protocol.

\x1b[1mGetting Started:\x1b[0m
  openacp                              First run launches setup wizard
  openacp                              After setup, starts the server

\x1b[1mServer:\x1b[0m
  openacp                              Start (mode from config)
  openacp start                        Start as background daemon
  openacp stop                         Stop background daemon
  openacp status                       Show daemon status
  openacp logs                         Tail daemon log file
  openacp --foreground                 Force foreground mode

\x1b[1mAgent Management:\x1b[0m
  openacp agents                       Browse all agents (installed + available)
  openacp agents install <name>        Install an agent from the ACP Registry
  openacp agents uninstall <name>      Remove an installed agent
  openacp agents info <name>           Show details, dependencies & setup guide
  openacp agents run <name> [-- args]  Run agent CLI directly (login, config...)
  openacp agents refresh               Force-refresh agent list from registry

  \x1b[2mExamples:\x1b[0m
    openacp agents install gemini           Install Gemini CLI
    openacp agents run gemini               Login to Google (first run)
    openacp agents info cursor              See setup instructions

\x1b[1mConfiguration:\x1b[0m
  openacp config                       Interactive config editor
  openacp config set <key> <value>     Set a config value
  openacp reset                        Re-run setup wizard
  openacp update                       Update to latest version
  openacp doctor                       Run system diagnostics
  openacp doctor --dry-run             Check only, don't fix

\x1b[1mPlugins:\x1b[0m
  openacp install <package>            Install adapter (e.g. @openacp/adapter-discord)
  openacp uninstall <package>          Remove adapter
  openacp plugins                      List installed plugins

\x1b[1mSession Transfer:\x1b[0m
  openacp integrate <agent>            Install handoff integration
  openacp integrate <agent> --uninstall
  openacp adopt <agent> <id>           Adopt an external session

\x1b[1mDaemon API:\x1b[0m \x1b[2m(requires running daemon)\x1b[0m
  openacp api status                   Active sessions
  openacp api session <id>             Session details
  openacp api new [agent] [workspace]  Create session
  openacp api send <id> <prompt>       Send prompt
  openacp api cancel <id>              Cancel session
  openacp api dangerous <id> on|off    Toggle dangerous mode
  openacp api topics [--status ...]    List topics
  openacp api cleanup [--status ...]   Cleanup old topics
  openacp api health                   System health check
  openacp api restart                  Restart daemon

\x1b[2mMore info: https://github.com/Open-ACP/OpenACP\x1b[0m
`)
}

export async function cmdVersion(): Promise<void> {
  const { getCurrentVersion } = await import("./version.js")
  console.log(`openacp v${getCurrentVersion()}`)
}

export async function cmdInstall(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp install\x1b[0m — Install a plugin adapter

\x1b[1mUsage:\x1b[0m
  openacp install <package>

\x1b[1mArguments:\x1b[0m
  <package>       npm package name (e.g. @openacp/adapter-discord)

Installs the plugin to ~/.openacp/plugins/.

\x1b[1mExamples:\x1b[0m
  openacp install @openacp/adapter-discord
`)
    return
  }
  const pkg = args[1]
  if (!pkg) {
    console.error("Usage: openacp install <package>")
    process.exit(1)
  }
  installPlugin(pkg)
}

export async function cmdUninstall(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp uninstall\x1b[0m — Remove a plugin adapter

\x1b[1mUsage:\x1b[0m
  openacp uninstall <package>

\x1b[1mArguments:\x1b[0m
  <package>       npm package name to remove

\x1b[1mExamples:\x1b[0m
  openacp uninstall @openacp/adapter-discord
`)
    return
  }
  const pkg = args[1]
  if (!pkg) {
    console.error("Usage: openacp uninstall <package>")
    process.exit(1)
  }
  uninstallPlugin(pkg)
}

export async function cmdPlugins(args: string[] = []): Promise<void> {
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp plugins\x1b[0m — List installed plugins

\x1b[1mUsage:\x1b[0m
  openacp plugins

Shows all plugins installed in ~/.openacp/plugins/.
`)
    return
  }
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

function printApiHelp(): void {
  console.log(`
\x1b[1mopenacp api\x1b[0m — Interact with the running OpenACP daemon

\x1b[1mUsage:\x1b[0m
  openacp api <command> [options]

\x1b[1mRequires a running daemon.\x1b[0m Start with: openacp start

\x1b[1mSession Commands:\x1b[0m
  openacp api status                       Show active sessions
  openacp api session <id>                 Show session details
  openacp api new [agent] [workspace]      Create a new session
  openacp api send <id> <prompt>           Send prompt to session
  openacp api cancel <id>                  Cancel a session
  openacp api dangerous <id> on|off        Toggle dangerous mode

\x1b[1mTopic Commands:\x1b[0m
  openacp api topics [--status s1,s2]      List topics
  openacp api delete-topic <id> [--force]  Delete a topic
  openacp api cleanup [--status s1,s2]     Cleanup finished topics

\x1b[1mSystem Commands:\x1b[0m
  openacp api health                       Show system health
  openacp api agents                       List available agents
  openacp api adapters                     List registered adapters
  openacp api tunnel                       Show tunnel status
  openacp api config                       Show runtime config
  openacp api config set <key> <value>     Update config value
  openacp api notify <message>             Send notification to all channels
  openacp api restart                      Restart daemon
  openacp api version                      Show daemon version

\x1b[1mOptions:\x1b[0m
  -h, --help                               Show this help message
`)
}

export async function cmdApi(args: string[]): Promise<void> {
  const subCmd = args[1]

  if (wantsHelp(args) && (!subCmd || subCmd === '--help' || subCmd === '-h')) {
    printApiHelp()
    return
  }

  // Handle --help for individual api subcommands (before port check)
  if (wantsHelp(args) && subCmd) {
    const apiSubHelp: Record<string, string> = {
      'status': `
\x1b[1mopenacp api status\x1b[0m — Show active sessions

\x1b[1mUsage:\x1b[0m
  openacp api status

Lists all active sessions with their ID, agent, status, and name.
`,
      'session': `
\x1b[1mopenacp api session\x1b[0m — Show session details

\x1b[1mUsage:\x1b[0m
  openacp api session <id>

\x1b[1mArguments:\x1b[0m
  <id>            Session ID

Shows detailed info: agent, status, name, workspace, creation time,
dangerous mode, queue depth, and channel/thread IDs.
`,
      'new': `
\x1b[1mopenacp api new\x1b[0m — Create a new session

\x1b[1mUsage:\x1b[0m
  openacp api new [agent] [workspace]
  openacp api new [agent] --workspace <path>

\x1b[1mArguments:\x1b[0m
  [agent]         Agent name (uses default if omitted)
  [workspace]     Working directory for the session

\x1b[1mExamples:\x1b[0m
  openacp api new
  openacp api new claude /path/to/project
  openacp api new gemini --workspace /path/to/project
`,
      'send': `
\x1b[1mopenacp api send\x1b[0m — Send prompt to a session

\x1b[1mUsage:\x1b[0m
  openacp api send <id> <prompt>

\x1b[1mArguments:\x1b[0m
  <id>            Session ID
  <prompt>        Prompt text (all remaining arguments are joined)

\x1b[1mExamples:\x1b[0m
  openacp api send abc123 "Fix the login bug"
  openacp api send abc123 refactor the auth module
`,
      'cancel': `
\x1b[1mopenacp api cancel\x1b[0m — Cancel a session

\x1b[1mUsage:\x1b[0m
  openacp api cancel <id>

\x1b[1mArguments:\x1b[0m
  <id>            Session ID to cancel
`,
      'dangerous': `
\x1b[1mopenacp api dangerous\x1b[0m — Toggle dangerous mode for a session

\x1b[1mUsage:\x1b[0m
  openacp api dangerous <id> on|off

\x1b[1mArguments:\x1b[0m
  <id>            Session ID
  on|off          Enable or disable dangerous mode

Dangerous mode allows the agent to run destructive commands
without confirmation prompts.
`,
      'topics': `
\x1b[1mopenacp api topics\x1b[0m — List topics

\x1b[1mUsage:\x1b[0m
  openacp api topics [--status <statuses>]

\x1b[1mOptions:\x1b[0m
  --status <s1,s2>  Filter by status (comma-separated)

\x1b[1mExamples:\x1b[0m
  openacp api topics
  openacp api topics --status active,finished
`,
      'delete-topic': `
\x1b[1mopenacp api delete-topic\x1b[0m — Delete a topic

\x1b[1mUsage:\x1b[0m
  openacp api delete-topic <id> [--force]

\x1b[1mArguments:\x1b[0m
  <id>            Session ID of the topic to delete

\x1b[1mOptions:\x1b[0m
  --force         Delete even if session is active
`,
      'cleanup': `
\x1b[1mopenacp api cleanup\x1b[0m — Cleanup finished topics

\x1b[1mUsage:\x1b[0m
  openacp api cleanup [--status <statuses>]

\x1b[1mOptions:\x1b[0m
  --status <s1,s2>  Filter by status (comma-separated, default: finished topics)

\x1b[1mExamples:\x1b[0m
  openacp api cleanup
  openacp api cleanup --status finished,error
`,
      'health': `
\x1b[1mopenacp api health\x1b[0m — Show system health

\x1b[1mUsage:\x1b[0m
  openacp api health

Shows status, uptime, version, memory usage, session counts,
registered adapters, and tunnel status.
`,
      'agents': `
\x1b[1mopenacp api agents\x1b[0m — List available agents from running daemon

\x1b[1mUsage:\x1b[0m
  openacp api agents

Lists agents configured in the running daemon with their names
and which one is the default.
`,
      'adapters': `
\x1b[1mopenacp api adapters\x1b[0m — List registered adapters

\x1b[1mUsage:\x1b[0m
  openacp api adapters

Shows all channel adapters registered with the running daemon.
`,
      'tunnel': `
\x1b[1mopenacp api tunnel\x1b[0m — Show tunnel status

\x1b[1mUsage:\x1b[0m
  openacp api tunnel

Shows whether a tunnel is enabled, the provider, and the URL.
`,
      'config': `
\x1b[1mopenacp api config\x1b[0m — Show or update runtime config

\x1b[1mUsage:\x1b[0m
  openacp api config                       Show current runtime config
  openacp api config set <key> <value>     Update a config value

\x1b[2mNote: Prefer 'openacp config' instead — it works whether daemon is running or not.\x1b[0m
`,
      'restart': `
\x1b[1mopenacp api restart\x1b[0m — Restart the daemon

\x1b[1mUsage:\x1b[0m
  openacp api restart

Sends a restart signal to the running daemon.
`,
      'notify': `
\x1b[1mopenacp api notify\x1b[0m — Send notification to all channels

\x1b[1mUsage:\x1b[0m
  openacp api notify <message>

\x1b[1mArguments:\x1b[0m
  <message>       Notification text (all remaining arguments are joined)

\x1b[1mExamples:\x1b[0m
  openacp api notify "Deployment complete"
`,
      'version': `
\x1b[1mopenacp api version\x1b[0m — Show daemon version

\x1b[1mUsage:\x1b[0m
  openacp api version

Shows the version of the currently running daemon process.
`,
    }
    const help = apiSubHelp[subCmd]
    if (help) {
      console.log(help)
      return
    }
    // Unknown subcommand with --help, show general help
    printApiHelp()
    return
  }

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
      console.warn('⚠️  Deprecated: use "openacp config" or "openacp config set" instead.')
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
      const { suggestMatch } = await import('./suggest.js')
      const apiSubcommands = [
        'new', 'cancel', 'status', 'agents', 'topics', 'delete-topic',
        'cleanup', 'send', 'session', 'dangerous', 'health', 'restart',
        'config', 'adapters', 'tunnel', 'notify', 'version',
      ]
      const suggestion = suggestMatch(subCmd ?? '', apiSubcommands)
      console.error(`Unknown api command: ${subCmd || '(none)'}\n`)
      if (suggestion) console.error(`Did you mean: ${suggestion}?\n`)
      printApiHelp()
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

export async function cmdStart(args: string[] = []): Promise<void> {
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp start\x1b[0m — Start OpenACP as a background daemon

\x1b[1mUsage:\x1b[0m
  openacp start

Starts the server as a background process (daemon mode).
Requires an existing config — run 'openacp' first to set up.

\x1b[1mSee also:\x1b[0m
  openacp stop       Stop the daemon
  openacp status     Check if daemon is running
  openacp logs       Tail daemon log file
`)
    return
  }
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

export async function cmdStop(args: string[] = []): Promise<void> {
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp stop\x1b[0m — Stop the background daemon

\x1b[1mUsage:\x1b[0m
  openacp stop

Sends a stop signal to the running OpenACP daemon process.
`)
    return
  }
  const { stopDaemon } = await import('../core/daemon.js')
  const result = stopDaemon()
  if (result.stopped) {
    console.log(`OpenACP daemon stopped (was PID ${result.pid})`)
  } else {
    console.error(result.error)
    process.exit(1)
  }
}

export async function cmdStatus(args: string[] = []): Promise<void> {
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp status\x1b[0m — Show daemon status

\x1b[1mUsage:\x1b[0m
  openacp status

Shows whether the OpenACP daemon is running and its PID.
`)
    return
  }
  const { getStatus } = await import('../core/daemon.js')
  const status = getStatus()
  if (status.running) {
    console.log(`OpenACP is running (PID ${status.pid})`)
  } else {
    console.log('OpenACP is not running')
  }
}

export async function cmdLogs(args: string[] = []): Promise<void> {
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp logs\x1b[0m — Tail daemon log file

\x1b[1mUsage:\x1b[0m
  openacp logs

Streams the last 50 lines of the OpenACP log file and
follows new output (like tail -f). Press Ctrl+C to stop.

Log file location is configured in config (default: ~/.openacp/logs/).
`)
    return
  }
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

export async function cmdConfig(args: string[] = []): Promise<void> {
  const subCmd = args[1] // 'set' or undefined

  if (wantsHelp(args) && subCmd === 'set') {
    console.log(`
\x1b[1mopenacp config set\x1b[0m — Set a config value directly

\x1b[1mUsage:\x1b[0m
  openacp config set <key> <value>

\x1b[1mArguments:\x1b[0m
  <key>           Dot-notation config path (e.g. telegram.botToken)
  <value>         New value (JSON-parsed if possible, otherwise string)

\x1b[1mOptions:\x1b[0m
  -h, --help      Show this help message

Works with both running and stopped daemon. When running, uses
the API for live updates. When stopped, edits config file directly.

\x1b[1mExamples:\x1b[0m
  openacp config set defaultAgent claude
  openacp config set security.maxConcurrentSessions 5
  openacp config set telegram.botToken "123:ABC"
`)
    return
  }

  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp config\x1b[0m — View and edit configuration

\x1b[1mUsage:\x1b[0m
  openacp config                       Open interactive config editor
  openacp config set <key> <value>     Set a config value directly

\x1b[1mOptions:\x1b[0m
  -h, --help                           Show this help message

Works with both running and stopped daemon. When running, uses
the API for live updates. When stopped, edits config file directly.

\x1b[1mExamples:\x1b[0m
  openacp config
  openacp config set defaultAgent claude

\x1b[2mRun 'openacp config set --help' for more info on the set subcommand.\x1b[0m
`)
    return
  }

  if (subCmd === 'set') {
    // Non-interactive: openacp config set <key> <value>
    const configPath = args[2]
    const configValue = args[3]
    if (!configPath || configValue === undefined) {
      console.error('Usage: openacp config set <path> <value>')
      process.exit(1)
    }

    // Validate top-level config key
    const { ConfigSchema } = await import('../core/config.js')
    const topLevelKey = configPath.split('.')[0]
    const validConfigKeys = Object.keys(ConfigSchema.shape)
    if (!validConfigKeys.includes(topLevelKey)) {
      const { suggestMatch } = await import('./suggest.js')
      const suggestion = suggestMatch(topLevelKey, validConfigKeys)
      console.error(`Unknown config key: ${topLevelKey}`)
      if (suggestion) console.error(`Did you mean: ${suggestion}?`)
      process.exit(1)
    }

    let value: unknown = configValue
    try { value = JSON.parse(configValue) } catch { /* keep as string */ }

    const port = readApiPort()
    if (port !== null) {
      // Server running — use API
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
      // Server not running — update file directly
      const { ConfigManager } = await import('../core/config.js')
      const cm = new ConfigManager()
      if (!(await cm.exists())) {
        console.error('No config found. Run "openacp" first to set up.')
        process.exit(1)
      }
      await cm.load()
      const updates = buildNestedUpdateFromPath(configPath, value)
      await cm.save(updates)
      console.log(`Config updated: ${configPath} = ${JSON.stringify(value)}`)
    }
    return
  }

  // Interactive editor
  const { runConfigEditor } = await import('../core/config-editor.js')
  const { ConfigManager } = await import('../core/config.js')
  const cm = new ConfigManager()
  if (!(await cm.exists())) {
    console.error('No config found. Run "openacp" first to set up.')
    process.exit(1)
  }

  const port = readApiPort()
  if (port !== null) {
    await runConfigEditor(cm, 'api', port)
  } else {
    await runConfigEditor(cm, 'file')
  }
}

function buildNestedUpdateFromPath(dotPath: string, value: unknown): Record<string, unknown> {
  const parts = dotPath.split('.')
  const result: Record<string, unknown> = {}
  let target = result
  for (let i = 0; i < parts.length - 1; i++) {
    target[parts[i]] = {}
    target = target[parts[i]] as Record<string, unknown>
  }
  target[parts[parts.length - 1]] = value
  return result
}

export async function cmdReset(args: string[] = []): Promise<void> {
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp reset\x1b[0m — Re-run setup wizard

\x1b[1mUsage:\x1b[0m
  openacp reset

Deletes all OpenACP data (~/.openacp) and allows you to
start fresh with the setup wizard. The daemon must be stopped first.

\x1b[1m\x1b[31mThis is destructive\x1b[0m — config, plugins, agent data will be removed.
`)
    return
  }
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

export async function cmdUpdate(args: string[] = []): Promise<void> {
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp update\x1b[0m — Update to latest version

\x1b[1mUsage:\x1b[0m
  openacp update

Checks npm for the latest version of @openacp/cli and
installs it globally if an update is available.
`)
    return
  }
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
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp adopt\x1b[0m — Adopt an external agent session

\x1b[1mUsage:\x1b[0m
  openacp adopt <agent> <session_id> [--cwd <path>]

\x1b[1mArguments:\x1b[0m
  <agent>         Agent name (e.g. claude)
  <session_id>    External session ID to adopt

\x1b[1mOptions:\x1b[0m
  --cwd <path>    Working directory for the session (default: current dir)
  -h, --help      Show this help message

Transfers an existing agent session into OpenACP so it appears
as a Telegram topic. Requires a running daemon.

\x1b[1mExamples:\x1b[0m
  openacp adopt claude abc123-def456
  openacp adopt claude abc123 --cwd /path/to/project
`)
    return
  }

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
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp integrate\x1b[0m — Manage agent integrations

\x1b[1mUsage:\x1b[0m
  openacp integrate <agent>              Install integration for an agent
  openacp integrate <agent> --uninstall  Remove integration

\x1b[1mArguments:\x1b[0m
  <agent>         Agent name (e.g. claude)

\x1b[1mOptions:\x1b[0m
  --uninstall     Remove the integration instead of installing
  -h, --help      Show this help message

Integrations enable features like session handoff from an agent
to OpenACP (Telegram). For example, the Claude integration adds
a "Handoff" slash command to Claude Code.

\x1b[1mExamples:\x1b[0m
  openacp integrate claude
  openacp integrate claude --uninstall
`)
    return
  }

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
    const { suggestMatch } = await import('./suggest.js');
    const available = listIntegrations();
    const suggestion = suggestMatch(agent, available);
    console.log(`No integration available for '${agent}'.`);
    if (suggestion) console.log(`Did you mean: ${suggestion}?`);
    console.log(`Available: ${available.join(", ")}`);
    process.exit(1);
  }

  for (const item of integration.items) {
    if (uninstall) {
      console.log(`Removing ${agent}/${item.id}...`);
      const result = await item.uninstall();
      for (const log of result.logs) console.log(`  ${log}`);
      if (result.success) {
        console.log(`  ${item.name} removed.`);
      } else {
        console.log(`  Failed to remove ${item.name}.`);
        process.exit(1);
      }
    } else {
      console.log(`Installing ${agent}/${item.id}...`);
      const result = await item.install();
      for (const log of result.logs) console.log(`  ${log}`);
      if (result.success) {
        console.log(`  ${item.name} installed.`);
      } else {
        console.log(`  Failed to install ${item.name}.`);
        process.exit(1);
      }
    }
  }
}

export async function cmdDoctor(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp doctor\x1b[0m — Run system diagnostics

\x1b[1mUsage:\x1b[0m
  openacp doctor [--dry-run]

\x1b[1mOptions:\x1b[0m
  --dry-run       Check only, don't apply any fixes
  -h, --help      Show this help message

Checks your OpenACP installation for common issues including
config validity, agent availability, dependencies, and connectivity.
Fixable issues can be auto-repaired when not using --dry-run.
`)
    return
  }

  const knownFlags = ["--dry-run"];
  const unknownFlags = args.slice(1).filter(
    (a) => a.startsWith("--") && !knownFlags.includes(a),
  );
  if (unknownFlags.length > 0) {
    const { suggestMatch } = await import('./suggest.js');
    for (const flag of unknownFlags) {
      const suggestion = suggestMatch(flag, knownFlags);
      console.error(`Unknown flag: ${flag}`);
      if (suggestion) console.error(`Did you mean: ${suggestion}?`);
    }
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const { DoctorEngine } = await import("../core/doctor/index.js");
  const engine = new DoctorEngine({ dryRun });

  console.log("\n🩺 OpenACP Doctor\n");

  const report = await engine.runAll();

  // Render results
  const icons = { pass: "\x1b[32m✅\x1b[0m", warn: "\x1b[33m⚠️\x1b[0m", fail: "\x1b[31m❌\x1b[0m" };

  for (const category of report.categories) {
    console.log(`\x1b[1m\x1b[36m${category.name}\x1b[0m`);
    for (const result of category.results) {
      console.log(`  ${icons[result.status]} ${result.message}`);
    }
    console.log();
  }

  // Handle risky fixes
  if (report.pendingFixes.length > 0) {
    console.log("\x1b[1mFixable issues:\x1b[0m\n");
    for (const pending of report.pendingFixes) {
      if (dryRun) {
        console.log(`  🔧 ${pending.message} (use without --dry-run to fix)`);
      } else {
        const { confirm } = await import("@inquirer/prompts");
        const shouldFix = await confirm({
          message: `Fix: ${pending.message}?`,
          default: false,
        });
        if (shouldFix) {
          const fixResult = await pending.fix();
          if (fixResult.success) {
            console.log(`  \x1b[32m✓ ${fixResult.message}\x1b[0m`);
          } else {
            console.log(`  \x1b[31m✗ Fix failed: ${fixResult.message}\x1b[0m`);
          }
        }
      }
    }
    console.log();
  }

  // Summary
  const { passed, warnings, failed, fixed } = report.summary;
  const fixedStr = fixed > 0 ? `, ${fixed} fixed` : "";
  console.log(`Result: ${passed} passed, ${warnings} warnings, ${failed} failed${fixedStr}`);

  if (failed > 0) {
    process.exit(1);
  }
}

export async function cmdAgents(args: string[]): Promise<void> {
  const subcommand = args[1];

  if (wantsHelp(args) && (!subcommand || subcommand === '--help' || subcommand === '-h')) {
    console.log(`
\x1b[1mopenacp agents\x1b[0m — Manage AI coding agents

\x1b[1mUsage:\x1b[0m
  openacp agents                       Browse all agents (installed + available)
  openacp agents install <name>        Install an agent from the ACP Registry
  openacp agents uninstall <name>      Remove an installed agent
  openacp agents info <name>           Show details, dependencies & setup guide
  openacp agents run <name> [-- args]  Run agent CLI directly (login, config...)
  openacp agents refresh               Force-refresh agent list from registry

\x1b[1mOptions:\x1b[0m
  -h, --help                           Show this help message

\x1b[1mExamples:\x1b[0m
  openacp agents install gemini           Install Gemini CLI
  openacp agents run gemini               Login to Google (first run)
  openacp agents info cursor              See setup instructions

\x1b[2mRun 'openacp agents <command> --help' for more info on a subcommand.\x1b[0m
`)
    return;
  }

  switch (subcommand) {
    case "install":
      return agentsInstall(args[2], args.includes("--force"), wantsHelp(args));
    case "uninstall":
      return agentsUninstall(args[2], wantsHelp(args));
    case "refresh":
      if (wantsHelp(args)) {
        console.log(`
\x1b[1mopenacp agents refresh\x1b[0m — Force-refresh agent list from registry

\x1b[1mUsage:\x1b[0m
  openacp agents refresh

Fetches the latest agent catalog from the ACP Registry,
bypassing the normal staleness check.
`)
        return;
      }
      return agentsRefresh();
    case "info":
      return agentsInfo(args[2], wantsHelp(args));
    case "run":
      return agentsRun(args[2], args.slice(3), wantsHelp(args));
    case "list":
    case undefined:
      return agentsList();
    default: {
      const { suggestMatch } = await import('./suggest.js');
      const agentSubcommands = ["install", "uninstall", "refresh", "info", "run", "list"];
      const suggestion = suggestMatch(subcommand, agentSubcommands);
      console.error(`Unknown agents command: ${subcommand}`);
      if (suggestion) console.error(`Did you mean: ${suggestion}?`);
      console.error(`\nRun 'openacp agents' to see available agents.`);
      process.exit(1);
    }
  }
}

async function agentsList(): Promise<void> {
  const { AgentCatalog } = await import("../core/agent-catalog.js");
  const catalog = new AgentCatalog();
  catalog.load();
  await catalog.refreshRegistryIfStale();

  const items = catalog.getAvailable();
  const installed = items.filter((i) => i.installed);
  const available = items.filter((i) => !i.installed);

  console.log("");
  if (installed.length > 0) {
    console.log("  \x1b[1mInstalled agents:\x1b[0m\n");
    for (const item of installed) {
      const deps = item.missingDeps?.length
        ? `  \x1b[33m(needs: ${item.missingDeps.join(", ")})\x1b[0m`
        : "";
      console.log(
        `  \x1b[32m✓\x1b[0m ${item.key.padEnd(18)} ${item.name.padEnd(22)} v${item.version.padEnd(10)} ${item.distribution}${deps}`,
      );
      if (item.description) {
        console.log(`    \x1b[2m${item.description}\x1b[0m`);
      }
    }
    console.log("");
  }

  if (available.length > 0) {
    console.log("  \x1b[1mAvailable to install:\x1b[0m\n");
    for (const item of available) {
      const icon = item.available ? "\x1b[2m⬇\x1b[0m" : "\x1b[33m⚠\x1b[0m";
      const deps = item.missingDeps?.length
        ? `  \x1b[33m(needs: ${item.missingDeps.join(", ")})\x1b[0m`
        : "";
      console.log(
        `  ${icon} ${item.key.padEnd(18)} ${item.name.padEnd(22)} v${item.version.padEnd(10)} ${item.distribution}${deps}`,
      );
      if (item.description) {
        console.log(`    \x1b[2m${item.description}\x1b[0m`);
      }
    }
    console.log("");
  }

  console.log(
    `  \x1b[2mInstall an agent: openacp agents install <name>\x1b[0m`,
  );
  console.log("");
}

async function agentsInstall(nameOrId: string | undefined, force: boolean, help = false): Promise<void> {
  if (help || !nameOrId) {
    console.log(`
\x1b[1mopenacp agents install\x1b[0m — Install an agent from the ACP Registry

\x1b[1mUsage:\x1b[0m
  openacp agents install <name> [--force]

\x1b[1mArguments:\x1b[0m
  <name>          Agent name or ID (e.g. claude, gemini, copilot)

\x1b[1mOptions:\x1b[0m
  --force         Reinstall even if already installed
  -h, --help      Show this help message

\x1b[1mExamples:\x1b[0m
  openacp agents install claude
  openacp agents install gemini --force

Run 'openacp agents' to see available agents.
`)
    return;
  }

  const { AgentCatalog } = await import("../core/agent-catalog.js");
  const catalog = new AgentCatalog();
  catalog.load();
  await catalog.refreshRegistryIfStale();

  const progress: import("../core/types.js").InstallProgress = {
    onStart(_id, name) {
      process.stdout.write(`\n  ⏳ Installing ${name}...\n`);
    },
    onStep(step) {
      process.stdout.write(`  \x1b[32m✓\x1b[0m ${step}\n`);
    },
    onDownloadProgress(percent) {
      const filled = Math.round(percent / 5);
      const empty = 20 - filled;
      const bar = "█".repeat(filled) + "░".repeat(empty);
      process.stdout.write(`\r  ${bar} ${String(percent).padStart(3)}%`);
      if (percent >= 100) process.stdout.write("\n");
    },
    onSuccess(name) {
      console.log(`\n  \x1b[32m✓ ${name} installed successfully!\x1b[0m\n`);
    },
    onError(error) {
      console.log(`\n  \x1b[31m✗ ${error}\x1b[0m\n`);
    },
  };

  const result = await catalog.install(nameOrId, progress, force);
  if (!result.ok) {
    if (result.error?.includes('not found')) {
      const { suggestMatch } = await import('./suggest.js');
      const allKeys = catalog.getAvailable().map((a) => a.key);
      const suggestion = suggestMatch(nameOrId, allKeys);
      if (suggestion) console.log(`  Did you mean: ${suggestion}?`);
    }
    process.exit(1);
  }

  // Auto-integrate handoff if agent supports it
  const { getAgentCapabilities } = await import("../core/agent-dependencies.js");
  const caps = getAgentCapabilities(result.agentKey);
  if (caps.integration) {
    const { installIntegration } = await import("./integrate.js");
    const intResult = await installIntegration(result.agentKey, caps.integration);
    if (intResult.success) {
      console.log(`  \x1b[32m✓\x1b[0m Handoff integration installed for ${result.agentKey}`);
    } else {
      console.log(`  \x1b[33m⚠ Handoff integration failed: ${intResult.logs[intResult.logs.length - 1] ?? "unknown error"}\x1b[0m`);
    }
  }

  // Show setup steps if any
  if (result.setupSteps?.length) {
    console.log("  \x1b[1mNext steps to get started:\x1b[0m\n");
    for (const step of result.setupSteps) {
      console.log(`  → ${step}`);
    }
    console.log(`\n  \x1b[2mRun 'openacp agents info ${result.agentKey}' for more details.\x1b[0m\n`);
  }
}

async function agentsUninstall(name: string | undefined, help = false): Promise<void> {
  if (help || !name) {
    console.log(`
\x1b[1mopenacp agents uninstall\x1b[0m — Remove an installed agent

\x1b[1mUsage:\x1b[0m
  openacp agents uninstall <name>

\x1b[1mArguments:\x1b[0m
  <name>          Agent name to remove

\x1b[1mExamples:\x1b[0m
  openacp agents uninstall gemini
`)
    return;
  }

  const { AgentCatalog } = await import("../core/agent-catalog.js");
  const catalog = new AgentCatalog();
  catalog.load();

  const result = await catalog.uninstall(name);
  if (result.ok) {
    // Auto-uninstall handoff integration if exists
    const { getAgentCapabilities } = await import("../core/agent-dependencies.js");
    const caps = getAgentCapabilities(name);
    if (caps.integration) {
      const { uninstallIntegration } = await import("./integrate.js");
      await uninstallIntegration(name, caps.integration);
      console.log(`  \x1b[32m✓\x1b[0m Handoff integration removed for ${name}`);
    }
    console.log(`\n  \x1b[32m✓ ${name} removed.\x1b[0m\n`);
  } else {
    console.log(`\n  \x1b[31m✗ ${result.error}\x1b[0m`);
    if (result.error?.includes('not installed')) {
      const { suggestMatch } = await import('./suggest.js');
      const installedKeys = Object.keys(catalog.getInstalledEntries());
      const suggestion = suggestMatch(name, installedKeys);
      if (suggestion) console.log(`  Did you mean: ${suggestion}?`);
    }
    console.log();
  }
}

async function agentsRefresh(): Promise<void> {
  const { AgentCatalog } = await import("../core/agent-catalog.js");
  const catalog = new AgentCatalog();
  catalog.load();
  console.log("\n  Updating agent list...");
  await catalog.fetchRegistry();
  console.log("  \x1b[32m✓ Agent list updated.\x1b[0m\n");
}

async function agentsInfo(nameOrId: string | undefined, help = false): Promise<void> {
  if (help || !nameOrId) {
    console.log(`
\x1b[1mopenacp agents info\x1b[0m — Show agent details, dependencies & setup guide

\x1b[1mUsage:\x1b[0m
  openacp agents info <name>

\x1b[1mArguments:\x1b[0m
  <name>          Agent name or ID

Shows version, distribution type, command, setup steps, and
whether the agent is installed or available from the registry.

\x1b[1mExamples:\x1b[0m
  openacp agents info claude
  openacp agents info cursor
`)
    return;
  }

  const { AgentCatalog } = await import("../core/agent-catalog.js");
  const catalog = new AgentCatalog();
  catalog.load();

  const { getAgentSetup } = await import("../core/agent-dependencies.js");

  const installed = catalog.getInstalledAgent(nameOrId);
  if (installed) {
    console.log(`\n  \x1b[1m${installed.name}\x1b[0m`);
    console.log(`  Version:      ${installed.version}`);
    console.log(`  Type:         ${installed.distribution}`);
    console.log(`  Command:      ${installed.command} ${installed.args.join(" ")}`);
    console.log(`  Installed:    ${new Date(installed.installedAt).toLocaleDateString()}`);
    if (installed.binaryPath) console.log(`  Binary path:  ${installed.binaryPath}`);

    const setup = installed.registryId ? getAgentSetup(installed.registryId) : undefined;
    if (setup) {
      console.log(`\n  \x1b[1mSetup:\x1b[0m`);
      for (const step of setup.setupSteps) {
        console.log(`  → ${step}`);
      }
    }

    console.log(`\n  Run agent CLI:  openacp agents run ${nameOrId} -- <args>`);
    console.log("");
    return;
  }

  const regAgent = catalog.findRegistryAgent(nameOrId);
  if (regAgent) {
    const availability = catalog.checkAvailability(nameOrId);
    console.log(`\n  \x1b[1m${regAgent.name}\x1b[0m \x1b[2m(not installed)\x1b[0m`);
    console.log(`  ${regAgent.description}`);
    console.log(`  Version:    ${regAgent.version}`);
    console.log(`  License:    ${regAgent.license ?? "unknown"}`);
    if (regAgent.website) console.log(`  Website:    ${regAgent.website}`);
    if (regAgent.repository) console.log(`  Source:     ${regAgent.repository}`);
    console.log(`  Available:  ${availability.available ? "\x1b[32mYes\x1b[0m" : `\x1b[33mNo\x1b[0m — ${availability.reason}`}`);

    const setup = getAgentSetup(regAgent.id);
    if (setup) {
      console.log(`\n  \x1b[1mSetup after install:\x1b[0m`);
      for (const step of setup.setupSteps) {
        console.log(`  → ${step}`);
      }
    }

    console.log(`\n  Install: openacp agents install ${nameOrId}\n`);
    return;
  }

  const { suggestMatch } = await import('./suggest.js');
  const allKeys = catalog.getAvailable().map((a) => a.key);
  const suggestion = suggestMatch(nameOrId, allKeys);
  console.log(`\n  \x1b[31m"${nameOrId}" not found.\x1b[0m`);
  if (suggestion) console.log(`  Did you mean: ${suggestion}?`);
  console.log(`  Run 'openacp agents' to see available agents.\n`);
}

async function agentsRun(nameOrId: string | undefined, extraArgs: string[], help = false): Promise<void> {
  if (help || !nameOrId) {
    console.log(`
\x1b[1mopenacp agents run\x1b[0m — Run agent CLI directly

\x1b[1mUsage:\x1b[0m
  openacp agents run <name> [-- <args>]

\x1b[1mArguments:\x1b[0m
  <name>          Installed agent name
  <args>          Arguments to pass to the agent CLI

Use \x1b[1m--\x1b[0m to separate OpenACP flags from agent arguments.
ACP-specific flags are automatically stripped.

\x1b[1mExamples:\x1b[0m
  openacp agents run gemini               Login to Google (first run)
  openacp agents run copilot              Login to GitHub Copilot (first run)
  openacp agents run cline                Setup API keys (first run)
`)
    return;
  }

  const { AgentCatalog } = await import("../core/agent-catalog.js");
  const catalog = new AgentCatalog();
  catalog.load();

  const installed = catalog.getInstalledAgent(nameOrId);
  if (!installed) {
    const { suggestMatch } = await import('./suggest.js');
    const installedKeys = Object.keys(catalog.getInstalledEntries());
    const suggestion = suggestMatch(nameOrId, installedKeys);
    console.log(`\n  \x1b[31m"${nameOrId}" is not installed.\x1b[0m`);
    if (suggestion) {
      console.log(`  Did you mean: ${suggestion}?`);
      console.log(`  Install first: openacp agents install ${suggestion}\n`);
    } else {
      console.log(`  Install first: openacp agents install ${nameOrId}\n`);
    }
    return;
  }

  // Strip leading "--" separator if present
  const userArgs = extraArgs[0] === "--" ? extraArgs.slice(1) : extraArgs;

  const { spawnSync } = await import("node:child_process");
  const command = installed.command;

  // Include agent's base args (e.g., package name for npx) but strip ACP-specific flags
  const acpFlags = new Set(["--acp", "acp", "--acp=true", "--experimental-skills"]);
  const baseArgs: string[] = [];
  for (let i = 0; i < installed.args.length; i++) {
    const arg = installed.args[i]!;
    // Skip standalone ACP flags
    if (acpFlags.has(arg)) continue;
    // Skip "--output-format acp" pair (factory-droid pattern)
    if (arg === "--output-format" && installed.args[i + 1] === "acp") { i++; continue; }
    // Skip "exec" subcommand used only in ACP mode (factory-droid)
    if (arg === "exec" && installed.args[i + 1] === "--output-format") continue;
    baseArgs.push(arg);
  }
  const fullArgs = [...baseArgs, ...userArgs];

  console.log(`\n  Running: ${command} ${fullArgs.join(" ")}\n`);

  const result = spawnSync(command, fullArgs, {
    stdio: "inherit",
    env: { ...process.env, ...installed.env },
    cwd: process.cwd(),
  });

  if (result.status !== null && result.status !== 0) {
    process.exit(result.status);
  }
}

export async function cmdDefault(command: string | undefined): Promise<void> {
  const forceForeground = command === '--foreground'

  // Reject unknown commands
  if (command && !command.startsWith('-')) {
    const { suggestMatch } = await import('./suggest.js')
    const topLevelCommands = [
      'start', 'stop', 'status', 'logs', 'config', 'reset', 'update',
      'install', 'uninstall', 'plugins', 'api', 'adopt', 'integrate', 'doctor', 'agents',
    ]
    const suggestion = suggestMatch(command, topLevelCommands)
    console.error(`Unknown command: ${command}`)
    if (suggestion) console.error(`Did you mean: ${suggestion}?`)
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
