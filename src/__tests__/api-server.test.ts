import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as net from 'node:net'

describe('ApiServer', () => {
  let tmpDir: string
  let portFilePath: string
  let server: any

  const mockCore = {
    handleNewSession: vi.fn(),
    wireSessionEvents: vi.fn(),
    sessionManager: {
      getSession: vi.fn(),
      listSessions: vi.fn(() => []),
    },
    agentManager: {
      getAvailableAgents: vi.fn(() => []),
    },
    configManager: {
      get: vi.fn(() => ({
        defaultAgent: 'claude',
        security: { maxConcurrentSessions: 5 },
      })),
    },
    adapters: new Map(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-api-test-'))
    portFilePath = path.join(tmpDir, 'api.port')
  })

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function startServer(portOverride?: number) {
    const { ApiServer } = await import('../core/api-server.js')
    server = new ApiServer(mockCore as any, { port: portOverride ?? 0, host: '127.0.0.1' }, portFilePath)
    await server.start()
    return server.getPort()
  }

  function apiFetch(port: number, urlPath: string, options?: RequestInit) {
    return globalThis.fetch(`http://127.0.0.1:${port}${urlPath}`, options)
  }

  it('starts and writes port file', async () => {
    const port = await startServer()
    expect(fs.existsSync(portFilePath)).toBe(true)
    const writtenPort = parseInt(fs.readFileSync(portFilePath, 'utf-8').trim(), 10)
    expect(writtenPort).toBe(port)
  })

  it('stops and removes port file', async () => {
    await startServer()
    await server.stop()
    server = null
    expect(fs.existsSync(portFilePath)).toBe(false)
  })

  it('continues without API when port is in use (EADDRINUSE)', async () => {
    const blocker = net.createServer()
    const blockerPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        resolve((blocker.address() as net.AddressInfo).port)
      })
    })

    try {
      await startServer(blockerPort)
      expect(server.getPort()).toBe(0)
      expect(fs.existsSync(portFilePath)).toBe(false)
    } finally {
      blocker.close()
    }
  })

  it('POST /api/sessions creates a session', async () => {
    const mockAgentInstance = { onPermissionRequest: vi.fn() }
    const mockSession = { id: 'abc123', agentName: 'claude', status: 'initializing', workingDirectory: '/tmp/ws', warmup: vi.fn().mockResolvedValue(undefined), agentInstance: mockAgentInstance }
    mockCore.handleNewSession.mockResolvedValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'claude' }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.sessionId).toBe('abc123')
    expect(data.agent).toBe('claude')
    expect(data.status).toBe('initializing')
    expect(data.workspace).toBe('/tmp/ws')
    expect(mockCore.handleNewSession).toHaveBeenCalledWith('api', 'claude', undefined)
    expect(mockSession.warmup).toHaveBeenCalled()
    // Verify auto-approve permission handler was wired
    expect(mockAgentInstance.onPermissionRequest).toBeTypeOf('function')
  })

  it('POST /api/sessions with empty body uses defaults', async () => {
    const mockSession = { id: 'def456', agentName: 'claude', status: 'initializing', workingDirectory: '/tmp/ws', warmup: vi.fn().mockResolvedValue(undefined), agentInstance: { onPermissionRequest: vi.fn() } }
    mockCore.handleNewSession.mockResolvedValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(mockCore.handleNewSession).toHaveBeenCalledWith('api', undefined, undefined)
  })

  it('POST /api/sessions returns 429 when max sessions reached', async () => {
    mockCore.sessionManager.listSessions.mockReturnValueOnce([
      { status: 'active' }, { status: 'active' }, { status: 'active' },
      { status: 'active' }, { status: 'initializing' },
    ])
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions', { method: 'POST' })
    expect(res.status).toBe(429)
    const data = await res.json()
    expect(data.error).toContain('concurrent sessions')
  })

  it('DELETE /api/sessions/:id cancels a session', async () => {
    const mockSession = { id: 'abc123', cancel: vi.fn() }
    mockCore.sessionManager.getSession.mockReturnValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/abc123', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(mockSession.cancel).toHaveBeenCalled()
  })

  it('DELETE /api/sessions/:id returns 404 for unknown session', async () => {
    mockCore.sessionManager.getSession.mockReturnValueOnce(undefined)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/unknown', { method: 'DELETE' })
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain('not found')
  })

  it('GET /api/sessions returns session list', async () => {
    mockCore.sessionManager.listSessions.mockReturnValueOnce([
      { id: 'abc', agentName: 'claude', status: 'active', name: 'Fix bug', workingDirectory: '/tmp/a' },
      { id: 'def', agentName: 'codex', status: 'initializing', name: undefined, workingDirectory: '/tmp/b' },
    ])
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.sessions).toHaveLength(2)
    expect(data.sessions[0]).toEqual({ id: 'abc', agent: 'claude', status: 'active', name: 'Fix bug', workspace: '/tmp/a' })
    expect(data.sessions[1]).toEqual({ id: 'def', agent: 'codex', status: 'initializing', name: null, workspace: '/tmp/b' })
  })

  it('GET /api/agents returns agent list with default', async () => {
    mockCore.agentManager.getAvailableAgents.mockReturnValueOnce([
      { name: 'claude', command: 'claude-agent-acp', args: [] },
      { name: 'codex', command: 'codex', args: ['--acp'] },
    ])
    const port = await startServer()

    const res = await apiFetch(port, '/api/agents')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.default).toBe('claude')
    expect(data.agents).toHaveLength(2)
    expect(data.agents[0]).toEqual({ name: 'claude', command: 'claude-agent-acp', args: [] })
  })

  it('returns 404 for unknown routes', async () => {
    const port = await startServer()
    const res = await apiFetch(port, '/api/unknown')
    expect(res.status).toBe(404)
  })
})
