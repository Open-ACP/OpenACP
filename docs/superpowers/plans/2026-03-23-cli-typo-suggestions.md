# CLI Typo Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fuzzy matching ("Did you mean: X?") to all CLI inputs where users type names, commands, or keys.

**Architecture:** A single utility function `suggestMatch()` in `src/cli/suggest.ts` using `fastest-levenshtein` + prefix/substring matching. Integrated into 7 points across `src/cli/commands.ts` and `src/cli.ts`.

**Tech Stack:** TypeScript, `fastest-levenshtein` npm package, vitest for tests

**Spec:** `docs/superpowers/specs/2026-03-23-cli-typo-suggestions-design.md`

---

### Task 1: Install dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install fastest-levenshtein**

Run: `pnpm add fastest-levenshtein`

- [ ] **Step 2: Verify installation**

Run: `pnpm ls fastest-levenshtein`
Expected: Shows `fastest-levenshtein` in the dependency tree.

---

### Task 2: Create `suggestMatch` with tests (TDD)

**Files:**
- Create: `src/cli/suggest.ts`
- Create: `src/__tests__/suggest.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/__tests__/suggest.test.ts
import { describe, it, expect } from "vitest";
import { suggestMatch } from "../cli/suggest.js";

describe("suggestMatch", () => {
  const commands = ["start", "stop", "status", "config", "install", "uninstall", "agents", "topics", "delete-topic"];

  it("returns undefined for exact match", () => {
    expect(suggestMatch("start", commands)).toBeUndefined();
  });

  it("matches by prefix", () => {
    expect(suggestMatch("statu", commands)).toBe("status");
  });

  it("matches by substring", () => {
    expect(suggestMatch("opic", commands)).toBe("topics");
  });

  it("matches by Levenshtein distance", () => {
    expect(suggestMatch("statr", commands)).toBe("start");
  });

  it("returns undefined when no match within threshold", () => {
    expect(suggestMatch("xyzabc", commands)).toBeUndefined();
  });

  it("is case insensitive", () => {
    expect(suggestMatch("START", commands)).toBeUndefined(); // exact match
    expect(suggestMatch("STATU", commands)).toBe("status");
  });

  it("returns undefined for empty candidates", () => {
    expect(suggestMatch("foo", [])).toBeUndefined();
  });

  it("prefix wins over Levenshtein when both could match", () => {
    // "instal" is prefix of "install" AND Levenshtein 1 from "install"
    // prefix should be the reason it matches, but result is the same
    expect(suggestMatch("instal", commands)).toBe("install");
  });

  it("prefers shortest candidate on substring tie", () => {
    const candidates = ["delete-topic", "topics"];
    expect(suggestMatch("opic", candidates)).toBe("topics");
  });

  it("reduces maxDistance for short candidates", () => {
    const short = ["run", "new", "api"];
    // "xyz" has distance 3 from "run" — should not match
    expect(suggestMatch("xyz", short)).toBeUndefined();
    // "rin" has distance 1 from "run" — should match
    expect(suggestMatch("rin", short)).toBe("run");
  });

  it("does not substring-match inputs shorter than 3 chars", () => {
    expect(suggestMatch("to", ["topics"])).toBeUndefined();
  });

  it("respects custom maxDistance", () => {
    expect(suggestMatch("stxxxxxxt", commands, 1)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/suggest.test.ts`
Expected: FAIL — module `../cli/suggest.js` not found.

- [ ] **Step 3: Implement suggestMatch**

```ts
// src/cli/suggest.ts
import { distance } from "fastest-levenshtein";

export function suggestMatch(
  input: string,
  candidates: string[],
  maxDistance: number = 2,
): string | undefined {
  if (candidates.length === 0) return undefined;

  const lower = input.toLowerCase();

  // Exact match — no suggestion needed
  if (candidates.some((c) => c.toLowerCase() === lower)) return undefined;

  // 1. Prefix match — candidate starts with input
  const prefixMatches = candidates.filter((c) =>
    c.toLowerCase().startsWith(lower),
  );
  if (prefixMatches.length > 0) {
    return prefixMatches.sort((a, b) => a.length - b.length)[0];
  }

  // 2. Substring match — candidate contains input (min 3 chars to avoid noise)
  if (lower.length >= 3) {
    const substringMatches = candidates.filter((c) =>
      c.toLowerCase().includes(lower),
    );
    if (substringMatches.length > 0) {
      return substringMatches.sort((a, b) => a.length - b.length)[0];
    }
  }

  // 3. Levenshtein distance
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const effectiveMax = candidate.length <= 3 ? Math.min(maxDistance, 1) : maxDistance;
    const d = distance(lower, candidate.toLowerCase());
    if (d <= effectiveMax && d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }

  return best;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/suggest.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: No TypeScript errors.

---

### Task 3: Integrate into top-level commands

**Files:**
- Modify: `src/cli.ts:56-63` — `main()` function
- Modify: `src/cli/commands.ts:1061-1069` — `cmdDefault()`

- [ ] **Step 1: Add suggestion to cmdDefault**

In `src/cli/commands.ts`, define the valid commands list directly inside `cmdDefault()` to avoid circular imports with `cli.ts`. Modify at line ~1065:

```ts
// Before:
  if (command && !command.startsWith('-')) {
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exit(1)
  }

