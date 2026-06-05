import { highlight, detectLanguage } from './syntax.js';
import { getSettings } from './settings.js';

const invoke = window.__TAURI__?.core.invoke;

export function initSplitPane(state, tabs) {
  const editorPanel = document.getElementById('editor-panel');
  const paneA       = document.getElementById('editor-pane-a');
  const paneB       = document.getElementById('editor-pane-b');
  const handle      = document.getElementById('pane-split-handle');
  const lineNumsB   = document.getElementById('line-numbers-b');
  const textareaB   = document.getElementById('editor-textarea-b');
  const highlightB  = document.getElementById('editor-highlight-b');
  const codeB       = document.getElementById('highlight-code-b');
  const fileNameB   = document.getElementById('pane-b-filename');
  const closeBtn    = document.getElementById('pane-b-close');
  const splitBtn    = document.getElementById('btn-split');

  let activeFileB = null;
  let _nameB      = '';
  let splitActive = false;
  let paneFocus   = 'a';
  let _splitW     = parseFloat(localStorage.getItem('ln:pane-split-w') || '0.5');

  function _applyWidths() {
    const totalW = editorPanel.clientWidth - 4;
    paneA.style.width = Math.round(totalW * _splitW) + 'px';
    paneA.style.flex  = 'none';
    paneB.style.flex  = '1 1 0';
  }

  function show() {
    splitActive = true;
    editorPanel.classList.add('split-active');
    paneB.style.display = 'flex';
    handle.style.display = 'block';
    _applyWidths();
    if (splitBtn) splitBtn.classList.add('active');
    if (!activeFileB) _autoPopulateB();
  }

  function _autoPopulateB() {
    const activeTab = document.querySelector('#tab-list .tab.active');
    if (!activeTab) return;
    const path = activeTab.dataset.path || null;
    const name = activeTab.dataset.name;
    if (!name) return;
    if (path) {
      const f = state.openFiles.get(path);
      openInPaneB(path, name, f?.content ?? null);
    } else {
      const f = state.openFiles.get(`@ut:${name}`);
      openInPaneB(null, name, f?.content ?? '');
    }
  }

  function hide() {
    splitActive = false;
    activeFileB = null;
    editorPanel.classList.remove('split-active');
    paneB.style.display = 'none';
    handle.style.display = 'none';
    paneA.style.width = '';
    paneA.style.flex  = '';
    paneFocus = 'a';
    _setFocus('a');
    if (splitBtn) splitBtn.classList.remove('active');
  }

  function toggle() { splitActive ? hide() : show(); }

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    function onMove(ev) {
      const rect = editorPanel.getBoundingClientRect();
      const x    = ev.clientX - rect.left;
      _splitW = Math.max(0.2, Math.min(0.8, x / (rect.width - 4)));
      _applyWidths();
    }
    function onUp() {
      handle.classList.remove('dragging');
      localStorage.setItem('ln:pane-split-w', String(_splitW));
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup',   onUp);
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup',   onUp);
  });

  new ResizeObserver(() => { if (splitActive) _applyWidths(); }).observe(editorPanel);

  function _setFocus(pane) {
    paneFocus = pane;
    paneA.classList.toggle('editor-pane--focused', pane === 'a');
    paneB.classList.toggle('editor-pane--focused', pane === 'b');
  }

  _setFocus('a');

  paneA.addEventListener('mousedown', () => { if (splitActive) _setFocus('a'); });
  paneB.addEventListener('mousedown', () => _setFocus('b'));

  function getFocusedPane() { return paneFocus; }

  function _updateLineNums(text) {
    const count = (text.match(/\n/g) ?? []).length + 1;
    lineNumsB.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  }

  function _updateHighlight(text, name) {
    codeB.innerHTML = highlight(text, detectLanguage(name ?? ''));
  }

  function _syncScroll() {
    highlightB.style.transform =
      `translate(${-textareaB.scrollLeft}px, ${-textareaB.scrollTop}px)`;
    lineNumsB.scrollTop = textareaB.scrollTop;
    if (activeFileB) {
      const f = state.openFiles.get(activeFileB);
      if (f) { f.scrollTopB = textareaB.scrollTop; f.scrollLeftB = textareaB.scrollLeft; }
    }
  }

  textareaB.addEventListener('scroll', _syncScroll);

  async function openInPaneB(path, name, contentHint = null) {
    const key = path || `@ut:${name}`;
    activeFileB = key;
    _nameB      = name;

    let text = contentHint;
    if (text == null) {
      const cached = state.openFiles.get(key);
      text = cached?.content ?? null;
    }
    if (text == null && invoke && path) {
      try {
        text = await invoke('read_file', { path });
        if (!state.openFiles.has(key)) {
          state.openFiles.set(key, { content: text, dirty: false });
        }
      } catch { text = '// Could not read file'; }
    }
    text = text ?? '';

    textareaB.value = text;
    const f = state.openFiles.get(key);
    textareaB.scrollTop  = f?.scrollTopB  ?? 0;
    textareaB.scrollLeft = f?.scrollLeftB ?? 0;
    textareaB.selectionStart = textareaB.selectionEnd = f?.cursorPosB ?? 0;
    _updateHighlight(text, name);
    _updateLineNums(text);
    _syncScroll();
    if (fileNameB) fileNameB.textContent = name;
    if (!splitActive) show();
    _setFocus('b');
    textareaB.focus();
  }

  textareaB.addEventListener('input', () => {
    const text = textareaB.value;
    if (activeFileB) {
      const f = state.openFiles.get(activeFileB);
      if (f) { f.content = text; f.dirty = true; }
      else state.openFiles.set(activeFileB, { content: text, dirty: true });
      if (!activeFileB.startsWith('@ut:')) tabs.setDirty(activeFileB, true);
    }
    _updateHighlight(text, _nameB);
    _updateLineNums(text);
    _syncScroll();
  });

  document.addEventListener('ln:activate-file', (e) => {
    if (!activeFileB) return;
    const key = e.detail.path || `@ut:${e.detail.name}`;
    if (key === activeFileB && e.detail.content != null) {
      textareaB.value = e.detail.content;
      _updateHighlight(e.detail.content, _nameB);
      _updateLineNums(e.detail.content);
    }
  });

  textareaB.addEventListener('keydown', e => {
    const s = getSettings();

    if (e.key === 'Tab') {
      e.preventDefault();
      const unit  = s.indentType === 'tabs' ? '\t' : ' '.repeat(s.tabSize);
      const start = textareaB.selectionStart;
      const end   = textareaB.selectionEnd;
      if (start === end) {
        const before = textareaB.value.substring(0, start);
        textareaB.value = before + unit + textareaB.value.substring(start);
        textareaB.selectionStart = textareaB.selectionEnd = start + unit.length;
        textareaB.dispatchEvent(new Event('input'));
      } else {
        const sel      = textareaB.value.substring(start, end);
        const adjusted = e.shiftKey
          ? sel.split('\n').map(l => l.replace(s.indentType === 'tabs' ? /^\t/ : new RegExp(`^ {1,${s.tabSize}}`), '')).join('\n')
          : sel.split('\n').map(l => unit + l).join('\n');
        textareaB.value = textareaB.value.substring(0, start) + adjusted + textareaB.value.substring(end);
        textareaB.dispatchEvent(new Event('input'));
        textareaB.setSelectionRange(start, start + adjusted.length);
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const start     = textareaB.selectionStart;
      const before    = textareaB.value.substring(0, start);
      const lineStart = before.lastIndexOf('\n') + 1;
      const indent    = before.substring(lineStart).match(/^(\s*)/)[1];
      const ins       = '\n' + indent;
      textareaB.value = before + ins + textareaB.value.substring(textareaB.selectionEnd);
      textareaB.selectionStart = textareaB.selectionEnd = start + ins.length;
      textareaB.dispatchEvent(new Event('input'));
      return;
    }

    const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
    if (pairs[e.key] && !e.ctrlKey && !e.metaKey) {
      const start  = textareaB.selectionStart;
      const closer = pairs[e.key];
      const isSym  = e.key === closer;
      if (textareaB.selectionStart === textareaB.selectionEnd && (!isSym || textareaB.value[start] !== closer)) {
        e.preventDefault();
        const before = textareaB.value.substring(0, start);
        textareaB.value = before + e.key + closer + textareaB.value.substring(start);
        textareaB.selectionStart = textareaB.selectionEnd = start + 1;
        textareaB.dispatchEvent(new Event('input'));
        return;
      }
    }

    const closers = new Set([')', ']', '}', '"', "'"]);
    if (closers.has(e.key) && textareaB.value[textareaB.selectionStart] === e.key) {
      e.preventDefault();
      textareaB.selectionStart = textareaB.selectionEnd = textareaB.selectionStart + 1;
      return;
    }

    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      _saveB();
    }
  });

  function _trackCursor() {
    if (activeFileB) {
      const f = state.openFiles.get(activeFileB);
      if (f) f.cursorPosB = textareaB.selectionStart;
    }
  }
  textareaB.addEventListener('keyup',     _trackCursor);
  textareaB.addEventListener('click',     _trackCursor);
  textareaB.addEventListener('pointerup', _trackCursor);

  async function _saveB() {
    if (!activeFileB || activeFileB.startsWith('@ut:') || !invoke) return;
    const f = state.openFiles.get(activeFileB);
    if (!f) return;
    try {
      await invoke('write_file', { path: activeFileB, content: f.content });
      f.dirty = false;
      tabs.setDirty(activeFileB, false);
      document.dispatchEvent(new CustomEvent('ln:file-saved', { detail: { path: activeFileB } }));
    } catch (err) { console.error('Pane B save failed:', err); }
  }

  document.addEventListener('keydown', e => {
    if (e.key === '\\' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      toggle();
    }
  });

  if (splitBtn) splitBtn.addEventListener('click', toggle);
  if (closeBtn) closeBtn.addEventListener('click',  hide);

  return {
    toggle,
    show,
    hide,
    openInPaneB,
    getFocusedPane,
    get activeFileB() { return activeFileB; },
  };
}
