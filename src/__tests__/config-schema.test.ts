import { describe, it, expect } from 'vitest'
import { ConfigSchema } from '../core/config.js'

describe('ConfigSchema - runMode and autoStart', () => {
  const baseConfig = {
    channels: { telegram: { enabled: false } },
    agents: { claude: { command: 'claude-agent-acp', args: [], env: {} } },
    defaultAgent: 'claude',
  }

  it('defaults runMode to foreground', () => {
    const result = ConfigSchema.parse(baseConfig)
    expect(result.runMode).toBe('foreground')
  })

  it('defaults autoStart to false', () => {
    const result = ConfigSchema.parse(baseConfig)
    expect(result.autoStart).toBe(false)
  })

  it('accepts runMode daemon', () => {
    const result = ConfigSchema.parse({ ...baseConfig, runMode: 'daemon' })
    expect(result.runMode).toBe('daemon')
  })

  it('accepts autoStart true', () => {
    const result = ConfigSchema.parse({ ...baseConfig, autoStart: true })
    expect(result.autoStart).toBe(true)
  })

  it('rejects invalid runMode', () => {
    expect(() => ConfigSchema.parse({ ...baseConfig, runMode: 'invalid' })).toThrow()
  })
})

describe('ConfigSchema - api', () => {
  const baseConfig = {
    channels: { telegram: { enabled: false } },
    agents: { claude: { command: 'claude-agent-acp', args: [], env: {} } },
    defaultAgent: 'claude',
  }

  it('defaults api.port to 21420 and api.host to 127.0.0.1', () => {
    const result = ConfigSchema.parse(baseConfig)
    expect(result.api.port).toBe(21420)
    expect(result.api.host).toBe('127.0.0.1')
  })

  it('accepts custom api port', () => {
    const result = ConfigSchema.parse({ ...baseConfig, api: { port: 9999 } })
    expect(result.api.port).toBe(9999)
    expect(result.api.host).toBe('127.0.0.1')
  })
})
