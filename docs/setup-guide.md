# OpenACP Setup Guide

## Prerequisites

Before starting, make sure you have:

- **Node.js >= 20** installed
- A **Telegram bot token** — create one via [@BotFather](https://t.me/BotFather)
- A **Telegram Supergroup** with **Topics/Forum** enabled
- At least one ACP agent installed (e.g., `claude-agent-acp`)

## Install

```bash
npm install -g @openacp/cli
```

Or from source:

```bash
git clone https://github.com/nicepkg/OpenACP.git
cd OpenACP
pnpm install
pnpm build
```

## First Run — Interactive Setup

```bash
openacp
```

If no config file exists (`~/.openacp/config.json`), the interactive setup wizard starts automatically. After setup, OpenACP starts immediately.

### Step 1: Telegram

The wizard asks for:

1. **Bot token** — paste the token from BotFather. OpenACP validates it by calling the Telegram API (`getMe`). If validation fails, you can re-enter or skip.
2. **Chat ID** — the numeric ID of your supergroup (e.g. `-1001234567890`). OpenACP validates it via `getChat` and checks that Topics are enabled.

**How to get your Chat ID:**
- Add [@raw_data_bot](https://t.me/raw_data_bot) to your group
- Send a message in the group
- The bot replies with the chat info including the ID

**How to set up your Telegram group:**
1. Create a new group in Telegram
2. Convert to Supergroup (Settings → Group Type)
3. Enable Topics (Settings → Topics → Enable)
4. Add your bot as admin with **Manage Topics** permission

### Step 2: Agents

The wizard auto-detects installed agents in your PATH and `node_modules/.bin`:

| Binary | Agent name |
|--------|------------|
| `claude-agent-acp` | claude |
| `claude-code` / `claude` | claude |
| `codex` | codex |

Agents are auto-configured — `claude-agent-acp` is preferred when available.

### Step 3: Workspace

Choose the base directory where OpenACP creates project workspaces.

Default: `~/openacp-workspace`

When you create sessions with named workspaces (e.g. `/new claude my-app`), they go under this directory (`~/openacp-workspace/my-app/`).

Config is saved automatically and OpenACP starts right away.

## Config File

Location: `~/.openacp/config.json` (override with `OPENACP_CONFIG_PATH` env var)

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "123456:ABC-DEF...",
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

`notificationTopicId` and `assistantTopicId` are auto-created by OpenACP on first start — you don't need to set them.

Security settings use defaults (all users allowed, 5 concurrent sessions, 60 min timeout). Edit the config file manually to change them.

## Environment Variables

These override config file values (useful for secrets or CI):

| Variable | Overrides |
|----------|-----------|
| `OPENACP_CONFIG_PATH` | Config file location |
| `OPENACP_TELEGRAM_BOT_TOKEN` | `channels.telegram.botToken` |
| `OPENACP_TELEGRAM_CHAT_ID` | `channels.telegram.chatId` |
| `OPENACP_DEFAULT_AGENT` | `defaultAgent` |
| `OPENACP_DEBUG` | Enable debug logging (`1`) |

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

## Re-running Setup

To re-run the setup wizard:

```bash
rm ~/.openacp/config.json
openacp
```

## Using OpenACP

Once running, OpenACP auto-creates two topics in your Telegram group:
- **Notifications** — aggregated alerts with deep links
- **Assistant** — AI helper for managing sessions

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
/new claude my-app          → Claude session in ~/openacp-workspace/my-app/
/new codex api-server       → Codex session in ~/openacp-workspace/api-server/
/new claude ~/code/project  → Claude session with absolute path
/new                        → Default agent and workspace
```

### Session Flow

1. `/new claude my-project` — bot creates a new topic
2. Send your coding request in the topic
3. Agent responds with streaming text, tool calls, and code
4. When agent needs permission (run command, edit file) — inline buttons appear
5. Click Allow/Deny — agent continues
6. `/cancel` to stop, or start a new topic with `/new`

## Troubleshooting

**"No channels enabled"** — Your config has `"enabled": false` for Telegram. Re-run setup or edit config manually.

**Bot token validation fails** — Make sure the token from BotFather is correct and the bot hasn't been revoked.

**Chat ID validation fails** — Ensure the chat is a Supergroup (not a regular group) and the bot is a member.

**Topics not enabled** — Go to group settings → Topics → Enable. The group must be a Supergroup first.

**Agent not found** — Install the agent binary and make sure it's in your PATH. Run `which claude-agent-acp` to verify.
