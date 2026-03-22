/**
 * OpenACP Product Guide — comprehensive reference for the AI assistant.
 * The assistant reads this at runtime to answer user questions about features.
 */
export const PRODUCT_GUIDE = `
# OpenACP — Product Guide

OpenACP lets you chat with AI coding agents (like Claude Code) through Telegram.
You type messages in Telegram, the agent reads/writes/runs code in your project folder, and results stream back in real time.

---

## Quick Start

1. Start OpenACP: \`openacp\` (or \`openacp start\` for background daemon)
2. Open your Telegram group — you'll see the Assistant topic
3. Tap 🆕 New Session or type /new
4. Pick an agent and a project folder
5. Chat in the session topic — the agent works on your code

---

## Core Concepts

### Sessions
A session = one conversation with one AI agent working in one project folder.
Each session gets its own Telegram topic. Chat there to give instructions to the agent.

### Agents
An agent is an AI coding tool (e.g., Claude Code). You can configure multiple agents.
The default agent is used when you don't specify one.

### Project Folder (Workspace)
The directory where the agent reads, writes, and runs code.
When creating a session, you choose which folder the agent works in.
You can type a full path like \`~/code/my-project\` or just a name like \`my-project\` (it becomes \`<base-dir>/my-project\`).

### System Topics
- **Assistant** — Always-on helper that can answer questions, create sessions, check status, troubleshoot
- **Notifications** — System alerts (permission requests, session errors, completions)

---

## Creating Sessions

### From menu
Tap 🆕 New Session → choose agent (if multiple) → choose project folder → confirm

### From command
- \`/new\` — Interactive flow (asks agent + folder)
- \`/new claude ~/code/my-project\` — Create directly with specific agent and folder

### From Assistant topic
Just ask: "Create a session for my-project with claude" — the assistant handles it

### Quick new chat
\`/newchat\` in a session topic — creates new session with same agent and folder as current one

---

## Working with Sessions

### Chat
Type messages in the session topic. The agent responds with code changes, explanations, tool outputs.

### What you see while the agent works
- **💭 Thinking indicator** — Shows when the agent is reasoning, with elapsed time
- **Text responses** — Streamed in real time, updated every few seconds
- **Tool calls** — When the agent runs commands or edits files, you see tool name, input, status, and output
- **📋 Plan card** — Visual task progress with completed/in-progress/pending items and progress bar
- **"View File" / "View Diff" buttons** — Opens in browser with Monaco editor (requires tunnel)

### Session lifecycle
1. **Creating** — Topic created, agent spawning
2. **Warming up** — Agent primes its cache (happens automatically, invisible to you)
3. **Active** — Ready for your messages
4. **Auto-naming** — After your first message, the session gets a descriptive name (agent summarizes in ~5 words). The topic title updates automatically.
5. **Finished/Error** — Session completed or hit an error

### Agent skills
Some agents provide slash commands (e.g., /compact, /review). Available skills are pinned in the session topic.

### Permission requests
When the agent wants to run a command, it asks for permission.
You see buttons: ✅ Allow, ❌ Reject (and sometimes "Always Allow").
A notification also appears in the Notifications topic with a link to the request.

### Dangerous mode
Auto-approves ALL permission requests — the agent runs any command without asking.
- Enable: \`/enable_dangerous\` or tap the ☠️ button in the session
- Disable: \`/disable_dangerous\` or tap the 🔐 button
- ⚠️ Use with caution — the agent can execute anything

### Session timeout
Idle sessions are automatically cancelled after a configurable timeout (default: 60 minutes).
Configure via \`security.sessionTimeoutMinutes\` in config.

---

## Session Transfer (Handoff)

### Telegram → Terminal
1. Type \`/handoff\` in a session topic
2. You get a command like \`claude --resume <SESSION_ID>\`
3. Copy and run it in your terminal — the session continues there with full conversation history

### Terminal → Telegram
1. First time: run \`openacp integrate claude\` to install the handoff skill (one-time setup)
2. In Claude Code, use the /openacp:handoff slash command
3. The session appears as a new topic in Telegram and you can continue chatting there

### How it works
- The agent session ID is shared between platforms
- Conversation history is preserved — pick up where you left off
- The agent that supports resume (e.g., Claude with \`--resume\`) handles the actual transfer

---

## Managing Sessions

### Status
- \`/status\` — Shows active sessions count and details
- Ask the Assistant: "What sessions are running?"

### List all sessions
- \`/sessions\` — Shows all sessions with status (active, finished, error)

### Cancel
- \`/cancel\` in a session topic — cancels that session
- Ask the Assistant: "Cancel the stuck session"

### Cleanup
- From \`/sessions\` → tap cleanup buttons (finished, errors, all)
- Ask the Assistant: "Clean up old sessions"

---

## Assistant Topic

The Assistant is an always-on AI helper in its own topic. It can:
- Answer questions about OpenACP
- Create sessions for you
- Check status and health
- Cancel sessions
- Clean up old sessions
- Troubleshoot issues
- Manage configuration

Just chat naturally: "How do I create a session?", "What's the status?", "Something is stuck"

### Clear history
\`/clear\` in the Assistant topic — resets the conversation

---

## System Commands

| Command | Where | What it does |
|---------|-------|-------------|
| \`/new [agent] [path]\` | Anywhere | Create new session |
| \`/newchat\` | Session topic | New session, same agent + folder |
| \`/cancel\` | Session topic | Cancel current session |
| \`/status\` | Anywhere | Show status |
| \`/sessions\` | Anywhere | List all sessions |
| \`/agents\` | Anywhere | List available agents |
| \`/enable_dangerous\` | Session topic | Auto-approve all permissions |
| \`/disable_dangerous\` | Session topic | Restore permission prompts |
| \`/handoff\` | Session topic | Transfer session to terminal |
| \`/clear\` | Assistant topic | Clear assistant history |
| \`/menu\` | Anywhere | Show action menu |
| \`/help\` | Anywhere | Show help |
| \`/restart\` | Anywhere | Restart OpenACP |
| \`/update\` | Anywhere | Update to latest version |
| \`/integrate\` | Anywhere | Manage agent integrations |

---

## Menu Buttons

| Button | Action |
|--------|--------|
| 🆕 New Session | Create new session (interactive) |
| 📋 Sessions | List all sessions with cleanup options |
| 📊 Status | Show active/total session count |
| 🤖 Agents | List available agents |
| 🔗 Integrate | Manage agent integrations |
| ❓ Help | Show help text |
| 🔄 Restart | Restart OpenACP |
| ⬆️ Update | Check and install updates |

---

## CLI Commands

### Server
- \`openacp\` — Start (uses configured mode: foreground or daemon)
- \`openacp start\` — Start as background daemon
- \`openacp stop\` — Stop daemon
- \`openacp status\` — Show daemon status
- \`openacp logs\` — Tail daemon logs
- \`openacp --foreground\` — Force foreground mode (useful for debugging or containers)

### Auto-start (run on boot)
- macOS: installs a LaunchAgent in \`~/Library/LaunchAgents/\`
- Linux: installs a systemd user service in \`~/.config/systemd/user/\`
- Enabled automatically when you start the daemon. Remove with \`openacp stop\`.

### Configuration
- \`openacp config\` — Interactive config editor
- \`openacp reset\` — Delete all data and start fresh

### Plugins
- \`openacp install <package>\` — Install adapter plugin (e.g., \`@openacp/adapter-discord\`)
- \`openacp uninstall <package>\` — Remove adapter plugin
- \`openacp plugins\` — List installed plugins

### Integration
- \`openacp integrate <agent>\` — Install agent integration (e.g., Claude handoff skill)
- \`openacp integrate <agent> --uninstall\` — Remove integration

### API (requires running daemon)
\`openacp api <command>\` — Interact with running daemon:

| Command | Description |
|---------|-------------|
| \`status\` | List active sessions |
| \`session <id>\` | Session details |
| \`new <agent> <path>\` | Create session |
| \`send <id> "text"\` | Send prompt |
| \`cancel <id>\` | Cancel session |
| \`dangerous <id> on/off\` | Toggle dangerous mode |
| \`topics [--status x,y]\` | List topics |
| \`delete-topic <id> [--force]\` | Delete topic |
| \`cleanup [--status x,y]\` | Cleanup old topics |
| \`agents\` | List agents |
| \`health\` | System health |
| \`config\` | Show config |
| \`config set <key> <value>\` | Update config |
| \`adapters\` | List adapters |
| \`tunnel\` | Tunnel status |
| \`notify "message"\` | Send notification |
| \`version\` | Daemon version |
| \`restart\` | Restart daemon |

---

## File Viewer (Tunnel)

When tunnel is enabled, file edits and diffs get "View" buttons that open in your browser:
- **Monaco Editor** — Full VS Code editor with syntax highlighting
- **Diff viewer** — Side-by-side or inline comparison
- **Line highlighting** — Click lines to highlight
- Dark/light theme toggle

### Setup
Enable in config: set \`tunnel.enabled\` to \`true\`.
Providers: Cloudflare (default, free), ngrok, bore, Tailscale Funnel.

---

## Configuration

Config file: \`~/.openacp/config.json\`

### Telegram
- **telegram.botToken** — Your Telegram bot token
- **telegram.chatId** — Your Telegram supergroup ID

### Agents
- **agents.<name>.command** — Agent executable path (e.g., \`claude\`, \`codex\`)
- **agents.<name>.args** — Arguments to pass to the agent command
- **agents.<name>.env** — Custom environment variables for the agent subprocess
- **defaultAgent** — Which agent to use by default

### Workspace
- **workspace.baseDir** — Base directory for project folders (default: \`~/openacp-workspace\`)

### Security
- **security.allowedUserIds** — Restrict who can use the bot (empty = everyone)
- **security.maxConcurrentSessions** — Max parallel sessions (default: 5)
- **security.sessionTimeoutMinutes** — Auto-cancel idle sessions (default: 60)

### Tunnel / File Viewer
- **tunnel.enabled** — Enable file viewer tunnel
- **tunnel.provider** — Tunnel provider: cloudflare (default, free), ngrok, bore, tailscale
- **tunnel.port** — Local port for tunnel server (default: 3100)
- **tunnel.auth.enabled** — Enable authentication for tunnel URLs
- **tunnel.auth.token** — Auth token for tunnel access
- **tunnel.storeTtlMinutes** — How long viewer links stay cached (default: 60)

### Logging
- **logging.level** — Log level: silent, debug, info, warn, error, fatal (default: info)
- **logging.logDir** — Log directory (default: \`~/.openacp/logs\`)
- **logging.maxFileSize** — Max log file size before rotation
- **logging.maxFiles** — Max number of rotated log files
- **logging.sessionLogRetentionDays** — Auto-delete old session logs (default: 30)

### Data Retention
- **sessionStore.ttlDays** — How long session records persist (default: 30). Old records are cleaned up automatically.

### Environment variables
Override config with env vars:
- \`OPENACP_TELEGRAM_BOT_TOKEN\`
- \`OPENACP_TELEGRAM_CHAT_ID\`
- \`OPENACP_DEFAULT_AGENT\`
- \`OPENACP_RUN_MODE\` — foreground or daemon
- \`OPENACP_API_PORT\` — API server port (default: 21420)
- \`OPENACP_TUNNEL_ENABLED\`
- \`OPENACP_TUNNEL_PORT\`
- \`OPENACP_TUNNEL_PROVIDER\`
- \`OPENACP_LOG_LEVEL\`
- \`OPENACP_LOG_DIR\`
- \`OPENACP_DEBUG\` — Sets log level to debug

---

## Troubleshooting

### Session stuck / not responding
- Check status: ask Assistant "Is anything stuck?"
- Cancel and create new: \`/cancel\` then \`/new\`
- Check system health: Assistant can run health check

### Agent not found
- Check available agents: \`/agents\`
- Verify agent command is installed and in PATH
- Check config: agent command + args must be correct

### Permission request not showing
- Check Notifications topic for the alert
- Try \`/enable_dangerous\` to auto-approve (if you trust the agent)

### Session disappeared after restart
- Sessions persist across restarts
- Send a message in the old topic — it auto-resumes
- If topic was deleted, the session record may still exist in status

### Bot not responding at all
- Check daemon: \`openacp status\`
- Check logs: \`openacp logs\`
- Restart: \`openacp start\` or \`/restart\`

### Messages going to wrong topic
- Each session is bound to a specific Telegram topic
- If you see messages appearing in the Assistant topic instead of the session topic, try creating a new session

### Viewing logs
- Session-specific logs: \`~/.openacp/logs/sessions/\`
- System logs: \`openacp logs\` to tail live
- Set \`OPENACP_DEBUG=true\` for verbose output

---

## Data & Storage

All data is stored in \`~/.openacp/\`:
- \`config.json\` — Configuration
- \`sessions/\` — Session records and state
- \`topics/\` — Topic-to-session mappings
- \`logs/\` — System and session logs
- \`plugins/\` — Installed adapter plugins
- \`openacp.pid\` — Daemon PID file

Session records auto-cleanup: 30 days (configurable via \`sessionStore.ttlDays\`).
Session logs auto-cleanup: 30 days (configurable via \`logging.sessionLogRetentionDays\`).
`;
