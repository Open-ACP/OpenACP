# Configuration

Config file: `~/.openacp/config.json`

Created by the setup wizard on first run. Edit manually anytime.

## Full Example

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "YOUR_BOT_TOKEN",
      "chatId": -1001234567890
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
  },
  "tunnel": {
    "enabled": true,
    "port": 3100,
    "provider": "cloudflare",
    "options": {},
    "storeTtlMinutes": 60,
    "auth": { "enabled": false }
  },
  "logging": {
    "level": "info",
    "logDir": "~/.openacp/logs",
    "maxFileSize": "10m",
    "maxFiles": 7,
    "sessionLogRetentionDays": 30
  },
  "sessionStore": {
    "ttlDays": 30
  }
}
```

## Channels

Each key is a channel name. Built-in: `telegram`. Plugins: any name with `adapter` field.

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable this channel |
| `botToken` | string | Platform bot token |
| `chatId` | number | Telegram group chat ID |
| `adapter` | string | Package name for plugin adapters |

## Agents

Each key is the agent name used in `/new` command.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | — | CLI command to spawn the agent |
| `args` | string[] | `[]` | Additional arguments |
| `workingDirectory` | string | — | Default working directory |
| `env` | object | `{}` | Additional environment variables |

## Workspace

| Field | Default | Description |
|-------|---------|-------------|
| `baseDir` | `~/openacp-workspace` | Base directory for named workspaces |

## Security

| Field | Default | Description |
|-------|---------|-------------|
| `allowedUserIds` | `[]` (all) | Telegram user IDs allowed to use the bot |
| `maxConcurrentSessions` | `5` | Max parallel sessions |
| `sessionTimeoutMinutes` | `60` | Session timeout |

## Tunnel

See [Tunnel & File Viewer](tunnel.md) for full details.

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable tunnel service |
| `port` | `3100` | Local HTTP server port |
| `provider` | `"cloudflare"` | Provider: `cloudflare`, `ngrok`, `bore`, `tailscale` |
| `options` | `{}` | Provider-specific options |
| `storeTtlMinutes` | `60` | Viewer entry expiration (minutes) |
| `auth.enabled` | `false` | Require Bearer token for viewer |
| `auth.token` | — | Token value |

## Logging

| Field | Default | Description |
|-------|---------|-------------|
| `level` | `"info"` | `debug`, `info`, `warn`, `error`, `fatal`, `silent` |
| `logDir` | `~/.openacp/logs` | Log directory |
| `maxFileSize` | `"10m"` | Log file rotation threshold |
| `maxFiles` | `7` | Rotated files to keep |
| `sessionLogRetentionDays` | `30` | Days to keep per-session logs |

Logs are written to:
- **Console**: pretty-printed with colors (Pino Pretty)
- **Combined file**: `~/.openacp/logs/openacp.log` (JSONL, rotated)
- **Per-session files**: `~/.openacp/logs/sessions/{sessionId}.log`

Old session logs are cleaned up automatically on startup.

## Session Store

| Field | Default | Description |
|-------|---------|-------------|
| `ttlDays` | `30` | Days to keep session records |

Sessions are stored in `~/.openacp/sessions.json` with debounced writes (2s). Enables [lazy resume](usage.md#session-persistence--resume) across restarts.

## Environment Variables

| Variable | Overrides |
|----------|-----------|
| `OPENACP_CONFIG_PATH` | Config file location |
| `OPENACP_TELEGRAM_BOT_TOKEN` | `channels.telegram.botToken` |
| `OPENACP_TELEGRAM_CHAT_ID` | `channels.telegram.chatId` |
| `OPENACP_DEFAULT_AGENT` | `defaultAgent` |
| `OPENACP_TUNNEL_ENABLED` | `tunnel.enabled` |
| `OPENACP_TUNNEL_PORT` | `tunnel.port` |
| `OPENACP_TUNNEL_PROVIDER` | `tunnel.provider` |
| `OPENACP_LOG_LEVEL` | `logging.level` |
| `OPENACP_LOG_DIR` | `logging.logDir` |
| `OPENACP_DEBUG` | Set logging to debug level |

## Backward Compatibility

New config sections are auto-added on upgrade:
- If `tunnel` section is missing → written to file with `enabled: true`, `provider: "cloudflare"`
- Existing fields are never modified
- Zod defaults handle any missing optional fields
