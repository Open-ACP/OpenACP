import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Mock child_process before importing daemon
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
  })),
}))

describe('daemon', () => {
  let tmpDir: string
  let pidFile: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-daemon-test-'))
    pidFile = path.join(tmpDir, 'openacp.pid')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('isProcessRunning', () => {
    it('returns false when PID file does not exist', async () => {
      const { isProcessRunning } = await import('../core/daemon.js')
      expect(isProcessRunning(pidFile)).toBe(false)
    })

    it('returns false for stale PID file', async () => {
      fs.writeFileSync(pidFile, '999999999') // unlikely to be a real process
      const { isProcessRunning } = await import('../core/daemon.js')
      expect(isProcessRunning(pidFile)).toBe(false)
    })
  })

  describe('writePidFile / removePidFile', () => {
    it('writes and reads PID', async () => {
      const { writePidFile, readPidFile } = await import('../core/daemon.js')
      writePidFile(pidFile, 42)
      expect(readPidFile(pidFile)).toBe(42)
    })

    it('removePidFile deletes the file', async () => {
      const { writePidFile, removePidFile } = await import('../core/daemon.js')
      writePidFile(pidFile, 42)
      removePidFile(pidFile)
      expect(fs.existsSync(pidFile)).toBe(false)
    })
  })

  describe('getStatus', () => {
    it('returns stopped when no PID file', async () => {
      const { getStatus } = await import('../core/daemon.js')
      expect(getStatus(pidFile)).toEqual({ running: false })
    })
  })
})
