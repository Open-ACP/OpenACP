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

  describe('escapeXml', () => {
    it('escapes XML special characters', async () => {
      const { escapeXml } = await import('../core/autostart.js')
      expect(escapeXml('a & b')).toBe('a &amp; b')
      expect(escapeXml('<script>')).toBe('&lt;script&gt;')
      expect(escapeXml('"hello"')).toBe('&quot;hello&quot;')
      expect(escapeXml("it's")).toBe('it&apos;s')
      expect(escapeXml('/normal/path')).toBe('/normal/path')
    })
  })

  describe('escapeSystemdValue', () => {
    it('quotes and escapes systemd special characters', async () => {
      const { escapeSystemdValue } = await import('../core/autostart.js')
      expect(escapeSystemdValue('/usr/bin/node')).toBe('"/usr/bin/node"')
      expect(escapeSystemdValue('/path with spaces/node')).toBe('"/path with spaces/node"')
      expect(escapeSystemdValue('/path"quote')).toBe('"/path\\"quote"')
      expect(escapeSystemdValue('/path\\back')).toBe('"/path\\\\back"')
      expect(escapeSystemdValue('/path%specifier')).toBe('"/path%%specifier"')
      expect(escapeSystemdValue('/home/$USER/bin')).toBe('"/home/$$USER/bin"')
    })
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

    it('escapes special characters in paths', async () => {
      const { generateLaunchdPlist } = await import('../core/autostart.js')
      const plist = generateLaunchdPlist('/usr/bin/no<de', '/path/"cli".js', '/logs/a&b')
      expect(plist).toContain('<string>/usr/bin/no&lt;de</string>')
      expect(plist).toContain('<string>/path/&quot;cli&quot;.js</string>')
      expect(plist).toContain('<string>/logs/a&amp;b/openacp.log</string>')
      expect(plist).not.toContain('<de')
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

    it('escapes special characters in paths', async () => {
      const { generateSystemdUnit } = await import('../core/autostart.js')
      const unit = generateSystemdUnit('/usr/bin/no de', '/path/"cli".js')
      expect(unit).toContain('ExecStart="/usr/bin/no de" "/path/\\"cli\\".js" --daemon-child')
    })

    it('escapes percent specifiers', async () => {
      const { generateSystemdUnit } = await import('../core/autostart.js')
      const unit = generateSystemdUnit('/usr/bin/node', '/home/%user/cli.js')
      expect(unit).toContain('%%user')
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
