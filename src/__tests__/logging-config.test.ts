import { describe, it, expect } from 'vitest'
import { ConfigSchema } from '../core/config.js'

describe('logging config schema', () => {
  const baseConfig = {
    channels: {},
    agents: { claude: { command: 'claude' } },
    defaultAgent: 'claude',
  }

  it('provides defaults when logging key is absent', () => {
    const result = ConfigSchema.parse(baseConfig)
    expect(result.logging).toEqual({
      level: 'info',
      logDir: '~/.openacp/logs',
      maxFileSize: '10m',
      maxFiles: 7,
      sessionLogRetentionDays: 30,
    })
  })

  it('allows partial logging overrides', () => {
    const result = ConfigSchema.parse({
      ...baseConfig,
      logging: { level: 'debug', maxFiles: 3 },
    })
    expect(result.logging.level).toBe('debug')
    expect(result.logging.maxFiles).toBe(3)
    expect(result.logging.logDir).toBe('~/.openacp/logs')
  })

  it('accepts silent level for testing', () => {
    const result = ConfigSchema.parse({
      ...baseConfig,
      logging: { level: 'silent' },
    })
    expect(result.logging.level).toBe('silent')
  })

  it('rejects invalid log level', () => {
    expect(() =>
      ConfigSchema.parse({
        ...baseConfig,
        logging: { level: 'verbose' },
      })
    ).toThrow()
  })

  it('accepts numeric maxFileSize', () => {
    const result = ConfigSchema.parse({
      ...baseConfig,
      logging: { maxFileSize: 10485760 },
    })
    expect(result.logging.maxFileSize).toBe(10485760)
  })
})
