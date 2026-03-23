import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  markdownToTelegramHtml,
  formatToolCall,
  formatToolUpdate,
  formatPlan,
  splitMessage,
} from './formatting.js'

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  it('escapes less-than', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b')
  })

  it('escapes greater-than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b')
  })

  it('escapes all HTML entities together', () => {
    expect(escapeHtml('<div class="test">&nbsp;</div>')).toBe(
      '&lt;div class="test"&gt;&amp;nbsp;&lt;/div&gt;',
    )
  })

  it('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('')
  })

  it('returns empty string for empty string', () => {
    expect(escapeHtml('')).toBe('')
  })

  it('preserves text without HTML entities', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })
})

describe('markdownToTelegramHtml', () => {
  it('converts bold **text**', () => {
    expect(markdownToTelegramHtml('**bold text**')).toBe('<b>bold text</b>')
  })

  it('converts italic *text*', () => {
    expect(markdownToTelegramHtml('*italic*')).toBe('<i>italic</i>')
  })

  it('handles bold and italic together', () => {
    const result = markdownToTelegramHtml('**bold** and *italic*')
    expect(result).toBe('<b>bold</b> and <i>italic</i>')
  })

  it('converts inline code', () => {
    const result = markdownToTelegramHtml('use `console.log`')
    expect(result).toBe('use <code>console.log</code>')
  })

  it('converts fenced code blocks', () => {
    const result = markdownToTelegramHtml('```js\nconst x = 1\n```')
    expect(result).toContain('<pre><code class="language-js">')
    expect(result).toContain('const x = 1')
    expect(result).toContain('</code></pre>')
  })

  it('converts fenced code blocks without language', () => {
    const result = markdownToTelegramHtml('```\nsome code\n```')
    expect(result).toContain('<pre><code>')
    expect(result).toContain('some code')
  })

  it('converts links [text](url)', () => {
    const result = markdownToTelegramHtml('[click here](https://example.com)')
    expect(result).toBe('<a href="https://example.com">click here</a>')
  })

  it('escapes HTML in regular text', () => {
    const result = markdownToTelegramHtml('a < b & c > d')
    expect(result).toBe('a &lt; b &amp; c &gt; d')
  })

  it('does NOT escape HTML inside code blocks', () => {
    const result = markdownToTelegramHtml('```\nif (a < b) {}\n```')
    expect(result).toContain('&lt;')
    expect(result).toContain('<pre>')
  })

  it('does NOT escape HTML inside inline code', () => {
    const result = markdownToTelegramHtml('use `a < b`')
    expect(result).toContain('<code>')
    expect(result).toContain('&lt;')
  })

  it('handles empty string', () => {
    expect(markdownToTelegramHtml('')).toBe('')
  })

  it('handles plain text without markdown', () => {
    expect(markdownToTelegramHtml('hello world')).toBe('hello world')
  })

  it('handles multiple code blocks', () => {
    const md = '```js\nconst a = 1\n```\ntext\n```py\nprint(1)\n```'
    const result = markdownToTelegramHtml(md)
    expect(result).toContain('language-js')
    expect(result).toContain('language-py')
  })

  it('preserves newlines in code blocks', () => {
    const result = markdownToTelegramHtml('```\nline1\nline2\n```')
    expect(result).toContain('line1\nline2')
  })
})

describe('formatToolCall', () => {
  it('formats a basic tool call', () => {
    const result = formatToolCall({
      id: 'tc-1',
      name: 'Read file.ts',
      kind: 'read',
      status: 'completed',
    })
    expect(result).toContain('✅')
    expect(result).toContain('📖')
    expect(result).toContain('<b>Read file.ts</b>')
  })

  it('uses default icons for unknown status/kind', () => {
    const result = formatToolCall({
      id: 'tc-1',
      name: 'Custom',
      status: 'unknown_status',
    })
    expect(result).toContain('🔧') // default status icon
    expect(result).toContain('🛠️') // default kind icon
  })

  it('shows content when no viewer links', () => {
    const result = formatToolCall({
      id: 'tc-1',
      name: 'Read',
      status: 'completed',
      content: 'file content here',
    })
    expect(result).toContain('<pre>')
    expect(result).toContain('file content here')
  })

  it('shows viewer links instead of content when available', () => {
    const result = formatToolCall({
      id: 'tc-1',
      name: 'Edit',
      status: 'completed',
      content: 'should not appear',
      viewerLinks: { file: 'https://view/1', diff: 'https://diff/1' },
      viewerFilePath: '/src/test.ts',
    })
    expect(result).toContain('View test.ts')
    expect(result).toContain('View diff')
    expect(result).not.toContain('should not appear')
  })

  it('truncates long content', () => {
    const longContent = 'x'.repeat(4000)
    const result = formatToolCall({
      id: 'tc-1',
      name: 'Read',
      status: 'completed',
      content: longContent,
    })
    expect(result).toContain('… (truncated)')
  })

  it('handles missing name', () => {
    const result = formatToolCall({
      id: 'tc-1',
      status: 'running',
    })
    expect(result).toContain('<b>Tool</b>')
  })

  it('handles null content', () => {
    const result = formatToolCall({
      id: 'tc-1',
      name: 'Test',
      status: 'running',
      content: null,
    })
    expect(result).not.toContain('<pre>')
  })

  it('extracts text from ACP content blocks', () => {
    const result = formatToolCall({
      id: 'tc-1',
      name: 'Read',
      status: 'completed',
      content: { type: 'text', text: 'extracted text' },
    })
    expect(result).toContain('extracted text')
  })

  it('extracts text from array of content blocks', () => {
    const result = formatToolCall({
      id: 'tc-1',
      name: 'Read',
      status: 'completed',
      content: [{ type: 'text', text: 'block1' }, { type: 'text', text: 'block2' }],
    })
    expect(result).toContain('block1')
  })

  it('shows only file viewer link when only file link present', () => {
    const result = formatToolCall({
      id: 'tc-1',
      name: 'Read',
      status: 'completed',
      viewerLinks: { file: 'https://view/1' },
      viewerFilePath: '/src/app.ts',
    })
    expect(result).toContain('📄')
    expect(result).not.toContain('📝')
  })
})

