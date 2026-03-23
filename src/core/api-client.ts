import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const DEFAULT_PORT_FILE = path.join(os.homedir(), '.openacp', 'api.port')
const DEFAULT_SECRET_FILE = path.join(os.homedir(), '.openacp', 'api-secret')

export function readApiPort(portFilePath: string = DEFAULT_PORT_FILE): number | null {
  try {
    const content = fs.readFileSync(portFilePath, 'utf-8').trim()
    const port = parseInt(content, 10)
    return isNaN(port) ? null : port
  } catch {
    return null
  }
}

export function readApiSecret(secretFilePath: string = DEFAULT_SECRET_FILE): string | null {
  try {
    const content = fs.readFileSync(secretFilePath, 'utf-8').trim()
    return content || null
  } catch {
    return null
  }
}

export function removeStalePortFile(portFilePath: string = DEFAULT_PORT_FILE): void {
  try {
    fs.unlinkSync(portFilePath)
  } catch {
    // ignore
  }
}

export async function apiCall(
  port: number,
  urlPath: string,
  options?: RequestInit,
): Promise<Response> {
  const secret = readApiSecret()
  const headers = new Headers(options?.headers)
  if (secret) {
    headers.set('Authorization', `Bearer ${secret}`)
  }
  return fetch(`http://127.0.0.1:${port}${urlPath}`, { ...options, headers })
}
