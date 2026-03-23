# Critical Fixes for Issue #21 — Design Spec

**Date:** 2026-03-23
**Issue:** [#21 — PR #19 Code Review: Issues to address](https://github.com/Open-ACP/OpenACP/issues/21)
**Scope:** 4 Critical items only

---

## Overview

This spec addresses the 4 critical issues identified during the PR #19 code review. Each fix is independent and can be implemented and tested in isolation.

---

## Fix 1: API Server Authentication

**Problem:** `api-server.ts` exposes HTTP routes (create session, toggle dangerous mode, restart daemon, modify config) with no authentication. Any local process can call them.

**Design:**

1. **Token generation:** On first API server start, generate a 32-byte random hex token using `crypto.randomBytes(32).toString('hex')`.
2. **Storage:** Write to `~/.openacp/api-secret` with file permission `0600`. If the file already exists, read and reuse the existing token. Token persists across daemon restarts.
3. **Validation:** Add an `authenticate()` method to `APIServer` that extracts the token from the `Authorization: Bearer <token>` header and compares it against the stored secret using `crypto.timingSafeEqual()` (with early rejection on length mismatch). Called at the top of `handleRequest()` before routing.
4. **Exempt routes:** `GET /api/health` and `GET /api/version` are exempt from authentication (used for monitoring/probes).
5. **Rejection:** Return `401 Unauthorized` with `{ error: "Unauthorized" }` for missing or invalid tokens on all other routes.
6. **Client integration:** `src/core/api-client.ts` (`apiCall()`) reads the token from `~/.openacp/api-secret` and attaches it as an `Authorization: Bearer` header. The raw `fetch()` call in `src/cli/commands.ts` (adopt endpoint) must also be migrated to use `apiCall()` or have auth added directly.
7. **Token rotation:** Delete `~/.openacp/api-secret` and restart daemon to regenerate. No additional mechanism needed for a local-only API.

**Files changed:**
- `src/core/api-server.ts` — add auth middleware, exempt health/version routes
- `src/core/api-client.ts` — read token and attach auth header in `apiCall()`
- `src/cli/commands.ts` — migrate raw `fetch()` at adopt endpoint to use `apiCall()` or add auth header

**Edge cases:**
- If `api-secret` file is missing when CLI tries to read it, print a clear error ("Daemon not running or API secret not found").
- Token file created with `0600` permissions so only the owning user can read it.

---

## Fix 2: XML/Systemd Injection in autostart.ts

**Problem:** `nodePath`, `cliPath`, and `logFile` are interpolated directly into plist XML and systemd unit strings. Special characters in paths can break syntax or enable injection.

**Design:**

1. **`escapeXml(str)`** — Escapes `&`, `<`, `>`, `"`, `'` for safe insertion into XML `<string>` elements.
2. **`escapeSystemdValue(str)`** — Double-quotes each argument individually on the `ExecStart=` line. Inside the double quotes: escape backslashes (`\\`), double-quotes (`\"`), and `%` characters (doubled to `%%` per systemd specifier rules).
3. **Apply escaping** to all interpolated values:
   - `generateLaunchdPlist()`: `nodePath`, `cliPath`, `logFile` (note: `LAUNCHD_LABEL` is a constant and safe)
   - `generateSystemdUnit()`: `nodePath`, `cliPath` (each quoted individually)

**Files changed:**
- `src/core/autostart.ts` — add escape helpers, apply to template literals

**Validation:** Paths with spaces, quotes, ampersands, angle brackets, and `%` characters must produce valid XML/unit files.

---

## Fix 3: Unused `createRequire` Import

**Problem:** `cli/version.ts` imports `createRequire` from `node:module` but never uses it. The original issue reported that `getCurrentVersion()` uses `require()` in ESM, but the code has already been fixed to use `readFileSync`. Only the dead import remains.

**Design:** Remove the unused `import { createRequire } from 'node:module'` line.

**Files changed:**
- `src/cli/version.ts` — remove unused import

---

## Fix 4: PID File Race Condition in stopDaemon

**Problem:** `stopDaemon()` in `daemon.ts` sends `SIGTERM` then immediately removes the PID file without waiting for the process to exit. If the child hasn't exited yet, the system loses track of it.

**Design:**

1. **Make `stopDaemon()` async.** Return type becomes `Promise<{ stopped: boolean; pid?: number; error?: string }>`.
2. **After sending `SIGTERM`, poll `process.kill(pid, 0)` every 100ms** to check if the process is still alive.
3. **Distinguish error codes in polling:** `ESRCH` = process exited (success), `EPERM` = process exists but we lost permission (PID reuse by another user — treat as exited to avoid signaling a foreign process).
4. **Timeout after 5 seconds.** If the process hasn't exited, attempt `SIGKILL`. If `SIGKILL` fails with `EPERM`, return an error and leave PID file in place with a warning message ("PID may have been reused — run `openacp status` to verify, or manually delete the PID file"). If `SIGKILL` succeeds, re-poll for up to 1 second to confirm exit, then remove PID file.
5. **Only remove PID file after confirmed exit** (or after successful SIGKILL + confirmed exit).
6. **Update all callers** of `stopDaemon()` to `await` the result, including the re-export in `src/core/index.ts`.

**Files changed:**
- `src/core/daemon.ts` — make `stopDaemon` async, add polling logic with error discrimination
- `src/core/index.ts` — update re-export type
- Callers of `stopDaemon()` — add `await`

---

## Testing Strategy

- **Fix 1:** Unit test that requests without auth header get 401; requests with correct token succeed; health/version routes work without auth.
- **Fix 2:** Unit test that `escapeXml` and `escapeSystemdValue` produce correct output for paths with special characters (`<`, `>`, `&`, `"`, `'`, `%`, spaces). Verify generated plist/unit are well-formed.
- **Fix 3:** No test needed — just removing an import.
- **Fix 4:** Unit test that `stopDaemon` waits for process exit before removing PID file. Mock `process.kill` to simulate delayed exit, ESRCH, and EPERM cases.

---

## Out of Scope

All non-critical items from issue #21 (Major, Minor, Tests, Housekeeping) are deferred to a separate spec.
