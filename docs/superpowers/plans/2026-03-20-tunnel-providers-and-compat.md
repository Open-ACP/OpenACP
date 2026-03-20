# Tunnel Providers & Backward Compatibility Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement missing tunnel providers (ngrok, bore) + add Tailscale provider, ensure backward-compatible config auto-migration, and write the tunnel design spec.

**Architecture:** Each provider implements `TunnelProvider` interface (start/stop/getPublicUrl), spawning its respective CLI subprocess. Config backward compat is handled by Zod defaults — existing configs without `tunnel` section parse cleanly. The `createProvider()` switch in `TunnelService` dispatches to the correct implementation.

**Tech Stack:** TypeScript, Node.js child_process, Zod, Hono

---

## Chunk 1: Tunnel Providers

### Task 1: Implement ngrok provider

**Files:**
- Create: `src/tunnel/providers/ngrok.ts`
- Test: `src/__tests__/ngrok-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/ngrok-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We test the URL parsing logic, not the actual subprocess
describe('NgrokTunnelProvider', () => {
  it('should export NgrokTunnelProvider class', async () => {
    const mod = await import('../tunnel/providers/ngrok.js')
    expect(mod.NgrokTunnelProvider).toBeDefined()
  })

  it('should implement TunnelProvider interface', async () => {
    const { NgrokTunnelProvider } = await import('../tunnel/providers/ngrok.js')
    const provider = new NgrokTunnelProvider({})
    expect(typeof provider.start).toBe('function')
    expect(typeof provider.stop).toBe('function')
    expect(typeof provider.getPublicUrl).toBe('function')
  })

  it('should return empty string before start', async () => {
    const { NgrokTunnelProvider } = await import('../tunnel/providers/ngrok.js')
    const provider = new NgrokTunnelProvider({})
    expect(provider.getPublicUrl()).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/ngrok-provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write ngrok provider implementation**

```typescript
// src/tunnel/providers/ngrok.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { createChildLogger } from '../../core/log.js'
import type { TunnelProvider } from '../provider.js'

const log = createChildLogger({ module: 'ngrok-tunnel' })

export class NgrokTunnelProvider implements TunnelProvider {
  private child: ChildProcess | null = null
  private publicUrl = ''
  private options: Record<string, unknown>

  constructor(options: Record<string, unknown> = {}) {
    this.options = options
  }

  async start(localPort: number): Promise<string> {
    const args = ['http', String(localPort), '--log', 'stdout', '--log-format', 'json']
    if (this.options.authtoken) {
      args.push('--authtoken', String(this.options.authtoken))
    }
    if (this.options.domain) {
      args.push('--domain', String(this.options.domain))
    }
    if (this.options.region) {
      args.push('--region', String(this.options.region))
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stop()
        reject(new Error('ngrok timed out after 30s. Is ngrok installed? https://ngrok.com/download'))
      }, 30_000)

      try {
        this.child = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        clearTimeout(timeout)
        reject(new Error('Failed to start ngrok. Install from https://ngrok.com/download'))
        return
      }

      // ngrok JSON log: {"url":"https://xxxx.ngrok-free.app"} or {"addr":"https://..."}
      const urlPattern = /https:\/\/[a-zA-Z0-9-]+\.ngrok(-free)?\.app/

      const onData = (data: Buffer) => {
        const line = data.toString()
        log.debug(line.trim())
        const match = line.match(urlPattern)
        if (match) {
          clearTimeout(timeout)
          this.publicUrl = match[0]
          log.info({ url: this.publicUrl }, 'ngrok tunnel ready')
          resolve(this.publicUrl)
        }
      }

      this.child.stdout?.on('data', onData)
      this.child.stderr?.on('data', onData)

