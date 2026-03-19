import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initLogger, shutdownLogger, createChildLogger, createSessionLogger } from '../core/log.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('session logger', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-session-log-'))
  })

  afterEach(async () => {
    await shutdownLogger()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a session log file', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'info', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    const parentLog = createChildLogger({ module: 'session' })
    const sessionLog = createSessionLogger('test-session-123', parentLog)
    sessionLog.info('session started')

    await new Promise(r => setTimeout(r, 200))

    const sessionFile = path.join(logDir, 'sessions', 'test-session-123.log')
    expect(fs.existsSync(sessionFile)).toBe(true)

    const content = fs.readFileSync(sessionFile, 'utf-8')
    expect(content).toContain('session started')
  })

  it('session log includes sessionId in context', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'debug', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    const parentLog = createChildLogger({ module: 'session' })
    const sessionLog = createSessionLogger('abc123', parentLog)
    sessionLog.info('prompt queued')

    await new Promise(r => setTimeout(r, 200))

    const sessionFile = path.join(logDir, 'sessions', 'abc123.log')
    const content = fs.readFileSync(sessionFile, 'utf-8')
    const entry = JSON.parse(content.trim().split('\n')[0])
    expect(entry.sessionId).toBe('abc123')
  })

  it('also writes to combined log', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'info', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    const parentLog = createChildLogger({ module: 'session' })
    const sessionLog = createSessionLogger('dual-write-test', parentLog)
    sessionLog.info('dual write message')

    await new Promise(r => setTimeout(r, 200))

    const combinedFile = fs.readdirSync(logDir).find(f => f.startsWith('openacp'))
    if (combinedFile) {
      const content = fs.readFileSync(path.join(logDir, combinedFile), 'utf-8')
      expect(content).toContain('dual write message')
    }
  })
})
