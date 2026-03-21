import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyMigrations } from "./config-migrations.js";
import { createChildLogger } from "./log.js";
const log = createChildLogger({ module: "config" });

const BaseChannelSchema = z
  .object({
    enabled: z.boolean().default(false),
    adapter: z.string().optional(), // package name for plugin adapters
  })
  .passthrough();

export const PLUGINS_DIR = path.join(os.homedir(), ".openacp", "plugins");

const AgentSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  workingDirectory: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
});

const LoggingSchema = z
  .object({
    level: z
      .enum(["silent", "debug", "info", "warn", "error", "fatal"])
      .default("info"),
    logDir: z.string().default("~/.openacp/logs"),
    maxFileSize: z.union([z.string(), z.number()]).default("10m"),
    maxFiles: z.number().default(7),
    sessionLogRetentionDays: z.number().default(30),
  })
  .default({});

export type LoggingConfig = z.infer<typeof LoggingSchema>;

const TunnelAuthSchema = z
  .object({
    enabled: z.boolean().default(false),
    token: z.string().optional(),
  })
  .default({});

const TunnelSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().default(3100),
    provider: z.enum(["cloudflare", "ngrok", "bore", "tailscale"]).default("cloudflare"),
    options: z.record(z.string(), z.unknown()).default({}),
    storeTtlMinutes: z.number().default(60),
    auth: TunnelAuthSchema,
  })
  .default({});

export type TunnelConfig = z.infer<typeof TunnelSchema>;

