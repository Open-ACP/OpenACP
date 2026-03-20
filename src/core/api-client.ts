import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const DEFAULT_PORT_FILE = path.join(os.homedir(), '.openacp', 'api.port')

export function readApiPort(portFilePath: string = DEFAULT_PORT_FILE): number | null {
  try {
    const content = fs.readFileSync(portFilePath, 'utf-8').trim()
    const port = parseInt(content, 10)
    return isNaN(port) ? null : port
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
  return fetch(`http://127.0.0.1:${port}${urlPath}`, options)
}
