# Getting Started

## Prerequisites

- Node.js >= 20
- At least one ACP agent installed (e.g., `@zed-industries/claude-agent-acp`)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- A Telegram Supergroup with **Topics** enabled

## Install

```bash
npm install -g @openacp/cli
```

## First Run

```bash
openacp
```

On first run (no config file), an **interactive setup wizard** guides you through:

### Step 1: Telegram Bot

- Enter your bot token from @BotFather
- Token is **validated** against the Telegram API — you'll see the bot name on success
- Option to retry if validation fails

### Step 2: Group Chat

- OpenACP **auto-detects** your supergroup by listening for messages (120s timeout)
- Send any message in your group while it's listening
- If multiple groups are found, you pick from a list
- Alternatively, press `m` to enter the chat ID manually
- Validates that it's a supergroup (required for forum topics)

### Step 3: Workspace

- Choose a base directory for project workspaces
- Default: `~/openacp-workspace`
- Named workspaces resolve to `{baseDir}/{name}`

### Agent Detection

The wizard automatically scans your system for known ACP agents:
- `claude-agent-acp` (preferred)
- `claude-code`
- `claude`
- `codex`

The first detected agent becomes the default. If none found, falls back to `claude-agent-acp`.

### Done

Config is saved to `~/.openacp/config.json`. Edit it anytime — see [Configuration](configuration.md).

## What Happens on Startup

1. Config loaded and validated (Zod schema)
2. Logger initialized (Pino with file rotation)
3. Session store loaded (`~/.openacp/sessions.json`)
4. Tunnel service started (if enabled — default: Cloudflare)
5. Channel adapters registered and started
6. System topics created in Telegram (Notifications + Assistant)
7. Ready for messages

## Next Steps

- [Telegram Setup](telegram-setup.md) — detailed bot & group configuration
- [Usage Guide](usage.md) — commands, sessions, workspaces
- [Configuration Reference](configuration.md) — all config options
- [Tunnel & File Viewer](tunnel.md) — shareable code viewer
