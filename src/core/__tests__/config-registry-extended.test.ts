import { describe, it, expect } from 'vitest'
import {
  getConfigValue,
  resolveOptions,
  getFieldDef,
  isHotReloadable,
  CONFIG_REGISTRY,
  type ConfigFieldDef,
} from '../config-registry.js'
import type { Config } from '../config.js'

describe('getConfigValue', () => {
  const config = {
    channels: { telegram: { enabled: true, botToken: 'tok' } },
    defaultAgent: 'claude',
    workspace: { baseDir: '~/workspace' },
    security: { allowedUserIds: ['user1'], maxConcurrentSessions: 10, sessionTimeoutMinutes: 60 },
    logging: { level: 'info' },
    sessionStore: { ttlDays: 30 },
  } as unknown as Config

  it('gets top-level value', () => {
    expect(getConfigValue(config, 'defaultAgent')).toBe('claude')
  })

  it('gets nested value with dot path', () => {
    expect(getConfigValue(config, 'workspace.baseDir')).toBe('~/workspace')
  })

  it('gets deeply nested value', () => {
    expect(getConfigValue(config, 'security.maxConcurrentSessions')).toBe(10)
  })

  it('gets value from channel config', () => {
    expect(getConfigValue(config, 'channels.telegram.enabled')).toBe(true)
  })

  it('returns undefined for non-existent top-level key', () => {
    expect(getConfigValue(config, 'nonexistent')).toBeUndefined()
  })

  it('returns undefined for non-existent nested key', () => {
    expect(getConfigValue(config, 'security.nonexistent')).toBeUndefined()
  })

  it('returns undefined when intermediate is not an object', () => {
    expect(getConfigValue(config, 'defaultAgent.nested')).toBeUndefined()
  })

  it('returns undefined for deeply non-existent path', () => {
    expect(getConfigValue(config, 'a.b.c.d.e')).toBeUndefined()
  })

  it('returns array values', () => {
    const result = getConfigValue(config, 'security.allowedUserIds')
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual(['user1'])
  })

  it('returns object values', () => {
    const result = getConfigValue(config, 'workspace')
    expect(result).toEqual({ baseDir: '~/workspace' })
  })
})

describe('resolveOptions', () => {
  const config = {
    agents: { claude: {}, codex: {} },
  } as unknown as Config

  it('returns undefined when no options defined', () => {
    const def: ConfigFieldDef = {
      path: 'test', displayName: 'Test', group: 'test',
      type: 'string', scope: 'safe', hotReload: false,
    }
    expect(resolveOptions(def, config)).toBeUndefined()
  })

  it('returns static options array', () => {
    const def: ConfigFieldDef = {
      path: 'test', displayName: 'Test', group: 'test',
      type: 'select', scope: 'safe', hotReload: false,
      options: ['a', 'b', 'c'],
    }
    expect(resolveOptions(def, config)).toEqual(['a', 'b', 'c'])
  })

  it('calls function options with config', () => {
    const def: ConfigFieldDef = {
      path: 'test', displayName: 'Test', group: 'test',
      type: 'select', scope: 'safe', hotReload: false,
      options: (cfg) => Object.keys(cfg.agents ?? {}),
    }
    const result = resolveOptions(def, config)
    expect(result).toEqual(['claude', 'codex'])
  })

  it('resolves logging.level options as static', () => {
    const def = getFieldDef('logging.level')!
    const result = resolveOptions(def, config)
    expect(result).toContain('info')
    expect(result).toContain('debug')
    expect(result).toContain('silent')
  })
})

describe('isHotReloadable', () => {
  it('returns true for hot-reloadable field', () => {
    expect(isHotReloadable('logging.level')).toBe(true)
    expect(isHotReloadable('defaultAgent')).toBe(true)
  })

  it('returns false for non-hot-reloadable field', () => {
    expect(isHotReloadable('tunnel.enabled')).toBe(false)
  })

  it('returns false for unknown field', () => {
    expect(isHotReloadable('nonexistent.path')).toBe(false)
  })
})

describe('CONFIG_REGISTRY completeness', () => {
  it('all fields have required metadata', () => {
    for (const field of CONFIG_REGISTRY) {
      expect(field.path).toBeTruthy()
      expect(field.displayName).toBeTruthy()
      expect(field.group).toBeTruthy()
      expect(['toggle', 'select', 'number', 'string']).toContain(field.type)
      expect(['safe', 'sensitive']).toContain(field.scope)
      expect(typeof field.hotReload).toBe('boolean')
    }
  })

  it('select fields have options defined', () => {
    const selectFields = CONFIG_REGISTRY.filter(f => f.type === 'select')
    for (const field of selectFields) {
      expect(field.options).toBeDefined()
    }
  })
})
