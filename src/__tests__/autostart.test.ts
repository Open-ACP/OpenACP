import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

vi.mock('../core/log.js', () => ({
  createChildLogger: () => ({
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  }),
}))

describe('autostart', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-autostart-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('generateLaunchdPlist', () => {
    it('generates valid plist with absolute paths', async () => {
      const { generateLaunchdPlist } = await import('../core/autostart.js')
      const plist = generateLaunchdPlist('/usr/local/bin/node', '/usr/local/lib/cli.js', '/Users/test/.openacp/logs')
      expect(plist).toContain('/usr/local/bin/node')
      expect(plist).toContain('/usr/local/lib/cli.js')
      expect(plist).toContain('--daemon-child')
      expect(plist).toContain('com.openacp.daemon')
      expect(plist).not.toContain('~')
    })
  })

  describe('generateSystemdUnit', () => {
    it('generates valid unit file with absolute paths', async () => {
      const { generateSystemdUnit } = await import('../core/autostart.js')
      const unit = generateSystemdUnit('/usr/bin/node', '/usr/lib/cli.js')
      expect(unit).toContain('/usr/bin/node')
      expect(unit).toContain('/usr/lib/cli.js')
      expect(unit).toContain('--daemon-child')
      expect(unit).toContain('Restart=on-failure')
    })
  })

  describe('isAutoStartSupported', () => {
    it('returns true on darwin', async () => {
      const { isAutoStartSupported } = await import('../core/autostart.js')
      const supported = isAutoStartSupported()
      if (process.platform === 'darwin' || process.platform === 'linux') {
        expect(supported).toBe(true)
      } else {
        expect(supported).toBe(false)
      }
    })
  })
})
