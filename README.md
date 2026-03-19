# OpenACP

Self-hosted bridge that lets you interact with AI coding agents (Claude Code, Codex, etc.) from messaging platforms (Telegram, Discord, etc.) via the [Agent Client Protocol (ACP)](https://agentclientprotocol.org/).

**One message, any channel, any agent.**

## How It Works

```
You (Telegram / Discord / ...)
  │
  ▼
OpenACP (ChannelAdapter)
  │
  ▼
ACP Protocol (JSON-RPC over stdio)
  │
  ▼
AI Agent subprocess (Claude Code, Codex, ...)
```

You send a message in Telegram → OpenACP forwards it to an AI coding agent via ACP → agent responds with text, code, tool calls → OpenACP streams the response back to your chat.

## Features

- **Multi-agent** — Switch between Claude Code, Codex, or any ACP-compatible agent
- **Telegram integration** — Forum topics per session, real-time streaming, inline permission buttons
- **Session management** — Multiple parallel sessions, prompt queue, auto-naming
- **Assistant topic** — AI-powered help bot that guides you through creating sessions
- **Notification topic** — Aggregated notifications with deep links
- **Workspace management** — Named workspaces or custom paths
- **Self-hosted** — Your keys, your data, your machine

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- A Telegram Supergroup with **Forum/Topics enabled**
- At least one ACP agent installed (e.g., `claude-agent-acp`)

### Install

```bash
npm install -g @openacp/cli
openacp
```

### Setup Telegram

1. Create a Supergroup in Telegram
2. Enable **Topics** in group settings
3. Add your bot as **admin** with **Manage Topics** permission
4. Get the chat ID (use [@raw_data_bot](https://t.me/raw_data_bot) or similar)

### Run

```bash
openacp
```

On first run (no config file), an **interactive setup wizard** walks you through:

1. **Telegram** — bot token + chat ID (validated against Telegram API)
2. **Agents** — auto-detects installed agents, select which to enable
3. **Workspace** — base directory for project workspaces
4. **Security** — allowed users, session limits, timeout

Config is saved to `~/.openacp/config.json`. See [docs/setup-guide.md](docs/setup-guide.md) for details.

OpenACP will auto-create two topics in your group:
- Notifications — aggregated alerts with deep links
- Assistant — AI helper for managing sessions

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/new [agent] [workspace]` | Create a new session |
| `/new_chat` | New session, same agent & workspace |
| `/cancel` | Cancel current session |
| `/status` | Show session or system status |
| `/agents` | List available agents |
| `/help` | Show help |

### Examples

```
/new claude my-app          → New session with Claude in ~/openacp-workspace/my-app/
/new codex api-server       → New session with Codex in ~/openacp-workspace/api-server/
/new claude ~/code/project  → New session with absolute path
/new                        → New session with default agent and workspace
```

### Session Flow

1. Type `/new claude my-project` — bot creates a new topic
2. Send your coding request in the topic
3. Agent responds with streaming text, tool calls, and code
4. When agent needs permission (run command, edit file) → inline buttons appear
5. Click Allow/Deny → agent continues
6. `/cancel` to stop, or start a new topic with `/new`

## Configuration

Config file: `~/.openacp/config.json`

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "...",
      "chatId": -1001234567890,
      "notificationTopicId": null,
      "assistantTopicId": null
    }
  },
  "agents": {
    "claude": {
      "command": "claude-agent-acp",
      "args": [],
      "env": {}
    },
    "codex": {
      "command": "codex",
      "args": ["--acp"],
      "env": {}
    }
  },
  "defaultAgent": "claude",
  "workspace": {
    "baseDir": "~/openacp-workspace"
  },
  "security": {
    "allowedUserIds": [],
    "maxConcurrentSessions": 5,
    "sessionTimeoutMinutes": 60
  }
}
```

### Environment Variables

| Variable | Overrides |
|----------|-----------|
| `OPENACP_CONFIG_PATH` | Config file location |
| `OPENACP_TELEGRAM_BOT_TOKEN` | `channels.telegram.botToken` |
| `OPENACP_TELEGRAM_CHAT_ID` | `channels.telegram.chatId` |
| `OPENACP_DEFAULT_AGENT` | `defaultAgent` |
| `OPENACP_DEBUG` | Enable debug logging (set to `1`) |

## Plugins

Install additional adapters:

```bash
openacp install @openacp/adapter-discord
openacp plugins                              # list installed
openacp uninstall @openacp/adapter-discord   # remove
```

Configure in `~/.openacp/config.json`:

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "adapter": "@openacp/adapter-discord",
      "botToken": "..."
    }
  }
}
```

## Project Structure

```
openacp/
  packages/
    core/                      → @openacp/core
      src/
        main.ts                → Entry point
        core.ts                → OpenACPCore orchestrator
        config.ts              → ConfigManager + Zod validation
        setup.ts               → Interactive setup wizard
        session.ts             → Session (prompt queue, auto-name)
        agent-instance.ts      → ACP SDK integration
        channel.ts             → ChannelAdapter abstract class
        types.ts               → Shared types
    adapters/
      telegram/                → @openacp/adapter-telegram
        src/
          adapter.ts           → TelegramAdapter
          streaming.ts         → Real-time message streaming
          commands.ts          → Bot commands
          permissions.ts       → Permission inline buttons
          assistant.ts         → AI assistant topic
          formatting.ts        → Markdown → Telegram HTML
          topics.ts            → Forum topic management
```

## Roadmap

- **Phase 1** ✅ Core + Telegram + ACP agents
- **Phase 2** — Web UI, CLI, Discord adapter, tunnel/file viewer
- **Phase 3** — Agent skills as commands, session persistence
- **Phase 4** — Voice control, file sharing
- **Phase 5** — WhatsApp, agent chaining, plugin marketplace

See [docs/specs/01-roadmap.md](docs/specs/01-roadmap.md) for details.

## Adding a Channel Adapter

Extend `ChannelAdapter` from `@openacp/core`:

```typescript
import { ChannelAdapter } from '@openacp/core'

class MyAdapter extends ChannelAdapter {
  async start() { /* connect to platform */ }
  async stop() { /* disconnect */ }
  async sendMessage(sessionId, content) { /* send to user */ }
  async sendPermissionRequest(sessionId, request) { /* show buttons */ }
  async sendNotification(notification) { /* notify user */ }
  async createSessionThread(sessionId, name) { /* create thread */ }
  async renameSessionThread(sessionId, name) { /* rename thread */ }
}
```

## Development

```bash
git clone https://github.com/nicepkg/OpenACP.git
cd OpenACP
pnpm install
pnpm build
```

Run locally:

```bash
node packages/core/dist/main.js
```

## License

AGPL-3.0
