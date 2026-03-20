import { Hono } from 'hono'
import type { ViewerStore } from './viewer-store.js'
import { renderFileViewer } from './templates/file-viewer.js'
import { renderDiffViewer } from './templates/diff-viewer.js'

function notFoundPage(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Not Found - OpenACP</title>
<style>body{background:#0d1117;color:#c9d1d9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:40px}.code{font-size:72px;font-weight:bold;color:#484f58}p{margin-top:16px;color:#8b949e}</style>
</head><body><div class="box"><div class="code">404</div><p>This viewer link has expired or does not exist.</p></div></body></html>`
}

export function createTunnelServer(store: ViewerStore, authToken?: string): Hono {
  const app = new Hono()

  // Auth middleware
  if (authToken) {
    app.use('*', async (c, next) => {
      if (c.req.path === '/health') return next()
      const bearer = c.req.header('Authorization')?.replace('Bearer ', '')
      const query = c.req.query('token')
      if (bearer !== authToken && query !== authToken) {
        return c.text('Unauthorized', 401)
      }
      return next()
    })
  }

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.get('/view/:id', (c) => {
    const entry = store.get(c.req.param('id'))
    if (!entry || entry.type !== 'file') {
      return c.html(notFoundPage(), 404)
    }
    return c.html(renderFileViewer(entry))
  })

  app.get('/diff/:id', (c) => {
    const entry = store.get(c.req.param('id'))
    if (!entry || entry.type !== 'diff') {
      return c.html(notFoundPage(), 404)
    }
    return c.html(renderDiffViewer(entry))
  })

  app.get('/api/file/:id', (c) => {
    const entry = store.get(c.req.param('id'))
    if (!entry || entry.type !== 'file') {
      return c.json({ error: 'not found' }, 404)
    }
    return c.json({ filePath: entry.filePath, content: entry.content, language: entry.language })
  })

  app.get('/api/diff/:id', (c) => {
    const entry = store.get(c.req.param('id'))
    if (!entry || entry.type !== 'diff') {
      return c.json({ error: 'not found' }, 404)
    }
    return c.json({ filePath: entry.filePath, oldContent: entry.oldContent, newContent: entry.content, language: entry.language })
  })

  return app
}
