import { describe, it, expect } from 'vitest'
import { applyMigrations } from '../config-migrations.js'

describe('Config Migrations', () => {
  describe('migration: add tunnel section', () => {
    it('adds tunnel with defaults when missing', () => {
      const raw: Record<string, unknown> = { channels: {}, agents: {}, defaultAgent: 'claude' }
      applyMigrations(raw)

      expect(raw.tunnel).toEqual({
        enabled: true,
        port: 3100,
        provider: 'cloudflare',
        options: {},
        storeTtlMinutes: 60,
        auth: { enabled: false },
      })
    })

    it('does not overwrite existing tunnel config', () => {
      const tunnel = { enabled: false, port: 9999, provider: 'ngrok', options: {}, storeTtlMinutes: 30, auth: { enabled: true } }
      const raw: Record<string, unknown> = {
        channels: {},
        agents: {},
        defaultAgent: 'claude',
        tunnel,
      }
      applyMigrations(raw)

      expect(raw.tunnel).toEqual(tunnel)
    })
  })

  describe('migration: fix agent commands', () => {
    it('migrates "claude" command to "claude-agent-acp"', () => {
      const raw: Record<string, unknown> = {
        channels: {},
        agents: { claude: { command: 'claude', args: [] } },
        defaultAgent: 'claude',
      }
      applyMigrations(raw)

      expect((raw.agents as any).claude.command).toBe('claude-agent-acp')
    })

    it('migrates "claude-code" command to "claude-agent-acp"', () => {
      const raw: Record<string, unknown> = {
        channels: {},
        agents: { claude: { command: 'claude-code', args: [] } },
        defaultAgent: 'claude',
      }
      applyMigrations(raw)

      expect((raw.agents as any).claude.command).toBe('claude-agent-acp')
    })

    it('leaves "claude-agent-acp" untouched', () => {
      const raw: Record<string, unknown> = {
        channels: {},
        agents: { claude: { command: 'claude-agent-acp', args: [] } },
        defaultAgent: 'claude',
      }
      applyMigrations(raw)

      expect((raw.agents as any).claude.command).toBe('claude-agent-acp')
    })

    it('does not touch non-claude agents', () => {
      const raw: Record<string, unknown> = {
        channels: {},
        agents: { codex: { command: 'codex', args: ['--acp'] } },
        defaultAgent: 'codex',
      }
      applyMigrations(raw)

      expect((raw.agents as any).codex.command).toBe('codex')
    })
  })

  describe('applyMigrations', () => {
    it('applies all migrations and mutates config in place', () => {
      const raw: Record<string, unknown> = {
        channels: {},
        agents: { claude: { command: 'claude', args: [] } },
        defaultAgent: 'claude',
      }
      const { changed } = applyMigrations(raw)

      expect(changed).toBe(true)
      expect(raw.tunnel).toBeDefined()
      expect((raw.agents as any).claude.command).toBe('claude-agent-acp')
    })

    it('returns changed=false when no migrations needed', () => {
      const raw: Record<string, unknown> = {
        channels: {},
        agents: { claude: { command: 'claude-agent-acp', args: [] } },
        defaultAgent: 'claude',
        tunnel: { enabled: true, port: 3100, provider: 'cloudflare', options: {}, storeTtlMinutes: 60, auth: { enabled: false } },
      }
      const { changed } = applyMigrations(raw)

      expect(changed).toBe(false)
    })

    it('does not pollute config with changed property', () => {
      const raw: Record<string, unknown> = {
        channels: {},
        agents: { claude: { command: 'claude', args: [] } },
        defaultAgent: 'claude',
      }
      applyMigrations(raw)

      expect(raw).not.toHaveProperty('changed')
    })
  })
})
