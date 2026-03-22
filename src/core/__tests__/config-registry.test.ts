import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  CONFIG_REGISTRY,
  getFieldDef,
  getSafeFields,
  isHotReloadable,
  type ConfigFieldDef,
} from '../config-registry.js'
import { ConfigManager } from '../config.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

describe('config-registry', () => {
  it('exports a non-empty registry', () => {
    expect(CONFIG_REGISTRY.length).toBeGreaterThan(0)
  })

  it('getFieldDef returns definition for known path', () => {
    const def = getFieldDef('defaultAgent')
    expect(def).toBeDefined()
    expect(def!.type).toBe('select')
    expect(def!.scope).toBe('safe')
  })

  it('getFieldDef returns undefined for unknown path', () => {
    expect(getFieldDef('nonexistent.path')).toBeUndefined()
  })

  it('getSafeFields returns only safe-scoped fields', () => {
    const safe = getSafeFields()
    expect(safe.length).toBeGreaterThan(0)
    for (const field of safe) {
      expect(field.scope).toBe('safe')
    }
  })

  it('isHotReloadable returns correct values', () => {
    expect(isHotReloadable('defaultAgent')).toBe(true)
    expect(isHotReloadable('logging.level')).toBe(true)
    expect(isHotReloadable('tunnel.enabled')).toBe(false)
    expect(isHotReloadable('channels.telegram.botToken')).toBe(false)
  })

  it('all safe fields have required metadata', () => {
    const safe = getSafeFields()
    for (const field of safe) {
      expect(field.path).toBeTruthy()
      expect(field.displayName).toBeTruthy()
      expect(field.group).toBeTruthy()
      expect(['toggle', 'select', 'number', 'string']).toContain(field.type)
      if (field.type === 'select') {
        expect(field.options).toBeDefined()
      }
    }
  })
})

describe('ConfigManager events', () => {
  let tmpDir: string
  let cm: ConfigManager

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-config-test-'))
    const configPath = path.join(tmpDir, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify({
      channels: { telegram: { enabled: false, botToken: 'test', chatId: 0 } },
      agents: { claude: { command: 'claude', args: [] } },
      defaultAgent: 'claude',
    }))
    process.env.OPENACP_CONFIG_PATH = configPath
    cm = new ConfigManager()
    await cm.load()
  })

  afterEach(() => {
    delete process.env.OPENACP_CONFIG_PATH
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('emits config:changed event on save', async () => {
    const events: Array<{ path: string; value: unknown }> = []
    cm.on('config:changed', (e) => events.push(e))

    await cm.save({ defaultAgent: 'codex' }, 'defaultAgent')
    expect(events).toHaveLength(1)
    expect(events[0].path).toBe('defaultAgent')
    expect(events[0].value).toBe('codex')
  })

  it('does not emit event when no changePath provided', async () => {
    const events: Array<unknown> = []
    cm.on('config:changed', (e) => events.push(e))

    await cm.save({ defaultAgent: 'codex' })
    expect(events).toHaveLength(0)
  })
})
