# Usage

## Commands

| Command | Description |
|---------|-------------|
| `/new [agent] [workspace]` | Create a new session (new topic) |
| `/new_chat` | New session, same agent & workspace |
| `/cancel` | Cancel current session |
| `/status` | Show session or system status |
| `/agents` | List available agents |
| `/help` | Show help |
| `/menu` | Show menu keyboard |

## Examples

```
/new claude my-app          → Claude in ~/openacp-workspace/my-app/
/new codex api-server       → Codex in ~/openacp-workspace/api-server/
/new claude ~/code/project  → Absolute path
/new                        → Default agent and workspace
```

## Session Flow

1. `/new claude my-project` — creates a new forum topic + spawns agent
2. Send your coding request
3. Agent responds with streaming text, tool calls, code
4. Permission needed → inline buttons (Allow / Always Allow / Reject)
5. File written → "View file" link opens Monaco Editor in browser
6. `/cancel` to stop, `/new` for another session

## Workspaces

| Input | Resolves to |
|-------|-------------|
| (none) | `~/openacp-workspace/` |
| `my-app` | `~/openacp-workspace/my-app/` |
| `~/code/project` | `~/code/project/` |
| `/absolute/path` | `/absolute/path/` |

Base directory is configurable via `workspace.baseDir` in config.

## Session Persistence & Resume

Sessions survive OpenACP restarts:

1. Session data is persisted to `~/.openacp/sessions.json`
2. After a restart, existing Telegram topics remain
3. Send a message in an old topic → **lazy resume** kicks in:
   - Agent subprocess respawns with the same session ID
   - Agent reconnects to its internal state
   - Your message is forwarded to the resumed agent
4. Sessions older than `sessionStore.ttlDays` (default: 30) are cleaned up

Resume works for sessions with status `active` or `finished`. Cancelled/error sessions are not resumable.

## Skill Commands

AI agents can publish available skills (like `/compact`, `/review`, `/debug`). When they do:

- An inline keyboard with skill buttons is pinned in the session topic
- Click a skill button to invoke it
- Skills update dynamically as the agent's capabilities change

## Multiple Sessions

Run sessions in parallel — each `/new` creates a separate topic with its own agent subprocess. Limited by `security.maxConcurrentSessions` (default: 5).

## Assistant

The **Assistant topic** is an always-on AI helper:
- Knows your available agents and commands
- Helps create sessions interactively
- Provides guidance on OpenACP usage
- Shows a menu keyboard on startup
