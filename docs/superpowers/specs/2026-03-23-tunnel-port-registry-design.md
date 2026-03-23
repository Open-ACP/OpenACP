# Dynamic Tunnel Port Registry — Design Spec

## Overview

Extend the tunnel service from a single-port file viewer into a multi-port registry. Each port gets its own cloudflared process and public URL. The registry persists across restarts.

## TunnelEntry

```typescript
interface TunnelEntry {
  port: number
  type: 'system' | 'user'
  label?: string
  publicUrl?: string
  sessionId?: string
  status: 'starting' | 'active' | 'failed' | 'stopped'
  createdAt: string
}
```

## Entry Types

| Type | Auto-start | User kill | Session end | Example |
|------|-----------|-----------|-------------|---------|
| `system` | Yes | No | Keep | File Viewer (port 3100) |
| `user` | Yes (restore) | Yes | Kill + notify | React app (port 3000) |

## TunnelRegistry

- In-memory Map: `port → { entry, process }`
- Persisted to `~/.openacp/tunnels.json`
- Debounced writes (2s)
- On startup: load file → re-spawn cloudflared for entries with `status: active`
- `ensureCloudflared()` called once, path cached, shared across all spawns

### API

```typescript
class TunnelRegistry {
  add(port: number, opts: { type, label?, sessionId? }): Promise<TunnelEntry>
  stop(port: number): Promise<void>
  stopBySession(sessionId: string): Promise<void>
  stopAll(): Promise<void>
  list(): TunnelEntry[]
  get(port: number): TunnelEntry | null
  getBySession(sessionId: string): TunnelEntry[]
  restore(): Promise<void>  // re-spawn on startup
}
```

## TunnelService Refactor

Currently manages a single provider. Refactored to delegate to TunnelRegistry.

- `TunnelService.start()` → create system entry (viewer) + restore user entries
- `TunnelService.addTunnel(port, opts)` → registry.add()
- `TunnelService.stopTunnel(port)` → registry.stop()
- `TunnelService.listTunnels()` → registry.list()
- ViewerStore attaches to the system entry; `fileUrl()`/`diffUrl()` read publicUrl from it

## Commands

### Telegram

| Command | Description |
|---------|-------------|
| `/tunnel <port> [label]` | Register a tunnel |
| `/tunnels` | List all tunnels (system entries marked 🔒) |
| `/tunnel stop <port>` | Stop a user tunnel |

### CLI

| Command | Description |
|---------|-------------|
| `openacp tunnel add <port> [--label name] [--session id]` | Register |
| `openacp tunnel list` | List |
| `openacp tunnel stop <port>` | Stop |
| `openacp tunnel stop-all` | Stop all user tunnels |

## Lifecycle

### System tunnel
1. OpenACP start → registry.add({ port: 3100, type: 'system', label: 'File Viewer' })
2. Spawn cloudflared → URL ready
3. Restart → restore from file, re-spawn, new URL
4. Shutdown → stop process, keep entry in file for next start

### User tunnel
1. `/tunnel 3000 my-react-app` or `openacp tunnel add 3000 --label my-react-app`
2. Spawn cloudflared → URL → notify user
3. Restart → restore, re-spawn, notify new URL
4. `/tunnel stop 3000` → kill process, remove entry, notify
5. Session destroy → stopBySession() → kill, remove, notify

## Notifications (→ Notification topic)

| Event | Message |
|-------|---------|
| Created | 🔗 Tunnel: port 3000 → https://xxx.trycloudflare.com |
| Created (label) | 🔗 Tunnel: port 3000 (my-react-app) → https://xxx.trycloudflare.com |
| Stopped (user) | 🔌 Tunnel stopped: port 3000 — user requested |
| Stopped (session) | 🔌 Tunnel stopped: port 3000 — session ended |
| Failed | ❌ Tunnel failed: port 3000 — cloudflared error |
| Restored | 🔄 Tunnel restored: port 3000 → https://new-xxx.trycloudflare.com |

## Persistence

```json
[
  { "port": 3100, "type": "system", "label": "File Viewer", "status": "active", "createdAt": "..." },
  { "port": 3000, "type": "user", "label": "my-react-app", "sessionId": "abc123", "status": "active", "createdAt": "..." }
]
```

Note: publicUrl is not persisted — Cloudflare free tier generates a new URL on each spawn.

## Integration

- **Core**: session destroy → `tunnelService.stopBySession(sessionId)`
- **Telegram**: `/tunnel`, `/tunnels` commands + notifications
- **CLI**: `openacp tunnel` subcommands
- **Product guide**: update tunnel CLI docs so agents can invoke it
- **Config**: `tunnel.enabled: false` → blocks all tunnel registration

## Files

| File | Action |
|------|--------|
| `src/tunnel/tunnel-registry.ts` | New |
| `src/tunnel/tunnel-service.ts` | Refactor |
| `src/adapters/telegram/commands/tunnel.ts` | New |
| `src/cli/commands.ts` | Modify |
| `src/core/core.ts` | Modify (session destroy hook) |
| `src/product-guide.ts` | Modify |
| `docs/guide/tunnel.md` | Update |
