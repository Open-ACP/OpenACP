import { createPatch } from 'diff'
import type { ViewerEntry } from '../viewer-store.js'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

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

export function renderDiffViewer(entry: ViewerEntry): string {
  const fileName = entry.filePath || 'untitled'
  const lang = getMonacoLang(entry.language)
  const oldContent = entry.oldContent || ''
  const newContent = entry.content

  // Count changes for stats
  const patch = createPatch(fileName, oldContent, newContent, 'before', 'after')
  const adds = (patch.match(/^\+[^+]/gm) || []).length
  const dels = (patch.match(/^-[^-]/gm) || []).length

  // Escape </script> in content
  const safeOld = JSON.stringify(oldContent).replace(/<\//g, '<\\/')
  const safeNew = JSON.stringify(newContent).replace(/<\//g, '<\\/')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(fileName)} (diff) - OpenACP</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1e1e1e; color: #d4d4d4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; flex-direction: column; height: 100vh; }
    .header { background: #252526; border-bottom: 1px solid #3c3c3c; padding: 8px 16px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; z-index: 10; }
    .file-info { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .file-icon { font-size: 14px; }
    .file-name { color: #e0e0e0; font-weight: 500; }
    .stats { font-size: 12px; margin-left: 12px; }
    .stats .add { color: #4ec9b0; }
    .stats .del { color: #f14c4c; }
    .actions { display: flex; gap: 6px; }
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
      <span class="file-icon">📝</span>
      <span class="file-name">${escapeHtml(fileName)}</span>
      <span class="stats"><span class="add">+${adds}</span> / <span class="del">-${dels}</span></span>
    </div>
    <div class="actions">
      <button class="btn active" id="btn-side" onclick="setView('side')">Side by Side</button>
      <button class="btn" id="btn-inline" onclick="setView('inline')">Inline</button>
      <button class="btn" onclick="toggleTheme()" id="btn-theme">Light</button>
    </div>
  </div>
  <div id="editor-container"></div>
  <div class="status-bar">
    <span>${escapeHtml(entry.language || 'plaintext')} | <span class="add">+${adds}</span> <span class="del">-${dels}</span></span>
    <span>OpenACP Diff Viewer</span>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js"></script>
  <script>
    const oldContent = ${safeOld};
    const newContent = ${safeNew};
    const lang = ${JSON.stringify(lang)};
    let diffEditor;
    let isDark = true;
    let renderSideBySide = true;

    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
    require(['vs/editor/editor.main'], function () {
      const originalModel = monaco.editor.createModel(oldContent, lang);
      const modifiedModel = monaco.editor.createModel(newContent, lang);

      diffEditor = monaco.editor.createDiffEditor(document.getElementById('editor-container'), {
        theme: 'vs-dark',
        readOnly: true,
        automaticLayout: true,
        renderSideBySide: true,
        scrollBeyondLastLine: false,
        fontSize: 13,
        fontFamily: "'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace",
        padding: { top: 8 },
        enableSplitViewResizing: true,
        renderOverviewRuler: true,
      });

      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    });

    function setView(mode) {
      renderSideBySide = mode === 'side';
      diffEditor.updateOptions({ renderSideBySide });
      document.getElementById('btn-side').classList.toggle('active', renderSideBySide);
      document.getElementById('btn-inline').classList.toggle('active', !renderSideBySide);
    }

    function toggleTheme() {
      isDark = !isDark;
      monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
      document.body.style.background = isDark ? '#1e1e1e' : '#ffffff';
      document.querySelector('.header').style.background = isDark ? '#252526' : '#f3f3f3';
      document.querySelector('.header').style.borderColor = isDark ? '#3c3c3c' : '#e0e0e0';
      document.getElementById('btn-theme').textContent = isDark ? 'Light' : 'Dark';
    }
  </script>
</body>
</html>`
}