export const ConfigSchema = z.object({
  channels: z.record(z.string(), BaseChannelSchema),
  agents: z.record(z.string(), AgentSchema),
  defaultAgent: z.string(),
  workspace: z
    .object({
      baseDir: z.string().default("~/openacp-workspace"),
    })
    .default({}),
  security: z
    .object({
      allowedUserIds: z.array(z.string()).default([]),
      maxConcurrentSessions: z.number().default(20),
      sessionTimeoutMinutes: z.number().default(60),
    })
    .default({}),
  logging: LoggingSchema,
  runMode: z.enum(['foreground', 'daemon']).default('foreground'),
  autoStart: z.boolean().default(false),
  api: z.object({
    port: z.number().default(21420),
    host: z.string().default('127.0.0.1'),
  }).default({}),
  sessionStore: z
    .object({
      ttlDays: z.number().default(30),
    })
    .default({}),
  tunnel: TunnelSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

export function expandHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

const DEFAULT_CONFIG = {
  channels: {
    telegram: {
      enabled: false,
      botToken: "YOUR_BOT_TOKEN_HERE",
      chatId: 0,
      notificationTopicId: null,
      assistantTopicId: null,
    },
  },
  agents: {
    claude: { command: "claude-agent-acp", args: [], env: {} },
    codex: { command: "codex", args: ["--acp"], env: {} },
  },
  defaultAgent: "claude",
  workspace: { baseDir: "~/openacp-workspace" },
  security: {
    allowedUserIds: [],
    maxConcurrentSessions: 20,
    sessionTimeoutMinutes: 60,
  },
  sessionStore: { ttlDays: 30 },
  tunnel: {
    enabled: true,
    port: 3100,
    provider: "cloudflare",
    options: {},
    storeTtlMinutes: 60,
    auth: { enabled: false },
  },
};

export class ConfigManager {
  private config!: Config;
  private configPath: string;

  constructor() {
    this.configPath =
      process.env.OPENACP_CONFIG_PATH || expandHome("~/.openacp/config.json");
  }

  async load(): Promise<void> {
    // 1. Ensure directory exists
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true });

    // 2. If config file doesn't exist, create default
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(DEFAULT_CONFIG, null, 2),
      );
      log.info({ configPath: this.configPath }, "Config created");
      log.info(
        "Please edit it with your Telegram bot token and chat ID, then restart.",
      );
      process.exit(1);
    }

    // 3. Read and parse
    const raw = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));

    // 3.5. Auto-migrate config
    const { changed: configUpdated } = applyMigrations(raw);
    if (configUpdated) {
      fs.writeFileSync(this.configPath, JSON.stringify(raw, null, 2));
    }

    // 4. Apply env var overrides
    this.applyEnvOverrides(raw);

    // 5. Validate with Zod
    const result = ConfigSchema.safeParse(raw);
    if (!result.success) {
      log.error("Config validation failed");
      for (const issue of result.error.issues) {
        log.error(
          { path: issue.path.join("."), message: issue.message },
          "Validation error",
        );
      }
      process.exit(1);
    }
    this.config = result.data;
  }

  get(): Config {
    return this.config;
  }

  async save(updates: Record<string, unknown>): Promise<void> {
    // Read current file, merge updates, write back
    const raw = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    this.deepMerge(raw, updates);
    fs.writeFileSync(this.configPath, JSON.stringify(raw, null, 2));
    // Re-validate and update in-memory config
    const result = ConfigSchema.safeParse(raw);
    if (result.success) {
      this.config = result.data;
    }
  }

  resolveWorkspace(input?: string): string {
    if (!input) {
      const resolved = expandHome(this.config.workspace.baseDir);
      fs.mkdirSync(resolved, { recursive: true });
      return resolved;
    }
    if (input.startsWith("/") || input.startsWith("~")) {
      const resolved = expandHome(input);
      fs.mkdirSync(resolved, { recursive: true });
      return resolved;
    }
    // Named workspace → lowercase, under baseDir
    const name = input.toLowerCase();
    const resolved = path.join(expandHome(this.config.workspace.baseDir), name);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  async exists(): Promise<boolean> {
    return fs.existsSync(this.configPath);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  async writeNew(config: Config): Promise<void> {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  private applyEnvOverrides(raw: Record<string, unknown>): void {
    const overrides: [string, string[]][] = [
      ["OPENACP_TELEGRAM_BOT_TOKEN", ["channels", "telegram", "botToken"]],
      ["OPENACP_TELEGRAM_CHAT_ID", ["channels", "telegram", "chatId"]],
      ["OPENACP_DEFAULT_AGENT", ["defaultAgent"]],
      ["OPENACP_RUN_MODE", ["runMode"]],
      ["OPENACP_API_PORT", ["api", "port"]],
    ];
    for (const [envVar, configPath] of overrides) {
      const value = process.env[envVar];
      if (value !== undefined) {
        let target = raw as Record<string, any>;
        for (let i = 0; i < configPath.length - 1; i++) {
          if (!target[configPath[i]]) target[configPath[i]] = {};
          target = target[configPath[i]];
        }
        const key = configPath[configPath.length - 1];
        // Convert numeric fields to number
        target[key] = (key === "chatId" || key === "port") ? Number(value) : value;
      }
    }

    // Logging env var overrides
    if (process.env.OPENACP_LOG_LEVEL) {
      raw.logging = raw.logging || {};
      (raw.logging as Record<string, unknown>).level =
        process.env.OPENACP_LOG_LEVEL;
    }
    if (process.env.OPENACP_LOG_DIR) {
      raw.logging = raw.logging || {};
      (raw.logging as Record<string, unknown>).logDir =
        process.env.OPENACP_LOG_DIR;
    }
    if (process.env.OPENACP_DEBUG && !process.env.OPENACP_LOG_LEVEL) {
      raw.logging = raw.logging || {};
      (raw.logging as Record<string, unknown>).level = "debug";
    }

    // Tunnel env var overrides
    if (process.env.OPENACP_TUNNEL_ENABLED) {
      raw.tunnel = raw.tunnel || {};
      (raw.tunnel as Record<string, unknown>).enabled =
        process.env.OPENACP_TUNNEL_ENABLED === "true";
    }
    if (process.env.OPENACP_TUNNEL_PORT) {
      raw.tunnel = raw.tunnel || {};
      (raw.tunnel as Record<string, unknown>).port = Number(
        process.env.OPENACP_TUNNEL_PORT,
      );
    }
    if (process.env.OPENACP_TUNNEL_PROVIDER) {
      raw.tunnel = raw.tunnel || {};
      (raw.tunnel as Record<string, unknown>).provider =
        process.env.OPENACP_TUNNEL_PROVIDER;
    }
  }

  private deepMerge(
    target: Record<string, any>,
    source: Record<string, any>,
  ): void {
    for (const key of Object.keys(source)) {
      if (
        source[key] &&
        typeof source[key] === "object" &&
        !Array.isArray(source[key])
      ) {
        if (!target[key]) target[key] = {};
        this.deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }
}
