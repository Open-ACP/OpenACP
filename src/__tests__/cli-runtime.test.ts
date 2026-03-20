import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

describe('api-client', () => {
  let tmpDir: string
  let portFile: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-cli-runtime-'))
    portFile = path.join(tmpDir, 'api.port')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('readApiPort returns null when port file does not exist', async () => {
    const { readApiPort } = await import('../core/api-client.js')
    expect(readApiPort(portFile)).toBeNull()
  })

  it('readApiPort returns port number when file exists', async () => {
    fs.writeFileSync(portFile, '21420')
    const { readApiPort } = await import('../core/api-client.js')
    expect(readApiPort(portFile)).toBe(21420)
  })

  it('removeStalePortFile deletes the port file', async () => {
    fs.writeFileSync(portFile, '21420')
    const { removeStalePortFile } = await import('../core/api-client.js')
    removeStalePortFile(portFile)
    expect(fs.existsSync(portFile)).toBe(false)
  })

  it('apiCall builds correct URL and calls fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ sessions: [] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { apiCall } = await import('../core/api-client.js')
    const result = await apiCall(21420, '/api/sessions', { method: 'GET' })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:21420/api/sessions',
      expect.objectContaining({ method: 'GET' })
    )
    expect(result.ok).toBe(true)
  })
})
