import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createChildLogger } from './log.js'

const log = createChildLogger({ module: 'autostart' })

const LAUNCHD_LABEL = 'com.openacp.daemon'
const LAUNCHD_PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
const SYSTEMD_SERVICE_PATH = path.join(os.homedir(), '.config', 'systemd', 'user', 'openacp.service')

export function isAutoStartSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux'
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function escapeSystemdValue(str: string): string {
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '$$$$')
    .replace(/%/g, '%%')
  return `"${escaped}"`
}

export function generateLaunchdPlist(nodePath: string, cliPath: string, logDir: string): string {
  const logFile = path.join(logDir, 'openacp.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(cliPath)}</string>
    <string>--daemon-child</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`
}

export function generateSystemdUnit(nodePath: string, cliPath: string): string {
  return `[Unit]
Description=OpenACP Daemon

[Service]
ExecStart=${escapeSystemdValue(nodePath)} ${escapeSystemdValue(cliPath)} --daemon-child
Restart=on-failure

[Install]
WantedBy=default.target
`
}

export function installAutoStart(logDir: string): { success: boolean; error?: string } {
  if (!isAutoStartSupported()) {
    return { success: false, error: 'Auto-start not supported on this platform' }
  }

  const nodePath = process.execPath
  const cliPath = path.resolve(process.argv[1])
  const resolvedLogDir = logDir.startsWith('~')
    ? path.join(os.homedir(), logDir.slice(1))
    : logDir

  try {
    if (process.platform === 'darwin') {
      const plist = generateLaunchdPlist(nodePath, cliPath, resolvedLogDir)
      const dir = path.dirname(LAUNCHD_PLIST_PATH)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(LAUNCHD_PLIST_PATH, plist)
      execFileSync('launchctl', ['load', LAUNCHD_PLIST_PATH], { stdio: 'pipe' })
      log.info('LaunchAgent installed')
      return { success: true }
    }

    if (process.platform === 'linux') {
      const unit = generateSystemdUnit(nodePath, cliPath)
      const dir = path.dirname(SYSTEMD_SERVICE_PATH)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(SYSTEMD_SERVICE_PATH, unit)
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' })
      execFileSync('systemctl', ['--user', 'enable', 'openacp'], { stdio: 'pipe' })
      log.info('systemd user service installed')
      return { success: true }
    }

    return { success: false, error: 'Unsupported platform' }
  } catch (e) {
    const msg = (e as Error).message
    log.error({ err: msg }, 'Failed to install auto-start')
    return { success: false, error: msg }
  }
}

export function uninstallAutoStart(): { success: boolean; error?: string } {
  if (!isAutoStartSupported()) {
    return { success: false, error: 'Auto-start not supported on this platform' }
  }

  try {
    if (process.platform === 'darwin') {
      if (fs.existsSync(LAUNCHD_PLIST_PATH)) {
        try {
          execFileSync('launchctl', ['unload', LAUNCHD_PLIST_PATH], { stdio: 'pipe' })
        } catch {
          // may already be unloaded
        }
        fs.unlinkSync(LAUNCHD_PLIST_PATH)
        log.info('LaunchAgent removed')
      }
      return { success: true }
    }

    if (process.platform === 'linux') {
      if (fs.existsSync(SYSTEMD_SERVICE_PATH)) {
        try {
          execFileSync('systemctl', ['--user', 'disable', 'openacp'], { stdio: 'pipe' })
        } catch {
          // may already be disabled
        }
        fs.unlinkSync(SYSTEMD_SERVICE_PATH)
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' })
        log.info('systemd user service removed')
      }
      return { success: true }
    }

    return { success: false, error: 'Unsupported platform' }
  } catch (e) {
    const msg = (e as Error).message
    log.error({ err: msg }, 'Failed to uninstall auto-start')
    return { success: false, error: msg }
  }
}

export function isAutoStartInstalled(): boolean {
  if (process.platform === 'darwin') {
    return fs.existsSync(LAUNCHD_PLIST_PATH)
  }
  if (process.platform === 'linux') {
    return fs.existsSync(SYSTEMD_SERVICE_PATH)
  }
  return false
}
