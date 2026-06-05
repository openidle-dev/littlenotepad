import { highlight, detectLanguage, injectMarks } from './syntax.js';
import { getSettings } from './settings.js';
import { initMinimap } from './minimap.js';
import { renderMarkdown } from './markdown.js';

const invoke = window.__TAURI__?.core.invoke;

export function initEditor(state, tabs) {
  const welcome            = document.getElementById('editor-welcome');
  const wrapper            = document.getElementById('editor-wrapper');
  const lineNums           = document.getElementById('line-numbers');
  const foldGutterEl       = document.getElementById('fold-gutter');
  const textarea           = document.getElementById('editor-textarea');
  const highlightCode      = document.getElementById('highlight-code');
  const statusLang         = document.getElementById('status-lang');
  const statusCursor       = document.getElementById('status-cursor');
  const statusWrap         = document.getElementById('status-wrap');
  const statusWordCount    = document.getElementById('status-wordcount');
  const gotoOverlay        = document.getElementById('goto-overlay');
  const gotoInput          = document.getElementById('goto-input');
  const breadcrumbBar      = document.getElementById('breadcrumb-bar');
  const breadcrumbContent  = document.getElementById('breadcrumb-content');
  const rulerEl            = document.getElementById('column-ruler');
  const fileChangedBanner  = document.getElementById('file-changed-banner');
  const fileChangedMsg     = document.getElementById('file-changed-msg');
  const fileChangedReload  = document.getElementById('file-changed-reload');
  const fileChangedDismiss = document.getElementById('file-changed-dismiss');
  const editorPanel        = document.getElementById('editor-panel');

  const minimap       = initMinimap(textarea);
  const mdPreviewEl   = document.getElementById('md-preview');
  const mdDividerEl   = document.getElementById('md-preview-divider');
  const codeAreaEl    = document.getElementById('code-area');

  let wordWrap      = false;
  let _previewTimer = 0;
  let _splitRatio   = parseFloat(localStorage.getItem('ln:split-ratio') || '0.5');
  let bracketMarks = [];
  let findMarks    = [];
  let mcMarks      = [];
  let diagMarks    = [];   // LSP diagnostic underlines

  let _lspClient       = null;
  let _lspChangeTimer  = null;
  let _acPopup         = null;
  let _acItems         = [];
  let _acSelected      = 0;
  let _acActive        = false;
  let _acInserting     = false;
  let _diagsByUri      = new Map();   // uri → LSP diagnostics[]
  let _problemsPanel   = null;
  let _problemsList    = null;
  let _problemsCount   = null;
  let _lightbulb       = null;
  let _caMenu          = null;
  let _lightbulbLine   = -1;
  let _caActions       = [];
  let _caCheckTimer    = null;


  function _normalizeUri(uri) {
    return (uri ?? '').toLowerCase().replace(/%3a/g, ':');
  }

  function _lspPathToUri(p) {
    if (!p) return '';
    const norm = p.replace(/\\/g, '/');
    return norm.startsWith('/') ? `file://${norm}` : `file:///${norm}`;
  }

  function _lspPosToOffset(text, line, char) {
    let off = 0;
    for (let i = 0; i < line; i++) {
      const nl = text.indexOf('\n', off);
      if (nl < 0) return text.length;
      off = nl + 1;
    }
    return Math.min(off + char, text.length);
  }

  function _offsetToLspPos(text, offset) {
    const before = text.slice(0, offset);
    const line = (before.match(/\n/g) ?? []).length;
    const character = offset - (before.lastIndexOf('\n') + 1);
    return { line, character };
  }

  function _getWordAt(text, offset) {
    const before = text.slice(0, offset);
    const after  = text.slice(offset);
    const wb = (before.match(/[\w$]+$/) ?? [''])[0];
    const wa = (after.match(/^[\w$]+/)  ?? [''])[0];
    return { word: wb + wa, start: offset - wb.length, end: offset + wa.length };
  }

  function _uriToPath(uri) {
    return decodeURIComponent(uri)
      .replace(/^file:\/\/\//, '')
      .replace(/^file:\/\//, '');
  }

  function _getLangId(name) {
    const n = (name ?? '').toLowerCase();
    if (n.endsWith('.py'))  return 'python';
    if (n.endsWith('.rs'))  return 'rust';
    if (n.endsWith('.tsx')) return 'typescriptreact';
    if (n.endsWith('.jsx')) return 'javascriptreact';
    if (n.endsWith('.ts'))  return 'typescript';
    if (n.endsWith('.js') || n.endsWith('.mjs') || n.endsWith('.cjs')) return 'javascript';
    return null;
  }

  // Each fold: { fullStart, fullEnd } (0-based line indices in full content)
  let folds = [];
  let foldIdSeq = 0;

  function _isMdFile(name) {
    return (name ?? '').toLowerCase().endsWith('.md');
  }

  function _renderPreview() {
    const file = state.activeFile && state.openFiles.get(state.activeFile);
    mdPreviewEl.innerHTML = renderMarkdown(file ? file.content : textarea.value);
  }

  function _applySplit() {
    const fixed     = lineNums.offsetWidth + foldGutterEl.offsetWidth + 4; // 4 = divider
    const available = wrapper.clientWidth - fixed;
    const cw        = Math.round(available * Math.max(0.15, Math.min(0.85, _splitRatio)));
    codeAreaEl.style.flex  = 'none';
    codeAreaEl.style.width = cw + 'px';
  }

  function _clearSplit() {
    codeAreaEl.style.flex  = '';
    codeAreaEl.style.width = '';
  }

  function _updatePreview(name) {
    const on = _isMdFile(name) && getSettings().mdPreview;
    wrapper.classList.toggle('md-preview-active', on);
    if (on) {
      _renderPreview();
      requestAnimationFrame(_applySplit);
    } else {
      _clearSplit();
    }
  }

  new ResizeObserver(() => {
    if (wrapper.classList.contains('md-preview-active')) _applySplit();
  }).observe(wrapper);

  mdDividerEl.addEventListener('pointerdown', e => {
    e.preventDefault();
    mdDividerEl.setPointerCapture(e.pointerId);
    mdDividerEl.classList.add('dragging');

    function onMove(e) {
      const rect      = wrapper.getBoundingClientRect();
      const fixed     = lineNums.offsetWidth + foldGutterEl.offsetWidth + 4;
      const available = wrapper.clientWidth - fixed;
      const x         = e.clientX - rect.left - lineNums.offsetWidth - foldGutterEl.offsetWidth;
      _splitRatio = Math.max(0.15, Math.min(0.85, x / available));
      _applySplit();
    }

    function onUp() {
      mdDividerEl.classList.remove('dragging');
      localStorage.setItem('ln:split-ratio', String(_splitRatio));
      mdDividerEl.removeEventListener('pointermove', onMove);
      mdDividerEl.removeEventListener('pointerup', onUp);
    }

    mdDividerEl.addEventListener('pointermove', onMove);
    mdDividerEl.addEventListener('pointerup', onUp);
  });

  // Prevent link navigation inside preview
  mdPreviewEl.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a) e.preventDefault();
  });

  document.addEventListener('ln:settings-changed', (e) => {
    const s = e.detail;
    if (s.wordWrap !== wordWrap) {
      wordWrap = s.wordWrap;
      wrapper.classList.toggle('wrap', wordWrap);
      textarea.setAttribute('wrap', wordWrap ? 'soft' : 'off');
      if (statusWrap) statusWrap.textContent = wordWrap ? 'Wrap: On' : 'Wrap: Off';
      syncScroll();
    }
    _updatePreview(getActiveName());
  });

  document.addEventListener('ln:activate-file', (e) => {
    const { path, name, content } = e.detail;
    folds = [];
    showEditor();
    const text = content ?? '';
    const file = path ? state.openFiles.get(path) : state.openFiles.get(`@ut:${name}`);
    textarea.value = text;
    const savedPos     = file?.cursorPos  ?? 0;
    const savedScrollT = file?.scrollTop  ?? 0;
    const savedScrollL = file?.scrollLeft ?? 0;
    textarea.selectionStart = textarea.selectionEnd = Math.min(savedPos, text.length);
    textarea.scrollTop  = savedScrollT;
    textarea.scrollLeft = savedScrollL;
    // Re-apply after layout in case browser clamped the scroll before reflow
    if (savedScrollT || savedScrollL) {
      requestAnimationFrame(() => {
        textarea.scrollTop  = savedScrollT;
        textarea.scrollLeft = savedScrollL;
        syncScroll();
      });
    }
    bracketMarks = [];
    _rebuildDiagMarks();
    updateLineNumbers(text);
    renderFoldGutter(text);
    minimap.update(text);
    updateCursorStatus();
    updateWordCount(text, name);
    updateBreadcrumb(path);
    _updatePreview(name);
    textarea.focus();
    syncScroll();
  });

  document.addEventListener('ln:no-active-file', () => {
    if (!window.__lnReady) return;
    showWelcome();
    updateBreadcrumb(null);
    wrapper.classList.remove('md-preview-active');
  });

  function updateBreadcrumb(filePath) {
    if (!filePath) {
      breadcrumbBar.style.display = 'none';
      return;
    }
    const norm  = filePath.replace(/\\/g, '/');
    const root  = state.folderPath ? state.folderPath.replace(/\\/g, '/') : null;
    let parts;
    if (root && norm.startsWith(root)) {
      parts = norm.slice(root.length).replace(/^\//, '').split('/');
      const rootName = root.split('/').filter(Boolean).pop() || root;
      parts = [rootName, ...parts];
    } else {
      parts = norm.split('/').filter(Boolean);
    }

    breadcrumbContent.innerHTML = '';
    parts.forEach((part, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'bc-sep';
        sep.textContent = '›';
        breadcrumbContent.appendChild(sep);
      }
      const seg = document.createElement('span');
      seg.className = i === parts.length - 1 ? 'bc-file' : 'bc-dir';
      seg.textContent = part;
      breadcrumbContent.appendChild(seg);
    });
    breadcrumbBar.style.display = 'flex';
  }

  textarea.addEventListener('input', () => {
    const text = textarea.value;
    const path = state.activeFile;
    const name = getActiveName();

    if (path && state.openFiles.has(path)) {
      const file = state.openFiles.get(path);
      file.content = text;
      file.dirty   = true;
    } else if (!path) {
      const key = `@ut:${name}`;
      const f   = state.openFiles.get(key);
      if (f) { f.content = text; f.dirty = true; }
      else state.openFiles.set(key, { content: text, dirty: true, isUntitled: true });
    }
    tabs.setDirty(path, true);
    updateHighlight(text, name);
    updateLineNumbers(text);
    renderFoldGutter(text);
    minimap.update(text);
    updateWordCount(text, name);
    if (_isMdFile(name)) {
      clearTimeout(_previewTimer);
      _previewTimer = setTimeout(_renderPreview, 150);
    }
    syncScroll();
  });

  textarea.addEventListener('keydown', handleEditorKeydown);

  textarea.addEventListener('scroll', () => { syncScroll(); drawIndentGuides(); if (_lightbulbLine >= 0) _positionLightbulb(_lightbulbLine); });

  function syncScroll() {
    highlightCode.parentElement.style.transform =
      `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
    lineNums.scrollTop     = textarea.scrollTop;
    foldGutterEl.scrollTop = textarea.scrollTop;
    minimap.syncViewport();
    if (state.activeFile) {
      const f = state.openFiles.get(state.activeFile);
      if (f) { f.scrollTop = textarea.scrollTop; f.scrollLeft = textarea.scrollLeft; }
    } else {
      const key = `@ut:${getActiveName()}`;
      const f   = state.openFiles.get(key);
      if (f) { f.scrollTop = textarea.scrollTop; f.scrollLeft = textarea.scrollLeft; }
    }
  }

  const _igCanvas = document.createElement('canvas');
  _igCanvas.id    = 'indent-guides-canvas';
  codeAreaEl.insertBefore(_igCanvas, textarea); // after highlight, before textarea

  let _igCharW = 0, _igLineH = 0, _igFont = '';

  function _igMetrics() {
    const cs   = getComputedStyle(textarea);
    const font = `${cs.fontSize} ${cs.fontFamily}`;
    if (font === _igFont && _igCharW) return;
    _igFont = font;
    const ctx = _igCanvas.getContext('2d');
    ctx.font  = font;
    _igCharW  = ctx.measureText(' ').width;
    _igLineH  = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  }

  function drawIndentGuides() {
    if (wordWrap) { _igCanvas.getContext('2d').clearRect(0, 0, _igCanvas.width, _igCanvas.height); return; }
    _igMetrics();
    const rect = codeAreaEl.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    const w    = rect.width, h = rect.height;
    if (_igCanvas.width !== Math.round(w * dpr) || _igCanvas.height !== Math.round(h * dpr)) {
      _igCanvas.width  = Math.round(w * dpr);
      _igCanvas.height = Math.round(h * dpr);
      _igCanvas.style.width  = `${w}px`;
      _igCanvas.style.height = `${h}px`;
    }

    const ctx      = _igCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const tabSize  = getSettings().tabSize ?? 4;
    const padL     = parseFloat(getComputedStyle(textarea).paddingLeft) || 12;
    const scrollT  = textarea.scrollTop;
    const scrollL  = textarea.scrollLeft;
    const lines    = textarea.value.split('\n');
    const firstLn  = Math.max(0, Math.floor(scrollT / _igLineH) - 1);
    const lastLn   = Math.min(lines.length - 1, Math.ceil((scrollT + h) / _igLineH) + 1);

    const levels = lines.map(ln => {
      let cols = 0;
      for (const ch of ln) {
        if (ch === ' ')  { cols++; }
        else if (ch === '\t') { cols += tabSize - (cols % tabSize); }
        else break;
      }
      return ln.trim() === '' ? -1 : Math.floor(cols / tabSize); // -1 = blank line
    });

    // For blank lines, inherit the lower of the surrounding indent levels
    for (let i = 1; i < levels.length - 1; i++) {
      if (levels[i] === -1) levels[i] = Math.min(levels[i - 1] ?? 0, levels[i + 1] ?? 0);
    }

    ctx.strokeStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--indent-guide-color').trim() || 'rgba(128,128,128,0.2)';
    ctx.lineWidth = 1;

    for (let i = firstLn; i <= lastLn; i++) {
      const lvl = levels[i] ?? 0;
      for (let lv = 1; lv <= lvl; lv++) {
        const x = Math.round(padL + lv * tabSize * _igCharW - scrollL) - 0.5;
        if (x < padL - 1 || x > w) continue;
        const y1 = i * _igLineH - scrollT;
        const y2 = y1 + _igLineH;
        ctx.beginPath();
        ctx.moveTo(x, y1);
        ctx.lineTo(x, y2);
        ctx.stroke();
      }
    }
  }

  textarea.addEventListener('input',  drawIndentGuides);
  document.addEventListener('ln:activate-file',    drawIndentGuides);
  document.addEventListener('ln:settings-changed', () => { _igCharW = 0; drawIndentGuides(); });

  textarea.addEventListener('keyup',     onCursorChange);
  textarea.addEventListener('click',     onCursorChange);
  textarea.addEventListener('pointerup', onCursorChange);

  function onCursorChange() {
    updateCursorStatus();
    updateBracketHighlight();
    if (_caMenu) _caMenu.style.display = 'none';
    _updateLightbulb();
    const pos = textarea.selectionStart;
    if (state.activeFile) {
      const f = state.openFiles.get(state.activeFile);
      if (f) f.cursorPos = pos;
    } else {
      const key = `@ut:${getActiveName()}`;
      const f   = state.openFiles.get(key);
      if (f) f.cursorPos = pos;
    }
  }

  function updateCursorStatus() {
    const pos    = textarea.selectionStart;
    const before = textarea.value.substring(0, pos);
    const lines  = before.split('\n');
    statusCursor.textContent = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
  }

  function updateBracketHighlight() {
    const pos  = textarea.selectionStart;
    const text = textarea.value;
    const openers = { '(': ')', '[': ']', '{': '}' };
    const closers = { ')': '(', ']': '[', '}': '{' };

    let openPos = -1, closePos = -1;
    const ch = text[pos], cp = text[pos - 1];

    if      (openers[ch])  { openPos = pos;     closePos = findClose(text, pos, ch, openers[ch]); }
    else if (openers[cp])  { openPos = pos - 1; closePos = findClose(text, pos - 1, cp, openers[cp]); }
    else if (closers[ch])  { closePos = pos;     openPos = findOpen(text, pos, closers[ch], ch); }
    else if (closers[cp])  { closePos = pos - 1; openPos = findOpen(text, pos - 1, closers[cp], cp); }

    const newMarks = (openPos >= 0 && closePos >= 0)
      ? [{ start: openPos, end: openPos + 1, cls: 'syn-bracket-match' },
         { start: closePos, end: closePos + 1, cls: 'syn-bracket-match' }]
      : [];

    if (JSON.stringify(newMarks) !== JSON.stringify(bracketMarks)) {
      bracketMarks = newMarks;
      updateHighlight(textarea.value, getActiveName());
    }
  }

  function findClose(text, pos, open, close) {
    let depth = 0;
    for (let i = pos; i < text.length; i++) {
      if (text[i] === open)  depth++;
      if (text[i] === close) { if (--depth === 0) return i; }
    }
    return -1;
  }

  function findOpen(text, pos, open, close) {
    let depth = 0;
    for (let i = pos; i >= 0; i--) {
      if (text[i] === close) depth++;
      if (text[i] === open)  { if (--depth === 0) return i; }
    }
    return -1;
  }

  function updateWordCount(text, name) {
    if (!statusWordCount) return;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    if (!words) { statusWordCount.textContent = ''; return; }
    const isMd = (name ?? '').toLowerCase().endsWith('.md');
    const mins = Math.ceil(words / 200);
    statusWordCount.textContent = isMd
      ? `${words.toLocaleString()} words · ${mins} min read`
      : `${words.toLocaleString()} words`;
  }

  function applyRuler(col) {
    if (col > 0) {
      wrapper.classList.add('has-ruler');
    } else {
      wrapper.classList.remove('has-ruler');
    }
  }

  document.addEventListener('ln:settings-changed', (e) => {
    applyRuler(e.detail.rulerCol ?? 0);
  });

  let _pendingReload   = null;
  const _conflictPaths = new Set(); // paths blocked from saving until conflict resolved

  function showFileChangedBanner(filePath, onReload) {
    _pendingReload = { filePath, onReload };
    _conflictPaths.add(filePath);
    const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
    fileChangedMsg.textContent = `${name} changed on disk.`;
    fileChangedBanner.style.display = 'flex';
  }

  function hideFileChangedBanner() {
    if (_pendingReload) _conflictPaths.delete(_pendingReload.filePath);
    fileChangedBanner.style.display = 'none';
    _pendingReload = null;
  }

  fileChangedReload.addEventListener('click', () => {
    if (_pendingReload) _pendingReload.onReload();
    hideFileChangedBanner();
  });
  fileChangedDismiss.addEventListener('click', hideFileChangedBanner);

  document.addEventListener('ln:activate-file', (e) => {
    if (_pendingReload && _pendingReload.filePath !== e.detail.path) {
      hideFileChangedBanner();
    }
  });

  // Visual feedback only — Tauri intercepts OS file drops before the HTML5
  // drop event fires. Actual file opening is handled via tauri://file-drop
  // in app.js. We still need dragover+preventDefault so the cursor changes.
  editorPanel.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      editorPanel.classList.add('drop-active');
    }
  });
  editorPanel.addEventListener('dragleave', (e) => {
    if (!editorPanel.contains(e.relatedTarget)) {
      editorPanel.classList.remove('drop-active');
    }
  });
  editorPanel.addEventListener('drop', (e) => {
    e.preventDefault();
    editorPanel.classList.remove('drop-active');
    // Tauri intercepts OS file drops and emits tauri://file-drop (handled in app.js)
  });

  function taLineToFullLine(taLine) {
    let cumOffset = 0;
    for (const f of folds) {
      const fTaLine = f.fullStart - cumOffset;
      if (taLine <= fTaLine) break;
      cumOffset += f.fullEnd - f.fullStart;
    }
    return taLine + cumOffset;
  }

  function findMatchingClose(lines, startLine) {
    const trimmed = lines[startLine].trimEnd();
    const last    = trimmed[trimmed.length - 1];
    const pairs   = { '{': '}', '[': ']', '(': ')' };
    const closer  = pairs[last];
    if (!closer) return -1;
    let depth = 1;
    for (let i = startLine + 1; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === last)   depth++;
        if (ch === closer) { if (--depth === 0) return i; }
      }
    }
    return -1;
  }

  function rebuildTextarea() {
    const path = state.activeFile;
    const file = path && state.openFiles.get(path);
    if (!file) return;
    const fullLines = file.content.split('\n');
    // Apply folds from bottom up so indices stay valid
    const sorted = [...folds].sort((a, b) => b.fullStart - a.fullStart);
    let lines = [...fullLines];
    for (const f of sorted) {
      const count = f.fullEnd - f.fullStart;
      const placeholder = lines[f.fullStart] + `  ⋯ ${count} lines`;
      lines.splice(f.fullStart, count + 1, placeholder);
    }
    // Preserve scroll and cursor — setting .value resets selectionStart to the
    // end in Chrome, which triggers an auto-scroll that desynchs the transform.
    const savedScroll = textarea.scrollTop;
    const savedPos    = textarea.selectionStart;
    textarea.value = lines.join('\n');
    textarea.scrollTop = savedScroll;
    textarea.selectionStart = textarea.selectionEnd = Math.min(savedPos, textarea.value.length);
  }

  function applyFold(taLine) {
    const path = state.activeFile;
    const file = path && state.openFiles.get(path);
    if (!file) return;
    const fullStart = taLineToFullLine(taLine);
    const fullLines = file.content.split('\n');
    const fullEnd   = findFoldEnd(fullLines, fullStart);
    if (fullEnd <= fullStart) return;
    folds.push({ fullStart, fullEnd });
    folds.sort((a, b) => a.fullStart - b.fullStart);
    rebuildTextarea();
    _afterFoldChange();
  }

  function unfoldAt(fullStart) {
    folds = folds.filter(f => f.fullStart !== fullStart);
    rebuildTextarea();
    _afterFoldChange();
  }

  function unfoldAll() {
    if (folds.length === 0) return;
    folds = [];
    const path = state.activeFile;
    const file = path && state.openFiles.get(path);
    if (file) {
      const savedScroll = textarea.scrollTop;
      const savedPos    = textarea.selectionStart;
      textarea.value = file.content;
      textarea.scrollTop = savedScroll;
      textarea.selectionStart = textarea.selectionEnd = Math.min(savedPos, textarea.value.length);
    }
    _afterFoldChange();
  }

  function _afterFoldChange() {
    const text = textarea.value;
    updateHighlight(text, getActiveName());
    updateLineNumbers(text);
    renderFoldGutter(text);
    minimap.update(text);
    syncScroll();
  }

  function renderFoldGutter(text) {
    const path      = state.activeFile;
    const file      = path && state.openFiles.get(path);
    const fullLines = file ? file.content.split('\n') : text.split('\n');
    const taLines   = text.split('\n');
    const lineH     = parseFloat(getComputedStyle(textarea).lineHeight) || 21;

    foldGutterEl.innerHTML = '';
    for (let i = 0; i < taLines.length; i++) {
      const div = document.createElement('div');
      div.className = 'fold-gutter-row';
      div.style.height     = lineH + 'px';
      div.style.lineHeight = lineH + 'px';

      const fullLine = taLineToFullLine(i);
      const isFolded = folds.some(f => f.fullStart === fullLine);

      if (isFolded) {
        const btn = document.createElement('span');
        btn.className   = 'fold-btn fold-closed';
        btn.textContent = '›';
        btn.title       = 'Expand';
        btn.addEventListener('click', (e) => { e.stopPropagation(); unfoldAt(fullLine); });
        div.appendChild(btn);
      } else {
        if (isFoldableLine(fullLines, fullLine)) {
          const btn = document.createElement('span');
          btn.className   = 'fold-btn fold-open';
          btn.textContent = '⌄';
          btn.title       = 'Collapse';
          btn.addEventListener('click', (e) => { e.stopPropagation(); applyFold(i); });
          div.appendChild(btn);
        }
      }
      foldGutterEl.appendChild(div);
    }
  }

  function isFoldableLine(lines, index) {
    const raw     = lines[index] ?? '';
    const trimmed = raw.trim();
    if (!trimmed) return false;
    const prev    = (lines[index - 1] ?? '').trim();
    const last    = raw.trimEnd().slice(-1);

    if (last === '{' || last === '[' || last === '(') return true;

    // // comment block — must be the first line of a run of 3+
    if (trimmed.startsWith('//') && !prev.startsWith('//')) {
      let end = index + 1;
      while (end < lines.length && (lines[end] ?? '').trim().startsWith('//')) end++;
      return end > index + 1;
    }

    if (trimmed.startsWith('/*') && !trimmed.endsWith('*/')) {
      for (let i = index + 1; i < lines.length; i++) {
        if ((lines[i] ?? '').includes('*/')) return i > index + 1;
        if ((lines[i] ?? '').trim().startsWith('/*')) return false;
      }
      return false;
    }

    // import / use / #include group — first line of a run of 3+
    const isImport = (t) => /^(import\s|from\s[\w'"*{]|export\s*\{|use\s+\w|#include\s)/.test(t);
    if (isImport(trimmed) && !isImport(prev)) {
      let end = index + 1;
      while (end < lines.length && isImport((lines[end] ?? '').trim())) end++;
      return end >= index + 2;
    }

    return false;
  }

  function findFoldEnd(lines, startLine) {
    const raw     = lines[startLine] ?? '';
    const trimmed = raw.trim();
    const last    = raw.trimEnd().slice(-1);

    if (last === '{' || last === '[' || last === '(') return findMatchingClose(lines, startLine);

    if (trimmed.startsWith('//')) {
      let end = startLine;
      while (end + 1 < lines.length && (lines[end + 1] ?? '').trim().startsWith('//')) end++;
      return end > startLine ? end : -1;
    }

    if (trimmed.startsWith('/*') && !trimmed.endsWith('*/')) {
      for (let i = startLine + 1; i < lines.length; i++) {
        if ((lines[i] ?? '').includes('*/')) return i;
      }
      return -1;
    }

    const isImport = (t) => /^(import\s|from\s[\w'"*{]|export\s*\{|use\s+\w|#include\s)/.test(t);
    if (isImport(trimmed)) {
      let end = startLine;
      while (end + 1 < lines.length && isImport((lines[end + 1] ?? '').trim())) end++;
      return end > startLine ? end : -1;
    }

    return -1;
  }

  let extraCursors = [];

  const mcLayer = document.createElement('div');
  mcLayer.id = 'mc-layer';
  textarea.parentElement.appendChild(mcLayer);

  let _mcCharWidthCache = 0;
  function _mcCharWidth() {
    if (_mcCharWidthCache) return _mcCharWidthCache;
    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d');
    const cs     = getComputedStyle(textarea);
    ctx.font     = `${cs.fontSize} ${cs.fontFamily}`;
    _mcCharWidthCache = ctx.measureText('M').width;
    return _mcCharWidthCache;
  }
  document.addEventListener('ln:settings-changed', () => { _mcCharWidthCache = 0; });

  function mcRender() {
    mcLayer.innerHTML = '';
    if (!extraCursors.length) return;
    const cs    = getComputedStyle(textarea);
    const lineH = parseFloat(cs.lineHeight) || 21;
    const charW = _mcCharWidth();
    const padL  = parseFloat(cs.paddingLeft) || 12;
    const text  = textarea.value;
    const sT    = textarea.scrollTop;
    const sL    = textarea.scrollLeft;
    for (const pos of extraCursors) {
      const before  = text.substring(0, Math.min(pos, text.length));
      const lines   = before.split('\n');
      const lineNum = lines.length - 1;
      const col     = lines[lineNum].length;
      const el      = document.createElement('div');
      el.className  = 'mc-cursor';
      el.style.top    = (lineNum * lineH - sT) + 'px';
      el.style.left   = (padL + col * charW - sL) + 'px';
      el.style.height = lineH + 'px';
      mcLayer.appendChild(el);
    }
  }

  function mcClear() {
    extraCursors = [];
    mcMarks = [];
    mcRender();
    updateHighlight(textarea.value, getActiveName());
  }

  textarea.addEventListener('scroll', () => { if (extraCursors.length) mcRender(); });

  textarea.addEventListener('mousedown', e => { if (!e.altKey && extraCursors.length) mcClear(); });

  textarea.addEventListener('mousedown', e => {
    if (!e.altKey) return;
    e.preventDefault();
    const cs    = getComputedStyle(textarea);
    const rect  = textarea.getBoundingClientRect();
    const lineH = parseFloat(cs.lineHeight) || 21;
    const charW = _mcCharWidth();
    const padL  = parseFloat(cs.paddingLeft) || 12;
    const x     = e.clientX - rect.left - padL + textarea.scrollLeft;
    const y     = e.clientY - rect.top        + textarea.scrollTop;
    const lines = textarea.value.split('\n');
    const line  = Math.max(0, Math.min(Math.floor(y / lineH), lines.length - 1));
    const col   = Math.max(0, Math.min(Math.round(x / charW), lines[line].length));
    let offset  = 0;
    for (let i = 0; i < line; i++) offset += lines[i].length + 1;
    offset += col;
    if (!extraCursors.includes(offset)) extraCursors.push(offset);
    mcRender();
  }, true);

  function _mcWordAt(text, pos) {
    const before = text.substring(0, pos).match(/\w+$/)?.[0] ?? '';
    const after  = text.substring(pos).match(/^\w+/)?.[0]  ?? '';
    return { word: before + after, start: pos - before.length };
  }

  function _mcInsert(ch) {
    mcMarks = [];
    const primary = textarea.selectionStart;
    const all     = [...new Set([primary, ...extraCursors])].sort((a, b) => a - b);
    let   text    = textarea.value;
    for (let i = all.length - 1; i >= 0; i--) {
      text = text.substring(0, all[i]) + ch + text.substring(all[i]);
    }
    textarea.value = text;
    const shiftPos = p => { const i = all.indexOf(p); return p + (i + 1) * ch.length; };
    textarea.selectionStart = textarea.selectionEnd = shiftPos(primary);
    extraCursors = extraCursors.map(shiftPos);
    textarea.dispatchEvent(new Event('input'));
    mcRender();
  }

  function _mcBackspace() {
    mcMarks = [];
    const primary = textarea.selectionStart;
    const all     = [...new Set([primary, ...extraCursors])].sort((a, b) => a - b);
    const del     = all.filter(p => p > 0).map(p => p - 1);
    if (!del.length) return;
    let text = textarea.value;
    for (let i = del.length - 1; i >= 0; i--) {
      text = text.substring(0, del[i]) + text.substring(del[i] + 1);
    }
    textarea.value = text;
    const shiftPos = p => Math.max(0, p) - del.filter(d => d < p).length;
    textarea.selectionStart = textarea.selectionEnd = shiftPos(primary);
    extraCursors = extraCursors.map(shiftPos);
    textarea.dispatchEvent(new Event('input'));
    mcRender();
  }

  function _mcDelete() {
    mcMarks = [];
    const primary = textarea.selectionStart;
    const text    = textarea.value;
    const all     = [...new Set([primary, ...extraCursors])].sort((a, b) => a - b);
    const del     = all.filter(p => p < text.length);
    if (!del.length) return;
    let newText = text;
    for (let i = del.length - 1; i >= 0; i--) {
      newText = newText.substring(0, del[i]) + newText.substring(del[i] + 1);
    }
    textarea.value = newText;
    const shiftPos = p => p - del.filter(d => d < p).length;
    textarea.selectionStart = textarea.selectionEnd = shiftPos(primary);
    extraCursors = extraCursors.map(shiftPos);
    textarea.dispatchEvent(new Event('input'));
    mcRender();
  }

  function mcHandleKeydown(e) {
    if (e.key === 'd' && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const text    = textarea.value;
      const primary = textarea.selectionStart;
      let word, start;
      if (textarea.selectionStart !== textarea.selectionEnd) {
        start = textarea.selectionStart;
        word  = text.substring(start, textarea.selectionEnd);
      } else {
        ({ word, start } = _mcWordAt(text, primary));
      }
      if (!word) return;
      const relOffset = primary - start;
      // Search from after the furthest known cursor/selection
      const lastPos = Math.max(start + word.length, ...[primary, ...extraCursors]);
      let idx = text.indexOf(word, lastPos);
      if (idx < 0) idx = text.indexOf(word, 0); // wrap
      if (idx < 0 || idx === start) return;
      const newCursor = idx + Math.min(relOffset, word.length);
      if (!extraCursors.includes(newCursor)) {
        extraCursors.push(newCursor);
        if (mcMarks.length === 0) mcMarks.push({ start, end: start + word.length, cls: 'syn-mc-match' });
        mcMarks.push({ start: idx, end: idx + word.length, cls: 'syn-mc-match' });
        updateHighlight(text, getActiveName());
      }
      mcRender();
      return;
    }

    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.ctrlKey && e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const text    = textarea.value;
      const primary = textarea.selectionStart;
      const bLines  = text.substring(0, primary).split('\n');
      const lineNum = bLines.length - 1;
      const col     = bLines[lineNum].length;
      const lines   = text.split('\n');
      const newLine = lineNum + (e.key === 'ArrowUp' ? -1 : 1);
      if (newLine >= 0 && newLine < lines.length) {
        const newCol = Math.min(col, lines[newLine].length);
        let offset   = 0;
        for (let i = 0; i < newLine; i++) offset += lines[i].length + 1;
        offset += newCol;
        if (!extraCursors.includes(offset)) extraCursors.push(offset);
        mcRender();
      }
      return;
    }

    if (!extraCursors.length) return;

    if (e.key === 'Escape') { mcClear(); return; }

    if ((e.key === 'z' || e.key === 'y') && e.ctrlKey) { mcClear(); return; }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      _mcInsert(e.key);
      return;
    }

    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      const s = getSettings();
      _mcInsert(s.indentType === 'tabs' ? '\t' : ' '.repeat(s.tabSize));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault(); e.stopImmediatePropagation();
      _mcInsert('\n');
      return;
    }

    if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      _mcBackspace();
      return;
    }

    if (e.key === 'Delete' && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      _mcDelete();
      return;
    }

    if (!e.key.startsWith('Shift') && !e.key.startsWith('Alt')) mcClear();
  }

  textarea.addEventListener('keydown', mcHandleKeydown, true);

  function handleEditorKeydown(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s     = getSettings();
      const unit  = s.indentType === 'tabs' ? '\t' : ' '.repeat(s.tabSize);
      const start = textarea.selectionStart;
      const end   = textarea.selectionEnd;
      if (start === end) {
        insert(unit);
      } else if (e.shiftKey) {
        const sel      = textarea.value.substring(start, end);
        const re       = s.indentType === 'tabs' ? /^\t/ : new RegExp(`^ {1,${s.tabSize}}`);
        const dedented = sel.split('\n').map(l => l.replace(re, '')).join('\n');
        textarea.setSelectionRange(start, end);
        if (!document.execCommand('insertText', false, dedented)) {
          textarea.value = textarea.value.substring(0, start) + dedented + textarea.value.substring(end);
          textarea.dispatchEvent(new Event('input'));
        }
        textarea.setSelectionRange(start, start + dedented.length);
      } else {
        const sel      = textarea.value.substring(start, end);
        const indented = sel.split('\n').map(l => unit + l).join('\n');
        textarea.setSelectionRange(start, end);
        if (!document.execCommand('insertText', false, indented)) {
          textarea.value = textarea.value.substring(0, start) + indented + textarea.value.substring(end);
          textarea.dispatchEvent(new Event('input'));
        }
        textarea.setSelectionRange(start, start + indented.length);
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const pos       = textarea.selectionStart;
      const val       = textarea.value;
      const before    = val.substring(0, pos);
      const lineStart = before.lastIndexOf('\n') + 1;
      const lineText  = before.substring(lineStart);
      const indent    = lineText.match(/^(\s*)/)[1];
      const trimmed   = lineText.trimEnd();
      const s         = getSettings();
      const unit      = s.indentType === 'tabs' ? '\t' : ' '.repeat(s.tabSize ?? 2);

      // Bracket pair expansion: Enter between { }, [ ], ( )
      const charBefore = val[pos - 1];
      const charAfter  = val[pos];
      const pairs      = { '{': '}', '[': ']', '(': ')' };
      if (pairs[charBefore] === charAfter) {
        insert('\n' + indent + unit + '\n' + indent, -(indent.length + 1));
        textarea.scrollLeft = 0;
        syncScroll();
        return;
      }

      // Strip trailing single-line comments before checking indent trigger
      const stripped = trimmed.replace(/(\/\/|#)[^"']*$/, '').trimEnd();
      const openRe   = /[:{(\[]\s*$/.test(stripped || trimmed);
      insert('\n' + indent + (openRe ? unit : ''));
      textarea.scrollLeft = 0;
      syncScroll();
      return;
    }

    const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
    if (pairs[e.key] && !e.ctrlKey && !e.metaKey) {
      const start      = textarea.selectionStart;
      const closer     = pairs[e.key];
      const isSymmetric = e.key === closer;
      const nextChar   = textarea.value[start];
      if (textarea.selectionStart === textarea.selectionEnd && (!isSymmetric || nextChar !== closer)) {
        e.preventDefault();
        insert(e.key + closer, -1);
        return;
      }
    }

    const closers = new Set([')', ']', '}', '"', "'"]);
    if (closers.has(e.key)) {
      const pos  = textarea.selectionStart;
      const next = textarea.value[pos];
      if (next === e.key) {
        e.preventDefault();
        textarea.selectionStart = textarea.selectionEnd = pos + 1;
        updateCursorStatus();
      }
    }
  }

  function insert(text, cursorOffset = 0) {
    const start = textarea.selectionStart;
    if (!document.execCommand('insertText', false, text)) {
      // execCommand not supported — fallback (loses undo history)
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + text + textarea.value.substring(end);
      textarea.dispatchEvent(new Event('input'));
    }
    if (cursorOffset !== 0) {
      const newPos = textarea.selectionStart + cursorOffset;
      textarea.selectionStart = textarea.selectionEnd = newPos;
    }
  }

  function updateHighlight(text, filename) {
    const lang = detectLanguage(filename ?? '');
    let html   = highlight(text, lang);
    const all  = [...bracketMarks, ...findMarks, ...mcMarks, ...diagMarks];
    if (all.length) html = injectMarks(html, all);
    highlightCode.innerHTML = html;
    updateStatusLang(lang);
    drawIndentGuides();
  }

  function updateLineNumbers(text) {
    const count = (text.match(/\n/g) ?? []).length + 1;
    lineNums.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  }

  function updateStatusLang(lang) {
    const labels = {
      javascript: 'JavaScript', typescript: 'TypeScript', rust: 'Rust',
      python: 'Python', html: 'HTML', css: 'CSS', json: 'JSON',
      markdown: 'Markdown', toml: 'TOML', yaml: 'YAML', shell: 'Shell',
      go: 'Go', plaintext: 'Plain Text',
    };
    statusLang.textContent = labels[lang] ?? lang;
  }

  function toggleWordWrap() {
    wordWrap = !wordWrap;
    wrapper.classList.toggle('wrap', wordWrap);
    textarea.setAttribute('wrap', wordWrap ? 'soft' : 'off');
    if (statusWrap) statusWrap.textContent = wordWrap ? 'Wrap: On' : 'Wrap: Off';
    syncScroll();
    document.dispatchEvent(new CustomEvent('ln:wordwrap-changed', { detail: { wordWrap } }));
  }

  if (statusWrap) statusWrap.addEventListener('click', toggleWordWrap);

  function openGoToLine() {
    showEditor();
    gotoOverlay.style.display = 'block';
    gotoInput.value = '';
    gotoInput.focus();
  }

  gotoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const n = parseInt(gotoInput.value, 10); if (!isNaN(n)) goToLine(n); closeGoToLine(); }
    if (e.key === 'Escape') { e.stopPropagation(); closeGoToLine(); }
  });

  function closeGoToLine() { gotoOverlay.style.display = 'none'; setTimeout(() => textarea.focus(), 0); }

  function goToLine(n) {
    const lines  = textarea.value.split('\n');
    const target = Math.max(1, Math.min(n, lines.length));
    let offset = 0;
    for (let i = 0; i < target - 1; i++) offset += lines[i].length + 1;
    textarea.selectionStart = textarea.selectionEnd = offset;
    textarea.focus();
    const lineH = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
    textarea.scrollTop = Math.max(0, (target - 1) * lineH - textarea.clientHeight / 2);
    syncScroll();
    updateCursorStatus();
  }

  async function saveActive() {
    const path = state.activeFile;
    if (!path) { await saveAs(); return; }
    if (_conflictPaths.has(path)) return; // external change unresolved — don't clobber
    // Always save full (unfolded) content
    const file    = state.openFiles.get(path);
    const content = file ? file.content : textarea.value;
    if (!invoke) return;
    try {
      await invoke('write_file', { path, content });
      tabs.setDirty(path, false);
      if (file) file.dirty = false;
      document.dispatchEvent(new CustomEvent('ln:file-saved', { detail: { path } }));
    } catch (err) { console.error('Save failed:', err); }
  }

  async function saveAs() {
    if (!invoke) return;
    const file     = state.activeFile && state.openFiles.get(state.activeFile);
    const content  = file ? file.content : textarea.value;
    const currName = getActiveName();
    const oldPath  = state.activeFile;
    const newPath  = await invoke('pick_save_file', { defaultName: currName }).catch(() => null);
    if (!newPath) return;
    const newName = newPath.replace(/\\/g, '/').split('/').pop() || newPath;
    try {
      await invoke('write_file', { path: newPath, content });
      if (oldPath) state.openFiles.delete(oldPath);
      state.openFiles.set(newPath, { content, dirty: false });
      state.activeFile = newPath;
      tabs.renameTab(oldPath, newPath, newName);
      updateHighlight(content, newName);
      document.dispatchEvent(new CustomEvent('ln:file-saved', { detail: { path: newPath } }));
    } catch (err) { console.error('Save As failed:', err); }
  }

  window.addEventListener('blur', () => { if (state.activeFile && getSettings().autoSave) saveActive(); });

  function showEditor()  { welcome.style.display = 'none'; wrapper.style.display = 'flex'; textarea.focus(); }
  function showWelcome() { if (!window.__lnReady) return; wrapper.style.display = 'none'; welcome.style.display = 'flex'; }
  function getActiveName() { return document.querySelector('.tab.active')?.dataset.name ?? ''; }

  function setFindMarks(marks) {
    findMarks = marks;
    updateHighlight(textarea.value, getActiveName());
  }

  function getTextarea()     { return textarea; }
  function getSyncScroll()   { return syncScroll; }
  function getUpdateCursor() { return updateCursorStatus; }

  function setDiagnostics(uri, diags) {
    _diagsByUri.set(_normalizeUri(uri), diags);

    const activeUri = _normalizeUri(_lspPathToUri(state.activeFile ?? ''));
    if (_normalizeUri(uri) === activeUri) { _rebuildDiagMarks(); _caActions = []; }

    _refreshProblems();
    _updateLspStatus();
    _updateLightbulb();
  }

  function _updateLspStatus() {
    const badge = document.getElementById('status-lsp');
    if (!badge) return;
    let errors = 0, warnings = 0;
    for (const diags of _diagsByUri.values()) {
      for (const d of diags) {
        if (d.severity === 1) errors++;
        else if (d.severity === 2) warnings++;
      }
    }
    if (errors + warnings === 0) {
      badge.style.display = 'none';
    } else {
      badge.style.display = '';
      badge.textContent = [
        errors   ? `⨯ ${errors}`   : '',
        warnings ? `⚠ ${warnings}` : '',
      ].filter(Boolean).join('  ');
      badge.style.color      = errors ? '#ffaaaa' : '#ffe680';
      badge.style.background = 'rgba(0,0,0,0.28)';
      badge.style.borderRadius = '3px';
      badge.style.padding    = '1px 5px';
    }
    badge.onclick = () => {
      const p = document.getElementById('problems-panel');
      if (p) p.style.display = p.style.display === 'none' ? 'flex' : 'none';
    };
  }

  function _rebuildDiagMarks() {
    const uri   = _normalizeUri(_lspPathToUri(state.activeFile ?? ''));
    const diags = _diagsByUri.get(uri) ?? [];
    const text  = textarea.value;
    diagMarks   = [];

    const SEV_CLS = { 1: 'diag-error', 2: 'diag-warning', 3: 'diag-info', 4: 'diag-hint' };

    for (const d of diags) {
      const r   = d.range;
      const cls = SEV_CLS[d.severity ?? 1] ?? 'diag-error';
      let start = _lspPosToOffset(text, r.start.line, r.start.character);
      let end   = _lspPosToOffset(text, r.end.line,   r.end.character);
      if (d.range.end.line > d.range.start.line) {
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const lineEnd   = text.indexOf('\n', start);
        start = lineStart;
        end   = lineEnd >= 0 ? lineEnd : text.length;
      }
      if (end <= start) end = Math.min(start + 1, text.length);
      if (start < text.length) {
        const msg  = d.message ?? '';
        const code = d.code != null ? String(d.code) : null;
        diagMarks.push({ start, end, cls, msg, code });
      }
    }

    updateHighlight(text, getActiveName());
    _refreshProblems();
  }

  function _refreshProblems() {
    if (!_problemsList) {
      _problemsList  = document.getElementById('problems-list');
      _problemsCount = document.getElementById('problems-count');
      _problemsPanel = document.getElementById('problems-panel');
    }
    if (!_problemsList) return;

    const SEV_LABEL = { 1: 'E', 2: 'W', 3: 'I', 4: 'H' };
    const SEV_CLS   = { 1: 'problem-sev-error', 2: 'problem-sev-warning', 3: 'problem-sev-info', 4: 'problem-sev-info' };

    _problemsList.innerHTML = '';
    let total = 0;

    const activeUri = _normalizeUri(_lspPathToUri(state.activeFile ?? ''));
    for (const [uri, diags] of _diagsByUri) {
      if (!diags.length) continue;
      if (uri !== activeUri) continue;  // only show current file's diagnostics
      const filePart = decodeURIComponent(uri.replace(/^file:\/\/\//, '').replace(/^file:\/\//, ''));
      for (const d of diags) {
        total++;
        const row = document.createElement('div');
        row.className = 'problem-row';

        const sev = document.createElement('span');
        sev.className = SEV_CLS[d.severity ?? 1] ?? 'problem-sev-error';
        sev.textContent = SEV_LABEL[d.severity ?? 1] ?? 'E';
        row.appendChild(sev);

        const msg = document.createElement('span');
        msg.className = 'problem-msg';
        msg.textContent = d.message;
        row.appendChild(msg);

        const loc = document.createElement('span');
        loc.className = 'problem-loc';
        loc.textContent = `${filePart.split(/[\\/]/).pop()}:${(d.range.start.line + 1)}`;
        row.appendChild(loc);

        if (d.code) {
          const code = document.createElement('span');
          code.className = 'problem-code';
          code.textContent = `(${d.code})`;
          row.appendChild(code);
        }

        row.addEventListener('click', () => {
          if (!tabs) return;
          const name = filePart.split(/[\\/]/).pop() || filePart;
          tabs.openFile(filePart, name, { activate: true });
          const handler = () => {
            document.removeEventListener('ln:activate-file', handler);
            setTimeout(() => {
              const line   = d.range.start.line;
              const lines  = textarea.value.split('\n');
              let off = 0;
              for (let i = 0; i < Math.min(line, lines.length - 1); i++) off += lines[i].length + 1;
              textarea.selectionStart = textarea.selectionEnd = off + d.range.start.character;
              textarea.focus();
              const lineH = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
              textarea.scrollTop = Math.max(0, line * lineH - textarea.clientHeight / 2);
            }, 60);
          };
          document.addEventListener('ln:activate-file', handler);
        });

        _problemsList.appendChild(row);
      }
    }

    if (total === 0) {
      const empty = document.createElement('div');
      empty.className = 'problems-empty';
      empty.textContent = 'No problems detected.';
      _problemsList.appendChild(empty);
    }

    if (_problemsCount) {
      _problemsCount.textContent = total > 0 ? String(total) : '';
      _problemsCount.style.display = total > 0 ? '' : 'none';
    }
    if (_problemsPanel) _problemsPanel.style.display = total > 0 ? 'flex' : 'none';
  }

  function _updateLightbulb() {
    if (!_lightbulb) return;
    clearTimeout(_caCheckTimer);
    if (!_lspClient?.running || !_getLangId(getActiveName()) || !state.activeFile) {
      _lightbulb.style.display = 'none';
      _lightbulbLine = -1;
      _caActions = [];
      return;
    }
    const pos        = textarea.selectionStart;
    const before     = textarea.value.slice(0, pos);
    const cursorLine = (before.match(/\n/g) ?? []).length;
    const uri        = _normalizeUri(_lspPathToUri(state.activeFile));
    const diags      = _diagsByUri.get(uri) ?? [];
    const hasLineDiag = diags.some(d => d.range.start.line <= cursorLine && d.range.end.line >= cursorLine);
    if (!hasLineDiag) {
      _lightbulb.style.display = 'none';
      _lightbulbLine = -1;
      _caActions = [];
      return;
    }
    if (cursorLine === _lightbulbLine && _caActions.length) return;
    _lightbulb.style.display = 'none';
    _lightbulbLine = cursorLine;
    _caActions = [];
    _caCheckTimer = setTimeout(() => _checkCodeActions(cursorLine), 500);
  }

  async function _checkCodeActions(lineNum) {
    if (!state.activeFile || !_lspClient?.running) return;
    const uri   = _normalizeUri(_lspPathToUri(state.activeFile));
    const diags = (_diagsByUri.get(uri) ?? []).filter(d =>
      d.range.start.line <= lineNum && d.range.end.line >= lineNum
    );
    const actions = await _lspClient.codeAction(state.activeFile, lineNum, 0, diags) ?? [];
    // Verify cursor is still on that line before showing
    const curLine = (textarea.value.slice(0, textarea.selectionStart).match(/\n/g) ?? []).length;
    if (curLine !== lineNum || !actions.length) return;
    _caActions = actions;
    _positionLightbulb(lineNum);
    if (_lightbulb) _lightbulb.style.display = 'flex';
  }

  function _positionLightbulb(lineNum) {
    if (!_lightbulb) return;
    const rect  = textarea.getBoundingClientRect();
    const lineH = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
    const top   = rect.top + lineNum * lineH - textarea.scrollTop + (lineH - 20) / 2;
    const left  = Math.max(2, rect.left - 24);
    _lightbulb.style.top  = `${top}px`;
    _lightbulb.style.left = `${left}px`;
  }

  function _showCodeActions() {
    if (_caMenu?.style.display === 'flex') { _caMenu.style.display = 'none'; return; }
    if (!_caActions.length) return;
    _showCodeActionDropdown(_caActions.slice(0, 20));
  }

  function _showCodeActionDropdown(actions) {
    if (!_caMenu) return;
    _caMenu.innerHTML = '';
    let focused = 0;

    actions.forEach((action, i) => {
      const item = document.createElement('div');
      item.className = 'code-action-item' + (i === 0 ? ' focused' : '');
      item.textContent = action.title ?? '(action)';
      item.title = action.title ?? '';
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        _caMenu.style.display = 'none';
        document.removeEventListener('keydown', onKey, true);
        _applyCodeAction(action);
      });
      _caMenu.appendChild(item);
    });

    let top, left;
    if (_lightbulb?.style.display !== 'none') {
      const lb = _lightbulb.getBoundingClientRect();
      top  = lb.bottom + 4;
      left = lb.left;
    } else {
      const rect  = textarea.getBoundingClientRect();
      const lineH = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
      const before = textarea.value.slice(0, textarea.selectionStart);
      const cursorLine = (before.match(/\n/g) ?? []).length;
      top  = rect.top + (cursorLine + 1) * lineH - textarea.scrollTop;
      left = rect.left;
    }
    _caMenu.style.top     = `${Math.min(top,  window.innerHeight - 220)}px`;
    _caMenu.style.left    = `${Math.min(left, window.innerWidth  - 440)}px`;
    _caMenu.style.display = 'flex';

    const onKey = (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        _caMenu.children[focused]?.classList.remove('focused');
        focused = Math.min(actions.length - 1, focused + 1);
        _caMenu.children[focused]?.classList.add('focused');
        _caMenu.children[focused]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _caMenu.children[focused]?.classList.remove('focused');
        focused = Math.max(0, focused - 1);
        _caMenu.children[focused]?.classList.add('focused');
        _caMenu.children[focused]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        _caMenu.style.display = 'none';
        document.removeEventListener('keydown', onKey, true);
        _applyCodeAction(actions[focused]);
      } else if (e.key === 'Escape') {
        _caMenu.style.display = 'none';
        document.removeEventListener('keydown', onKey, true);
        textarea.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);

    setTimeout(() => {
      document.addEventListener('click', (e) => {
        if (!_caMenu?.contains(e.target) && e.target !== _lightbulb) {
          _caMenu.style.display = 'none';
          document.removeEventListener('keydown', onKey, true);
        }
      }, { once: true });
    }, 50);
  }

  async function _applyCodeAction(action) {
    if (action.edit) await _applyWorkspaceEdit(action.edit);
  }

  document.getElementById('problems-close')?.addEventListener('click', () => {
    const p = document.getElementById('problems-panel');
    if (p) p.style.display = 'none';
  });

  function _lspOpenCurrent() {
    if (!_lspClient?.running) return;
    const path   = state.activeFile;
    const name   = getActiveName();
    const langId = _getLangId(name);
    if (!path || !langId) return;
    _lspClient.openDoc(path, textarea.value, langId);
  }

  function _lspChangeCurrent() {
    if (!_lspClient?.running) return;
    const path = state.activeFile;
    const name = getActiveName();
    if (!path || !_getLangId(name)) return;
    clearTimeout(_lspChangeTimer);
    _lspChangeTimer = setTimeout(() => {
      _lspClient.changeDoc(path, textarea.value);
    }, 100);
  }

  function notifyLspReady() {
    _lspOpenCurrent();
  }

  function setLspClientRef(client) {
    _lspClient = client;
  }

  document.addEventListener('ln:activate-file', () => {
    clearTimeout(_caCheckTimer);
    _lightbulbLine = -1;
    _caActions = [];
    if (_lightbulb) _lightbulb.style.display = 'none';
    if (_caMenu)    _caMenu.style.display    = 'none';
    setTimeout(_lspOpenCurrent, 80);
  });

  textarea.addEventListener('input', _lspChangeCurrent);

  _acPopup   = document.getElementById('autocomplete-popup');
  _lightbulb = document.getElementById('lightbulb');
  _caMenu    = document.getElementById('code-action-menu');
  if (_lightbulb) _lightbulb.addEventListener('click', (e) => { e.stopPropagation(); _showCodeActions(); });

  const COMPLETION_KINDS = {
    1:'T', 2:'M', 3:'F', 4:'C', 5:'V', 6:'P', 7:'K', 8:'F',
    9:'I', 10:'E', 11:'I', 12:'V', 13:'K', 14:'X', 15:'S',
  };

  function _acHide() {
    if (_acPopup) _acPopup.style.display = 'none';
    _acActive = false;
    _acItems  = [];
    _acSelected = 0;
  }

  function _acShow(items, x, y) {
    if (!_acPopup || !items.length) { _acHide(); return; }
    _acItems   = items;
    _acSelected = 0;
    _acActive   = true;
    _acPopup.innerHTML = '';

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const row = document.createElement('div');
      row.className = 'ac-item' + (i === 0 ? ' selected' : '');
      row.dataset.idx = i;

      const kind = document.createElement('span');
      kind.className = 'ac-kind';
      kind.textContent = COMPLETION_KINDS[it.kind] ?? '·';
      row.appendChild(kind);

      const label = document.createElement('span');
      label.className = 'ac-label';
      label.textContent = it.label;
      row.appendChild(label);

      if (it.detail) {
        const detail = document.createElement('span');
        detail.className = 'ac-detail';
        detail.textContent = it.detail.slice(0, 30);
        row.appendChild(detail);
      }

      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        _acInsert(parseInt(row.dataset.idx, 10));
      });
      _acPopup.appendChild(row);
    }

    const rect = textarea.getBoundingClientRect();
    const lineH = parseFloat(getComputedStyle(textarea).lineHeight) || 19;
    const charW = parseFloat(getComputedStyle(textarea).fontSize) * 0.6;
    const pos   = textarea.selectionStart;
    const before = textarea.value.slice(0, pos);
    const line  = (before.match(/\n/g) ?? []).length;
    const col   = pos - before.lastIndexOf('\n') - 1;
    const top   = rect.top  + (line + 1) * lineH - textarea.scrollTop;
    const left  = rect.left + col * charW - textarea.scrollLeft;

    _acPopup.style.display = 'block';
    _acPopup.style.top  = Math.min(top,  window.innerHeight - 210) + 'px';
    _acPopup.style.left = Math.min(left, window.innerWidth  - 420) + 'px';
  }

  function _acSelect(delta) {
    if (!_acActive || !_acItems.length) return;
    _acSelected = Math.max(0, Math.min(_acItems.length - 1, _acSelected + delta));
    _acPopup.querySelectorAll('.ac-item').forEach((r, i) => r.classList.toggle('selected', i === _acSelected));
    _acPopup.children[_acSelected]?.scrollIntoView({ block: 'nearest' });
  }

  function _acInsert(idx) {
    const item = _acItems[idx ?? _acSelected];
    if (!item) { _acHide(); return; }
    const insert = item.insertText ?? item.label;
    const pos    = textarea.selectionStart;
    const val    = textarea.value;
    // Replace only the word after the last dot/space — never include the dot itself
    let wordStart = pos;
    while (wordStart > 0 && /\w/.test(val[wordStart - 1])) wordStart--;
    _acHide();                    // hide first to block re-trigger
    _acInserting = true;
    textarea.value = val.slice(0, wordStart) + insert + val.slice(pos);
    textarea.selectionStart = textarea.selectionEnd = wordStart + insert.length;
    updateHighlight(textarea.value, getActiveName());
    updateLineNumbers(textarea.value);
    textarea.dispatchEvent(new Event('input'));
    _acInserting = false;
  }

  textarea.addEventListener('keydown', (e) => {
    if (!_acActive) return;
    if (e.key === 'Escape')    { e.stopPropagation(); _acHide(); }
    if (e.key === 'ArrowDown') { e.preventDefault();  _acSelect(+1); }
    if (e.key === 'ArrowUp')   { e.preventDefault();  _acSelect(-1); }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      _acInsert();
    }
  }, true);

  let _acTimer = null;
  textarea.addEventListener('input', () => {
    if (_acInserting || !_lspClient?.running) return;
    const pos    = textarea.selectionStart;
    const before = textarea.value.slice(0, pos);
    const last   = before[before.length - 1] ?? '';
    if (!/[\w.]/.test(last)) { _acHide(); return; }
    clearTimeout(_acTimer);
    _acTimer = setTimeout(async () => {
      if (!state.activeFile || !_getLangId(getActiveName())) return;
      const text    = textarea.value;
      const curPos  = textarea.selectionStart;
      const curBefore = text.slice(0, curPos);
      const line    = (curBefore.match(/\n/g) ?? []).length;
      const col     = curPos - (curBefore.lastIndexOf('\n') + 1);
      const isDot   = curBefore[curPos - 1] === '.';
      const items   = await _lspClient.complete(state.activeFile, line, col, isDot);

      const prefix  = (curBefore.match(/[\w]*$/) ?? [''])[0].toLowerCase();
      const filtered = prefix
        ? items.filter(i => i.label.toLowerCase().startsWith(prefix))
        : items;

      if (filtered.length) _acShow(filtered, 0, 0);
      else _acHide();
    }, 400);
  });

  document.addEventListener('click', (e) => {
    if (_acActive && !_acPopup?.contains(e.target)) _acHide();
  });

  // Hit-test the <mark> elements in the highlight layer by briefly
  // swapping pointer-events so elementFromPoint sees through the textarea.
  const _diagTooltip = document.createElement('div');
  _diagTooltip.id = 'diag-tooltip';
  document.body.appendChild(_diagTooltip);

  textarea.addEventListener('mousemove', (e) => {
    if (!diagMarks.length) { _diagTooltip.style.display = 'none'; return; }

    textarea.style.pointerEvents    = 'none';
    highlightCode.style.pointerEvents = 'auto';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    textarea.style.pointerEvents    = '';
    highlightCode.style.pointerEvents = '';

    const mark = el?.closest?.('mark[data-msg]');
    if (!mark) { _diagTooltip.style.display = 'none'; return; }

    _diagTooltip.textContent = mark.dataset.code
      ? `${mark.dataset.msg} (${mark.dataset.code})`
      : mark.dataset.msg;
    _diagTooltip.className = mark.classList.contains('diag-warning') ? 'diag-tooltip-warning'
                           : mark.classList.contains('diag-info')    ? 'diag-tooltip-info'
                           : 'diag-tooltip-error';

    _diagTooltip.style.display = 'block';
    const pad = 10;
    const tw  = _diagTooltip.offsetWidth;
    const th  = _diagTooltip.offsetHeight;
    let left  = e.clientX + pad;
    let top   = e.clientY - th - pad;
    if (left + tw > window.innerWidth - 4) left = e.clientX - tw - pad;
    if (top < 4) top = e.clientY + pad + 16;
    _diagTooltip.style.left = `${left}px`;
    _diagTooltip.style.top  = `${top}px`;
  });

  textarea.addEventListener('mouseleave', () => {
    _diagTooltip.style.display = 'none';
  });

  function _navigateToLocation(uri, range) {
    const filePath = _uriToPath(uri);
    const name = filePath.split(/[\\/]/).pop() || filePath;
    if (tabs) {
      tabs.openFile(filePath, name, { activate: true });
      const handler = () => {
        document.removeEventListener('ln:activate-file', handler);
        setTimeout(() => {
          const off = _lspPosToOffset(textarea.value, range.start.line, range.start.character);
          textarea.selectionStart = textarea.selectionEnd = off;
          textarea.focus();
          const lineH = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
          textarea.scrollTop = Math.max(0, range.start.line * lineH - textarea.clientHeight / 2);
        }, 60);
      };
      document.addEventListener('ln:activate-file', handler);
    }
  }

  function _navigateToFileLine(filePath, line, word) {
    const name = filePath.split(/[\\/]/).pop() || filePath;
    if (tabs) {
      tabs.openFile(filePath, name, { activate: true });
      const handler = () => {
        document.removeEventListener('ln:activate-file', handler);
        setTimeout(() => {
          const lines = textarea.value.split('\n');
          let off = 0;
          for (let i = 0; i < Math.min(line, lines.length - 1); i++) off += lines[i].length + 1;
          const col = word ? (lines[line] ?? '').indexOf(word) : 0;
          textarea.selectionStart = textarea.selectionEnd = off + Math.max(0, col);
          textarea.focus();
          const lineH = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
          textarea.scrollTop = Math.max(0, line * lineH - textarea.clientHeight / 2);
        }, 60);
      };
      document.addEventListener('ln:activate-file', handler);
    }
  }

  function _showDefPicker(results) {
    const overlay   = document.getElementById('def-picker');
    const list      = document.getElementById('def-picker-list');
    const backdrop  = document.getElementById('def-picker-backdrop');
    if (!overlay || !list) return;

    list.innerHTML = '';
    let focused = 0;

    results.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'def-pick-item' + (i === 0 ? ' focused' : '');
      const label = r.path
        ? `${r.path.split(/[\\/]/).pop()}:${r.line + 1}`
        : _uriToPath(r.uri).split(/[\\/]/).pop() + ':' + (r.range?.start?.line + 1 ?? '?');
      li.innerHTML = `<span class="def-pick-file">${label}</span><span class="def-pick-preview">${(r.preview ?? '').replace(/</g,'&lt;')}</span>`;
      li.addEventListener('click', () => { _pickDef(i); });
      list.appendChild(li);
    });

    function _pickDef(i) {
      overlay.style.display = 'none';
      const r = results[i];
      if (r.path) _navigateToFileLine(r.path, r.line, r.word);
      else if (r.uri) _navigateToLocation(r.uri, r.range);
    }

    function _moveFocus(delta) {
      list.children[focused]?.classList.remove('focused');
      focused = Math.max(0, Math.min(results.length - 1, focused + delta));
      list.children[focused]?.classList.add('focused');
      list.children[focused]?.scrollIntoView({ block: 'nearest' });
    }

    const onKey = (e) => {
      if (e.key === 'ArrowDown')  { e.preventDefault(); _moveFocus(1); }
      if (e.key === 'ArrowUp')    { e.preventDefault(); _moveFocus(-1); }
      if (e.key === 'Enter')      { e.preventDefault(); _pickDef(focused); document.removeEventListener('keydown', onKey); }
      if (e.key === 'Escape')     { overlay.style.display = 'none'; document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', () => { overlay.style.display = 'none'; document.removeEventListener('keydown', onKey); }, { once: true });
    overlay.style.display = 'block';
  }

  async function goToDefinition() {
    if (!state.activeFile) return;
    const text   = textarea.value;
    const cursor = textarea.selectionStart;
    const { word, start } = _getWordAt(text, cursor);
    if (!word) return;
    const { line, character } = _offsetToLspPos(text, start + (word.length >> 1));

    if (_lspClient?.running && _getLangId(getActiveName())) {
      const locs = await _lspClient.goToDefinition(state.activeFile, line, character);
      if (locs?.length) {
        if (locs.length === 1) { _navigateToLocation(locs[0].uri, locs[0].range); return; }
        _showDefPicker(locs.map(l => ({ uri: l.uri, range: l.range })));
        return;
      }
    }

    if (!state.folderPath || !invoke) return;
    const files = await invoke('list_all_files', { path: state.folderPath, maxDepth: 10 }).catch(() => []);
    const defPat = new RegExp(`\\b(?:function|class|const|let|var|def|fn|struct|type|interface|enum|async\\s+function)\\s+${word}\\b`);
    const results = [];
    for (const f of files.slice(0, 300)) {
      try {
        const content = await invoke('read_file', { path: f });
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (defPat.test(lines[i])) results.push({ path: f, line: i, word, preview: lines[i].trim() });
        }
      } catch {}
    }
    if (!results.length) return;
    if (results.length === 1) { _navigateToFileLine(results[0].path, results[0].line, word); return; }
    _showDefPicker(results);
  }

  function renameSymbol() {
    if (!state.activeFile) return;
    const text   = textarea.value;
    const cursor = textarea.selectionStart;
    const { word, start } = _getWordAt(text, cursor);
    if (!word) return;

    const overlay   = document.getElementById('rename-overlay');
    const container = document.getElementById('rename-container');
    const input     = document.getElementById('rename-input');
    if (!overlay || !input) return;

    const lineNum = (text.slice(0, cursor).match(/\n/g) ?? []).length;
    const lineH   = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
    const rect    = textarea.getBoundingClientRect();
    const topPx   = rect.top + (lineNum + 1) * lineH - textarea.scrollTop + 4;
    container.style.top  = `${Math.min(topPx, window.innerHeight - 80)}px`;
    container.style.left = `${rect.left + 24}px`;

    input.value = word;
    overlay.style.display = 'block';
    input.select();
    input.focus();

    async function _doRename() {
      const newName = input.value.trim();
      overlay.style.display = 'none';
      if (!newName || newName === word) return;

      const { line, character } = _offsetToLspPos(text, start + (word.length >> 1));

      if (_lspClient?.running && _getLangId(getActiveName())) {
        const edit = await _lspClient.rename(state.activeFile, line, character, newName);
        if (edit) { await _applyWorkspaceEdit(edit); return; }
      }

      await _renameFallback(word, newName);
    }

    const onKey = (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); input.removeEventListener('keydown', onKey); _doRename(); }
      if (e.key === 'Escape') { overlay.style.display = 'none'; input.removeEventListener('keydown', onKey); }
    };
    input.addEventListener('keydown', onKey);
  }

  async function _applyWorkspaceEdit(edit) {
    const changes = edit.changes ?? {};
    for (const dc of edit.documentChanges ?? []) {
      const uri = dc.textDocument?.uri ?? dc.uri;
      if (uri) changes[uri] = (changes[uri] ?? []).concat(dc.edits ?? []);
    }
    for (const [uri, edits] of Object.entries(changes)) {
      if (!edits.length) continue;
      const filePath = _uriToPath(uri);
      const isActive = _normPath(filePath) === _normPath(state.activeFile);
      let content = isActive ? textarea.value
                  : await invoke?.('read_file', { path: filePath }).catch(() => null);
      if (content == null) continue;
      // Apply edits in reverse order so positions stay valid
      const sorted = [...edits].sort((a, b) => {
        const al = a.range.start.line * 1e6 + a.range.start.character;
        const bl = b.range.start.line * 1e6 + b.range.start.character;
        return bl - al;
      });
      for (const e of sorted) {
        const s = _lspPosToOffset(content, e.range.start.line, e.range.start.character);
        const en = _lspPosToOffset(content, e.range.end.line, e.range.end.character);
        content = content.slice(0, s) + e.newText + content.slice(en);
      }
      if (isActive) {
        const sel = textarea.selectionStart;
        textarea.value = content;
        textarea.selectionStart = textarea.selectionEnd = sel;
        updateHighlight(content, getActiveName());
        _lspChangeCurrent();
        tabs?.setDirty(state.activeFile, true);
      } else {
        await invoke?.('write_file', { path: filePath, content }).catch(() => {});
      }
    }
  }

  function _normPath(p) { return (p ?? '').replace(/\\/g, '/').toLowerCase(); }

  async function _renameFallback(word, newName) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRe  = () => new RegExp(`\\b${escaped}\\b`, 'g');
    const activeNorm = _normPath(state.activeFile);

    const hits = [];
    const activeCount = (textarea.value.match(wordRe()) ?? []).length;
    if (activeCount) hits.push({ path: state.activeFile, count: activeCount, active: true });

    const files = state.folderPath && invoke
      ? await invoke('list_all_files', { path: state.folderPath, maxDepth: 10 }).catch(() => [])
      : [];
    const fileContents = new Map();
    for (const f of files) {
      if (_normPath(f) === activeNorm) continue;
      try {
        const content = await invoke('read_file', { path: f });
        const n = (content.match(wordRe()) ?? []).length;
        if (n) { hits.push({ path: f, count: n }); fileContents.set(f, content); }
      } catch {}
    }

    if (!hits.length) return;

    const totalCount = hits.reduce((s, h) => s + h.count, 0);
    const fileCount  = hits.length;

    const overlay   = document.getElementById('rename-confirm-overlay');
    const body      = document.getElementById('rename-confirm-body');
    const okBtn     = document.getElementById('rename-confirm-ok');
    const cancelBtn = document.getElementById('rename-confirm-cancel');
    const backdrop  = document.getElementById('rename-confirm-backdrop');
    if (!overlay) return;

    body.innerHTML =
      `Will replace <strong>${totalCount}</strong> occurrence${totalCount !== 1 ? 's' : ''} ` +
      `of <strong>"${word}"</strong> → <strong>"${newName}"</strong> ` +
      `across <strong>${fileCount}</strong> file${fileCount !== 1 ? 's' : ''}.<br><br>` +
      `<span style="color:var(--fg-muted)">This is a text replace — not scope-aware. ` +
      `Unrelated uses of "${word}" will also be renamed.</span>`;
    overlay.style.display = 'flex';
    cancelBtn.focus();

    const confirmed = await new Promise(resolve => {
      let settled = false;
      const cleanup = (v) => {
        if (settled) return;
        settled = true;
        overlay.style.display = 'none';
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onBackdrop);
        resolve(v);
      };
      const onOk       = () => cleanup(true);
      const onCancel   = () => cleanup(false);
      const onBackdrop = () => cleanup(false);
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      // Delay backdrop listener by 200ms to avoid click-through from rename input Enter
      setTimeout(() => backdrop.addEventListener('click', onBackdrop), 200);
    });

    if (!confirmed) return;

    for (const h of hits) {
      if (h.active) {
        const sel = textarea.selectionStart;
        const newContent = textarea.value.replace(wordRe(), newName);
        textarea.value = newContent;
        textarea.selectionStart = textarea.selectionEnd = sel;
        updateHighlight(newContent, getActiveName());
        _lspChangeCurrent();
        tabs?.setDirty(state.activeFile, true);
      } else {
        const content = fileContents.get(h.path);
        if (content != null)
          await invoke?.('write_file', { path: h.path, content: content.replace(wordRe(), newName) }).catch(() => {});
      }
    }
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'F12') { e.preventDefault(); goToDefinition(); }
    if (e.key === 'F2')  { e.preventDefault(); renameSymbol(); }
    if (e.key === '.' && e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); _showCodeActions(); }
  }, true);

  textarea.addEventListener('click', (e) => {
    if (e.ctrlKey) { e.preventDefault(); goToDefinition(); }
  });

  return {
    saveActive, saveAs, toggleWordWrap, openGoToLine, setFindMarks,
    getTextarea, getSyncScroll, getUpdateCursor, showFileChangedBanner,
    setDiagnostics, notifyLspReady, setLspClientRef,
    goToDefinition, renameSymbol,
  };
}
