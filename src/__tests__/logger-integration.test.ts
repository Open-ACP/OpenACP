import { describe, it, expect, afterEach } from 'vitest'
import { initLogger, shutdownLogger, createChildLogger, createSessionLogger, cleanupOldSessionLogs, log } from '../core/log.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('logger integration', () => {
  let tmpDir: string

  afterEach(async () => {
    await shutdownLogger()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('full lifecycle: init → child → session → cleanup → shutdown', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-int-'))
    const logDir = path.join(tmpDir, 'logs')

    // 1. Init
    initLogger({ level: 'debug', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    // 2. Module child logger
    const coreLog = createChildLogger({ module: 'core' })
    coreLog.info('core started')

    // 3. Session logger
    const sessionLog = createSessionLogger('integration-sess', coreLog)
    sessionLog.info({ promptLength: 42 }, 'Prompt queued')
    sessionLog.warn('something iffy')
    sessionLog.error({ err: new Error('test error') }, 'Prompt failed')

    // 4. Wait for flush (pino transports run in worker threads, need time to flush)
    await new Promise(r => setTimeout(r, 600))

    // 5. Verify combined log
    const combinedFile = fs.readdirSync(logDir).find(f => f.startsWith('openacp'))
    expect(combinedFile).toBeDefined()
    const combined = fs.readFileSync(path.join(logDir, combinedFile!), 'utf-8')
    expect(combined).toContain('core started')
    expect(combined).toContain('Prompt queued')
    expect(combined).toContain('Prompt failed')

    // 6. Verify session log
    const sessionFile = path.join(logDir, 'sessions', 'integration-sess.log')
    expect(fs.existsSync(sessionFile)).toBe(true)
    const sessionContent = fs.readFileSync(sessionFile, 'utf-8')
    expect(sessionContent).toContain('Prompt queued')
    expect(sessionContent).toContain('integration-sess')

    // 7. Cleanup (should not delete fresh file)
    await cleanupOldSessionLogs(30)
    expect(fs.existsSync(sessionFile)).toBe(true)

    // 8. Shutdown
    await shutdownLogger()
  })

  it('gracefully degrades if log dir is not writable', () => {
    // /dev/null/subdir cannot be created on any platform
    expect(() => {
      initLogger({ level: 'info', logDir: '/dev/null/openacp-test-log', maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })
    }).not.toThrow()
  })
})
