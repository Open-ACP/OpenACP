# OpenACP UI Dashboard — Design Specification

## Overview

Embedded web dashboard for monitoring and managing OpenACP instances. Served directly from the existing API server as static files, providing session management, system health monitoring, agent overview, configuration editing, and topic management.

## Architecture

### Deployment Model

Embedded SPA served by OpenACP's existing `http.createServer` API server on the same port (default 21420). No separate process or port required.

- Build output: `dist/ui/` (static files)
- API server serves static files for non-`/api/*` routes
- SPA fallback: all unmatched routes return `index.html`
- CORS not needed (same origin)

### Tech Stack

- **React 19** + **Vite** — SPA framework and build tool
- **React Router v7** — client-side routing (library mode, no SSR/framework features)
- **Tailwind CSS v4** — styling with dark mode support (CSS-based config, not `tailwind.config.ts`)
- **TypeScript** — strict mode, no `any`

### Project Structure

```
ui/
├── src/
│   ├── main.tsx
│   ├── App.tsx                   # Router setup
│   ├── api/
│   │   ├── client.ts             # Typed fetch wrapper
│   │   └── use-event-stream.ts   # SSE hook with auto-reconnect
│   ├── pages/
│   │   ├── DashboardPage.tsx
│   │   ├── SessionsPage.tsx
│   │   ├── SessionDetailPage.tsx
│   │   ├── AgentsPage.tsx
│   │   ├── ConfigPage.tsx
│   │   └── TopicsPage.tsx
│   ├── components/
│   │   ├── layout/               # Sidebar, Header, ThemeToggle
│   │   └── shared/               # StatusBadge, Card, DataTable, Modal, Toast, Toggle, Button, Input, Select
│   ├── hooks/
│   │   └── use-theme.ts
│   ├── contexts/
│   │   ├── sessions-context.tsx
│   │   └── theme-context.tsx
│   └── lib/
│       ├── theme.ts              # Dark/light persistence logic
│       └── format.ts             # Duration, bytes, date formatters
├── index.html
├── package.json
├── vite.config.ts
├── app.css                   # Tailwind v4 CSS config (@theme, @variant)
└── tsconfig.json
```

### Build Pipeline

- `cd ui && pnpm build` → outputs to `ui/dist/`
- Root `package.json` script: `"build:ui": "cd ui && pnpm build"`
- `pnpm build:publish` includes `build:ui` step, copies `ui/dist/` to `dist-publish/ui/`
- Dev: `cd ui && pnpm dev` (Vite on port 5173, proxy `/api/*` to `localhost:21420`)
- `ui/` is NOT a pnpm workspace member — managed independently with its own `package.json`

**Vite proxy config (`ui/vite.config.ts`):**
```typescript
server: {
  proxy: {
    '/api': { target: 'http://localhost:21420' }
  }
}
```

**Static file resolution in backend:**
- Development: resolves `ui/dist/` relative to project root
- Published (`dist-publish/`): resolves `ui/` relative to bundle root
- Uses `__dirname` to locate the correct path at runtime

## Backend Changes

### Authentication

MVP uses a simple token-based auth for API and SSE:

- Config field `api.token` (optional string, default empty = no auth)
- When set, all `/api/*` requests must include `Authorization: Bearer <token>` header
- SSE connections use `EventSource` which cannot set headers — use query param: `/api/events?token=<token>`
- API client in UI reads token from a login prompt and stores in `sessionStorage`
- **Localhost bypass**: When `api.host` is `127.0.0.1` or `localhost`, auth is optional (backward compatible)
- This is a known MVP limitation — proper user auth (OAuth, etc.) is out of scope

### SSE Endpoint: `GET /api/events`

Server-Sent Events stream for real-time dashboard updates.

**Event types:**

| Event | Data | Trigger |
|-------|------|---------|
| `session:created` | `{ sessionId, agent, status }` | New session created |
| `session:updated` | `{ sessionId, status, name?, ... }` | Session state change, rename |
| `session:deleted` | `{ sessionId }` | Session removed |
| `agent:event` | `{ sessionId, event: AgentEvent }` | Agent emits text, tool_call, usage, etc. |
| `health` | `{ uptime, memory, sessions }` | Heartbeat every 30s |

**Server-side filtering:**
- Optional query param: `/api/events?sessionId=xxx` — only sends `agent:event` for that session
- Without filter, all events are broadcast (acceptable for MVP with few concurrent sessions)

**Event source architecture:**

The current codebase has no global event bus. Changes needed:

1. **Add `EventBus` class** (`src/core/event-bus.ts`) — simple typed `EventEmitter` for system-wide events
2. **`OpenACPCore`** creates and owns the `EventBus` instance
3. **`SessionManager`** emits `session:created` and `session:removed` on the bus when sessions are added/removed
4. **`SessionBridge`** emits `session:updated` (status change, rename) and `agent:event` on the bus when wiring session events
5. **`ApiServer`** subscribes to the `EventBus` and forwards events to SSE connections

