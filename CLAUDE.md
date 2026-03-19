# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
pnpm install            # Install dependencies
pnpm build              # TypeScript compile (tsc)
pnpm build:publish      # Bundle for npm publish (tsup → dist-publish/)
pnpm start              # Run: node dist/cli.js
pnpm dev                # Watch mode (tsc --watch)
pnpm test               # Run tests (vitest)
```

## Architecture

OpenACP bridges AI coding agents to messaging platforms via the Agent Client Protocol (ACP). The flow:

```
User (Telegram) → ChannelAdapter → OpenACPCore → Session → AgentInstance (ACP subprocess)
```

### Project Layout

```
src/
  cli.ts              — CLI entry (start, install, uninstall, plugins, --version, --help)
  main.ts             — Server startup, adapter registration
  index.ts            — Public API exports
  core/               — Core modules
    config.ts         — Zod-validated config from ~/.openacp/config.json
    core.ts           — OpenACPCore orchestrator
    session.ts        — Session with prompt queue, auto-naming
    agent-instance.ts — ACP subprocess client
    channel.ts        — ChannelAdapter abstract base
    plugin-manager.ts — Plugin install/uninstall/load from ~/.openacp/plugins/
    setup.ts          — Interactive first-run setup
  adapters/
    telegram/         — Built-in Telegram adapter (grammY)
```

### Core Abstractions

**OpenACPCore** (`core.ts`) — Registers adapters, routes messages, creates sessions, wires agent events to adapters. Enforces security (allowedUserIds, maxConcurrentSessions).

**Session** (`session.ts`) — Wraps an AgentInstance with a prompt queue (serial processing), auto-naming (asks agent to summarize after first prompt), and lifecycle management.

**AgentInstance** (`agent-instance.ts`) — Spawns agent subprocess, implements full ACP Client interface. Converts ACP events to AgentEvent types.

**ChannelAdapter** (`channel.ts`) — Abstract base. Implementations must handle: sendMessage, sendPermissionRequest, sendNotification, createSessionThread, renameSessionThread.

**ConfigManager** (`config.ts`) — Zod-validated config. Supports env overrides: `OPENACP_TELEGRAM_BOT_TOKEN`, `OPENACP_TELEGRAM_CHAT_ID`, `OPENACP_DEFAULT_AGENT`, `OPENACP_DEBUG`.

### Telegram Adapter Patterns

- **Forum topics**: Each session gets its own topic. System topics: Notifications, Assistant
- **MessageDraft** (`streaming.ts`): Buffers text chunks, sends periodic batch updates
- **Callback routing**: Permission buttons use `p:` prefix, menu buttons use `m:` prefix. Must use `bot.callbackQuery(/^prefix/)` to avoid blocking the middleware chain
- **Topic-first creation**: Create forum topic BEFORE `core.handleNewSession()` to prevent race condition

## npm Publishing

Published as `@openacp/cli` on npm. Users install with `npm install -g @openacp/cli`.

- `pnpm build:publish` bundles via tsup into `dist-publish/`
- GitHub Action auto-publishes on tag push (`v*`)
- Plugin system: `openacp install @openacp/adapter-discord` installs to `~/.openacp/plugins/`

## Conventions

- ESM-only (`"type": "module"`), all imports use `.js` extension
- TypeScript strict mode, target ES2022, NodeNext module resolution
