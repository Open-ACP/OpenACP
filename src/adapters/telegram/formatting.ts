export function escapeHtml(text: string | undefined | null): string {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function markdownToTelegramHtml(md: string): string {
  // Step 1: Extract code blocks and inline code into placeholders
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  // Extract fenced code blocks (```lang\n...\n```)
  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const index = codeBlocks.length
    const escapedCode = escapeHtml(code)
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    codeBlocks.push(`<pre><code${langAttr}>${escapedCode}</code></pre>`)
    return `\x00CODE_BLOCK_${index}\x00`
  })

  // Extract inline code (`...`)
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00INLINE_CODE_${index}\x00`
  })

  // Step 2: Escape HTML in remaining text
  text = escapeHtml(text)

  // Step 3: Apply markdown transformations
  // Bold: **text** → <b>text</b>
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

  // Italic: *text* → <i>text</i> (but not the ** used for bold)
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')

  // Links: [text](url) → <a href="url">text</a>
  // Note: after escapeHtml, parentheses are not affected, but we need to handle
  // the escaped brackets properly. Since [ ] and ( ) are not escaped, this works directly.
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Step 4: Restore fenced code blocks
  text = text.replace(/\x00CODE_BLOCK_(\d+)\x00/g, (_match, idx: string) => {
    return codeBlocks[parseInt(idx, 10)]
  })

  // Step 5: Restore inline code
  text = text.replace(/\x00INLINE_CODE_(\d+)\x00/g, (_match, idx: string) => {
    return inlineCodes[parseInt(idx, 10)]
  })

  return text
}

const STATUS_ICON: Record<string, string> = {
  pending: '⏳',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌',
}

const KIND_ICON: Record<string, string> = {
  read: '📖', edit: '✏️', delete: '🗑️', execute: '▶️',
  search: '🔍', fetch: '🌐', think: '🧠', move: '📦', other: '🛠️',
}

function extractContentText(content: unknown, depth = 0): string {
  if (!content || depth > 5) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => extractContentText(c, depth + 1))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content === 'object' && content !== null) {
    const c = content as Record<string, unknown>
    // ACP content blocks: {type: ..., text: ...} or {type: ..., content: ...}
    if (c.type === 'text' && typeof c.text === 'string') return c.text
    if (typeof c.text === 'string') return c.text
    if (typeof c.content === 'string') return c.content
    // Tool input/output objects
    if (c.input) return extractContentText(c.input, depth + 1)
    if (c.output) return extractContentText(c.output, depth + 1)
    // Fallback: pretty-print JSON (but skip type-only objects)
    const keys = Object.keys(c).filter(k => k !== 'type')
    if (keys.length === 0) return ''
    return JSON.stringify(c, null, 2)
  }
  return String(content)
}

function truncateContent(text: string, maxLen = 3800): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '\n… (truncated)'
}

export function formatToolCall(tool: { id: string; name?: string; kind?: string; status?: string; content?: unknown; viewerLinks?: { file?: string; diff?: string } }): string {
  const si = STATUS_ICON[tool.status || ''] || '🔧'
  const ki = KIND_ICON[tool.kind || ''] || '🛠️'
  let text = `${si} ${ki} <b>${escapeHtml(tool.name || 'Tool')}</b>`
  const details = extractContentText(tool.content)
  if (details) {
    text += `\n<pre>${escapeHtml(truncateContent(details))}</pre>`
  }
  text += formatViewerLinks(tool.viewerLinks)
  return text
}

export function formatToolUpdate(update: { id: string; name?: string; kind?: string; status: string; content?: unknown; viewerLinks?: { file?: string; diff?: string } }): string {
  const si = STATUS_ICON[update.status] || '🔧'
  const ki = KIND_ICON[update.kind || ''] || '🛠️'
  const name = update.name || 'Tool'
  let text = `${si} ${ki} <b>${escapeHtml(name)}</b>`
  const details = extractContentText(update.content)
  if (details) {
    text += `\n<pre>${escapeHtml(truncateContent(details))}</pre>`
  }
  text += formatViewerLinks(update.viewerLinks)
  return text
}

function formatViewerLinks(links?: { file?: string; diff?: string }): string {
  if (!links) return ''
  let text = ''
  if (links.file) text += `\n📄 <a href="${escapeHtml(links.file)}">View file</a>`
  if (links.diff) text += `\n📝 <a href="${escapeHtml(links.diff)}">View diff</a>`
  return text
}

export function formatPlan(plan: { entries: Array<{ content: string; status: string }> }): string {
  const statusIcon: Record<string, string> = { pending: '⬜', in_progress: '🔄', completed: '✅' }
  const lines = plan.entries.map((e, i) =>
    `${statusIcon[e.status] || '⬜'} ${i + 1}. ${escapeHtml(e.content)}`
  )
  return `<b>Plan:</b>\n${lines.join('\n')}`
}

export function formatUsage(usage: { tokensUsed?: number; contextSize?: number; cost?: { amount: number; currency: string } }): string {
  const parts: string[] = []
  if (usage.tokensUsed != null) parts.push(`Tokens: ${usage.tokensUsed.toLocaleString()}`)
  if (usage.contextSize != null) parts.push(`Context: ${usage.contextSize.toLocaleString()}`)
  if (usage.cost) parts.push(`Cost: $${usage.cost.amount.toFixed(4)}`)
  return `📊 ${parts.join(' | ')}`
}

export function splitMessage(text: string, maxLength = 4096): string[] {
  if (text.length <= maxLength) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }
    let splitAt = remaining.lastIndexOf('\n\n', maxLength)
    if (splitAt === -1 || splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf('\n', maxLength)
    }
    if (splitAt === -1 || splitAt < maxLength * 0.5) {
      splitAt = maxLength
    }
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  return chunks
}
