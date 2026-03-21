import fs from "node:fs";
import path from "node:path";
import type { SessionRecord } from "./types.js";
import { createChildLogger } from "./log.js";

const log = createChildLogger({ module: "session-store" });

export interface SessionStore {
  save(record: SessionRecord): Promise<void>;
  get(sessionId: string): SessionRecord | undefined;
  findByPlatform(
    channelId: string,
    predicate: (platform: Record<string, unknown>) => boolean,
  ): SessionRecord | undefined;
  findByAgentSessionId(agentSessionId: string): SessionRecord | undefined;
  list(channelId?: string): SessionRecord[];
  remove(sessionId: string): Promise<void>;
}

interface StoreFile {
  version: number;
  sessions: Record<string, SessionRecord>;
}

const DEBOUNCE_MS = 2000;

export class JsonFileSessionStore implements SessionStore {
  private records: Map<string, SessionRecord> = new Map();
  private filePath: string;
  private ttlDays: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private flushHandler: (() => void) | null = null;

  constructor(filePath: string, ttlDays: number) {
    this.filePath = filePath;
    this.ttlDays = ttlDays;
    this.load();
    this.cleanup();

    // Daily cleanup for long-running instances
    this.cleanupInterval = setInterval(
      () => this.cleanup(),
      24 * 60 * 60 * 1000,
    );

    // Force flush on shutdown
    this.flushHandler = () => this.flushSync();
    process.on("SIGTERM", this.flushHandler);
    process.on("SIGINT", this.flushHandler);
    process.on("exit", this.flushHandler);
  }

  async save(record: SessionRecord): Promise<void> {
    this.records.set(record.sessionId, { ...record });
    this.scheduleDiskWrite();
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId);
  }

  findByPlatform(
    channelId: string,
    predicate: (platform: Record<string, unknown>) => boolean,
  ): SessionRecord | undefined {
    for (const record of this.records.values()) {
      if (record.channelId === channelId && predicate(record.platform)) {
        return record;
      }
    }
    return undefined;
  }

  findByAgentSessionId(agentSessionId: string): SessionRecord | undefined {
    return [...this.records.values()].find(
      (r) =>
        r.agentSessionId === agentSessionId ||
        r.originalAgentSessionId === agentSessionId,
    );
  }

  list(channelId?: string): SessionRecord[] {
    const all = [...this.records.values()];
    if (channelId) return all.filter((r) => r.channelId === channelId);
    return all;
  }

  async remove(sessionId: string): Promise<void> {
    this.records.delete(sessionId);
    this.scheduleDiskWrite();
  }

  flushSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const data: StoreFile = {
      version: 1,
      sessions: Object.fromEntries(this.records),
    };
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.flushHandler) {
      process.removeListener("SIGTERM", this.flushHandler);
      process.removeListener("SIGINT", this.flushHandler);
      process.removeListener("exit", this.flushHandler);
      this.flushHandler = null;
    }
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.filePath, "utf-8"),
      ) as StoreFile;
      if (raw.version !== 1) {
        log.warn(
          { version: raw.version },
          "Unknown session store version, skipping load",
        );
        return;
      }
      for (const [id, record] of Object.entries(raw.sessions)) {
        this.records.set(id, record);
      }
      log.info({ count: this.records.size }, "Loaded session records");
    } catch (err) {
      log.error({ err }, "Failed to load session store");
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttlDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.status === "active" || record.status === "initializing")
        continue;
      const lastActive = new Date(record.lastActiveAt).getTime();
      if (lastActive < cutoff) {
        this.records.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      log.info({ removed }, "Cleaned up expired session records");
      this.scheduleDiskWrite();
    }
  }

  private scheduleDiskWrite(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flushSync();
    }, DEBOUNCE_MS);
  }
}