This keeps each module's responsibilities clean:
- `SessionManager` knows about session lifecycle
- `SessionBridge` knows about agent events
- `ApiServer` only knows about SSE transport
- `EventBus` is the glue

**Implementation details:**
- Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
- Maintain a `Set<ServerResponse>` of active SSE connections
- Health heartbeat every 30s keeps connection alive
- Cleanup connection from set on client disconnect

### API Fixes

**`DELETE /api/sessions/:id` — Fix cancel behavior:**
- Current: only calls `session.abortPrompt()` (does not change status)
- Fix: call `sessionManager.cancelSession(sessionId)` instead, which calls both `abortPrompt()` and `markCancelled()`

**`GET /api/sessions` — Extend response:**
- Add missing fields needed by dashboard: `createdAt`, `queueDepth`, `dangerousMode`, `promptRunning`
- `lastActiveAt`: Read from `SessionStore` record (not on live `Session` class). Update `lastActiveAt` in store whenever a prompt completes.

**`POST /api/sessions/:id/permission` — New endpoint for permission responses:**
- Request body: `{ permissionId: string, optionId: string }`
- Resolves the pending permission via `session.permissionGate.resolve(permissionId, optionId)`
- Returns `200 { ok: true }` or `404` if session/permission not found
- SSE event `permission:request` added to event table: `{ sessionId, permission: PermissionRequest }`

**`session:deleted` event clarification:**
- Emitted when `SessionManager.removeRecord()` is called (TTL cleanup or manual delete)
- NOT emitted for status transitions (finished/cancelled/error) — those emit `session:updated`

### Static File Serving

Added to `handleRequest()` after all `/api/*` route matching:

1. If request path matches a file in the UI dist directory → serve with correct `Content-Type`
2. Otherwise → serve `index.html` (SPA fallback)
3. Only enabled when `index.html` exists on disk

## Pages & Features

### Dashboard Overview (`/`)

System health and quick summary view.

- **Health card**: Uptime (formatted), version, memory usage (RSS/heap bar), tunnel status + public URL
- **Sessions summary**: Active / Total count with visual indicator
- **Adapters list**: Registered adapters with connection status
- **Quick actions**: Create session button, restart server button (with confirmation dialog)
- **Data source**: `GET /api/health` on mount + SSE `health` heartbeat

### Sessions (`/sessions`)

Session list with filtering and management actions.

- **Table columns**: ID (truncated), name, agent, status, workspace, created, queue depth
- **Status filter**: All / Active / Initializing / Finished / Error / Cancelled
- **Row actions**: Cancel, toggle dangerous mode
- **Create session**: Modal dialog — select agent (from `GET /api/agents`), optional workspace path
- **Row click**: Navigate to Session Detail page
- **Real-time**: SSE `session:created`, `session:updated`, `session:deleted` merge into table state
- **Data source**: `GET /api/sessions` on mount

### Session Detail (`/sessions/:id`)

Single session view with live event stream and prompt interaction.

- **Header**: Session name, status badge, agent name, workspace path, dangerous mode toggle
- **Event stream**: Scrollable log of agent events (text, tool calls, thoughts, errors) via SSE `agent:event` filtered by `sessionId`
- **Prompt input**: Text area + send button → `POST /api/sessions/:id/prompt`
- **Permission requests**: Inline prompt showing permission details + Allow/Deny buttons (requires new SSE event `permission:request` and new API endpoint `POST /api/sessions/:id/permission` to respond)
- **Actions**: Cancel session (`DELETE /api/sessions/:id`), abort current prompt
- **Info panel**: Created at, last active, queue depth, prompt running indicator
- **Data source**: `GET /api/sessions/:id` on mount + SSE updates

### Agents (`/agents`)

Available agents overview.

- **Card grid**: Each agent shows name, command, args, capabilities list, working directory
- **Default agent**: Highlighted with badge
- **Read-only** in MVP (install/uninstall via CLI)
- **Data source**: `GET /api/agents`

### Config (`/config`)

Configuration editor using the existing editable config API.

- **Grouped sections**: Fields grouped by `group` property (General, Security, Logging, Tunnel, etc.)
- **Field rendering by type**:
  - `string` → text input
  - `number` → number input
  - `boolean` → toggle switch
  - `enum` → select dropdown (options from API)
- **Hot-reload badge**: Visual indicator for fields that require restart vs. hot-reloadable
- **Save**: `PATCH /api/config` per field change, toast notification for success/error
- **Restart button**: Shown when pending changes require restart → `POST /api/restart`
- **Data source**: `GET /api/config/editable`

### Topics (`/topics`)

Telegram forum topic management.

