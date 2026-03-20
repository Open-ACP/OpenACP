import pino from 'pino'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { LoggingConfig } from './config.js'

export type Logger = pino.Logger

// --- Default console-only logger (pre-init) ---
let rootLogger: pino.Logger = pino({
  level: 'debug',
  transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
})
let initialized = false
let logDir: string | undefined
let currentTransport: ReturnType<typeof pino.transport> | undefined

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

// --- Variadic wrapper for backward compatibility ---
function wrapVariadic(logger: pino.Logger) {
  return {
    info: (...args: unknown[]) => {
      if (args.length === 0) return
      if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
        logger.info(args[0] as object, args.slice(1).join(' '))
      } else {
        logger.info(args.map(String).join(' '))
      }
    },
    warn: (...args: unknown[]) => {
      if (args.length === 0) return
      if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
        logger.warn(args[0] as object, args.slice(1).join(' '))
      } else {
        logger.warn(args.map(String).join(' '))
      }
    },
    error: (...args: unknown[]) => {
      if (args.length === 0) return
      if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
        logger.error(args[0] as object, args.slice(1).join(' '))
      } else {
        logger.error(args.map(String).join(' '))
      }
    },
    debug: (...args: unknown[]) => {
      if (args.length === 0) return
      if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
        logger.debug(args[0] as object, args.slice(1).join(' '))
      } else {
        logger.debug(args.map(String).join(' '))
      }
    },
    fatal: (...args: unknown[]) => {
      if (args.length === 0) return
      if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
        logger.fatal(args[0] as object, args.slice(1).join(' '))
      } else {
        logger.fatal(args.map(String).join(' '))
      }
    },
    child: (bindings: pino.Bindings) => logger.child(bindings),
  }
}

export const log = wrapVariadic(rootLogger)

// --- Public API ---

export function initLogger(config: LoggingConfig): Logger {
  if (initialized) return rootLogger

  const resolvedLogDir = expandHome(config.logDir)
  logDir = resolvedLogDir

  try {
    fs.mkdirSync(resolvedLogDir, { recursive: true })
    fs.mkdirSync(path.join(resolvedLogDir, 'sessions'), { recursive: true })
  } catch (err) {
    console.error(`[WARN] Failed to create log directory ${resolvedLogDir}, falling back to console-only:`, err)
    return rootLogger
  }

  const transports = pino.transport({
    targets: [
      {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
        level: config.level,
      },
      {
        target: 'pino-roll',
        options: {
          file: path.join(resolvedLogDir, 'openacp.log'),
          size: config.maxFileSize,
          limit: { count: config.maxFiles },
        },
        level: config.level,
      },
    ],
  })

  currentTransport = transports
  rootLogger = pino({ level: config.level }, transports)
  initialized = true

  // Update the default log wrapper to use the new root logger
  Object.assign(log, wrapVariadic(rootLogger))

  return rootLogger
}

export function createChildLogger(context: { module: string; [key: string]: unknown }): Logger {
  // Return a proxy that always delegates to the current rootLogger.
  // This ensures child loggers created at module-level (before initLogger)
  // pick up the initialized logger with pino-pretty transport.
  return new Proxy({} as Logger, {
    get(_target, prop, receiver) {
      const child = rootLogger.child(context)
      const value = Reflect.get(child, prop, receiver)
      return typeof value === 'function' ? value.bind(child) : value
    },
  })
}

export function createSessionLogger(sessionId: string, parentLogger: Logger): Logger {
  const sessionLogDir = logDir ? path.join(logDir, 'sessions') : undefined
  if (!sessionLogDir) {
    return parentLogger.child({ sessionId })
  }

  try {
    const sessionLogPath = path.join(sessionLogDir, `${sessionId}.log`)
    const dest = pino.destination(sessionLogPath)
    const sessionFileLogger = pino({ level: parentLogger.level }, dest).child({ sessionId })

    // Create a logger that writes to both parent (combined) and session file
    const combinedChild = parentLogger.child({ sessionId })
    const originalInfo = combinedChild.info.bind(combinedChild)
    const originalWarn = combinedChild.warn.bind(combinedChild)
    const originalError = combinedChild.error.bind(combinedChild)
    const originalDebug = combinedChild.debug.bind(combinedChild)
    const originalFatal = combinedChild.fatal.bind(combinedChild)

    // Proxy log methods to write to both destinations
    combinedChild.info = ((objOrMsg: any, ...rest: any[]) => {
      sessionFileLogger.info(objOrMsg, ...rest)
      return originalInfo(objOrMsg, ...rest)
    }) as any
    combinedChild.warn = ((objOrMsg: any, ...rest: any[]) => {
      sessionFileLogger.warn(objOrMsg, ...rest)
      return originalWarn(objOrMsg, ...rest)
    }) as any
    combinedChild.error = ((objOrMsg: any, ...rest: any[]) => {
      sessionFileLogger.error(objOrMsg, ...rest)
      return originalError(objOrMsg, ...rest)
    }) as any
    combinedChild.debug = ((objOrMsg: any, ...rest: any[]) => {
      sessionFileLogger.debug(objOrMsg, ...rest)
      return originalDebug(objOrMsg, ...rest)
    }) as any
    combinedChild.fatal = ((objOrMsg: any, ...rest: any[]) => {
      sessionFileLogger.fatal(objOrMsg, ...rest)
      return originalFatal(objOrMsg, ...rest)
    }) as any

    // Store dest for cleanup
    ;(combinedChild as any).__sessionDest = dest

    return combinedChild
  } catch (err) {
    // Graceful degradation: session file failed, just use combined log
    parentLogger.warn({ sessionId, err }, 'Failed to create session log file, using combined log only')
    return parentLogger.child({ sessionId })
  }
}

export async function shutdownLogger(): Promise<void> {
  if (!initialized) return

  const transport = currentTransport

  // Reset state immediately so re-init is possible
  rootLogger = pino({ level: 'debug' })
  Object.assign(log, wrapVariadic(rootLogger))
  currentTransport = undefined
  logDir = undefined
  initialized = false

  if (transport) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000)
      transport.on('close', () => {
        clearTimeout(timeout)
        resolve()
      })
      transport.end()
    })
  }
}

export async function cleanupOldSessionLogs(retentionDays: number): Promise<void> {
  if (!logDir) return

  const sessionsDir = path.join(logDir, 'sessions')
  try {
    const files = await fs.promises.readdir(sessionsDir)
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

    for (const file of files) {
      try {
        const filePath = path.join(sessionsDir, file)
        const stat = await fs.promises.stat(filePath)
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath)
          rootLogger.debug({ file }, 'Deleted old session log')
        }
      } catch (err) {
        rootLogger.warn({ file, err }, 'Failed to delete old session log')
      }
    }
  } catch {
    // Sessions directory doesn't exist — no-op
  }
}