      this.child.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(`ngrok failed: ${err.message}. Install from https://ngrok.com/download`))
      })

      this.child.on('exit', (code) => {
        if (!this.publicUrl) {
          clearTimeout(timeout)
          reject(new Error(`ngrok exited with code ${code} before establishing tunnel`))
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
      log.info('ngrok tunnel stopped')
    }
  }

  getPublicUrl(): string {
    return this.publicUrl
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/ngrok-provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tunnel/providers/ngrok.ts src/__tests__/ngrok-provider.test.ts
git commit -m "feat(tunnel): add ngrok provider"
```

---

### Task 2: Implement bore provider

**Files:**
- Create: `src/tunnel/providers/bore.ts`
- Test: `src/__tests__/bore-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/bore-provider.test.ts
import { describe, it, expect } from 'vitest'

describe('BoreTunnelProvider', () => {
  it('should export BoreTunnelProvider class', async () => {
    const mod = await import('../tunnel/providers/bore.js')
    expect(mod.BoreTunnelProvider).toBeDefined()
  })

  it('should implement TunnelProvider interface', async () => {
    const { BoreTunnelProvider } = await import('../tunnel/providers/bore.js')
    const provider = new BoreTunnelProvider({})
    expect(typeof provider.start).toBe('function')
    expect(typeof provider.stop).toBe('function')
    expect(typeof provider.getPublicUrl).toBe('function')
  })

  it('should return empty string before start', async () => {
    const { BoreTunnelProvider } = await import('../tunnel/providers/bore.js')
    const provider = new BoreTunnelProvider({})
    expect(provider.getPublicUrl()).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/bore-provider.test.ts`
Expected: FAIL

- [ ] **Step 3: Write bore provider implementation**

```typescript
// src/tunnel/providers/bore.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { createChildLogger } from '../../core/log.js'
import type { TunnelProvider } from '../provider.js'

const log = createChildLogger({ module: 'bore-tunnel' })

export class BoreTunnelProvider implements TunnelProvider {
  private child: ChildProcess | null = null
  private publicUrl = ''
  private options: Record<string, unknown>

  constructor(options: Record<string, unknown> = {}) {
    this.options = options
  }

  async start(localPort: number): Promise<string> {
    const server = String(this.options.server || 'bore.pub')
    const args = ['local', String(localPort), '--to', server]
    if (this.options.port) {
      args.push('--port', String(this.options.port))
    }
    if (this.options.secret) {
      args.push('--secret', String(this.options.secret))
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stop()
        reject(new Error('bore timed out after 30s. Is bore installed? https://github.com/ekzhang/bore'))
      }, 30_000)

      try {
        this.child = spawn('bore', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        clearTimeout(timeout)
        reject(new Error('Failed to start bore. Install from https://github.com/ekzhang/bore'))
        return
      }

      // bore output: "listening at bore.pub:12345"
      const urlPattern = /listening at ([^\s]+):(\d+)/

      const onData = (data: Buffer) => {
        const line = data.toString()
        log.debug(line.trim())
        const match = line.match(urlPattern)
        if (match) {
          clearTimeout(timeout)
          this.publicUrl = `http://${match[1]}:${match[2]}`
          log.info({ url: this.publicUrl }, 'bore tunnel ready')
          resolve(this.publicUrl)
        }
      }

      this.child.stdout?.on('data', onData)
      this.child.stderr?.on('data', onData)

      this.child.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(`bore failed: ${err.message}. Install from https://github.com/ekzhang/bore`))
      })

      this.child.on('exit', (code) => {
        if (!this.publicUrl) {
          clearTimeout(timeout)
          reject(new Error(`bore exited with code ${code} before establishing tunnel`))
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
      log.info('bore tunnel stopped')
    }
  }

  getPublicUrl(): string {
    return this.publicUrl
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/bore-provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tunnel/providers/bore.ts src/__tests__/bore-provider.test.ts
git commit -m "feat(tunnel): add bore provider"
```

---

### Task 3: Implement Tailscale Funnel provider

**Files:**
- Create: `src/tunnel/providers/tailscale.ts`
- Test: `src/__tests__/tailscale-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/tailscale-provider.test.ts
import { describe, it, expect } from 'vitest'

describe('TailscaleTunnelProvider', () => {
  it('should export TailscaleTunnelProvider class', async () => {
    const mod = await import('../tunnel/providers/tailscale.js')
    expect(mod.TailscaleTunnelProvider).toBeDefined()
  })

  it('should implement TunnelProvider interface', async () => {
    const { TailscaleTunnelProvider } = await import('../tunnel/providers/tailscale.js')
    const provider = new TailscaleTunnelProvider({})
    expect(typeof provider.start).toBe('function')
    expect(typeof provider.stop).toBe('function')
    expect(typeof provider.getPublicUrl).toBe('function')
  })

  it('should return empty string before start', async () => {
    const { TailscaleTunnelProvider } = await import('../tunnel/providers/tailscale.js')
    const provider = new TailscaleTunnelProvider({})
    expect(provider.getPublicUrl()).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/tailscale-provider.test.ts`
Expected: FAIL

- [ ] **Step 3: Write Tailscale Funnel provider implementation**

```typescript
// src/tunnel/providers/tailscale.ts
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { createChildLogger } from '../../core/log.js'
import type { TunnelProvider } from '../provider.js'

const log = createChildLogger({ module: 'tailscale-tunnel' })

export class TailscaleTunnelProvider implements TunnelProvider {
  private child: ChildProcess | null = null
  private publicUrl = ''
  private options: Record<string, unknown>

  constructor(options: Record<string, unknown> = {}) {
    this.options = options
  }

  async start(localPort: number): Promise<string> {
    // Tailscale Funnel exposes a local port to the public internet via HTTPS
    // Requires: tailscale up, tailscale cert, funnel enabled in ACL
    const args = ['funnel', String(localPort)]
    if (this.options.bg) {
      args.push('--bg')
    }

    // First, get the Tailscale hostname to construct the public URL
    let hostname: string
    try {
      hostname = execSync('tailscale status --json', { encoding: 'utf-8' })
      const status = JSON.parse(hostname)
      const dnsName = status.Self?.DNSName?.replace(/\.$/, '')
      if (!dnsName) {
        throw new Error('Could not determine Tailscale DNS name')
      }
      hostname = dnsName
    } catch (err) {
      throw new Error(
        `Failed to get Tailscale status. Is Tailscale running? https://tailscale.com/download\n${err instanceof Error ? err.message : err}`
      )
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stop()
        reject(new Error('Tailscale Funnel timed out after 30s. Ensure Funnel is enabled in your Tailscale ACL.'))
      }, 30_000)

      try {
        this.child = spawn('tailscale', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        clearTimeout(timeout)
        reject(new Error('Failed to start tailscale. Install from https://tailscale.com/download'))
        return
      }

      // Tailscale funnel outputs: "Available on the internet: https://hostname.ts.net/"
      const funnelPattern = /https:\/\/[^\s]+/
      let resolved = false

      const onData = (data: Buffer) => {
        const line = data.toString()
        log.debug(line.trim())
        if (!resolved) {
          const match = line.match(funnelPattern)
          if (match) {
            clearTimeout(timeout)
            resolved = true
            this.publicUrl = match[0].replace(/\/$/, '')
            log.info({ url: this.publicUrl }, 'Tailscale Funnel ready')
            resolve(this.publicUrl)
          }
        }
      }

      this.child.stdout?.on('data', onData)
      this.child.stderr?.on('data', onData)

      this.child.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(`tailscale failed: ${err.message}. Install from https://tailscale.com/download`))
      })

      this.child.on('exit', (code) => {
        if (!resolved) {
          clearTimeout(timeout)
          // Tailscale funnel may exit immediately if already running — construct URL from hostname
          this.publicUrl = `https://${hostname}`
          log.info({ url: this.publicUrl }, 'Tailscale Funnel (constructed URL)')
          resolve(this.publicUrl)
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
      log.info('Tailscale Funnel stopped')
    }
  }

  getPublicUrl(): string {
    return this.publicUrl
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/tailscale-provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tunnel/providers/tailscale.ts src/__tests__/tailscale-provider.test.ts
git commit -m "feat(tunnel): add tailscale funnel provider"
```

---

### Task 4: Wire all providers into TunnelService and update config schema

**Files:**
- Modify: `src/tunnel/tunnel-service.ts:70-78` (createProvider switch)
- Modify: `src/core/config.ts:49` (provider enum)
- Modify: `src/tunnel/index.ts` (exports)

- [ ] **Step 1: Update provider enum in config schema**

In `src/core/config.ts`, change line 49:
```typescript
// Before:
provider: z.enum(["cloudflare", "ngrok", "bore"]).default("cloudflare"),
// After:
provider: z.enum(["cloudflare", "ngrok", "bore", "tailscale"]).default("cloudflare"),
```

- [ ] **Step 2: Wire providers in TunnelService.createProvider()**

In `src/tunnel/tunnel-service.ts`, add imports and update switch:
```typescript
import { NgrokTunnelProvider } from './providers/ngrok.js'
import { BoreTunnelProvider } from './providers/bore.js'
import { TailscaleTunnelProvider } from './providers/tailscale.js'

// In createProvider():
private createProvider(name: string, options: Record<string, unknown>): TunnelProvider {
  switch (name) {
    case 'cloudflare':
      return new CloudflareTunnelProvider(options)
    case 'ngrok':
      return new NgrokTunnelProvider(options)
    case 'bore':
      return new BoreTunnelProvider(options)
    case 'tailscale':
      return new TailscaleTunnelProvider(options)
    default:
      log.warn({ provider: name }, 'Unknown tunnel provider, falling back to cloudflare')
      return new CloudflareTunnelProvider(options)
  }
}
```

- [ ] **Step 3: Update tunnel/index.ts exports**

Add provider exports:
```typescript
export { CloudflareTunnelProvider } from './providers/cloudflare.js'
export { NgrokTunnelProvider } from './providers/ngrok.js'
export { BoreTunnelProvider } from './providers/bore.js'
export { TailscaleTunnelProvider } from './providers/tailscale.js'
```

- [ ] **Step 4: Build and verify**

Run: `pnpm build`
Expected: Success, no errors

- [ ] **Step 5: Commit**

```bash
git add src/tunnel/tunnel-service.ts src/core/config.ts src/tunnel/index.ts
git commit -m "feat(tunnel): wire ngrok, bore, tailscale providers into service"
```

---

## Chunk 2: Backward-Compatible Config Auto-Migration

### Task 5: Add tunnel defaults to DEFAULT_CONFIG

**Files:**
- Modify: `src/core/config.ts:92-114` (DEFAULT_CONFIG)
- Test: `src/__tests__/config-tunnel-compat.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/config-tunnel-compat.test.ts
import { describe, it, expect } from 'vitest'
import { ConfigSchema } from '../core/config.js'

describe('Tunnel config backward compatibility', () => {
  it('should parse config without tunnel section', () => {
    const raw = {
      channels: { telegram: { enabled: false, botToken: 'x', chatId: 0 } },
      agents: { claude: { command: 'claude-agent-acp', args: [] } },
      defaultAgent: 'claude',
    }
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tunnel.enabled).toBe(false)
      expect(result.data.tunnel.provider).toBe('cloudflare')
      expect(result.data.tunnel.port).toBe(3100)
    }
  })

  it('should parse config with partial tunnel section', () => {
    const raw = {
      channels: { telegram: { enabled: false, botToken: 'x', chatId: 0 } },
      agents: { claude: { command: 'claude-agent-acp', args: [] } },
      defaultAgent: 'claude',
      tunnel: { enabled: true },
    }
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tunnel.enabled).toBe(true)
      expect(result.data.tunnel.provider).toBe('cloudflare')
    }
  })

  it('should accept all provider values', () => {
    for (const provider of ['cloudflare', 'ngrok', 'bore', 'tailscale']) {
      const raw = {
        channels: {},
        agents: { claude: { command: 'x' } },
        defaultAgent: 'claude',
        tunnel: { enabled: true, provider },
      }
      const result = ConfigSchema.safeParse(raw)
      expect(result.success).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run test to verify current state**

Run: `pnpm vitest run src/__tests__/config-tunnel-compat.test.ts`
Expected: First two tests PASS (Zod defaults already handle this), third may fail if tailscale not in enum yet (depends on task 4 order)

- [ ] **Step 3: Add tunnel to DEFAULT_CONFIG**

In `src/core/config.ts`, add tunnel section to `DEFAULT_CONFIG`:
```typescript
const DEFAULT_CONFIG = {
  // ... existing fields ...
  sessionStore: { ttlDays: 30 },
  tunnel: {
    enabled: false,
    port: 3100,
    provider: "cloudflare",
    options: {},
    storeTtlMinutes: 60,
    auth: { enabled: false },
  },
};
```

This ensures newly generated configs include the tunnel section with documentation-friendly defaults.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/__tests__/config-tunnel-compat.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/__tests__/config-tunnel-compat.test.ts
git commit -m "feat(config): add tunnel defaults for backward compatibility"
```

---

## Chunk 3: Tunnel Design Spec

### Task 6: Write tunnel service design spec

**Files:**
- Create: `docs/superpowers/specs/2026-03-20-tunnel-service-design.md`

- [ ] **Step 1: Write the design spec**

```markdown
# Tunnel Service Design Spec

## Overview

The tunnel service exposes a local HTTP server to the public internet,
enabling shareable links for file viewing and diff inspection directly
from messaging platforms (Telegram, Discord, etc.).

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Messaging   │     │  OpenACP     │     │  Tunnel Provider │
│  Platform    │◄────│  HTTP Server │◄────│  (cloudflare,    │
│  (Telegram)  │     │  (Hono)      │     │   ngrok, bore,   │
│              │     │  :3100       │     │   tailscale)     │
└─────────────┘     └──────────────┘     └──────────────────┘
                          │
                    ┌─────┴─────┐
                    │ ViewerStore│
                    │ (in-memory)│
                    └───────────┘
```

## Providers

### Interface

All providers implement `TunnelProvider`:
- `start(localPort: number): Promise<string>` — starts tunnel, returns public URL
- `stop(): Promise<void>` — graceful shutdown
- `getPublicUrl(): string` — returns current public URL

### Cloudflare (default)

- CLI: `cloudflared tunnel --url http://localhost:{port}`
- Free, no account required (trycloudflare.com subdomain)
- URL changes on each restart
- Options: `domain` (custom hostname, requires Cloudflare account)

### ngrok

- CLI: `ngrok http {port} --log stdout --log-format json`
- Requires account + authtoken for persistent URLs
- Options: `authtoken`, `domain`, `region`

### bore

- CLI: `bore local {port} --to {server}`
- Open source, self-hostable
- Default server: bore.pub
- Options: `server`, `port`, `secret`

### Tailscale Funnel

- CLI: `tailscale funnel {port}`
- Requires Tailscale account + Funnel ACL enabled
- Stable URL based on Tailscale hostname
- Options: `bg` (background mode)

## Config Schema

```json
{
  "tunnel": {
    "enabled": false,
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

- `OPENACP_TUNNEL_ENABLED` — "true"/"false"
- `OPENACP_TUNNEL_PORT` — port number
- `OPENACP_TUNNEL_PROVIDER` — provider name

## Backward Compatibility

- Zod schema uses `.default({})` — configs without `tunnel` section parse with
  `enabled: false`, no runtime error
- DEFAULT_CONFIG includes `tunnel` section so newly generated configs are
  self-documenting
- Provider enum accepts all 4 values; unknown providers fall back to cloudflare
  with a warning log

## HTTP Server Routes

| Route | Description |
|-------|-------------|
| `GET /health` | Health check |
| `GET /view/:id` | File viewer (Monaco editor) |
| `GET /diff/:id` | Diff viewer (Monaco diff editor) |
| `GET /api/file/:id` | JSON file content |
| `GET /api/diff/:id` | JSON diff content |

## Security

- Optional Bearer token auth (`tunnel.auth.enabled` + `tunnel.auth.token`)
- Token via header (`Authorization: Bearer <token>`) or query param (`?token=<token>`)
- `/health` route is unauthenticated
- ViewerStore validates file paths are within session working directory
- Content size capped at 1MB per entry
- TTL-based auto-expiration (default 60 min)
- Ephemeral URLs for Cloudflare free tier (changes on restart)

## ViewerStore

In-memory ephemeral store. Entries have:
- Auto-generated nanoid
- Language auto-detection from file extension
- TTL with 5-minute cleanup interval
- `storeFile()` and `storeDiff()` methods
- `destroy()` clears cleanup interval

## Integration Points

- `OpenACPCore.tunnelService` — set after startup if enabled
- Core enriches tool_call events with viewer links when tunnel is active
- Telegram adapter renders links as clickable URLs in messages
```

- [ ] **Step 2: Verify spec file is valid markdown**

Run: `head -5 docs/superpowers/specs/2026-03-20-tunnel-service-design.md`
Expected: Shows the title

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-03-20-tunnel-service-design.md
git commit -m "docs: add tunnel service design spec"
```

---

## Execution Checklist

| Task | Description | Status |
|------|-------------|--------|
| 1 | ngrok provider | ⬜ |
| 2 | bore provider | ⬜ |
| 3 | Tailscale Funnel provider | ⬜ |
| 4 | Wire providers + update schema | ⬜ |
| 5 | Config backward compat + defaults | ⬜ |
| 6 | Design spec | ⬜ |
