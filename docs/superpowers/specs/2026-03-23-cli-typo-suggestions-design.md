# CLI Typo Validation & Suggestions

## Problem

When users mistype commands, agent names, config keys, or flags, the CLI either shows generic error messages without guidance, or silently falls through to unintended behavior. Users must re-read help text to figure out the correct spelling.

## Solution

Add fuzzy matching (prefix + substring + Levenshtein) to all user-typed inputs across the CLI, showing "Did you mean: X?" suggestions on typos.

## Dependency

- `fastest-levenshtein` — ~1KB, zero transitive deps, 50M+ weekly downloads on npm

## New Module: `src/cli/suggest.ts`

Single exported function:

```ts
export function suggestMatch(
  input: string,
  candidates: string[],
  maxDistance?: number  // default: 2
): string | undefined
```

**Matching priority:**
1. Exact prefix — `statu` matches `status`
2. Substring — `opic` matches `topics`
3. Levenshtein distance — `statr` matches `start` (via `fastest-levenshtein`)

Returns the single best match, or `undefined` if no match within threshold.

**Tie-breaking:** When multiple candidates match at the same priority level, prefer the shortest candidate. If still tied, prefer first in candidate order.

**Short candidate protection:** For candidates with length ≤ 3, reduce maxDistance to 1 to avoid false positives (e.g., `xyz` should NOT match `run`).

Case-insensitive comparison throughout.

## Integration Points

### 1. Top-level commands (`cmdDefault`)

**File:** `src/cli/commands.ts` — `cmdDefault()` (line ~1065)

**Current:** `Unknown command: ${command}` + prints full help

**After:**
```
Unknown command: statr
Did you mean: start?
```
Still prints help after suggestion.

**Candidates:** Derived from the keys of the `commands` record in `src/cli.ts`, filtering out flag-style entries (those starting with `--` or `-`) and `--daemon-child`. This keeps the list in sync automatically if new commands are added.

### 2. API subcommands (`cmdApi`)

**File:** `src/cli/commands.ts` — `cmdApi()` else branch (line ~437)

**Current:** `Unknown api command: ${subCmd}` + prints usage

**After:**
```
Unknown api command: statu
Did you mean: status?
```
Still prints usage after suggestion.

**Candidates:** `new`, `cancel`, `status`, `agents`, `topics`, `delete-topic`, `cleanup`, `send`, `session`, `dangerous`, `health`, `restart`, `config`, `adapters`, `tunnel`, `notify`, `version`

### 3. Agents subcommands (`cmdAgents`)

**File:** `src/cli/commands.ts` — `cmdAgents()` switch default (line ~814)

**Current:** Falls through to `agentsList()` silently — user doesn't know they typed a wrong subcommand.

**After:** Add `list` as an explicit alias case that falls through to `agentsList()`. Check if `subcommand` is truthy and not a valid subcommand. If so:
```
Unknown agents command: instal
Did you mean: install?
```
Then exit. If no subcommand provided (or `list`), fall through to `agentsList()` as before.

**Candidates:** `install`, `uninstall`, `refresh`, `info`, `run`, `list`

### 4. Agent names (install/uninstall/info/run)

**Files:** `src/cli/commands.ts` — `agentsInstall()`, `agentsUninstall()`, `agentsInfo()`, `agentsRun()`

**For `agentsInfo` (line ~1002):**
Current: `"${nameOrId}" not found.`
After:
```
"cluade" not found.
Did you mean: claude?
Run 'openacp agents' to see available agents.
```

**For `agentsRun` (line ~1022):**
Current: `"${nameOrId}" is not installed.`
After:
```
"cluade" is not installed.
Did you mean: claude?
```

**For `agentsInstall` and `agentsUninstall`:** Both `catalog.install()` and `catalog.uninstall()` return structured results with `{ ok: false, error: string }`. After checking `result.ok === false`, call `suggestMatch` against the appropriate candidate list and append the suggestion to the error output.

**Candidates:** All agent keys from `catalog.getAvailable()` (for info/install) or `catalog.getInstalled()` (for run/uninstall).

### 5. Integration names (`cmdIntegrate`)

**File:** `src/cli/commands.ts` — `cmdIntegrate()` (line ~715)

**Current:** `No integration available for '${agent}'.` + lists available

**After:**
```
No integration available for 'clude'.
Did you mean: claude?
Available: claude
```

**Candidates:** `listIntegrations()` return value.

### 6. Config keys (`cmdConfig`)

**File:** `src/cli/commands.ts` — `cmdConfig()` / `buildNestedUpdateFromPath()`

**Current:** Silently creates wrong key or Zod validation error.

**After:** Before either code path (API or file-write), validate the top-level key at line ~539 after parsing configPath. If no match:
```
Unknown config key: defaltAgent
Did you mean: defaultAgent?
```

**Candidates:** Top-level keys from `ConfigSchema`: `channels`, `agents`, `defaultAgent`, `workspace`, `security`, `logging`, `runMode`, `autoStart`, `api`, `sessionStore`, `tunnel`, `integrations`

Only validate the first segment of the dot-path (e.g., for `defaltAgent.foo`, check `defaltAgent`). This ensures consistent UX regardless of whether the daemon is running.

### 7. Doctor flags (`cmdDoctor`)

**File:** `src/cli/commands.ts` — `cmdDoctor()` (line ~745)

**Current:** Unknown flags silently ignored.

**After:** Check for unknown `--` flags and suggest:
```
Unknown flag: --dryrun
Did you mean: --dry-run?
```

**Known flags:** `--dry-run`

## Output Format

Consistent across all integration points:

```
<error message>          ← existing error text
Did you mean: <match>?   ← suggestion line (only if match found)
<existing help/usage>    ← unchanged
```

The suggestion line uses no color — keep it simple and readable.

## Testing

- Unit tests for `suggestMatch()` in `src/__tests__/suggest.test.ts`
  - Prefix matching: `statu` → `status`
  - Substring matching: `opic` → `topics`
  - Levenshtein: `statr` → `start`
  - No match: `xyzabc` → `undefined`
  - Case insensitive: `START` matches `start`
  - Empty candidates → `undefined`
  - Exact match returns `undefined` (no suggestion needed)
  - Priority: prefix wins over Levenshtein when both match

## Backward Compatibility

- No breaking changes to any CLI command behavior
- All existing error messages preserved, suggestion line is additive
- No config format changes
