import type { ViewerEntry } from '../viewer-store.js'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Map our language IDs to Monaco language IDs
const MONACO_LANGUAGE: Record<string, string> = {
  typescript: 'typescript', javascript: 'javascript', python: 'python',
  rust: 'rust', go: 'go', java: 'java', kotlin: 'kotlin', ruby: 'ruby',
  php: 'php', c: 'c', cpp: 'cpp', csharp: 'csharp', swift: 'swift',
  bash: 'shell', json: 'json', yaml: 'yaml', toml: 'ini', xml: 'xml',
  html: 'html', css: 'css', scss: 'scss', sql: 'sql', markdown: 'markdown',
  dockerfile: 'dockerfile', hcl: 'hcl', plaintext: 'plaintext',
}

function getMonacoLang(lang?: string): string {
  if (!lang) return 'plaintext'
  return MONACO_LANGUAGE[lang] || 'plaintext'
}

export function renderFileViewer(entry: ViewerEntry): string {
  const fileName = entry.filePath || 'untitled'
  const lang = getMonacoLang(entry.language)
  // Escape </script> inside content to prevent premature tag closure
  const safeContent = JSON.stringify(entry.content).replace(/<\//g, '<\\/')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(fileName)} - OpenACP</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1e1e1e; color: #d4d4d4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; flex-direction: column; height: 100vh; }
    .header { background: #252526; border-bottom: 1px solid #3c3c3c; padding: 8px 16px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; z-index: 10; }
    .file-info { display: flex; align-items: center; gap: 8px; font-size: 13px; min-width: 0; }
    .file-icon { font-size: 14px; flex-shrink: 0; }
    .file-path { color: #969696; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-name { color: #e0e0e0; font-weight: 500; flex-shrink: 0; }
    .actions { display: flex; gap: 6px; flex-shrink: 0; }
    .btn { background: #3c3c3c; color: #d4d4d4; border: 1px solid #505050; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; transition: background 0.15s; }
    .btn:hover { background: #505050; }
    .btn.active { background: #0e639c; border-color: #1177bb; }
    #editor-container { flex: 1; overflow: hidden; }
    .status-bar { background: #007acc; color: #fff; padding: 2px 16px; font-size: 12px; display: flex; justify-content: space-between; flex-shrink: 0; }
  </style>
</head>
<body>
  <div class="header">
    <div class="file-info">
      <span class="file-icon">📄</span>
      ${formatBreadcrumb(fileName)}
    </div>
    <div class="actions">
      <button class="btn" onclick="toggleWordWrap()" id="btn-wrap">Wrap</button>
      <button class="btn" onclick="toggleMinimap()" id="btn-minimap">Minimap</button>
      <button class="btn" onclick="toggleTheme()" id="btn-theme">Light</button>
      <button class="btn" onclick="copyCode()">Copy</button>
    </div>
  </div>
  <div id="editor-container"></div>
  <div class="status-bar">
    <span>${escapeHtml(entry.language || 'plaintext')} | ${entry.content.split('\n').length} lines</span>
    <span>OpenACP Viewer (read-only)</span>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js"></script>
  <script>
    const content = ${safeContent};
    const lang = ${JSON.stringify(lang)};
    let editor;
    let isDark = true;
    let wordWrap = false;
    let minimap = true;

    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
    require(['vs/editor/editor.main'], function () {
      editor = monaco.editor.create(document.getElementById('editor-container'), {
        value: content,
        language: lang,
        theme: 'vs-dark',
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        fontSize: 13,
        fontFamily: "'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace",
        lineNumbers: 'on',
        renderLineHighlight: 'all',
        wordWrap: 'off',
        padding: { top: 8 },
      });

      // Handle line range from URL hash: #L42 or #L42-L55
      function highlightFromHash() {
        const hash = location.hash.slice(1);
        const match = hash.match(/^L(\\d+)(?:-L?(\\d+))?$/);
        if (!match) return;
        const startLine = parseInt(match[1], 10);
        const endLine = match[2] ? parseInt(match[2], 10) : startLine;
        editor.revealLineInCenter(startLine);
        editor.setSelection(new monaco.Selection(startLine, 1, endLine + 1, 1));
      }
      highlightFromHash();
      window.addEventListener('hashchange', highlightFromHash);
    });

    function toggleTheme() {
      isDark = !isDark;
      monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
      document.body.style.background = isDark ? '#1e1e1e' : '#ffffff';
      document.querySelector('.header').style.background = isDark ? '#252526' : '#f3f3f3';
      document.querySelector('.header').style.borderColor = isDark ? '#3c3c3c' : '#e0e0e0';
      document.getElementById('btn-theme').textContent = isDark ? 'Light' : 'Dark';
    }

    function toggleWordWrap() {
      wordWrap = !wordWrap;
      editor.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' });
      document.getElementById('btn-wrap').classList.toggle('active', wordWrap);
    }

    function toggleMinimap() {
      minimap = !minimap;
      editor.updateOptions({ minimap: { enabled: minimap } });
      document.getElementById('btn-minimap').classList.toggle('active', !minimap);
    }

    function copyCode() {
      navigator.clipboard.writeText(content).then(() => {
        const btn = event.target;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 2000);
      });
    }
  </script>
</body>
</html>`
}

function formatBreadcrumb(filePath: string): string {
  const parts = filePath.split('/')
  if (parts.length <= 1) return `<span class="file-name">${escapeHtml(filePath)}</span>`
  const dir = parts.slice(0, -1).join(' / ')
  const name = parts[parts.length - 1]
  return `<span class="file-path">${escapeHtml(dir)} /</span> <span class="file-name">${escapeHtml(name)}</span>`
}
