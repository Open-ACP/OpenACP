# Tunnel Service Design Spec

## Overview

Tunnel service exposes a local HTTP server to the public internet, enabling shareable links for file viewing and diff inspection directly from messaging platforms. Users click a link in Telegram and see the code in a Monaco Editor (VS Code engine) in their browser.

## Architecture

```
User (Browser)
  ↓ HTTPS
Tunnel Provider (cloudflare/ngrok/bore/tailscale)
  ↓ proxy
Hono HTTP Server (:3100)
  ├── GET /view/:id   → File Viewer (Monaco Editor)
  ├── GET /diff/:id   → Diff Viewer (Monaco Diff Editor)
  ├── GET /api/file/:id → JSON file content
  ├── GET /api/diff/:id → JSON diff content
  └── GET /health     → { status: 'ok' }
  ↓ reads from
ViewerStore (in-memory, TTL-based)
  ↑ writes to
OpenACPCore (enriches tool events with viewer links)
```

## Components

### TunnelProvider Interface

```typescript
interface TunnelProvider {
  start(localPort: number): Promise<string>  // returns public URL
  stop(): Promise<void>
  getPublicUrl(): string
}
```

All providers spawn a CLI subprocess, parse stdout/stderr for the public URL, with 30s timeout and graceful SIGTERM shutdown.

### Implemented Providers

| Provider | CLI | Free | Stable URL | Notes |
|----------|-----|------|------------|-------|
| **Cloudflare** (default) | `cloudflared tunnel --url` | Yes | No (changes on restart) | No account required |
| ngrok | `ngrok http --log stdout` | Freemium | With paid plan | Requires authtoken |
| bore | `bore local --to` | Yes | No | Self-hostable |
| Tailscale Funnel | `tailscale funnel` | With Tailscale account | Yes (based on hostname) | Requires Funnel ACL |

### Provider Options

**Cloudflare**: `{ domain?: string }` — custom hostname (requires CF account)

**ngrok**: `{ authtoken?: string, domain?: string, region?: string }`

**bore**: `{ server?: string, port?: number, secret?: string }` — default server: bore.pub

**Tailscale**: `{ bg?: boolean }` — background mode

### ViewerStore

In-memory ephemeral store for file/diff content:
- Auto-generated nanoid as entry ID
- Language detection from file extension (27+ languages)
- TTL-based auto-expiration (default 60 min, cleanup every 5 min)
- Path validation: files must be within session working directory
- Max content size: 1MB per entry
- Two entry types: `file` and `diff`

### File Viewer (Monaco Editor)

- VS Code editor engine loaded from CDN
- Syntax highlighting for all languages
- Line range highlighting via URL hash: `#L42` or `#L42-L55`
- Controls: dark/light theme, word wrap, minimap toggle, copy button
- File path breadcrumb, status bar with language and line count
- Read-only

### Diff Viewer (Monaco Diff Editor)

- Side-by-side or inline view toggle
- +/- change stats display
- Syntax highlighting, dark/light theme
- Read-only

### Core Integration

- `OpenACPCore.tunnelService` — set after startup if enabled
- Core enriches `tool_call` and `tool_update` events with `viewerLinks` metadata
- `extract-file-info.ts` parses ACP content formats:
  - Diff blocks: `{ type: 'diff', path, oldText, newText }`
  - Content wrappers: `{ type: 'content', content: { type: 'text', text } }`
  - Tool inputs: `{ file_path, content }`
  - Infers file path from tool name (e.g., "Read src/main.ts")
- Viewer links persist across tool updates (carried forward on message edits)

### Telegram Adapter Integration

- Renders clickable "View file" / "View diff" links in tool call messages
- Links survive tool_update edits (not lost when status changes)

## Config

```json
{
  "tunnel": {
    "enabled": true,
    "port": 3100,
    "provider": "cloudflare",
    "options": {},
    "storeTtlMinutes": 60,
    "auth": {
      "enabled": false,
      "token": ""
    }
  }
}
```

### Environment Variable Overrides

| Env Var | Config Path |
|---------|-------------|
| `OPENACP_TUNNEL_ENABLED` | `tunnel.enabled` |
| `OPENACP_TUNNEL_PORT` | `tunnel.port` |
| `OPENACP_TUNNEL_PROVIDER` | `tunnel.provider` |

## Security

- **Enabled by default**: tunnel is on with cloudflare provider out of the box
- **Auth**: optional Bearer token via header or `?token=` query param
- `/health` route is unauthenticated
- Path validation: rejects files outside session working directory
- Content size cap: 1MB per entry
- TTL expiration: entries auto-deleted after configured minutes
- Ephemeral URLs: Cloudflare free tier URL changes on every restart

## Backward Compatibility & Config Auto-Migration

When `ConfigManager.load()` reads an existing config file that has **no `tunnel` section**, it:

1. Injects the default tunnel config with `enabled: true` and `provider: "cloudflare"`
2. **Writes it back to the config file** so the user can see and modify it
3. Logs: `"Added tunnel section to config (enabled by default with cloudflare)"`

This ensures:
- Existing users get tunnel enabled automatically on upgrade
- The config file is self-documenting (user sees the new section)
- User can disable by setting `enabled: false` in the file
- Zod schema default remains `enabled: false` (safe for programmatic empty configs)
- DEFAULT_CONFIG for new installations has `enabled: true`
- Unknown provider values fall back to cloudflare with warning log

## Startup Flow

1. Config loaded, auto-migration adds `tunnel` section if missing (writes to file)
2. `tunnel.enabled` checked
3. If enabled: dynamic import `./tunnel/tunnel-service.js`
4. `TunnelService` created with config
5. HTTP server started on port — if port in use, warns and falls back to localhost URL (no crash)
6. Tunnel provider spawned, waits for public URL (30s timeout)
7. If provider fails: falls back to `http://localhost:{port}`
8. `core.tunnelService` set for event enrichment
9. On shutdown: provider stopped, server closed, store destroyed

## Files

| File | Purpose |
|------|---------|
| `src/tunnel/provider.ts` | TunnelProvider interface |
| `src/tunnel/tunnel-service.ts` | Orchestrator: server + provider + store |
| `src/tunnel/server.ts` | Hono HTTP routes |
| `src/tunnel/viewer-store.ts` | In-memory store with TTL |
| `src/tunnel/extract-file-info.ts` | Parse ACP tool content → file info |
| `src/tunnel/providers/cloudflare.ts` | Cloudflare provider |
| `src/tunnel/providers/ngrok.ts` | ngrok provider |
| `src/tunnel/providers/bore.ts` | bore provider |
| `src/tunnel/providers/tailscale.ts` | Tailscale Funnel provider |
| `src/tunnel/templates/file-viewer.ts` | Monaco Editor HTML template |
| `src/tunnel/templates/diff-viewer.ts` | Monaco Diff Editor HTML template |
| `src/tunnel/index.ts` | Public exports |
