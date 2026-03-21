import type { AgentManager } from "./agent-manager.js";
import { Session } from "./session.js";
import type { SessionStore } from "./session-store.js";
import type { SessionStatus } from "./types.js";

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private store: SessionStore | null;

  constructor(store: SessionStore | null = null) {
    this.store = store;
  }

  async createSession(
    channelId: string,
    agentName: string,
    workingDirectory: string,
    agentManager: AgentManager,
  ): Promise<Session> {
    const agentInstance = await agentManager.spawn(agentName, workingDirectory);
    const session = new Session({
      channelId,
      agentName,
      workingDirectory,
      agentInstance,
    });
    this.sessions.set(session.id, session);
    session.agentSessionId = session.agentInstance.sessionId;

    if (this.store) {
      await this.store.save({
        sessionId: session.id,
        agentSessionId: session.agentInstance.sessionId,
        agentName: session.agentName,
        workingDir: session.workingDirectory,
        channelId,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        lastActiveAt: new Date().toISOString(),
        name: session.name,
        platform: {},
      });
    }

    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionByThread(channelId: string, threadId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.channelId === channelId && session.threadId === threadId) {
        return session;
      }
    }
    return undefined;
  }

  getSessionByAgentSessionId(agentSessionId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.agentSessionId === agentSessionId) {
        return session;
      }
    }
    return undefined;
  }

  getRecordByAgentSessionId(agentSessionId: string): import("./types.js").SessionRecord | undefined {
    return this.store?.findByAgentSessionId(agentSessionId);
  }

  getRecordByThread(channelId: string, threadId: string): import("./types.js").SessionRecord | undefined {
    return this.store?.findByPlatform(
      channelId,
      (p) => String(p.topicId) === threadId,
    );
  }

  registerSession(session: Session): void {
    this.sessions.set(session.id, session);
  }

  async updateSessionPlatform(
    sessionId: string,
    platform: Record<string, unknown>,
  ): Promise<void> {
    if (!this.store) return;
    const record = this.store.get(sessionId);
    if (record) {
      await this.store.save({ ...record, platform });
    }
  }

  async updateSessionActivity(sessionId: string): Promise<void> {
    if (!this.store) return;
    const record = this.store.get(sessionId);
    if (record) {
      await this.store.save({
        ...record,
        lastActiveAt: new Date().toISOString(),
      });
    }
  }

  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<void> {
    if (!this.store) return;
    const record = this.store.get(sessionId);
    if (record) {
      await this.store.save({ ...record, status });
    }
  }

  async updateSessionDangerousMode(sessionId: string, dangerousMode: boolean): Promise<void> {
    if (!this.store) return;
    const record = this.store.get(sessionId);
    if (record) {
      await this.store.save({ ...record, dangerousMode });
    }
  }

  async updateSessionName(sessionId: string, name: string): Promise<void> {
    if (!this.store) return;
    const record = this.store.get(sessionId);
    if (record) {
      await this.store.save({ ...record, name });
    }
  }

  getSessionRecord(sessionId: string): import("./types.js").SessionRecord | undefined {
    return this.store?.get(sessionId);
  }

  async cancelSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.cancel();
    }
    if (this.store) {
      const record = this.store.get(sessionId);
      if (record && record.status !== "cancelled") {
        await this.store.save({ ...record, status: "cancelled" });
      }
    }
  }

  listSessions(channelId?: string): Session[] {
    const all = Array.from(this.sessions.values());
    if (channelId) return all.filter((s) => s.channelId === channelId);
    return all;
  }

  listRecords(filter?: { statuses?: string[] }): import("./types.js").SessionRecord[] {
    if (!this.store) return [];
    let records = this.store.list();
    if (filter?.statuses?.length) {
      records = records.filter(r => filter.statuses!.includes(r.status));
    }
    return records;
  }

  async removeRecord(sessionId: string): Promise<void> {
    if (!this.store) return;
    await this.store.remove(sessionId);
  }

  async destroyAll(): Promise<void> {
    if (this.store) {
      for (const session of this.sessions.values()) {
        const record = this.store.get(session.id);
        if (record) {
          await this.store.save({ ...record, status: "finished" });
        }
      }
    }
    for (const session of this.sessions.values()) {
      await session.destroy();
    }
    this.sessions.clear();
  }
}
