import { initFileTree } from './file-tree.js';
import { initTabs } from './tabs.js';
import { initEditor } from './editor.js';
import { initTerminal, setDefaultShellGetter } from './terminal.js';
import { initCommandPalette } from './command-palette.js';
import { initFindReplace } from './find-replace.js';
import { initSettings, loadSettings, getSettings, setFontSize } from './settings.js';
import { initShortcuts } from './shortcuts.js';
import { initHelp, setChannelGetter } from './help.js';
import { initUpdates, setUpdatesChannelGetter, setUpdatesChannelValueGetter } from './updates.js';
import { initApps, setLspClient, isLspDisabled, LSP_SERVERS } from './apps.js';
import { LspClient } from './lsp.js';
import { initSplitPane } from './split-pane.js';

const invoke = window.__TAURI__?.core.invoke;

export const state = {
  folderPath: null,
  openFiles:  new Map(),
  activeFile: null,
};

document.addEventListener('DOMContentLoaded', async () => {
  const savedSettings = await loadSettings();

  const tabs        = initTabs(state);
  const editor      = initEditor(state, tabs);
  const splitPane   = initSplitPane(state, tabs);
  const fileTree    = initFileTree(state, tabs, editor, splitPane);
  const terminal    = initTerminal(state, tabs, editor);
  setDefaultShellGetter(() => getSettings().defaultShell);
  const findReplace = initFindReplace(editor);
  const settings    = initSettings();
  const shortcuts   = initShortcuts();
  setChannelGetter(() => getSettings().updateChannel === 'beta' ? 'Beta' : 'Stable');
  setUpdatesChannelGetter(() => getSettings().updateChannel === 'beta' ? 'Beta' : 'Stable');
  setUpdatesChannelValueGetter(() => getSettings().updateChannel ?? 'stable');
  const help        = initHelp();
  const updates     = initUpdates();
  const apps        = initApps();

  const lspClient = new LspClient({
    language: 'python',
    onDiagnostics: (uri, diags) => {
      editor.setDiagnostics?.(uri, diags);
    },
    onStatus: (status) => {
      const badge = document.getElementById('status-lsp');
      if (badge) {
        badge.textContent = status === 'running' ? '●' : status === 'error' ? '⚠' : '';
        badge.title = `LSP: ${status}`;
        badge.style.display = status === 'stopped' ? 'none' : '';
      }
    },
  });
  setLspClient(lspClient);

  editor.setLspClientRef?.(lspClient);

  async function _startLsp(srv) {
    const probe = await invoke('lsp_probe', { name: srv.binary }).catch(() => null);
    if (!probe?.installed) return;
    lspClient.language  = srv.id;
    lspClient._serverId = srv.id;
    try {
      await lspClient.start(probe.path, srv.args, state.folderPath ?? '');
    } catch { return; }
    editor.notifyLspReady?.();
  }

  setTimeout(async () => {
    if (lspClient.running) return;
    const name = document.querySelector('.tab.active')?.dataset.name ?? '';
    const ext  = name.toLowerCase().slice(name.lastIndexOf('.'));
    const srv  = LSP_SERVERS.find(s => s.extensions.includes(ext));
    if (!srv || isLspDisabled(srv.id)) return;
    try { await _startLsp(srv); } catch {}
  }, 2000);

  document.addEventListener('ln:activate-file', async (e) => {
    const { name } = e.detail;
    const ext = (name ?? '').toLowerCase().slice((name ?? '').lastIndexOf('.'));
    const srv = LSP_SERVERS.find(s => s.extensions.includes(ext));
    if (!srv || isLspDisabled(srv.id)) return;
    if (lspClient.running) {
      if (lspClient._serverId === srv.id && lspClient._hasOpened) return;
      await lspClient.stop();
    }
    try { await _startLsp(srv); } catch {}
  });

  if (savedSettings.wordWrap) {
    document.dispatchEvent(new CustomEvent('ln:settings-changed', { detail: savedSettings }));
  }

  document.addEventListener('ln:wordwrap-changed', (e) => {
    invoke && invoke('save_pref', {
      key: 'settings',
      value: JSON.stringify({ ...savedSettings, wordWrap: e.detail.wordWrap }),
    }).catch(() => {});
  });

  const gfOverlay  = document.getElementById('global-find');
  const gfBackdrop = document.getElementById('global-find-backdrop');
  const gfInput    = document.getElementById('global-find-input');
  const gfClose    = document.getElementById('global-find-close');
  const gfResults  = document.getElementById('global-find-results');
  let   gfTimer    = null;

  const globalFind = {
    open()  { gfOverlay.style.display = 'block'; gfInput.value = ''; gfResults.innerHTML = ''; gfInput.focus(); },
    close() { gfOverlay.style.display = 'none'; },
  };

  gfBackdrop.addEventListener('click', () => globalFind.close());
  gfClose.addEventListener('click',    () => globalFind.close());
  gfOverlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); globalFind.close(); } });

  gfInput.addEventListener('input', () => {
    clearTimeout(gfTimer);
    const q = gfInput.value.trim();
    if (!q || !invoke || !state.folderPath) { gfResults.innerHTML = ''; return; }
    gfTimer = setTimeout(async () => {
      gfResults.innerHTML = '<div class="gf-empty">Searching…</div>';
      try {
        const results = await invoke('search_in_files', { root: state.folderPath, query: q, maxResults: 200 });
        renderGfResults(results, q);
      } catch (err) { gfResults.innerHTML = `<div class="gf-empty">Error: ${err}</div>`; }
    }, 300);
  });

  function renderGfResults(results, q) {
    if (!results.length) { gfResults.innerHTML = '<div class="gf-empty">No results found</div>'; return; }
    gfResults.innerHTML = '';
    const byFile = new Map();
    for (const r of results) {
      if (!byFile.has(r.file)) byFile.set(r.file, []);
      byFile.get(r.file).push(r);
    }
    for (const [file, hits] of byFile) {
      const rel = state.folderPath
        ? file.slice(state.folderPath.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
        : file.replace(/\\/g, '/');
      const fileEl = document.createElement('div');
      fileEl.className   = 'gf-file';
      fileEl.textContent = rel;
      gfResults.appendChild(fileEl);

      for (const hit of hits) {
        const name    = file.replace(/\\/g, '/').split('/').pop() ?? file;
        const matchEl = document.createElement('div');
        matchEl.className = 'gf-match';
        const ql = q.toLowerCase(), tl = hit.text.toLowerCase(), mi = tl.indexOf(ql);
        if (mi >= 0) {
          matchEl.appendChild(document.createTextNode(hit.text.slice(0, mi)));
          const mark = document.createElement('mark');
          mark.textContent = hit.text.slice(mi, mi + q.length);
          matchEl.appendChild(mark);
          matchEl.appendChild(document.createTextNode(hit.text.slice(mi + q.length)));
        } else { matchEl.textContent = hit.text; }
        matchEl.title = `Line ${hit.line}`;
        matchEl.addEventListener('click', () => {
          globalFind.close();
          tabs.openFile(file, name);
          const lineNum = hit.line;
          const handler = (ev) => {
            if (ev.detail.path === file) {
              document.removeEventListener('ln:activate-file', handler);
              setTimeout(() => {
                const ta     = editor.getTextarea();
                const lines  = ta.value.split('\n');
                const target = Math.max(1, Math.min(lineNum, lines.length));
                let offset   = 0;
                for (let i = 0; i < target - 1; i++) offset += lines[i].length + 1;
                ta.selectionStart = ta.selectionEnd = offset;
                ta.focus();
                const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 21;
                ta.scrollTop = Math.max(0, (target - 1) * lineH - ta.clientHeight / 2);
              }, 60);
            }
          };
          document.addEventListener('ln:activate-file', handler);
        });
        gfResults.appendChild(matchEl);
      }
    }
  }

  let recentFolders = [];

  const palette = initCommandPalette(state, { fileTree, tabs, editor, terminal, findReplace, globalFind });

  // Global function called directly via win.eval() from the native shortcut handler
  window.__openCommandPalette = () => palette.open('command');
  window.__onFileDrop = (paths) => {
    for (const path of paths) {
      const name = path.split('/').pop() || path;
      tabs.openFile(path, name);
    }
  };

  if (window.__TAURI__?.event) {
    window.__TAURI__.event.listen('open-command-palette', () => {
      palette.open('command');
    }).catch(() => {});
  }

  function updateTitle() {
    if (!invoke) return;
    const activeTab = document.querySelector('.tab.active');
    const name   = activeTab?.dataset.name ?? null;
    const dirty  = activeTab?.querySelector('.tab-dirty')?.style.display !== 'none';
    const folder = state.folderPath
      ? state.folderPath.replace(/\\/g, '/').split('/').filter(Boolean).pop()
      : null;
    let title = 'LittleNotepad';
    if (name)        title = `${dirty ? '● ' : ''}${name} — LittleNotepad`;
    else if (folder) title = `${folder} — LittleNotepad`;
    invoke('set_title', { title }).catch(() => {});
  }

  document.addEventListener('ln:activate-file',  updateTitle);
  document.addEventListener('ln:dirty-changed',   updateTitle);
  document.addEventListener('ln:folder-opened',   updateTitle);
  document.addEventListener('ln:no-active-file',  updateTitle);

  const statusBranch = document.getElementById('status-branch');

  async function refreshGitBranch() {
    if (!invoke || !state.folderPath) { statusBranch.textContent = ''; return; }
    try {
      const branch = await invoke('git_branch', { path: state.folderPath });
      statusBranch.textContent = branch ? `⎇ ${branch}` : '';
    } catch { statusBranch.textContent = ''; }
  }

  document.addEventListener('ln:folder-opened', refreshGitBranch);
  window.addEventListener('focus', refreshGitBranch);
  setInterval(refreshGitBranch, 10_000);

  function _applyDirtyRestore(path, map) {
    if (!map.has(path)) return;
    const data = map.get(path);
    const file = state.openFiles.get(path);
    if (!file) return;
    file.content   = data.content;
    file.dirty     = true;
    file.cursorPos = data.cursorPos ?? file.cursorPos;
    file.scrollTop = data.scrollTop ?? file.scrollTop;
    file.scrollLeft = data.scrollLeft ?? file.scrollLeft;
    tabs.setDirty(path, true);
    if (state.activeFile === path) {
      document.dispatchEvent(new CustomEvent('ln:activate-file', {
        detail: { path, name: path.replace(/\\/g, '/').split('/').pop(), content: data.content }
      }));
    }
  }

  let _autosaveDir    = null;
  let _autosaveTimer  = null;

  async function _resolveAutosaveDir() {
    if (!invoke) return null;
    try {
      const path = getSettings().autoSavePath ?? '';
      _autosaveDir = await invoke('get_autosave_dir', { customPath: path });
      const el = document.getElementById('autosave-resolved-path');
      if (el) el.textContent = _autosaveDir;
      return _autosaveDir;
    } catch { return null; }
  }

  async function runAutosave() {
    if (!invoke || !_autosaveDir) return;
    const namedDirty = {};
    const untitled   = [];
    for (const [key, file] of state.openFiles) {
      if (key.startsWith('@ut:')) {
        untitled.push({ name: key.slice(4), content: file.content ?? '', cursorPos: file.cursorPos ?? 0, scrollTop: file.scrollTop ?? 0, scrollLeft: file.scrollLeft ?? 0 });
      } else if (file.dirty) {
        namedDirty[key] = { content: file.content ?? '', name: key.replace(/\\/g, '/').split('/').pop(), cursorPos: file.cursorPos ?? 0, scrollTop: file.scrollTop ?? 0, scrollLeft: file.scrollLeft ?? 0 };
      }
    }
    try {
      await invoke('write_file', { path: _autosaveDir + '/autosave_state.json', content: JSON.stringify({ namedDirty, untitled }) });
    } catch {}
  }

  async function clearAutosaveEntry(filePath) {
    if (!invoke || !_autosaveDir) return;
    try {
      const raw = await invoke('read_file', { path: _autosaveDir + '/autosave_state.json' }).catch(() => null);
      if (!raw) return;
      const state_ = JSON.parse(raw);
      delete state_.namedDirty?.[filePath];
      await invoke('write_file', { path: _autosaveDir + '/autosave_state.json', content: JSON.stringify(state_) });
    } catch {}
  }

  function _restartAutosaveTimer() {
    clearInterval(_autosaveTimer);
    const s = getSettings();
    // Recovery backup to temp always runs regardless of the autoSave toggle
    _autosaveTimer = setInterval(runAutosave, (s.autoSaveInterval ?? 30) * 1000);
  }

  document.addEventListener('ln:autosave-settings-changed', async () => {
    await _resolveAutosaveDir();
    _restartAutosaveTimer();
  });

  document.addEventListener('ln:file-saved', (e) => { clearAutosaveEntry(e.detail.path); });

  let restoringSession = false;
  let _saving     = false;
  let _saveQueued = false;

  async function saveSession() {
    if (!invoke || restoringSession) return;
    if (_saving) { _saveQueued = true; return; }
    _saving = true;
    try {
      const tabEntries = [];
      for (const tab of document.querySelectorAll('#tab-list .tab')) {
        if (!tab.dataset.path) continue;
        const f = state.openFiles.get(tab.dataset.path);
        tabEntries.push({
          path:       tab.dataset.path,
          cursorPos:  f?.cursorPos  ?? 0,
          scrollTop:  f?.scrollTop  ?? 0,
          scrollLeft: f?.scrollLeft ?? 0,
          pinned:     tab.classList.contains('pinned'),
          bookmarks:  editor.getFileBookmarks(tab.dataset.path),
        });
      }
      const active = state.activeFile ?? '';
      // Sequential saves prevent read-modify-write races in prefs.json
      await invoke('save_pref', { key: 'session', value: JSON.stringify({ tabs: tabEntries, active }) });
      await invoke('save_pref', { key: 'terminalState', value: JSON.stringify(terminal.getState()) });
    } catch {}
    _saving = false;
    if (_saveQueued) { _saveQueued = false; saveSession(); }
  }

  document.addEventListener('ln:tabs-changed',    saveSession);
  document.addEventListener('ln:activate-file',  saveSession);
  document.addEventListener('ln:terminal-changed', saveSession);
  window.addEventListener('blur', saveSession);

  function renderWelcomeRecent() {
    const list      = document.getElementById('recent-list');
    const emptyMsg  = document.getElementById('recent-empty');
    if (!list) return;
    list.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = recentFolders.length ? 'none' : '';
    for (const p of recentFolders) {
      const name = p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p;
      const btn  = document.createElement('button');
      btn.className = 'recent-folder-btn';
      const nameSpan = document.createElement('span');
      nameSpan.className   = 'recent-name';
      nameSpan.textContent = name;
      const pathSpan = document.createElement('span');
      pathSpan.className   = 'recent-path';
      pathSpan.textContent = p.replace(/\\/g, '/');
      btn.appendChild(nameSpan);
      btn.appendChild(pathSpan);
      btn.addEventListener('click', () => fileTree.openFolder(p));
      list.appendChild(btn);
    }
  }

  function addRecentFolder(path) {
    recentFolders = [path, ...recentFolders.filter(p => p !== path)].slice(0, 5);
    if (invoke) invoke('save_pref', { key: 'recentFolders', value: JSON.stringify(recentFolders) }).catch(() => {});
    palette.setRecentFolders(recentFolders);
    renderWelcomeRecent();
  }

  document.addEventListener('ln:folder-opened', (e) => addRecentFolder(e.detail.path));

  // showWelcome() is blocked in editor.js until __lnReady is true.
  // We set it only after the active file is fully loaded (or we confirm nothing to load).
  window.__lnReady = false;

  await _resolveAutosaveDir();
  _restartAutosaveTimer();

  if (invoke) {
    const rawRecent = await invoke('load_pref', { key: 'recentFolders' }).catch(() => null);
    if (rawRecent) try { recentFolders = JSON.parse(rawRecent); } catch {}
    palette.setRecentFolders(recentFolders);
    renderWelcomeRecent();

    const lastFolder = await invoke('load_pref', { key: 'lastFolder' }).catch(() => null);

    // Read both prefs BEFORE any restore runs so saveSession() can't race with our reads
    const sessionStr = lastFolder ? await invoke('load_pref', { key: 'session' }).catch(() => null) : null;
    const termStr    = await invoke('load_pref', { key: 'terminalState' }).catch(() => null);

    const dirtyRestoreMap = new Map(); // path → { content, cursorPos, scrollTop, scrollLeft }
    if (_autosaveDir) {
      try {
        const asRaw = await invoke('read_file', { path: _autosaveDir + '/autosave_state.json' }).catch(() => null);
        if (asRaw) {
          const asState = JSON.parse(asRaw);
          // Restore dirty named files — content applied after session opens them
          for (const [path, data] of Object.entries(asState.namedDirty ?? {})) {
            dirtyRestoreMap.set(path, data);
          }
          for (const ut of (asState.untitled ?? [])) {
            const key = `@ut:${ut.name}`;
            state.openFiles.set(key, { content: ut.content, dirty: true, isUntitled: true, cursorPos: ut.cursorPos ?? 0, scrollTop: ut.scrollTop ?? 0, scrollLeft: ut.scrollLeft ?? 0 });
            tabs.restoreUntitled(ut.name);
          }
        }
      } catch {}
    }

    if (lastFolder) {
      await fileTree.openFolder(lastFolder);
      if (sessionStr) {
        restoringSession = true;
        try {
          const session = JSON.parse(sessionStr);
          const tabEntries = session.tabs
            ?? (session.paths ?? []).map(p => ({ path: p, cursorPos: 0, scrollTop: 0, scrollLeft: 0 }));
          const active = session.active ?? '';
          const background = tabEntries.filter(t => t.path !== active);
          for (const t of background) {
            const name = t.path.replace(/\\/g, '/').split('/').pop() || t.path;
            await tabs.openFile(t.path, name, { activate: false, cursorPos: t.cursorPos, scrollTop: t.scrollTop, scrollLeft: t.scrollLeft });
            if (t.pinned) tabs.setPinnedByPath(t.path);
            if (t.bookmarks?.length) editor.setFileBookmarks(t.path, t.bookmarks);
            _applyDirtyRestore(t.path, dirtyRestoreMap);
          }
          if (active) {
            const name = active.replace(/\\/g, '/').split('/').pop() || active;
            const t = tabEntries.find(e => e.path === active);
            await tabs.openFile(active, name, { activate: true, cursorPos: t?.cursorPos ?? 0, scrollTop: t?.scrollTop ?? 0, scrollLeft: t?.scrollLeft ?? 0 });
            if (t?.pinned) tabs.setPinnedByPath(active);
            if (t?.bookmarks?.length) editor.setFileBookmarks(active, t.bookmarks);
            _applyDirtyRestore(active, dirtyRestoreMap);
          }
        } catch (e) { console.error('Session restore failed:', e); }
        finally { restoringSession = false; saveSession(); }
      }
    }

    // Restore terminal sessions (uses termStr read before session restore)
    if (termStr) {
      try {
        const { sessions: termSessions, visible: termVisible } = JSON.parse(termStr);
        if (termSessions?.length > 0) {
          terminal.restoreSessions(termSessions, termVisible);
        }
      } catch {}
    }
    window.__lnReady = true;
    if (!state.activeFile) {
      const firstTab = document.querySelector('#tab-list .tab');
      if (firstTab) firstTab.click();
      else document.dispatchEvent(new CustomEvent('ln:no-active-file'));
    }

    if (savedSettings.launchTerminalOnStartup) {
      terminal.show();
    }
  } else {
    window.__lnReady = true;
    document.dispatchEvent(new CustomEvent('ln:no-active-file'));
  }

  const _mtimes  = new Map(); // filePath → last known mtime (seconds)
  const _ignored = new Set(); // paths dismissed by user

  document.addEventListener('ln:activate-file', (e) => {
    if (e.detail.path) _ignored.delete(e.detail.path);
  });

  // After the app saves a file, the mtime changes — drop the cached value so
  // the next poll reinitialises it without triggering a false "changed" banner.
  document.addEventListener('ln:file-saved', (e) => {
    if (e.detail.path) _mtimes.delete(e.detail.path);
  });

  async function _pollMtimes() {
    if (!invoke) return;
    for (const [path, file] of state.openFiles) {
      if (file.dirty) continue;
      if (_ignored.has(path)) continue;
      try {
        const mtime = await invoke('get_file_mtime', { path });
        if (mtime == null) continue;
        const prev = _mtimes.get(path);
        _mtimes.set(path, mtime);
        if (prev != null && mtime !== prev && path === state.activeFile) {
          editor.showFileChangedBanner(path, async () => {
            try {
              const content = await invoke('read_file', { path });
              if (state.openFiles.has(path)) {
                state.openFiles.get(path).content = content;
                state.openFiles.get(path).dirty   = false;
              }
              document.dispatchEvent(new CustomEvent('ln:activate-file', {
                detail: { path, name: path.replace(/\\/g, '/').split('/').pop(), content }
              }));
              tabs.setDirty(path, false);
              _mtimes.set(path, mtime);
            } catch {}
          });
        } else if (prev != null && mtime !== prev) {
          // Background tab changed — mark it visually via dirty indicator reuse
          _ignored.add(path); // suppress repeat banners until user visits tab
        }
      } catch {}
    }
  }

  setInterval(_pollMtimes, 3000);

  const _dirMtimes = new Map();

  document.addEventListener('ln:folder-opened', () => _dirMtimes.clear());

  async function _pollDirs() {
    if (!invoke || !state.folderPath) return;
    const paths = new Set([state.folderPath]);
    // Also watch every expanded (visible) subdirectory in the tree
    for (const el of document.querySelectorAll('#file-tree .tree-item[data-type="dir"]')) {
      const kids = el.nextElementSibling;
      if (kids?.classList.contains('tree-children') && kids.style.display !== 'none') {
        if (el.dataset.path) paths.add(el.dataset.path);
      }
    }
    for (const path of paths) {
      try {
        const mtime = await invoke('get_file_mtime', { path });
        if (mtime == null) continue;
        const prev = _dirMtimes.get(path);
        _dirMtimes.set(path, mtime);
        if (prev != null && mtime !== prev) fileTree.refreshDir(path);
      } catch {}
    }
  }

  setInterval(_pollDirs, 3000);

  const sidebar      = document.getElementById('sidebar');
  const resizeHandle = document.getElementById('sidebar-resize-handle');
  let sidebarDragging = false;

  resizeHandle.addEventListener('mousedown', (e) => { sidebarDragging = true; resizeHandle.classList.add('dragging'); e.preventDefault(); });
  document.addEventListener('mousemove', (e) => { if (sidebarDragging) sidebar.style.width = Math.max(120, Math.min(e.clientX, 600)) + 'px'; });
  document.addEventListener('mouseup',   () => { if (sidebarDragging) { sidebarDragging = false; resizeHandle.classList.remove('dragging'); } });

  let pendingChord = null;

  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key  = e.key.toLowerCase();

    if (e.key === 'F1') { e.preventDefault(); palette.open('command'); return; }
    if (ctrl && e.shiftKey && key === 'p') { e.preventDefault(); palette.open('command'); return; }
    if (ctrl && e.shiftKey && key === 'f') { e.preventDefault(); globalFind.open(); return; }
    if (ctrl && e.shiftKey && key === 's') { e.preventDefault(); editor.saveAs(); return; }
    if (ctrl && !e.shiftKey && key === 'p') { e.preventDefault(); palette.open('file'); return; }
    if (ctrl && !e.shiftKey && key === 'f') { e.preventDefault(); findReplace.open('find'); return; }
    if (ctrl && !e.shiftKey && key === 'h') { e.preventDefault(); findReplace.open('replace'); return; }
    if (ctrl && !e.shiftKey && key === 'g') { e.preventDefault(); editor.openGoToLine(); return; }
    if (ctrl && !e.shiftKey && key === 'o' && pendingChord !== 'k') { e.preventDefault(); fileTree.openSingleFile(); return; }
    if (ctrl && !e.shiftKey && key === 's') { e.preventDefault(); editor.saveActive(); return; }
    if (ctrl && !e.shiftKey && key === 'w') { e.preventDefault(); tabs.closeActiveTab(); return; }
    if (ctrl && !e.shiftKey && key === 'n') { e.preventDefault(); tabs.newUntitled(); return; }
    if (ctrl && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); terminal.toggle(); return; }
    if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); setFontSize((parseInt(getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size')) || 14) + 1); return; }
    if (ctrl && e.key === '-')  { e.preventDefault(); setFontSize((parseInt(getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size')) || 14) - 1); return; }
    if (ctrl && e.key === '0')  { e.preventDefault(); setFontSize(14); return; }
    if (!ctrl && e.altKey && key === 'z') { e.preventDefault(); editor.toggleWordWrap(); return; }
    if (ctrl && (e.key === '?' || e.key === '/')) { e.preventDefault(); shortcuts.open(); return; }

    if (ctrl && key === 'k') { e.preventDefault(); pendingChord = 'k'; setTimeout(() => { pendingChord = null; }, 2000); return; }
    if (pendingChord === 'k' && ctrl && key === 'o') { e.preventDefault(); pendingChord = null; fileTree.openFolder(); return; }
  });

  const ctxMenu = document.getElementById('context-menu');
  let ctxFocus  = null;

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ctxFocus = document.activeElement;

    const inTab      = e.target.closest('#tab-list .tab');
    const inEditor   = !!e.target.closest('#editor-wrapper');
    const inTerminal = !!e.target.closest('#terminal-body');

    let items;
    if (inTab) {
      const isPinned = inTab.classList.contains('pinned');
      items = [
        { label: isPinned ? 'Unpin Tab' : 'Pin Tab', run: () => tabs.togglePinByPath(inTab.dataset.path ?? null) },
      ];
    } else if (inEditor) {
      items = [
        { label: 'Cut',        kbd: 'Ctrl+X', run: () => doExec('cut') },
        { label: 'Copy',       kbd: 'Ctrl+C', run: () => doExec('copy') },
        { label: 'Paste',      kbd: 'Ctrl+V', run: () => doExec('paste') },
        'sep',
        { label: 'Select All', kbd: 'Ctrl+A', run: () => doExec('selectAll') },
        'sep',
        { label: 'Find',    kbd: 'Ctrl+F', run: () => findReplace.open('find') },
        { label: 'Replace', kbd: 'Ctrl+H', run: () => findReplace.open('replace') },
      ];
    } else if (inTerminal) {
      items = [
        { label: 'Copy',  kbd: 'Ctrl+C', run: () => doExec('copy') },
        { label: 'Paste', kbd: 'Ctrl+V', run: () => doExec('paste') },
      ];
    } else {
      items = [
        { label: 'Open Folder', run: () => fileTree.openFolder() },
        { label: 'Open File',   run: () => fileTree.openSingleFile() },
        { label: 'New File',    run: () => tabs.newUntitled() },
      ];
    }

    ctxMenu.innerHTML = '';
    for (const item of items) {
      if (item === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        ctxMenu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'ctx-item';
      const lbl = document.createElement('span');
      lbl.textContent = item.label;
      btn.appendChild(lbl);
      if (item.kbd) {
        const kbd = document.createElement('span');
        kbd.className   = 'ctx-kbd';
        kbd.textContent = item.kbd;
        btn.appendChild(kbd);
      }
      btn.addEventListener('mousedown', (ev) => ev.preventDefault());
      btn.addEventListener('click',     () => { hideCtx(); item.run(); });
      ctxMenu.appendChild(btn);
    }

    ctxMenu.style.left = '-9999px';
    ctxMenu.style.top  = '-9999px';
    ctxMenu.style.display = 'block';
    const rect = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.min(e.clientX, window.innerWidth  - rect.width  - 4) + 'px';
    ctxMenu.style.top  = Math.min(e.clientY, window.innerHeight - rect.height - 4) + 'px';
  });

  document.addEventListener('click', (e) => { if (!e.target.closest('#context-menu')) hideCtx(); });

  function hideCtx() { ctxMenu.style.display = 'none'; }

  async function doExec(cmd) {
    if (ctxFocus) ctxFocus.focus();
    if (cmd === 'paste') {
      try {
        const text   = await navigator.clipboard.readText();
        const target = document.activeElement;
        if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
          const s  = target.selectionStart;
          const en = target.selectionEnd;
          target.value = target.value.slice(0, s) + text + target.value.slice(en);
          target.selectionStart = target.selectionEnd = s + text.length;
          target.dispatchEvent(new Event('input'));
          return;
        }
      } catch { /* fallthrough */ }
    }
    document.execCommand(cmd);
  }
});
