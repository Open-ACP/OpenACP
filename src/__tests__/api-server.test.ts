import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as net from 'node:net'

describe('ApiServer', () => {
  let tmpDir: string
  let portFilePath: string
  let server: any

  const mockTopicManager = {
    listTopics: vi.fn(() => []),
    deleteTopic: vi.fn(),
    cleanup: vi.fn(),
  }

  const mockCore = {
    handleNewSession: vi.fn(),
    wireSessionEvents: vi.fn(),
    sessionManager: {
      getSession: vi.fn(),
      listSessions: vi.fn(() => []),
      listRecords: vi.fn(() => []),
      updateSessionDangerousMode: vi.fn(),
    },
    agentManager: {
      getAvailableAgents: vi.fn(() => []),
    },
    configManager: {
      get: vi.fn(() => ({
        defaultAgent: 'claude',
        security: { maxConcurrentSessions: 5 },
        channels: { telegram: { botToken: 'secret-token' } },
      })),
      save: vi.fn(),
    },
    adapters: new Map(),
    notificationManager: { notifyAll: vi.fn() },
    requestRestart: vi.fn(),
    tunnelService: undefined as any,
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
    server = new ApiServer(mockCore as any, { port: portOverride ?? 0, host: '127.0.0.1' }, portFilePath, mockTopicManager as any)
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
    expect(data.agents[0]).toEqual({ name: 'claude', command: 'claude-agent-acp', args: [], capabilities: { supportsResume: true } })
  })

  it('returns 404 for unknown routes', async () => {
    const port = await startServer()
    const res = await apiFetch(port, '/api/unknown')
    expect(res.status).toBe(404)
  })

  it('GET /api/topics returns topic list', async () => {
    mockTopicManager.listTopics.mockReturnValueOnce([
      { sessionId: 'abc', topicId: 42, name: 'Fix bug', status: 'finished', agentName: 'claude', lastActiveAt: '2026-03-21' },
    ])
    const port = await startServer()

    const res = await apiFetch(port, '/api/topics')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.topics).toHaveLength(1)
    expect(data.topics[0].sessionId).toBe('abc')
  })

  it('GET /api/topics filters by status', async () => {
    mockTopicManager.listTopics.mockReturnValueOnce([])
    const port = await startServer()

    await apiFetch(port, '/api/topics?status=finished,error')
    expect(mockTopicManager.listTopics).toHaveBeenCalledWith({ statuses: ['finished', 'error'] })
  })

  it('DELETE /api/topics/:sessionId deletes topic', async () => {
    mockTopicManager.deleteTopic.mockResolvedValueOnce({ ok: true, topicId: 42 })
    const port = await startServer()

    const res = await apiFetch(port, '/api/topics/abc123', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.topicId).toBe(42)
  })

  it('DELETE /api/topics/:sessionId returns 409 for active session', async () => {
    mockTopicManager.deleteTopic.mockResolvedValueOnce({
      ok: false, needsConfirmation: true,
      session: { id: 'abc', name: 'Task', status: 'active' },
    })
    const port = await startServer()

    const res = await apiFetch(port, '/api/topics/abc', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.needsConfirmation).toBe(true)
  })

  it('DELETE /api/topics/:sessionId with force=true deletes active session', async () => {
    mockTopicManager.deleteTopic.mockResolvedValueOnce({ ok: true, topicId: 42 })
    const port = await startServer()

    const res = await apiFetch(port, '/api/topics/abc?force=true', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(mockTopicManager.deleteTopic).toHaveBeenCalledWith('abc', { confirmed: true })
  })

  it('DELETE /api/topics/:sessionId returns 403 for system topic', async () => {
    mockTopicManager.deleteTopic.mockResolvedValueOnce({ ok: false, error: 'Cannot delete system topic' })
    const port = await startServer()

    const res = await apiFetch(port, '/api/topics/sys', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('POST /api/topics/cleanup cleans up topics', async () => {
    mockTopicManager.cleanup.mockResolvedValueOnce({ deleted: ['a', 'b'], failed: [] })
    const port = await startServer()

    const res = await apiFetch(port, '/api/topics/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statuses: ['finished', 'error'] }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.deleted).toEqual(['a', 'b'])
    expect(data.failed).toHaveLength(0)
  })

  // ===== New endpoint tests =====

  it('GET /api/health returns system health', async () => {
    mockCore.sessionManager.listSessions.mockReturnValueOnce([
      { status: 'active' },
      { status: 'initializing' },
      { status: 'finished' },
    ])
    mockCore.sessionManager.listRecords.mockReturnValueOnce([
      { sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }, { sessionId: 'd' },
    ])
    const port = await startServer()

    const res = await apiFetch(port, '/api/health')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('ok')
    expect(data.version).toBeDefined()
    expect(typeof data.uptime).toBe('number')
    expect(data.memory.rss).toBeGreaterThan(0)
    expect(data.memory.heapUsed).toBeGreaterThan(0)
    expect(data.memory.heapTotal).toBeGreaterThan(0)
    expect(data.sessions.active).toBe(2)
    expect(data.sessions.total).toBe(4)
    expect(data.tunnel.enabled).toBe(false)
  })

  it('GET /api/version returns version', async () => {
    const port = await startServer()

    const res = await apiFetch(port, '/api/version')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.version).toBeDefined()
    expect(typeof data.version).toBe('string')
  })

  it('GET /api/adapters returns adapter list', async () => {
    mockCore.adapters.set('telegram', { name: 'telegram' })
    const port = await startServer()

    const res = await apiFetch(port, '/api/adapters')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.adapters).toEqual([{ name: 'telegram', type: 'built-in' }])

    // Cleanup
    mockCore.adapters.delete('telegram')
  })

  it('GET /api/tunnel returns tunnel disabled when no tunnel', async () => {
    mockCore.tunnelService = undefined
    const port = await startServer()

    const res = await apiFetch(port, '/api/tunnel')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.enabled).toBe(false)
  })

  it('GET /api/config returns redacted config', async () => {
    const port = await startServer()

    const res = await apiFetch(port, '/api/config')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.config).toBeDefined()
    expect(data.config.channels.telegram.botToken).toBe('***')
    expect(data.config.defaultAgent).toBe('claude')
  })

  it('POST /api/sessions/:id/prompt sends prompt to session', async () => {
    const mockSession = {
      id: 'abc123',
      status: 'active',
      queueDepth: 0,
      enqueuePrompt: vi.fn().mockResolvedValue(undefined),
    }
    mockCore.sessionManager.getSession.mockReturnValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/abc123/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Hello world' }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.sessionId).toBe('abc123')
    expect(mockSession.enqueuePrompt).toHaveBeenCalledWith('Hello world')
  })

  it('POST /api/sessions/:id/prompt returns 404 for unknown session', async () => {
    mockCore.sessionManager.getSession.mockReturnValueOnce(undefined)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/unknown/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Hello' }),
    })

    expect(res.status).toBe(404)
  })

  it('POST /api/sessions/:id/prompt returns 400 for inactive session', async () => {
    const mockSession = { id: 'abc123', status: 'cancelled' }
    mockCore.sessionManager.getSession.mockReturnValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/abc123/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Hello' }),
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('cancelled')
  })

  it('POST /api/sessions/:id/prompt returns 400 for missing prompt', async () => {
    const mockSession = { id: 'abc123', status: 'active' }
    mockCore.sessionManager.getSession.mockReturnValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/abc123/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Missing prompt')
  })

  it('GET /api/sessions/:id returns full session details', async () => {
    const createdAt = new Date('2026-03-21T10:00:00Z')
    const mockSession = {
      id: 'abc123',
      agentName: 'claude',
      status: 'active',
      name: 'Fix bug',
      workingDirectory: '/tmp/ws',
      createdAt,
      dangerousMode: false,
      queueDepth: 2,
      promptRunning: true,
      threadId: 'thread-1',
      channelId: 'telegram',
      agentSessionId: 'agent-sess-1',
    }
    mockCore.sessionManager.getSession.mockReturnValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/abc123')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.session.id).toBe('abc123')
    expect(data.session.agent).toBe('claude')
    expect(data.session.status).toBe('active')
    expect(data.session.name).toBe('Fix bug')
    expect(data.session.workspace).toBe('/tmp/ws')
    expect(data.session.createdAt).toBe(createdAt.toISOString())
    expect(data.session.dangerousMode).toBe(false)
    expect(data.session.queueDepth).toBe(2)
    expect(data.session.promptRunning).toBe(true)
    expect(data.session.threadId).toBe('thread-1')
    expect(data.session.channelId).toBe('telegram')
    expect(data.session.agentSessionId).toBe('agent-sess-1')
  })

  it('GET /api/sessions/:id returns 404 for unknown session', async () => {
    mockCore.sessionManager.getSession.mockReturnValueOnce(undefined)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/unknown')
    expect(res.status).toBe(404)
  })

  it('PATCH /api/sessions/:id/dangerous toggles dangerous mode', async () => {
    const mockSession = { id: 'abc123', dangerousMode: false }
    mockCore.sessionManager.getSession.mockReturnValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/abc123/dangerous', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.dangerousMode).toBe(true)
    expect(mockSession.dangerousMode).toBe(true)
    expect(mockCore.sessionManager.updateSessionDangerousMode).toHaveBeenCalledWith('abc123', true)
  })

  it('PATCH /api/sessions/:id/dangerous returns 400 for missing enabled', async () => {
    const mockSession = { id: 'abc123', dangerousMode: false }
    mockCore.sessionManager.getSession.mockReturnValueOnce(mockSession)
    const port = await startServer()

    const res = await apiFetch(port, '/api/sessions/abc123/dangerous', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Missing enabled')
  })

  it('POST /api/notify sends notification', async () => {
    const port = await startServer()

    const res = await apiFetch(port, '/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello everyone' }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(mockCore.notificationManager.notifyAll).toHaveBeenCalledWith({
      sessionId: 'system',
      type: 'completed',
      summary: 'Hello everyone',
    })
  })

  it('POST /api/notify returns 400 for missing message', async () => {
    const port = await startServer()

    const res = await apiFetch(port, '/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Missing message')
  })

  it('POST /api/restart returns 200 and triggers restart', async () => {
    mockCore.requestRestart = vi.fn()
    const port = await startServer()

    const res = await apiFetch(port, '/api/restart', { method: 'POST' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.message).toBe('Restarting...')

    await new Promise(resolve => setImmediate(resolve))
    expect(mockCore.requestRestart).toHaveBeenCalled()
  })

  it('POST /api/restart returns 501 when restart not available', async () => {
    mockCore.requestRestart = null as any
    const port = await startServer()

    const res = await apiFetch(port, '/api/restart', { method: 'POST' })
    expect(res.status).toBe(501)

    // Restore for other tests
    mockCore.requestRestart = vi.fn()
  })

  it('PATCH /api/config updates config', async () => {
    const fullConfig = {
      defaultAgent: 'claude',
      security: { allowedUserIds: [], maxConcurrentSessions: 5, sessionTimeoutMinutes: 60 },
      channels: { telegram: { botToken: 'secret-token' } },
      agents: { claude: { command: 'claude-agent-acp', args: [], env: {} } },
      workspace: { baseDir: '~/openacp-workspace' },
      logging: { level: 'info', pretty: true },
      runMode: 'foreground',
      autoStart: false,
      api: { port: 21420, host: '127.0.0.1' },
      sessionStore: { ttlDays: 30 },
      tunnel: { enabled: true, port: 3100, provider: 'cloudflare', options: {}, storeTtlMinutes: 60, auth: { enabled: false } },
    }
    mockCore.configManager.get.mockReturnValue(fullConfig)
    const port = await startServer()

    const res = await apiFetch(port, '/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'defaultAgent', value: 'codex' }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(mockCore.configManager.save).toHaveBeenCalledWith({ defaultAgent: 'codex' })
  })

  it('PATCH /api/config returns 400 for missing path', async () => {
    const port = await startServer()

    const res = await apiFetch(port, '/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'codex' }),
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Missing path')
  })
})
