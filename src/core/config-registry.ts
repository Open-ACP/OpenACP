import type { Config } from './config.js'

export interface ConfigFieldDef {
  path: string
  displayName: string
  group: string
  type: 'toggle' | 'select' | 'number' | 'string'
  options?: string[] | ((config: Config) => string[])
  scope: 'safe' | 'sensitive'
  hotReload: boolean
}

export const CONFIG_REGISTRY: ConfigFieldDef[] = [
  {
    path: 'defaultAgent',
    displayName: 'Default Agent',
    group: 'agent',
    type: 'select',
    options: (config) => Object.keys(config.agents),
    scope: 'safe',
    hotReload: true,
  },
  {
    path: 'logging.level',
    displayName: 'Log Level',
    group: 'logging',
    type: 'select',
    options: ['silent', 'debug', 'info', 'warn', 'error', 'fatal'],
    scope: 'safe',
    hotReload: true,
  },
  {
    path: 'tunnel.enabled',
    displayName: 'Tunnel',
    group: 'tunnel',
    type: 'toggle',
    scope: 'safe',
    hotReload: false,
  },
  {
    path: 'security.maxConcurrentSessions',
    displayName: 'Max Concurrent Sessions',
    group: 'security',
    type: 'number',
    scope: 'safe',
    hotReload: true,
  },
  {
    path: 'security.sessionTimeoutMinutes',
    displayName: 'Session Timeout (min)',
    group: 'security',
    type: 'number',
    scope: 'safe',
    hotReload: true,
  },
  {
    path: 'workspace.baseDir',
    displayName: 'Workspace Directory',
    group: 'workspace',
    type: 'string',
    scope: 'safe',
    hotReload: true,
  },
  {
    path: 'sessionStore.ttlDays',
    displayName: 'Session Store TTL (days)',
    group: 'storage',
    type: 'number',
    scope: 'safe',
    hotReload: true,
  },
]

export function getFieldDef(path: string): ConfigFieldDef | undefined {
  return CONFIG_REGISTRY.find((f) => f.path === path)
}

export function getSafeFields(): ConfigFieldDef[] {
  return CONFIG_REGISTRY.filter((f) => f.scope === 'safe')
}

export function isHotReloadable(path: string): boolean {
  const def = getFieldDef(path)
  return def?.hotReload ?? false
}

export function resolveOptions(def: ConfigFieldDef, config: Config): string[] | undefined {
  if (!def.options) return undefined
  return typeof def.options === 'function' ? def.options(config) : def.options
}

export function getConfigValue(config: Config, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = config
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}