- **Table columns**: Topic name, session ID, status, created at
- **Status filter**: Active / Finished / Error
- **Row actions**: Delete (confirmation dialog if session is active)
- **Batch cleanup**: Button → `POST /api/topics/cleanup` with status filter
- **Data source**: `GET /api/topics`

## Layout & Navigation

### Sidebar Layout

```
┌──────────┬──────────────────────────────┐
│ OpenACP  │  Header (breadcrumb + theme) │
│          ├──────────────────────────────│
│ ◉ Dashboard│                            │
│ ◎ Sessions │      Page Content          │
│ ◎ Agents   │                            │
│ ◎ Config   │                            │
│ ◎ Topics   │                            │
│          │                              │
│──────────│                              │
│ v0.5.0   │                              │
│ ● Online │                              │
└──────────┴──────────────────────────────┘
```

- **Sidebar**: Fixed left, ~220px width
- **Logo area**: "OpenACP" text at top
- **Footer**: Version number + SSE connection status (green dot = connected, red = disconnected)
- **Nav items**: Icon + label, active state highlight
- **Header**: Breadcrumb trail + theme toggle button (sun/moon icon)
- **Responsive**: Sidebar collapses to hamburger menu below 768px

### Theme System

- **Dark mode**: Slate/zinc backgrounds, subtle borders, white text
- **Light mode**: White backgrounds, gray borders, dark text
- **Toggle**: Persisted to `localStorage`, defaults to `prefers-color-scheme`
- **Implementation**: Tailwind v4 CSS-based config with `@variant dark (&:where(.dark *))`, toggle `.dark` class on `<html>`

## State Management

### API Client (`api/client.ts`)

- Thin typed fetch wrapper, base URL = `window.location.origin`
- Generic functions: `get<T>(path)`, `post<T>(path, body)`, `patch<T>(path, body)`, `del<T>(path)`
- Throws typed `ApiError` with status code and message
- No external HTTP library

### SSE Hook (`api/use-event-stream.ts`)

- Custom hook `useEventStream()` wrapping `EventSource('/api/events')`
- Auto-reconnect with exponential backoff (max 30s)
- Returns `connectionStatus: 'connected' | 'connecting' | 'disconnected'`
- Event dispatch via callback subscription pattern
- Cleanup on component unmount

### Global State

React Context + `useReducer` (no external state library):

- **`SessionsContext`**: Session list state, updated via SSE events
- **`ThemeContext`**: Dark/light mode toggle and persistence

### Data Flow Pattern

1. Page mounts → REST call for initial data (e.g., `GET /api/sessions`)
2. SSE events arrive → merge into existing state (add, update, remove)
3. User action → REST call → optimistic UI update → SSE confirms actual state

### Error & Loading States

- **Loading**: Skeleton placeholder components while initial REST data loads
- **Empty states**: Friendly message + CTA when no sessions, agents, or topics exist
- **Error boundary**: Top-level React error boundary catches render errors, shows fallback UI with retry button
- **SSE disconnect**: Banner at top of page "Connection lost — reconnecting..." with live status. UI continues showing last known data (stale but usable). On reconnect, re-fetch full state to sync.
- **API errors**: Toast notification with error message. Forms show inline validation errors.

## Routing

| Path | Page | Description |
|------|------|-------------|
| `/` | DashboardPage | System overview and health |
| `/sessions` | SessionsPage | Session list and management |
| `/sessions/:id` | SessionDetailPage | Single session with live events |
| `/agents` | AgentsPage | Available agents grid |
| `/config` | ConfigPage | Configuration editor |
| `/topics` | TopicsPage | Telegram topic management |

React Router v7 with SPA fallback handled by backend static serving.

## Custom Components

Built in-house (no component library dependency):

| Component | Purpose |
|-----------|---------|
| `StatusBadge` | Colored dot + label for session/connection status |
| `Card` | Container with border, padding, optional header |
| `DataTable` | Sortable table with column definitions and filter support |
| `Modal` | Dialog overlay with backdrop |
| `Toast` | Notification snackbar (success/error/info) |
| `Toggle` | Switch for boolean values |
| `Button` | Primary/secondary/danger variants |
| `Input` | Text/number input with label and error state |
| `Select` | Dropdown with options |

## Dependencies

### UI package (`ui/package.json`)

**Runtime:**
- `react`, `react-dom` — UI framework
- `react-router` — client-side routing

**Dev:**
- `vite` — build tool
- `@vitejs/plugin-react` — React fast refresh
- `tailwindcss`, `@tailwindcss/vite` — styling
- `typescript` — type checking

No additional runtime dependencies. Total bundle target: < 150KB gzipped.

## npm Publish Considerations

UI assets are included in the npm package (`dist-publish/ui/`). This adds ~150KB gzipped to the package size, which is acceptable for an embedded dashboard. The dashboard is optional — if `ui/` directory doesn't exist at runtime, the API server continues to function normally without serving static files.
