# Design: CLI Config Editor & Daemon Mode

## Overview

Two features for OpenACP:
1. **`openacp config`** — Menu-based interactive config editor
2. **Daemon mode** — Background execution with auto-start on boot, chosen during onboarding

## Config Schema Changes

Add to `ConfigSchema`:

```typescript
runMode: z.enum(['foreground', 'daemon']).default('foreground')
autoStart: z.boolean().default(false)
```

- `runMode: 'daemon'` — `openacp` spawns a background process and exits
- `autoStart: true` — installs OS-level auto-start (LaunchAgent on macOS, systemd on Linux)
- Env override: `OPENACP_RUN_MODE` (must be added to `applyEnvOverrides` in config.ts)

## CLI Commands

| Command | Description |
|---|---|
| `openacp` (no args) | Reads `runMode` from config. `foreground` → runs server directly. `daemon` → spawns detached child and exits. |
| `openacp start` | Force daemon mode (regardless of config) |
| `openacp stop` | Reads PID from `~/.openacp/openacp.pid`, sends SIGTERM |
| `openacp status` | Checks PID file, reports running/stopped |
| `openacp logs` | Reads `logDir` from config, tails `openacp.log` in that dir with `tail -f -n 50` |
| `openacp config` | Menu-based config editor |
| `openacp --foreground` | Force foreground (overrides `runMode: daemon`) |
| `openacp --daemon-child` | Internal flag — actual server process spawned by daemon mode |

### Daemon Spawn Logic

1. Check `~/.openacp/openacp.pid` — if PID file exists but process is not alive, remove stale PID file. If process alive, print "Already running (PID xxx)" and exit
2. Spawn `node <cli-path> --daemon-child` with `{ detached: true, stdio: 'ignore' }`
3. **Parent** writes child PID to `~/.openacp/openacp.pid` (single writer — child does NOT write PID)
4. Parent exits immediately

### `--daemon-child` Behavior

- Initializes pino logger before any output (structured JSON logs, consistent with existing format)
- Redirects stdout/stderr to log file at configured `logDir` path
- Runs `startServer()` as normal
- On shutdown (SIGTERM): removes PID file

### Foreground/Daemon Interaction

- `openacp --foreground` does NOT write a PID file — it runs like the current behavior
- `openacp start` and daemon-mode `openacp` always check/write PID file
- `openacp stop` only affects daemon processes (PID file). Foreground processes are stopped with Ctrl+C as usual
- If a foreground instance is running and user runs `openacp start`, the daemon starts independently (no conflict — they are separate processes)

## Menu-based Config Editor

### Flow

```
openacp config
  → Main menu:
    ❯ Telegram
      Agent
      Workspace
      Security
      Logging
      Run Mode
      ← Exit
```

Selecting a group shows current values and edit options:

```
[Telegram]
  Bot Token: sk-xxx...xxx
  Chat ID: -1001234567890

  ❯ Change Bot Token
    Change Chat ID
    ← Back
```

### Edit Behavior

- Shows current value as default
- Enter to keep current, or type new value
- Validates same as setup (bot token → API check, chat ID → supergroup check)
- After editing a field → returns to group menu
- Back → returns to main menu
- Exit → saves config to disk
- Ctrl+C at any point → discards unsaved changes (same as existing setup wizard's `ExitPromptError` handling)

### Run Mode Submenu

```
[Run Mode]
  Current: foreground
  Auto-start: off

  ❯ Switch to daemon
    ← Back
```

- "Switch to daemon" → sets `runMode: 'daemon'`, installs OS service, sets `autoStart: true`
- "Switch to foreground" → sets `runMode: 'foreground'`, removes OS service, sets `autoStart: false`
- "Toggle auto-start" → independently toggle `autoStart` (install/remove OS service without changing `runMode`)

Users can run daemon mode without auto-start, or enable auto-start independently.

## Auto-start on Boot

### macOS (LaunchAgent)

File: `~/Library/LaunchAgents/com.openacp.daemon.plist`

```xml
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openacp.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/openacp/cli.js</string>
    <string>--daemon-child</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/username/.openacp/logs/openacp.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/username/.openacp/logs/openacp.log</string>
</dict>
</plist>
```

- Install: `launchctl load <plist>`
- Uninstall: `launchctl unload <plist>` + delete file

### Linux (systemd user service)

File: `~/.config/systemd/user/openacp.service`

```ini
[Unit]
Description=OpenACP Daemon

[Service]
ExecStart=/path/to/node /path/to/openacp/cli.js --daemon-child
Restart=on-failure

[Install]
WantedBy=default.target
```

- Install: `systemctl --user daemon-reload && systemctl --user enable openacp`
- Uninstall: `systemctl --user disable openacp` + delete file

### Platform Detection

`process.platform === 'darwin'` → launchd, `'linux'` → systemd.

### Windows

Daemon mode and auto-start are not supported on Windows. If `runMode: 'daemon'` is set on Windows, fall back to foreground with a warning. The onboarding step will not show the daemon option on Windows.

### Path Expansion

All paths in generated service files (plist, systemd) must use absolute paths via `os.homedir()`. Tilde (`~`) is NOT expanded by launchd or systemd.

## Onboarding Changes

Add Run Mode as step 3 (Workspace becomes step 2):

```
[3/3] Run Mode

  How would you like to run OpenACP?

  ❯ Background (daemon)
    Runs silently, auto-starts on boot.
    Manage with: openacp status | stop | logs

    Foreground (terminal)
    Runs in current terminal session.
    Start with: openacp
```

- **Background** → `runMode: 'daemon'`, `autoStart: true` → install OS service → spawn daemon → print "OpenACP is running in background (PID xxx)"
- **Foreground** → `runMode: 'foreground'`, `autoStart: false` → start server directly (current behavior)

Step numbering updates: `[1/3] Telegram` (includes bot token + group chat as before), `[2/3] Workspace`, `[3/3] Run Mode`. Agent detection remains non-interactive (auto-detect, print result) — no step header needed.

## New Files

| File | Purpose |
|---|---|
| `src/core/daemon.ts` | Spawn logic, PID management, start/stop/status |
| `src/core/autostart.ts` | LaunchAgent/systemd install/uninstall |
| `src/core/config-editor.ts` | Menu-based config editor |

## Dependencies

No new dependencies. Uses existing `@inquirer/prompts` and Node.js built-ins (`child_process`, `fs`).
