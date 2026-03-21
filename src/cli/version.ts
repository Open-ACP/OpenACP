import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const NPM_PACKAGE = '@openacp/cli'

function findPackageJson(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function getCurrentVersion(): string {
  try {
    const pkgPath = findPackageJson()
    if (!pkgPath) return '0.0.0-dev'
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version as string
  } catch {
    return '0.0.0-dev'
  }
}

export async function getLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { version?: string }
    return data.version ?? null
  } catch {
    return null
  }
}

export function compareVersions(current: string, latest: string): -1 | 0 | 1 {
  const a = current.split('.').map(Number)
  const b = latest.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return -1
    if ((a[i] ?? 0) > (b[i] ?? 0)) return 1
  }
  return 0
}

export async function runUpdate(): Promise<boolean> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', `${NPM_PACKAGE}@latest`], {
      stdio: 'inherit',
      shell: true,
    })
    const onSignal = () => {
      child.kill('SIGTERM')
      resolve(false)
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    child.on('close', (code) => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      resolve(code === 0)
    })
  })
}

export async function checkAndPromptUpdate(): Promise<void> {
  if (process.env.OPENACP_DEV_LOOP) return

  const current = getCurrentVersion()
  if (current === '0.0.0-dev') return

  const latest = await getLatestVersion()
  if (!latest || compareVersions(current, latest) >= 0) return

  console.log(`\x1b[33mUpdate available: v${current} → v${latest}\x1b[0m`)
  const { confirm } = await import('@inquirer/prompts')
  const yes = await confirm({
    message: 'Update now before starting?',
    default: true,
  })
  if (yes) {
    const ok = await runUpdate()
    if (ok) {
      console.log(`\x1b[32m✓ Updated to v${latest}. Please re-run your command.\x1b[0m`)
      process.exit(0)
    } else {
      console.error('\x1b[31mUpdate failed. Continuing with current version.\x1b[0m')
    }
  }
}
