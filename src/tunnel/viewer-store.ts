import * as path from 'node:path'
import { nanoid } from 'nanoid'
import { createChildLogger } from '../core/log.js'

const log = createChildLogger({ module: 'viewer-store' })

const MAX_CONTENT_SIZE = 1_000_000  // 1MB

const EXTENSION_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.kt': 'kotlin',
  '.rb': 'ruby', '.php': 'php', '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
  '.cs': 'csharp', '.swift': 'swift', '.sh': 'bash', '.zsh': 'bash', '.bash': 'bash',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.xml': 'xml', '.html': 'html', '.css': 'css', '.scss': 'scss',
  '.sql': 'sql', '.md': 'markdown', '.dockerfile': 'dockerfile',
  '.tf': 'hcl', '.vue': 'xml', '.svelte': 'xml',
}

export interface ViewerEntry {
  id: string
  type: 'file' | 'diff'
  filePath?: string
  content: string
  oldContent?: string
  language?: string
  sessionId: string
  workingDirectory: string
  createdAt: number
  expiresAt: number
}

export class ViewerStore {
  private entries = new Map<string, ViewerEntry>()
  private cleanupTimer: ReturnType<typeof setInterval>
  private ttlMs: number

  constructor(ttlMinutes: number = 60) {
    this.ttlMs = ttlMinutes * 60 * 1000
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000)
  }

  storeFile(sessionId: string, filePath: string, content: string, workingDirectory: string): string | null {
    if (!this.isPathAllowed(filePath, workingDirectory)) {
      log.warn({ filePath, workingDirectory }, 'Path outside workspace, rejecting')
      return null
    }
    if (content.length > MAX_CONTENT_SIZE) {
      log.debug({ filePath, size: content.length }, 'File too large for viewer')
      return null
    }

    const id = nanoid(12)
    const now = Date.now()
    this.entries.set(id, {
      id,
      type: 'file',
      filePath,
      content,
      language: this.detectLanguage(filePath),
      sessionId,
      workingDirectory,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    })
    log.debug({ id, filePath }, 'Stored file for viewing')
    return id
  }

  storeDiff(sessionId: string, filePath: string, oldContent: string, newContent: string, workingDirectory: string): string | null {
    if (!this.isPathAllowed(filePath, workingDirectory)) {
      log.warn({ filePath, workingDirectory }, 'Path outside workspace, rejecting')
      return null
    }
    const combined = oldContent.length + newContent.length
    if (combined > MAX_CONTENT_SIZE) {
      log.debug({ filePath, size: combined }, 'Diff content too large for viewer')
      return null
    }

    const id = nanoid(12)
    const now = Date.now()
    this.entries.set(id, {
      id,
      type: 'diff',
      filePath,
      content: newContent,
      oldContent,
      language: this.detectLanguage(filePath),
      sessionId,
      workingDirectory,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    })
    log.debug({ id, filePath }, 'Stored diff for viewing')
    return id
  }

  get(id: string): ViewerEntry | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(id)
      return undefined
    }
    return entry
  }

  private cleanup(): void {
    const now = Date.now()
    let removed = 0
    for (const [id, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(id)
        removed++
      }
    }
    if (removed > 0) {
      log.debug({ removed, remaining: this.entries.size }, 'Cleaned up expired viewer entries')
    }
  }

  private isPathAllowed(filePath: string, workingDirectory: string): boolean {
    const resolved = path.resolve(workingDirectory, filePath)
    return resolved.startsWith(path.resolve(workingDirectory))
  }

  private detectLanguage(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase()
    return EXTENSION_LANGUAGE[ext]
  }

  destroy(): void {
    clearInterval(this.cleanupTimer)
    this.entries.clear()
  }
}
