import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentStore } from '../agent-store.js'

describe('AgentStore - extended', () => {
  let tmpDir: string
  let storePath: string

  const sampleAgent = {
    registryId: 'claude-acp',
    name: 'Claude (ACP)',
    version: '1.0.0',
    distribution: 'npx' as const,
    command: 'claude-agent-acp',
    args: [],
    env: {},
    installedAt: new Date().toISOString(),
    binaryPath: null,
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-store-test-'))
    storePath = path.join(tmpDir, 'agents.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('exists()', () => {
    it('returns false when file does not exist', () => {
      const store = new AgentStore(storePath)
      expect(store.exists()).toBe(false)
    })

    it('returns true when file exists', () => {
      fs.writeFileSync(storePath, '{}')
      const store = new AgentStore(storePath)
      expect(store.exists()).toBe(true)
    })
  })

  describe('hasAgent()', () => {
    it('returns false for unknown agent', () => {
      const store = new AgentStore(storePath)
      store.load()
      expect(store.hasAgent('unknown')).toBe(false)
    })

    it('returns true for installed agent', () => {
      const store = new AgentStore(storePath)
      store.load()
      store.addAgent('claude', sampleAgent)
      expect(store.hasAgent('claude')).toBe(true)
    })

    it('returns false after agent is removed', () => {
      const store = new AgentStore(storePath)
      store.load()
      store.addAgent('claude', sampleAgent)
      store.removeAgent('claude')
      expect(store.hasAgent('claude')).toBe(false)
    })
  })

  describe('getAgent()', () => {
    it('returns undefined for unknown agent', () => {
      const store = new AgentStore(storePath)
      store.load()
      expect(store.getAgent('unknown')).toBeUndefined()
    })

    it('returns agent data for installed agent', () => {
      const store = new AgentStore(storePath)
      store.load()
      store.addAgent('claude', sampleAgent)
      const agent = store.getAgent('claude')
      expect(agent).toMatchObject({
        name: 'Claude (ACP)',
        command: 'claude-agent-acp',
      })
    })
  })

  describe('load() with corrupted file', () => {
    it('handles invalid JSON gracefully', () => {
      fs.writeFileSync(storePath, 'not valid json')
      const store = new AgentStore(storePath)
      store.load() // should not throw
      expect(store.getInstalled()).toEqual({})
    })

    it('handles invalid schema gracefully', () => {
      fs.writeFileSync(storePath, JSON.stringify({ version: 'bad', installed: 'wrong' }))
      const store = new AgentStore(storePath)
      store.load() // should not throw
      expect(store.getInstalled()).toEqual({})
    })

    it('handles empty file gracefully', () => {
      fs.writeFileSync(storePath, '')
      const store = new AgentStore(storePath)
      store.load() // should not throw
      expect(store.getInstalled()).toEqual({})
    })
  })

  describe('getInstalled()', () => {
    it('returns empty object when no agents', () => {
      const store = new AgentStore(storePath)
      store.load()
      expect(store.getInstalled()).toEqual({})
    })

    it('returns all installed agents', () => {
      const store = new AgentStore(storePath)
      store.load()
      store.addAgent('claude', sampleAgent)
      store.addAgent('codex', { ...sampleAgent, name: 'Codex', command: 'codex' })

      const installed = store.getInstalled()
      expect(Object.keys(installed)).toEqual(['claude', 'codex'])
    })
  })

  describe('atomic writes', () => {
    it('persists data across load cycles', () => {
      const store1 = new AgentStore(storePath)
      store1.load()
      store1.addAgent('claude', sampleAgent)

      const store2 = new AgentStore(storePath)
      store2.load()
      expect(store2.hasAgent('claude')).toBe(true)
      expect(store2.getAgent('claude')?.command).toBe('claude-agent-acp')
    })

    it('creates parent directory if missing', () => {
      const nestedPath = path.join(tmpDir, 'nested', 'dir', 'agents.json')
      const store = new AgentStore(nestedPath)
      store.load() // should create directory
      expect(fs.existsSync(path.dirname(nestedPath))).toBe(true)
    })
  })

  describe('addAgent()', () => {
    it('overwrites existing agent with same key', () => {
      const store = new AgentStore(storePath)
      store.load()
      store.addAgent('claude', sampleAgent)
      store.addAgent('claude', { ...sampleAgent, version: '2.0.0' })

      expect(store.getAgent('claude')?.version).toBe('2.0.0')
    })
  })

  describe('removeAgent()', () => {
    it('is no-op for unknown agent', () => {
      const store = new AgentStore(storePath)
      store.load()
      store.removeAgent('nonexistent') // should not throw
    })
  })
})
