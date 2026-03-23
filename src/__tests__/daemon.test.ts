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

  describe('stopDaemon', () => {
    it('waits for process exit before removing PID file', async () => {
      const { writePidFile, stopDaemon, readPidFile } = await import('../core/daemon.js')
      writePidFile(pidFile, process.pid)

      let callCount = 0
      vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0) {
          callCount++
          if (callCount <= 2) return true
          const err = new Error('No such process') as NodeJS.ErrnoException
          err.code = 'ESRCH'
          throw err
        }
        if (signal === 'SIGTERM') return true
        return true
      })

      const result = await stopDaemon(pidFile)
      expect(result.stopped).toBe(true)
      expect(result.pid).toBe(process.pid)
      expect(readPidFile(pidFile)).toBeNull()

      vi.restoreAllMocks()
    })

    it('sends SIGKILL after timeout', async () => {
      vi.useFakeTimers()
      const { writePidFile, stopDaemon } = await import('../core/daemon.js')
      writePidFile(pidFile, process.pid)

      const signals: (string | number)[] = []
      let killedWithSIGKILL = false
      vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
        signals.push(signal ?? 0)
        if (signal === 'SIGKILL') {
          killedWithSIGKILL = true
          return true
        }
        if (signal === 0) {
          if (killedWithSIGKILL) {
            const err = new Error('No such process') as NodeJS.ErrnoException
            err.code = 'ESRCH'
            throw err
          }
          return true
        }
        if (signal === 'SIGTERM') return true
        return true
      })

      // Run stopDaemon and advance fake timers concurrently
      const stopPromise = stopDaemon(pidFile)
      // Advance past the 5s SIGTERM timeout and 1s SIGKILL timeout
      await vi.runAllTimersAsync()
      const result = await stopPromise
      expect(result.stopped).toBe(true)
      expect(signals).toContain('SIGKILL')

      vi.useRealTimers()
      vi.restoreAllMocks()
    }, 10000)

    it('handles EPERM on initial check (stale PID from another user)', async () => {
      const { writePidFile, stopDaemon, readPidFile } = await import('../core/daemon.js')
      writePidFile(pidFile, process.pid)

      vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0) {
          const err = new Error('Operation not permitted') as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        }
        return true
      })

      const result = await stopDaemon(pidFile)
      expect(result.stopped).toBe(false)
      expect(result.error).toContain('stale PID file removed')
      expect(readPidFile(pidFile)).toBeNull()

      vi.restoreAllMocks()
    })

    it('handles EPERM during polling (PID reuse after SIGTERM)', async () => {
      const { writePidFile, stopDaemon, readPidFile } = await import('../core/daemon.js')
      writePidFile(pidFile, process.pid)

      let callCount = 0
      vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 'SIGTERM') return true
        if (signal === 0) {
          callCount++
          if (callCount <= 1) return true // alive on first poll
          const err = new Error('Operation not permitted') as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        }
        return true
      })

      const result = await stopDaemon(pidFile)
      expect(result.stopped).toBe(true)
      expect(readPidFile(pidFile)).toBeNull()

      vi.restoreAllMocks()
    })
  })
})