// After:
  if (command && !command.startsWith('-')) {
    const { suggestMatch } = await import('./suggest.js')
    const topLevelCommands = [
      'start', 'stop', 'status', 'logs', 'config', 'reset', 'update',
      'install', 'uninstall', 'plugins', 'api', 'adopt', 'integrate', 'doctor', 'agents',
    ]
    const suggestion = suggestMatch(command, topLevelCommands)
    console.error(`Unknown command: ${command}`)
    if (suggestion) console.error(`Did you mean: ${suggestion}?`)
    printHelp()
    process.exit(1)
  }
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: No errors.

---

### Task 4: Integrate into API subcommands

**Files:**
- Modify: `src/cli/commands.ts:436-457` — `cmdApi()` else branch

- [ ] **Step 1: Add suggestion to unknown API subcommand**

At the top of `cmdApi`, define the valid subcommands list. Then modify the else branch at line ~437:

```ts
// Add at start of cmdApi (after line 107):
const apiSubcommands = [
  "new", "cancel", "status", "agents", "topics", "delete-topic",
  "cleanup", "send", "session", "dangerous", "health", "restart",
  "config", "adapters", "tunnel", "notify", "version",
];

// Replace the else branch (line ~437):
} else {
  const { suggestMatch } = await import('./suggest.js')
  const suggestion = suggestMatch(subCmd ?? '', apiSubcommands)
  console.error(`Unknown api command: ${subCmd || '(none)'}\n`)
  if (suggestion) console.error(`Did you mean: ${suggestion}?\n`)
  // ... existing usage output unchanged ...
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: No errors.

---

### Task 5: Integrate into agents subcommands

**Files:**
- Modify: `src/cli/commands.ts:800-817` — `cmdAgents()` switch

- [ ] **Step 1: Fix silent fall-through and add suggestion**

Replace the `cmdAgents` switch block:

```ts
export async function cmdAgents(args: string[]): Promise<void> {
  const subcommand = args[1];

  const agentSubcommands = ["install", "uninstall", "refresh", "info", "run", "list"];

  switch (subcommand) {
    case "install":
      return agentsInstall(args[2], args.includes("--force"));
    case "uninstall":
      return agentsUninstall(args[2]);
    case "refresh":
      return agentsRefresh();
    case "info":
      return agentsInfo(args[2]);
    case "run":
      return agentsRun(args[2], args.slice(3));
    case "list":
    case undefined:
      return agentsList();
    default: {
      const { suggestMatch } = await import('./suggest.js');
      const suggestion = suggestMatch(subcommand, agentSubcommands);
      console.error(`Unknown agents command: ${subcommand}`);
      if (suggestion) console.error(`Did you mean: ${suggestion}?`);
      console.error(`\nRun 'openacp agents' to see available agents.`);
      process.exit(1);
    }
  }
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: No errors.

---

### Task 6: Integrate into agent name lookups (info, run, install, uninstall)

**Files:**
- Modify: `src/cli/commands.ts` — `agentsInfo()` (~line 1002), `agentsRun()` (~line 1022), `agentsInstall()` (~line 903), `agentsUninstall()` (~line 928)

- [ ] **Step 1: Add suggestion to agentsInfo**

At line ~1002, modify the not-found branch:

```ts
// Before:
  console.log(`\n  \x1b[31m"${nameOrId}" not found.\x1b[0m Run 'openacp agents' to see available agents.\n`);

// After:
  const { suggestMatch } = await import('./suggest.js');
  const allKeys = catalog.getAvailable().map((a) => a.key);
  const suggestion = suggestMatch(nameOrId, allKeys);
  console.log(`\n  \x1b[31m"${nameOrId}" not found.\x1b[0m`);
  if (suggestion) console.log(`  Did you mean: ${suggestion}?`);
  console.log(`  Run 'openacp agents' to see available agents.\n`);
```

- [ ] **Step 2: Add suggestion to agentsRun**

At line ~1022, modify the not-installed branch:

```ts
// Before:
    console.log(`\n  \x1b[31m"${nameOrId}" is not installed.\x1b[0m`);
    console.log(`  Install first: openacp agents install ${nameOrId}\n`);

// After:
    const { suggestMatch } = await import('./suggest.js');
    const installedKeys = Object.keys(catalog.getInstalledEntries());
    const suggestion = suggestMatch(nameOrId, installedKeys);
    console.log(`\n  \x1b[31m"${nameOrId}" is not installed.\x1b[0m`);
    if (suggestion) {
      console.log(`  Did you mean: ${suggestion}?`);
      console.log(`  Install first: openacp agents install ${suggestion}\n`);
    } else {
      console.log(`  Install first: openacp agents install ${nameOrId}\n`);
    }
```

- [ ] **Step 3: Add suggestion to agentsInstall**

After `catalog.install()` returns at line ~903, add suggestion on failure:

```ts
  const result = await catalog.install(nameOrId, progress, force);
  if (!result.ok) {
    // Add suggestion if agent not found in registry
    if (result.error?.includes('not found')) {
      const { suggestMatch } = await import('./suggest.js');
      const allKeys = catalog.getAvailable().map((a) => a.key);
      const suggestion = suggestMatch(nameOrId, allKeys);
      if (suggestion) console.log(`  Did you mean: ${suggestion}?`);
    }
    process.exit(1);
  }
```

- [ ] **Step 4: Add suggestion to agentsUninstall**

After `catalog.uninstall()` returns at line ~928:

```ts
  const result = await catalog.uninstall(name);
  if (result.ok) {
    console.log(`\n  \x1b[32m✓ ${name} removed.\x1b[0m\n`);
  } else {
    console.log(`\n  \x1b[31m✗ ${result.error}\x1b[0m`);
    if (result.error?.includes('not installed')) {
      const { suggestMatch } = await import('./suggest.js');
      const installedKeys = Object.keys(catalog.getInstalledEntries());
      const suggestion = suggestMatch(name, installedKeys);
      if (suggestion) console.log(`  Did you mean: ${suggestion}?`);
    }
    console.log();
  }
```

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: No errors.

---

### Task 7: Integrate into integrate and config commands

**Files:**
- Modify: `src/cli/commands.ts` — `cmdIntegrate()` (~line 714), `cmdConfig()` (~line 535)

- [ ] **Step 1: Add suggestion to cmdIntegrate**

At line ~715:

```ts
// Before:
  if (!integration) {
    console.log(`No integration available for '${agent}'.`);
    console.log(`Available: ${listIntegrations().join(", ")}`);
    process.exit(1);
  }

// After:
  if (!integration) {
    const { suggestMatch } = await import('./suggest.js');
    const available = listIntegrations();
    const suggestion = suggestMatch(agent, available);
    console.log(`No integration available for '${agent}'.`);
    if (suggestion) console.log(`Did you mean: ${suggestion}?`);
    console.log(`Available: ${available.join(", ")}`);
    process.exit(1);
  }
```

- [ ] **Step 2: Add config key validation to cmdConfig**

In `cmdConfig()`, after parsing `configPath` and `configValue` (line ~535), before either code path:

```ts
  if (subCmd === 'set') {
    const configPath = args[2]
    const configValue = args[3]
    if (!configPath || configValue === undefined) {
      console.error('Usage: openacp config set <path> <value>')
      process.exit(1)
    }

    // Validate top-level config key (derived from schema to stay in sync)
    const { ConfigSchema } = await import('../core/config.js')
    const topLevelKey = configPath.split('.')[0]
    const validConfigKeys = Object.keys(ConfigSchema.shape)
    if (!validConfigKeys.includes(topLevelKey)) {
      const { suggestMatch } = await import('./suggest.js')
      const suggestion = suggestMatch(topLevelKey, validConfigKeys)
      console.error(`Unknown config key: ${topLevelKey}`)
      if (suggestion) console.error(`Did you mean: ${suggestion}?`)
      process.exit(1)
    }

    // ... rest of existing code unchanged ...
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: No errors.

---

### Task 8: Integrate into doctor flags

**Files:**
- Modify: `src/cli/commands.ts` — `cmdDoctor()` (~line 745)

- [ ] **Step 1: Add flag validation to cmdDoctor**

At the start of `cmdDoctor()`, check for unknown flags:

```ts
export async function cmdDoctor(args: string[]): Promise<void> {
  const knownFlags = ["--dry-run"];
  const unknownFlags = args.slice(1).filter(
    (a) => a.startsWith("--") && !knownFlags.includes(a),
  );
  if (unknownFlags.length > 0) {
    const { suggestMatch } = await import('./suggest.js');
    for (const flag of unknownFlags) {
      const suggestion = suggestMatch(flag, knownFlags);
      console.error(`Unknown flag: ${flag}`);
      if (suggestion) console.error(`Did you mean: ${suggestion}?`);
    }
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  // ... rest unchanged ...
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: No errors.

---

### Task 9: Final verification

- [ ] **Step 1: Run all tests**

Run: `pnpm test`
Expected: All tests pass, including new `suggest.test.ts`.

- [ ] **Step 2: Run build**

Run: `pnpm build`
Expected: No errors.

- [ ] **Step 3: Manual smoke test**

```bash
# Top-level command
node dist/cli.js statr
# Expected: Unknown command: statr\nDid you mean: start?

# Agents subcommand
node dist/cli.js agents instal
# Expected: Unknown agents command: instal\nDid you mean: install?

# Agent name
node dist/cli.js agents info cluade
# Expected: "cluade" not found.\nDid you mean: claude?
```
