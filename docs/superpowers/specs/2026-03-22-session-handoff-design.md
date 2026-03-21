# Session Handoff Design

**Date**: 2026-03-22
**Status**: Draft

## Overview

Bidirectional session transfer between Claude CLI and OpenACP (Telegram). Users can hand off an in-progress Claude CLI session to Telegram and vice versa. Designed agent-agnostic — starts with Claude support, extensible to other agents.

## Assumptions

- **Claude CLI `session_id` = ACP protocol session ID**: The `session_id` provided by Claude CLI hooks is the same ID used by `unstable_resumeSession()`. This needs to be verified against `claude-agent-acp` implementation before building. If they differ, the adopt flow needs a mapping step.
- **`UserPromptSubmit` hook stdout is injected as per-message context**: Claude CLI injects hook output into the conversation context for the current prompt, making it readable by the `/openacp:handoff` command in the same turn.

## Direction 1: CLI → Telegram (`openacp adopt`)

### Flow

1. User chatting in Claude CLI (standalone, not via OpenACP)
2. User types `/openacp:handoff` in Claude CLI
3. Claude CLI hook has injected `session_id` and `cwd` into context
4. Claude reads context, runs: `openacp adopt claude <session_id> --cwd <cwd>`
5. CLI command calls `POST /api/sessions/adopt`
6. Core checks if session already exists in OpenACP:
   - **Exists**: Ping the Telegram topic to surface it, return existing session info
   - **New**: Spawn agent subprocess, call `unstable_resumeSession()`, create Telegram topic, wire events, persist to session store
   - **Resume fails**: Destroy subprocess, return error, no topic created (optimistic approach)

### API Endpoint

```
POST /api/sessions/adopt
Request:  { agent: "claude", agentSessionId: "<id>", cwd: "/path/to/dir" }
Response: { ok: true, sessionId: "xxx", threadId: "123", status: "adopted" | "existing" }
Error:    { error: "agent_not_supported" | "resume_failed" | "invalid_cwd", message: "..." }
```

### Adopt Core Logic (`OpenACPCore.adoptSession()`)

This is a standalone method — does NOT delegate to `handleNewSession()` (which would spawn a new agent). The adopt flow spawns and resumes separately.

```
1. Validate agent exists in config and has supportsResume in registry
2. Validate cwd: fs.existsSync(cwd) — return error "invalid_cwd" if not
3. Check maxConcurrentSessions limit — return error "session_limit" if exceeded
4. Search for existing session by agentSessionId:
   - SessionStore.findByAgentSessionId(agentSessionId)  ← new method
   - Searches both `agentSessionId` and `originalAgentSessionId` fields
   - If found and has platform.topicId:
     → Adapter sends ping message to topic ("Session resumed from CLI")
     → Return { status: "existing", sessionId, threadId }
5. Spawn agent subprocess with cwd
6. Call unstable_resumeSession(agentSessionId)
   - On failure: destroy subprocess, return { error: "resume_failed" }
7. Choose default adapter (first registered, typically telegram)
8. Adapter creates new topic
9. Create Session object, wire events (directly, not via handleNewSession)
10. Persist to session store:
    - sessionId (OpenACP internal)
    - originalAgentSessionId (the input ID, for future lookups)
    - agentSessionId (from resume, may differ from input)
    - agentName, cwd, channelId, status: "active"
    - platform: { topicId }
11. Return { status: "adopted", sessionId, threadId }
```

### CLI Command

```
openacp adopt <agent> <session_id> [--cwd <path>]
```

Flow:
1. Read API port from `~/.openacp/api.port` (error if daemon not running)
2. `POST /api/sessions/adopt` with payload (agent, agentSessionId, cwd — defaults to `process.cwd()`)
3. Display result:
   - `adopted`: "Session transferred to Telegram."
   - `existing`: "Session already on Telegram. Topic pinged."
   - Error: show error message

## Direction 2: Telegram → CLI (`/handoff`)

### Flow

1. User in a Telegram session topic
2. User types `/handoff`
3. Bot looks up session → gets `agentSessionId` and `agentName`
4. Bot replies with resume command:
   ```
   Resume this session on CLI:
   claude --resume abc123-def456
   ```
5. User copies command, runs in terminal
6. Original Telegram topic stays open — if user comes back, lazy resume works normally

### Implementation

