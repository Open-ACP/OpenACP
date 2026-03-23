import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { JsonFileSessionStore } from '../core/session-store.js'
import type { SessionRecord } from '../core/types.js'

function createRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: overrides.sessionId ?? 'sess-1',
    agentSessionId: overrides.agentSessionId ?? 'agent-1',
    agentName: overrides.agentName ?? 'claude',
    workingDir: '/workspace',
    channelId: 'telegram',
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    dangerousMode: false,
    platform: overrides.platform ?? {},
    ...overrides,
  }
}

describe('JsonFileSessionStore - extended edge cases', () => {
  let tmpDir: string
  let storePath: string
  let store: JsonFileSessionStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-ext-'))
    storePath = path.join(tmpDir, 'sessions.json')
    store = new JsonFileSessionStore(storePath, 30)
  })

  afterEach(() => {
    store.destroy()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('findByAgentSessionId()', () => {
    it('finds by direct agentSessionId', async () => {
      await store.save(createRecord({ sessionId: 's1', agentSessionId: 'agent-abc' }))
      const found = store.findByAgentSessionId('agent-abc')
      expect(found?.sessionId).toBe('s1')
    })

    it('finds by originalAgentSessionId', async () => {
      await store.save(createRecord({
        sessionId: 's2',
        agentSessionId: 'new-agent-id',
        originalAgentSessionId: 'original-agent-id',
      }))
      const found = store.findByAgentSessionId('original-agent-id')
      expect(found?.sessionId).toBe('s2')
    })

    it('returns undefined when not found', () => {
      expect(store.findByAgentSessionId('nonexistent')).toBeUndefined()
    })

    it('prefers direct match over original', async () => {
      await store.save(createRecord({ sessionId: 's1', agentSessionId: 'match-id' }))
      await store.save(createRecord({
        sessionId: 's2',
        agentSessionId: 'other',
        originalAgentSessionId: 'match-id',
      }))
      const found = store.findByAgentSessionId('match-id')
      expect(found?.sessionId).toBe('s1')
    })
  })

  describe('findByPlatform()', () => {
    it('finds record by platform predicate', async () => {
      await store.save(createRecord({
        sessionId: 's1',
        platform: { topicId: 123 },
      }))
      const found = store.findByPlatform('telegram', (p) => p.topicId === 123)
      expect(found?.sessionId).toBe('s1')
    })

    it('returns undefined when predicate does not match', async () => {
      await store.save(createRecord({
        sessionId: 's1',
        platform: { topicId: 123 },
      }))
      const found = store.findByPlatform('telegram', (p) => p.topicId === 999)
      expect(found).toBeUndefined()
    })

    it('filters by channelId', async () => {
      await store.save(createRecord({
        sessionId: 's1',
        channelId: 'discord',
        platform: { topicId: 123 },
      }))
      const found = store.findByPlatform('telegram', (p) => p.topicId === 123)
      expect(found).toBeUndefined()
    })
  })

  describe('corrupted file handling', () => {
    it('handles invalid JSON on load', () => {
      fs.writeFileSync(storePath, 'invalid json content')
      const s = new JsonFileSessionStore(storePath, 30)
      // Should not throw, starts fresh
      expect(s.list()).toEqual([])
      s.destroy()
    })

    it('handles empty file', () => {
      fs.writeFileSync(storePath, '')
      const s = new JsonFileSessionStore(storePath, 30)
      expect(s.list()).toEqual([])
      s.destroy()
    })
  })

  describe('destroy()', () => {
    it('cleans up without errors', () => {
      store.destroy()
      // Double destroy should not throw
      store.destroy()
    })
  })

  describe('list()', () => {
    it('lists all records', async () => {
      await store.save(createRecord({ sessionId: 's1' }))
      await store.save(createRecord({ sessionId: 's2' }))
      expect(store.list()).toHaveLength(2)
    })

    it('lists records filtered by channelId', async () => {
      await store.save(createRecord({ sessionId: 's1', channelId: 'telegram' }))
      await store.save(createRecord({ sessionId: 's2', channelId: 'discord' }))
      expect(store.list('telegram')).toHaveLength(1)
      expect(store.list('telegram')[0].sessionId).toBe('s1')
    })

    it('returns empty array for no matches', () => {
      expect(store.list('nonexistent')).toEqual([])
    })
  })

  describe('flushSync()', () => {
    it('persists data to disk immediately', async () => {
      await store.save(createRecord({ sessionId: 's1' }))
      store.flushSync()

      // Verify on disk
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'))
      expect(raw.sessions.s1).toBeDefined()
    })
  })

  describe('concurrent saves', () => {
    it('handles rapid sequential saves', async () => {
      for (let i = 0; i < 10; i++) {
        await store.save(createRecord({ sessionId: `s${i}` }))
      }
      expect(store.list()).toHaveLength(10)
    })

    it('save then remove in sequence', async () => {
      await store.save(createRecord({ sessionId: 's1' }))
      await store.remove('s1')
      expect(store.get('s1')).toBeUndefined()
    })
  })

  describe('TTL cleanup', () => {
    it('preserves initializing sessions even if old', async () => {
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 60) // 60 days ago
      await store.save(createRecord({
        sessionId: 'old-init',
        status: 'initializing',
        createdAt: oldDate.toISOString(),
      }))

      // Force flush and reload
      store.flushSync()
      const newStore = new JsonFileSessionStore(storePath, 30)
      // Initializing = active, should be preserved
      expect(newStore.get('old-init')).toBeDefined()
      newStore.destroy()
    })
  })
})
