# Tunnel & File Viewer

The tunnel service exposes a local HTTP server to the public internet, generating shareable links for file/diff viewing directly from Telegram.

## How It Works

```
Agent reads/writes file → content stored in ViewerStore → link in Telegram
                                                              ↓
User clicks → Browser opens Monaco Editor (VS Code engine) with syntax highlighting
```

## File Viewer

- Monaco Editor loaded from CDN
- Syntax highlighting for all languages
- Line range highlighting via URL hash: `#L42` or `#L42-L55`
- Dark/light theme, word wrap, minimap toggle
- Copy button, file path breadcrumb

## Diff Viewer

- Monaco diff editor — side-by-side or inline toggle
- +/- change stats
- Syntax highlighting, dark/light theme

## Configuration

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

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable tunnel service |
| `port` | `3100` | Local HTTP server port |
| `provider` | `"cloudflare"` | Tunnel provider |
| `options` | `{}` | Provider-specific options |
| `storeTtlMinutes` | `60` | Viewer entry expiration (minutes) |
| `auth.enabled` | `false` | Require Bearer token |
| `auth.token` | — | Token value |

## Providers

| Provider | Config | Free | Stable URL | CLI |
|----------|--------|------|------------|-----|
| **Cloudflare** (default) | `"cloudflare"` | Yes | No | [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) |
| **ngrok** | `"ngrok"` | Freemium | With paid plan | [ngrok](https://ngrok.com/download) |
| **bore** | `"bore"` | Yes | No | [bore](https://github.com/ekzhang/bore) |
| **Tailscale Funnel** | `"tailscale"` | With account | Yes | [tailscale](https://tailscale.com/download) |

### Provider Options

**Cloudflare**: `{ "domain": "my-app.trycloudflare.com" }`

**ngrok**: `{ "authtoken": "xxx", "domain": "my-app.ngrok-free.app", "region": "ap" }`

**bore**: `{ "server": "bore.pub", "port": 12345, "secret": "xxx" }`

**Tailscale**: `{ "bg": true }`

## HTTP Endpoints

| Route | Description |
|-------|-------------|
| `GET /health` | Health check (always public) |
| `GET /view/:id` | File viewer (Monaco Editor) |
| `GET /diff/:id` | Diff viewer (Monaco Diff Editor) |
| `GET /api/file/:id` | JSON file content |
| `GET /api/diff/:id` | JSON diff content |

## Security

- **Auth**: `auth.enabled: true` requires Bearer token (header or `?token=` query param)
- **Path validation**: only files within session working directory
- **Content size**: max 1MB per entry
- **TTL**: entries auto-expire after `storeTtlMinutes`
- **Ephemeral URLs**: Cloudflare free tier URL changes on every restart
- **Resilience**: if port in use, warns and continues without tunnel (no crash)
