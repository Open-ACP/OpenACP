<div align="center">

# OpenACP

**Self-hosted bridge between messaging platforms and AI coding agents**

One message, any channel, any agent.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg)](https://nodejs.org/)
[![ACP Protocol](https://img.shields.io/badge/Protocol-ACP-purple.svg)](https://agentclientprotocol.org/)

[Getting Started](docs/guide/getting-started.md) | [Usage](docs/guide/usage.md) | [Configuration](docs/guide/configuration.md) | [Tunnel](docs/guide/tunnel.md) | [Plugins](docs/guide/plugins.md) | [Development](docs/guide/development.md)

</div>

---

## What is OpenACP?

OpenACP lets you control AI coding agents (Claude Code, Codex, ...) from messaging apps like Telegram. You send a message, the agent writes code, runs commands, and streams everything back — in real time.

It uses the [Agent Client Protocol (ACP)](https://agentclientprotocol.org/) to talk to agents. You host it on your own machine, so you own the data.

```
You (Telegram / Discord / ...)
  ↓
OpenACP ─── ChannelAdapter ─── Session Manager ─── Session Store
  ↓                                                     ↓
ACP Protocol (JSON-RPC / stdio)                  Tunnel Service
  ↓                                                     ↓
AI Agent (Claude Code, Codex, ...)            File/Diff Viewer
```

## Features

- **Multi-agent** — Claude Code, Codex, or any ACP-compatible agent
- **Telegram** — Forum topics, real-time streaming, permission buttons, skill commands
- **Tunnel & file viewer** — Public file/diff viewer via Cloudflare, ngrok, bore, or Tailscale
- **Session persistence** — Resume sessions across restarts
- **Plugin system** — Install channel adapters as npm packages
- **Structured logging** — Pino with rotation, per-session log files
- **Self-hosted** — Your keys, your data, your machine

## Setup

### Prerequisites

- **Node.js 20+**
- **A Telegram bot** — Create one via [@BotFather](https://t.me/BotFather) and save the token
- **A Telegram supergroup** with Topics enabled — Add your bot as admin

### Install & first run

```bash
npm install -g @openacp/cli
openacp
```

> **Important: `openacp` is an interactive CLI.**
> The first run launches a setup wizard that asks you questions in the terminal (bot token, group selection, workspace path, etc.).
> You **must run it yourself in a terminal** — it cannot be run by a script or an AI agent because it requires interactive input.

The wizard will:

1. **Ask for your Telegram bot token** — validates it against the Telegram API
2. **Auto-detect your group** — send "hi" in the group and it picks it up, or enter the chat ID manually
3. **Set a workspace directory** — where agents will create project folders (default: `~/openacp-workspace`)
4. **Detect installed agents** — finds Claude Code, Codex, etc.
5. **Choose run mode** — foreground (in terminal) or background (daemon with auto-start)

Config is saved to `~/.openacp/config.json`. After setup, OpenACP starts automatically.

### Running after setup

```bash
# Foreground (shows logs in terminal)
openacp

# Or as a background daemon
openacp start
openacp stop
openacp status
openacp logs
```

### Other CLI commands

```bash
openacp config            # Show current config
openacp reset             # Re-run the setup wizard
openacp update            # Update to latest version
openacp install <plugin>  # Install a plugin (e.g. @openacp/adapter-discord)
openacp uninstall <plugin>
openacp plugins           # List installed plugins
```

## Usage

Once OpenACP is running, control it from Telegram:

| Command | Description |
|---------|-------------|
| `/new [agent] [workspace]` | Create a new session |
| `/newchat` | New session, same agent & workspace |
| `/cancel` | Cancel current session |
| `/status` | Show session or system status |
| `/agents` | List available agents |

Each session gets its own forum topic. The agent streams responses in real time, shows tool calls, and asks for permission when needed.

### Session Handoff

Transfer sessions between Claude CLI and Telegram:

**CLI → Telegram:**
```bash
# Install Claude CLI integration (one-time)
openacp integrate claude

# In Claude CLI, type /openacp:handoff to transfer current session
# Or manually:
openacp adopt claude <session_id> --cwd /path/to/project
```

**Telegram → CLI:**
Type `/handoff` in any session topic. The bot will reply with the `claude --resume` command to paste in your terminal.

Sessions are not locked after handoff — you can continue from either side.

## Roadmap

- **Phase 1** — Core + Telegram + ACP agents
- **Phase 2** — Tunnel/file viewer, session persistence, logging, plugin system
- **Phase 3** — Agent skills as commands, Discord adapter, Web UI
- **Phase 4** — Voice control, file/image sharing
- **Phase 5** — WhatsApp, agent chaining, plugin marketplace

## Star History

<a href="https://star-history.com/#Open-ACP/OpenACP&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Open-ACP/OpenACP&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Open-ACP/OpenACP&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Open-ACP/OpenACP&type=Date" />
 </picture>
</a>

## Contributing

See [development guide](docs/guide/development.md).

## License

[AGPL-3.0](LICENSE)
