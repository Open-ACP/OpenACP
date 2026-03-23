import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ViewerStore } from '../tunnel/viewer-store.js'

describe('ViewerStore', () => {
  let store: ViewerStore

  beforeEach(() => {
    store = new ViewerStore(60) // 60 min TTL
  })

  afterEach(() => {
    store.destroy()
  })

  describe('storeFile()', () => {
    it('stores a file and returns an id', () => {
      const id = store.storeFile('sess-1', '/workspace/test.ts', 'const x = 1', '/workspace')
      expect(id).toBeTruthy()
      expect(typeof id).toBe('string')
    })

    it('detects language from file extension', () => {
      const id = store.storeFile('sess-1', '/workspace/test.ts', 'code', '/workspace')
      const entry = store.get(id!)
      expect(entry?.language).toBe('typescript')
    })

    it('detects python language', () => {
      const id = store.storeFile('sess-1', '/workspace/main.py', 'print(1)', '/workspace')
      const entry = store.get(id!)
      expect(entry?.language).toBe('python')
    })

    it('stores entry with correct metadata', () => {
      const id = store.storeFile('sess-1', '/workspace/file.js', 'content', '/workspace')
      const entry = store.get(id!)
      expect(entry).toMatchObject({
        type: 'file',
        filePath: '/workspace/file.js',
        content: 'content',
        sessionId: 'sess-1',
        workingDirectory: '/workspace',
        language: 'javascript',
      })
      expect(entry?.createdAt).toBeGreaterThan(0)
      expect(entry?.expiresAt).toBeGreaterThan(entry!.createdAt)
    })

    it('rejects paths outside workspace', () => {
      const id = store.storeFile('sess-1', '/etc/passwd', 'bad', '/workspace')
      expect(id).toBeNull()
    })

    it('rejects path traversal attempts', () => {
      const id = store.storeFile('sess-1', '/workspace/../etc/passwd', 'bad', '/workspace')
      expect(id).toBeNull()
    })

    it('rejects content exceeding 1MB', () => {
      const bigContent = 'x'.repeat(1_000_001)
      const id = store.storeFile('sess-1', '/workspace/big.txt', bigContent, '/workspace')
      expect(id).toBeNull()
    })

    it('accepts content at exactly 1MB', () => {
      const content = 'x'.repeat(1_000_000)
      const id = store.storeFile('sess-1', '/workspace/big.txt', content, '/workspace')
      expect(id).toBeTruthy()
    })

    it('returns undefined language for unknown extensions', () => {
      const id = store.storeFile('sess-1', '/workspace/file.xyz', 'data', '/workspace')
      const entry = store.get(id!)
      expect(entry?.language).toBeUndefined()
    })
  })

  describe('storeDiff()', () => {
    it('stores a diff with old and new content', () => {
      const id = store.storeDiff('sess-1', '/workspace/file.ts', 'old code', 'new code', '/workspace')
      expect(id).toBeTruthy()

      const entry = store.get(id!)
      expect(entry).toMatchObject({
        type: 'diff',
        filePath: '/workspace/file.ts',
        content: 'new code',
        oldContent: 'old code',
        language: 'typescript',
      })
    })

    it('rejects paths outside workspace', () => {
      const id = store.storeDiff('sess-1', '/etc/hosts', 'old', 'new', '/workspace')
      expect(id).toBeNull()
    })

    it('rejects when combined size exceeds 1MB', () => {
      const big = 'x'.repeat(600_000)
      const id = store.storeDiff('sess-1', '/workspace/file.ts', big, big, '/workspace')
      expect(id).toBeNull()
    })

    it('accepts when combined size is at 1MB boundary', () => {
      const half = 'x'.repeat(500_000)
      const id = store.storeDiff('sess-1', '/workspace/file.ts', half, half, '/workspace')
      expect(id).toBeTruthy()
    })
  })

  describe('get()', () => {
    it('returns stored entry', () => {
      const id = store.storeFile('sess-1', '/workspace/f.ts', 'code', '/workspace')
      expect(store.get(id!)).toBeDefined()
    })

    it('returns undefined for unknown id', () => {
      expect(store.get('nonexistent')).toBeUndefined()
    })

    it('returns undefined for expired entry', async () => {
      // Create store with very short TTL
      const shortStore = new ViewerStore(0) // 0 minutes = instant expire
      const id = shortStore.storeFile('sess-1', '/workspace/f.ts', 'code', '/workspace')

      // Wait just enough for Date.now() to advance past expiresAt
      await new Promise((r) => setTimeout(r, 5))
      const entry = shortStore.get(id!)
      expect(entry).toBeUndefined()
      shortStore.destroy()
    })
  })

  describe('destroy()', () => {
    it('clears all entries', () => {
      const id = store.storeFile('sess-1', '/workspace/f.ts', 'code', '/workspace')
      store.destroy()
      expect(store.get(id!)).toBeUndefined()
    })
  })

  describe('language detection', () => {
    const cases: [string, string][] = [
      ['.ts', 'typescript'],
      ['.tsx', 'typescript'],
      ['.js', 'javascript'],
      ['.jsx', 'javascript'],
      ['.py', 'python'],
      ['.rs', 'rust'],
      ['.go', 'go'],
      ['.java', 'java'],
      ['.rb', 'ruby'],
      ['.sh', 'bash'],
      ['.json', 'json'],
      ['.yaml', 'yaml'],
      ['.yml', 'yaml'],
      ['.html', 'html'],
      ['.css', 'css'],
      ['.sql', 'sql'],
      ['.md', 'markdown'],
      ['.swift', 'swift'],
      ['.kt', 'kotlin'],
      ['.php', 'php'],
      ['.c', 'c'],
      ['.cpp', 'cpp'],
      ['.cs', 'csharp'],
      ['.toml', 'toml'],
      ['.xml', 'xml'],
    ]

    for (const [ext, lang] of cases) {
      it(`detects ${lang} for ${ext}`, () => {
        const id = store.storeFile('s1', `/workspace/file${ext}`, 'x', '/workspace')
        expect(store.get(id!)?.language).toBe(lang)
      })
    }
  })
})
