import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { PLUGINS_DIR } from './config.js'
import { createChildLogger } from './log.js'
const log = createChildLogger({ module: 'plugin-manager' })
import type { ChannelAdapter } from './channel.js'

export interface AdapterFactory {
  name: string
  createAdapter(core: any, config: any): ChannelAdapter
}

function ensurePluginsDir(): void {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true })
  const pkgPath = path.join(PLUGINS_DIR, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'openacp-plugins', private: true, dependencies: {} }, null, 2))
  }
}

export function installPlugin(packageName: string): void {
  ensurePluginsDir()
  log.info({ packageName }, 'Installing plugin')
  execSync(`npm install ${packageName} --prefix "${PLUGINS_DIR}"`, { stdio: 'inherit' })
  log.info({ packageName }, 'Plugin installed successfully')
}

export function uninstallPlugin(packageName: string): void {
  ensurePluginsDir()
  log.info({ packageName }, 'Uninstalling plugin')
  execSync(`npm uninstall ${packageName} --prefix "${PLUGINS_DIR}"`, { stdio: 'inherit' })
  log.info({ packageName }, 'Plugin uninstalled')
}

export function listPlugins(): Record<string, string> {
  const pkgPath = path.join(PLUGINS_DIR, 'package.json')
  if (!fs.existsSync(pkgPath)) return {}
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  return pkg.dependencies || {}
}

export async function loadAdapterFactory(packageName: string): Promise<AdapterFactory | null> {
  try {
    const require = createRequire(path.join(PLUGINS_DIR, 'package.json'))
    const resolved = require.resolve(packageName)
    const mod = await import(resolved)

    // Plugin must export `adapterFactory` or default export conforming to AdapterFactory
    const factory: AdapterFactory | undefined = mod.adapterFactory || mod.default
    if (!factory || typeof factory.createAdapter !== 'function') {
      log.error({ packageName }, 'Plugin does not export a valid AdapterFactory (needs .createAdapter())')
      return null
    }
    return factory
  } catch (err) {
    log.error({ packageName, err }, 'Failed to load plugin')
    log.error({ packageName }, 'Run: npx openacp install <packageName>')
    return null
  }
}
