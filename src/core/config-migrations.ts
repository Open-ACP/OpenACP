import { createChildLogger } from "./log.js";
const log = createChildLogger({ module: "config-migrations" });

type RawConfig = Record<string, unknown>;

export interface Migration {
  name: string;
  apply: (raw: RawConfig) => boolean; // returns true if config was modified
}

export const migrations: Migration[] = [
  {
    name: "add-tunnel-section",
    apply(raw) {
      if (raw.tunnel) return false;
      raw.tunnel = {
        enabled: true,
        port: 3100,
        provider: "cloudflare",
        options: {},
        storeTtlMinutes: 60,
        auth: { enabled: false },
      };
      log.info("Added tunnel section to config (enabled by default with cloudflare)");
      return true;
    },
  },
  {
    name: "fix-agent-commands",
    apply(raw) {
      const COMMAND_MIGRATIONS: Record<string, string[]> = {
        "claude-agent-acp": ["claude", "claude-code"],
      };

      const agents = raw.agents;
      if (!agents || typeof agents !== "object") return false;

      let changed = false;
      for (const [agentName, agentDef] of Object.entries(agents as Record<string, any>)) {
        if (!agentDef?.command) continue;
        for (const [correctCmd, legacyCmds] of Object.entries(COMMAND_MIGRATIONS)) {
          if (legacyCmds.includes(agentDef.command)) {
            log.warn(
              { agent: agentName, oldCommand: agentDef.command, newCommand: correctCmd },
              `Auto-migrating agent command: "${agentDef.command}" → "${correctCmd}"`,
            );
            agentDef.command = correctCmd;
            changed = true;
          }
        }
      }
      return changed;
    },
  },
];

/**
 * Apply all migrations to raw config (mutates in place).
 * Returns whether any changes were made.
 */
export function applyMigrations(
  raw: RawConfig,
  migrationList: Migration[] = migrations,
): { changed: boolean } {
  let changed = false;
  for (const migration of migrationList) {
    if (migration.apply(raw)) {
      changed = true;
    }
  }
  return { changed };
}