- Register `/handoff` bot command handler in Telegram adapter
- Only works in session topics (not Notifications/Assistant)
- Reply format depends on agent (from agent registry's `resumeCommand`)
- Agent doesn't support resume → reply "This agent does not support CLI handoff."

## Session Behavior After Handoff

- **No lock/detach** — session topic stays open
- If user sends message in Telegram topic after handoff → lazy resume kicks in as normal
- Two channels can use same session (not simultaneously — whoever resumes last owns the agent subprocess)

## Claude CLI Integration

### Files Installed

| File | Purpose |
|------|---------|
| `~/.claude/hooks/openacp-inject-session.sh` | UserPromptSubmit hook — outputs session_id and cwd to context |
| `~/.claude/hooks/openacp-handoff.sh` | Script that calls `openacp adopt` |
| `~/.claude/commands/openacp:handoff.md` | Slash command `/openacp:handoff` |
| `~/.claude/settings.json` | Hook registration (merged, not overwritten) |

### Hook: `openacp-inject-session.sh`

```bash
#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
CWD=$(echo "$INPUT" | jq -r '.cwd')

echo "CLAUDE_SESSION_ID: $SESSION_ID"
echo "CLAUDE_WORKING_DIR: $CWD"

exit 0
```

Registered as `UserPromptSubmit` hook. Output is injected into Claude's conversation context on every prompt. No temp files, no race conditions.

### Handoff Script: `openacp-handoff.sh`

```bash
#!/bin/bash
TARGET=${1:-openacp}
SESSION_ID=$2
CWD=$3

if [ -z "$SESSION_ID" ]; then
  echo "Usage: openacp-handoff.sh <target> <session_id> [cwd]"
  exit 1
fi

openacp adopt "$TARGET" "$SESSION_ID" ${CWD:+--cwd "$CWD"}
```

### Command: `openacp:handoff.md`

```markdown
Look at the context injected at the start of this message to find
CLAUDE_SESSION_ID and CLAUDE_WORKING_DIR, then run:

bash ~/.claude/hooks/openacp-handoff.sh openacp <CLAUDE_SESSION_ID> <CLAUDE_WORKING_DIR>
```

### Settings.json Merge Logic

Hook entry JSON structure:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/openacp-inject-session.sh"
          }
        ]
      }
    ]
  }
}
```

Merge steps:
1. Read existing `~/.claude/settings.json` (or `{}` if not exists)
2. Backup to `settings.json.bak`
3. Ensure path: `hooks.UserPromptSubmit` is array
4. Check if any entry's hooks contain command matching `openacp-inject-session.sh` → skip if so
5. Append new hook group entry to the `UserPromptSubmit` array
6. Write back with `JSON.stringify(settings, null, 2)`

## `openacp integrate claude`

### Install

```
openacp integrate claude
```

1. Check `claude` in PATH (warn if not found, still proceed)
2. `mkdir -p ~/.claude/hooks` and `mkdir -p ~/.claude/commands`
3. Create `~/.claude/hooks/openacp-inject-session.sh` (chmod +x)
4. Create `~/.claude/hooks/openacp-handoff.sh` (chmod +x)
5. Create `~/.claude/commands/openacp:handoff.md`
6. Merge hook into `~/.claude/settings.json` (backup first)
7. Log success message

### Uninstall

```
openacp integrate claude --uninstall
```

1. Delete `~/.claude/hooks/openacp-inject-session.sh`
2. Delete `~/.claude/hooks/openacp-handoff.sh`
3. Delete `~/.claude/commands/openacp:handoff.md`
4. Remove openacp hook entry from `~/.claude/settings.json` (filter by command containing `openacp-`, keep other hooks)
5. Log success message

### Setup Flow Integration

During `runSetup()`, after detecting `claude` agent:
```
"Install handoff command for Claude CLI? (Y/n)"
  → Y: run integrate logic
  → n: skip, mention `openacp integrate claude` for later
```

## Agent Registry

```typescript
// src/core/agent-registry.ts

interface AgentCapability {
  supportsResume: boolean
  resumeCommand?: (sessionId: string) => string
}

const agentCapabilities: Record<string, AgentCapability> = {
  claude: {
    supportsResume: true,
    resumeCommand: (sid) => `claude --resume ${sid}`
  }
}

function getCapabilities(agentName: string): AgentCapability {
  return agentCapabilities[agentName] ?? { supportsResume: false }
}
```

Not stored in config — lives in code. Adding new agent = add entry to registry. Old configs unaffected.

The `GET /api/agents` endpoint will be extended to include capabilities from the registry, merging with the existing agent config data.

## Extensibility: `AgentIntegration` Interface

```typescript
// src/cli/integrate.ts

interface AgentIntegration {
  install(): Promise<void>
  uninstall(): Promise<void>
}

const integrations: Record<string, AgentIntegration> = {
  claude: new ClaudeIntegration()
  // cursor: new CursorIntegration() — future
}
```

Each agent integration handles its own file creation, hook setup, and cleanup.

## New Methods on Existing Modules

| Module | Method | Purpose |
|--------|--------|---------|
| `SessionStore` | `findByAgentSessionId(id)` | Lookup session record by agent's session ID |
| `SessionManager` | `getSessionByAgentSessionId(id)` | Find in-memory session by agent session ID |
| `OpenACPCore` | `adoptSession(agent, agentSessionId, cwd)` | Full adopt flow |

## New Files

| File | Purpose |
|------|---------|
| `src/core/agent-registry.ts` | Agent capabilities (resume support, CLI commands) |
| `src/cli/integrate.ts` | `AgentIntegration` interface + `ClaudeIntegration` class |

## Modified Files

| File | Change |
|------|--------|
| `src/core/core.ts` | Add `adoptSession()` method |
| `src/core/api-server.ts` | Add `POST /api/sessions/adopt`, extend `GET /api/agents` with capabilities |
| `src/core/session-store.ts` | Add `findByAgentSessionId()` |
| `src/core/session-manager.ts` | Add `getSessionByAgentSessionId()` |
| `src/cli.ts` | Add `adopt` and `integrate` commands |
| `src/cli/commands.ts` | Add `cmdAdopt()` and `cmdIntegrate()` |
| `src/core/setup.ts` | Add Claude CLI integration prompt |
| `src/adapters/telegram/adapter.ts` | Add `/handoff` bot command handler |
| `README.md` | Add Session Handoff section: feature overview, `openacp adopt` usage, `openacp integrate claude` usage, `/handoff` Telegram command, flow diagrams for both directions |
| `src/cli.ts` (help text) | Add `adopt` and `integrate` to `--help` output |
| `src/cli/commands.ts` (help text) | Add usage/description for `adopt` and `integrate` in CLI help |
