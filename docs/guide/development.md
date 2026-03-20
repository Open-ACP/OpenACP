# Development

## Setup

```bash
git clone https://github.com/Open-ACP/OpenACP.git
cd OpenACP
pnpm install
pnpm build
```

## Run

```bash
pnpm start                    # Start server
OPENACP_DEBUG=1 pnpm start    # Debug mode
```

## Tests

```bash
pnpm test
```

## Pre-commit Hook

Husky runs `pnpm build` before every commit to catch type errors.

## Project Structure

```
src/
  cli.ts                           CLI entry point (openacp command)
  main.ts                          Server startup & shutdown
  core/
    core.ts                        OpenACPCore orchestrator
    config.ts                      ConfigManager + Zod schema
    setup.ts                       Interactive setup wizard
    session.ts                     Session (prompt queue, auto-name, resume)
    session-manager.ts             Session lifecycle
    session-store.ts               JSON file persistence
    agent-instance.ts              ACP SDK integration + resume
    agent-manager.ts               Agent spawning
    channel.ts                     ChannelAdapter abstract class
    plugin-manager.ts              Plugin install/uninstall/load
    log.ts                         Pino logging (console + file rotation)
    types.ts                       Shared types
  adapters/
    telegram/
      adapter.ts                   TelegramAdapter
      streaming.ts                 MessageDraft (throttled streaming)
      commands.ts                  Bot commands (/new, /cancel, etc.)
      permissions.ts               Permission inline buttons
      assistant.ts                 AI assistant topic
      formatting.ts                Markdown → Telegram HTML
      topics.ts                    Forum topic management
  tunnel/
    tunnel-service.ts              Orchestrator: server + provider + store
    server.ts                      Hono HTTP routes
    provider.ts                    TunnelProvider interface
    viewer-store.ts                In-memory store with TTL
    extract-file-info.ts           ACP content → file info parser
    providers/
      cloudflare.ts                Cloudflare Tunnel
      ngrok.ts                     ngrok
      bore.ts                      bore
      tailscale.ts                 Tailscale Funnel
    templates/
      file-viewer.ts               Monaco Editor HTML
      diff-viewer.ts               Monaco Diff Editor HTML
```

## Architecture

```
ChannelAdapter (Telegram, plugin adapters)
  ↕ messages
OpenACPCore
  ├── SessionManager → Session → AgentInstance (ACP SDK)
  ├── ConfigManager (Zod validation, env overrides)
  ├── SessionStore (JSON file, debounced writes, lazy resume)
  ├── NotificationManager
  └── TunnelService (optional)
        ├── HTTP Server (Hono)
        ├── TunnelProvider (cloudflare/ngrok/bore/tailscale)
        └── ViewerStore (in-memory, TTL)
```

## Key Design Decisions

- **Fire-and-forget message handling** — Telegram handler doesn't await the agent prompt, preventing a deadlock between polling and permission callbacks
- **Lazy resume** — Sessions only reconnect when a user sends a message, not on startup (avoids subprocess explosion)
- **Debounced session store** — Writes batched every 2s with force flush on shutdown
- **Pluggable adapters** — `ChannelAdapter` abstract class, loaded dynamically for plugins
- **Pluggable tunnel providers** — `TunnelProvider` interface, add providers with `start()`/`stop()`/`getPublicUrl()`
- **Config auto-migration** — New sections auto-added to existing config files on upgrade

## Standard Paths

| Path | Purpose |
|------|---------|
| `~/.openacp/config.json` | Configuration |
| `~/.openacp/sessions.json` | Session persistence |
| `~/.openacp/plugins/` | Installed plugin adapters |
| `~/.openacp/logs/openacp.log` | Combined log (JSONL, rotated) |
| `~/.openacp/logs/sessions/` | Per-session log files |
| `~/openacp-workspace/` | Default workspace base |