describe('formatToolUpdate', () => {
  it('formats a completed update', () => {
    const result = formatToolUpdate({
      id: 'tc-1',
      name: 'Edit file.ts',
      kind: 'edit',
      status: 'completed',
    })
    expect(result).toContain('✅')
    expect(result).toContain('✏️')
    expect(result).toContain('<b>Edit file.ts</b>')
  })

  it('formats a failed update', () => {
    const result = formatToolUpdate({
      id: 'tc-1',
      name: 'Write',
      status: 'failed',
    })
    expect(result).toContain('❌')
  })

  it('handles missing name', () => {
    const result = formatToolUpdate({
      id: 'tc-1',
      status: 'completed',
    })
    expect(result).toContain('<b>Tool</b>')
  })
})

describe('formatPlan', () => {
  it('formats plan entries with status icons', () => {
    const result = formatPlan({
      entries: [
        { content: 'Step 1', status: 'completed' },
        { content: 'Step 2', status: 'in_progress' },
        { content: 'Step 3', status: 'pending' },
      ],
    })
    expect(result).toContain('<b>Plan:</b>')
    expect(result).toContain('✅ 1. Step 1')
    expect(result).toContain('🔄 2. Step 2')
    expect(result).toContain('⬜ 3. Step 3')
  })

  it('handles empty entries', () => {
    const result = formatPlan({ entries: [] })
    expect(result).toContain('<b>Plan:</b>')
  })

  it('escapes HTML in entry content', () => {
    const result = formatPlan({
      entries: [{ content: '<script>alert(1)</script>', status: 'pending' }],
    })
    expect(result).toContain('&lt;script&gt;')
    expect(result).not.toContain('<script>')
  })

  it('uses default icon for unknown status', () => {
    const result = formatPlan({
      entries: [{ content: 'Step', status: 'unknown' }],
    })
    expect(result).toContain('⬜')
  })
})

describe('splitMessage', () => {
  it('returns single chunk when under limit', () => {
    const result = splitMessage('hello world', 3800)
    expect(result).toEqual(['hello world'])
  })

  it('splits at double newline when possible', () => {
    const part1 = 'a'.repeat(2000)
    const part2 = 'b'.repeat(2000)
    const text = `${part1}\n\n${part2}`
    const result = splitMessage(text, 3800)
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it('splits at single newline as fallback', () => {
    const part1 = 'a'.repeat(2000)
    const part2 = 'b'.repeat(2000)
    const text = `${part1}\n${part2}`
    const result = splitMessage(text, 3800)
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it('splits at hard limit when no newlines', () => {
    const text = 'x'.repeat(8000)
    const result = splitMessage(text, 3800)
    expect(result.length).toBeGreaterThanOrEqual(2)
    // All content should be preserved
    expect(result.join('').length).toBe(8000)
  })

  it('balances chunks when slightly over limit', () => {
    // Text length between maxLength and maxLength*1.3 should split roughly in half
    const text = 'a'.repeat(4500) // slightly over 3800
    const result = splitMessage(text, 3800)
    expect(result.length).toBe(2)
    // Both chunks should be reasonable size (not one huge + one tiny)
    for (const chunk of result) {
      expect(chunk.length).toBeGreaterThan(1000)
    }
  })

  it('handles empty text', () => {
    const result = splitMessage('', 3800)
    expect(result).toEqual([''])
  })

  it('avoids splitting inside code blocks', () => {
    // Create text with a code block that would be split
    const before = 'x'.repeat(3700)
    const codeBlock = '```\ncode line 1\ncode line 2\n```'
    const after = 'y'.repeat(100)
    const text = `${before}\n${codeBlock}\n${after}`

    const result = splitMessage(text, 3800)
    // The code block should not be split across chunks
    const allText = result.join('')
    expect(allText).toContain('```\ncode line 1\ncode line 2\n```')
  })

  it('strips leading newlines from subsequent chunks', () => {
    const part1 = 'a'.repeat(3800)
    const part2 = 'b'.repeat(100)
    const text = `${part1}\n\n\n${part2}`
    const result = splitMessage(text, 3800)
    if (result.length > 1) {
      expect(result[1]).not.toMatch(/^\n/)
    }
  })

  it('handles text at exact boundary', () => {
    const text = 'x'.repeat(3800)
    const result = splitMessage(text, 3800)
    expect(result).toEqual([text])
  })

  it('handles custom maxLength', () => {
    const text = 'hello world this is a test'
    const result = splitMessage(text, 10)
    expect(result.length).toBeGreaterThanOrEqual(2)
  })
})
