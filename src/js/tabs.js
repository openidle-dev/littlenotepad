const invoke = window.__TAURI__?.core.invoke;

export function initTabs(state) {
  const tabList           = document.getElementById('tab-list');
  const fileMissingOverlay = document.getElementById('file-missing-overlay');
  const fileMissingName    = document.getElementById('file-missing-name');
  let tabIdSeq    = 0;
  let _draggedTab = null;
  let _fileMissingTab = null;

  function _closeFileMissingDialog() {
    fileMissingOverlay.style.display = 'none';
    if (_fileMissingTab) { const t = _fileMissingTab; _fileMissingTab = null; closeTab(t); }
  }
  document.getElementById('file-missing-close')?.addEventListener('click', _closeFileMissingDialog);
  document.getElementById('file-missing-backdrop')?.addEventListener('click', _closeFileMissingDialog);

  function _showFileMissing(filePath, fileName) {
    const tab = filePath ? findTabByPath(filePath) : tabList.querySelector('.tab.active');
    if (!tab) return;
    _fileMissingTab = tab;
    fileMissingName.textContent = fileName ?? tab.dataset.name;
    fileMissingOverlay.style.display = 'flex';
  }

  document.getElementById('btn-new-file').addEventListener('click', newUntitled);

  function openFile(filePath, fileName, { activate = true, cursorPos = 0, scrollTop = 0, scrollLeft = 0 } = {}) {
    const existing = findTabByPath(filePath);
    if (existing) { if (activate) activateTab(existing); return Promise.resolve(); }
    createTab(filePath, fileName);
    const p = loadFileContent(filePath, fileName, activate, { cursorPos, scrollTop, scrollLeft });
    document.dispatchEvent(new CustomEvent('ln:tabs-changed'));
    return p;
  }

  async function loadFileContent(filePath, fileName, activate = true, pos = {}) {
    let content;
    if (!invoke) {
      content = '// File system not yet connected.\n';
    } else {
      try {
        content = await invoke('read_file', { path: filePath });
      } catch (err) {
        const mtime = await invoke('get_file_mtime', { path: filePath }).catch(() => null);
        if (mtime == null) {
          if (activate) activateByPath(filePath, '');
          _showFileMissing(filePath, fileName);
          return;
        }
        content = `// Could not read file: ${err}\n`;
      }
    }
    state.openFiles.set(filePath, { content, dirty: false, ...pos });
    if (activate) activateByPath(filePath, content);
  }

  function newUntitled() {
    const name = `untitled-${++tabIdSeq}`;
    createTab(null, name, true);
    activateByName(name);
  }

  function createTab(filePath, fileName, isNew = false) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    if (filePath) tab.dataset.path = filePath;
    tab.dataset.name = fileName;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';
    nameSpan.textContent = fileName;

    const dirtyDot = document.createElement('span');
    dirtyDot.className = 'tab-dirty';
    dirtyDot.textContent = '●';
    dirtyDot.style.display = 'none';

    const pinIcon = document.createElement('span');
    pinIcon.className = 'tab-pin-icon';
    pinIcon.title = 'Pinned';
    pinIcon.innerHTML = `<svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/></svg>`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close (Ctrl+W)';

    tab.append(nameSpan, dirtyDot, pinIcon, closeBtn);
    tabList.appendChild(tab);

    tab.addEventListener('click', async (e) => {
      if (e.target === closeBtn) return;
      const filePath = tab.dataset.path;
      if (filePath && invoke) {
        const mtime = await invoke('get_file_mtime', { path: filePath }).catch(() => null);
        if (mtime == null) {
          _showFileMissing(filePath, tab.dataset.name);
          return;
        }
      }
      activateTab(tab);
    });

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab);
    });

    let _pointerDragging = false;
    let _pointerStartX   = 0;
    let _pointerReady    = false; // only true after a valid pointerdown on the tab body

    // Stop close-button pointer events from reaching the tab's drag handlers.
    // Without this, setPointerCapture can redirect the click event to the tab
    // element, causing activateTab to fire before closeTab.
    closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

    tab.addEventListener('pointerdown', (e) => {
      if (e.target === closeBtn) return;
      _pointerStartX   = e.clientX;
      _pointerDragging = false;
      _pointerReady    = true;
    });

    tab.addEventListener('pointermove', (e) => {
      if (!e.buttons || !_pointerReady) return;
      if (!_pointerDragging && Math.abs(e.clientX - _pointerStartX) > 6) {
        _pointerDragging = true;
        _draggedTab = tab;
        tab.setPointerCapture(e.pointerId);
        tab.classList.add('dragging');
      }
      if (!_pointerDragging || _draggedTab !== tab) return;
      const overEl = document.elementsFromPoint(e.clientX, e.clientY)
        .find(el => el.classList.contains('tab') && el !== tab);
      tabList.querySelectorAll('.tab.drag-target').forEach(t => t.classList.remove('drag-target'));
      if (overEl) overEl.classList.add('drag-target');
    });

    tab.addEventListener('pointerup', (e) => {
      _pointerReady = false;
      if (!_pointerDragging || _draggedTab !== tab) { _pointerDragging = false; return; }
      const target = document.elementsFromPoint(e.clientX, e.clientY)
        .find(el => el.classList.contains('tab') && el !== tab);
      tabList.querySelectorAll('.tab.drag-target').forEach(t => t.classList.remove('drag-target'));
      if (target) {
        const rect = target.getBoundingClientRect();
        tabList.insertBefore(_draggedTab, e.clientX < rect.left + rect.width / 2 ? target : target.nextSibling);
        document.dispatchEvent(new CustomEvent('ln:tabs-changed'));
      }
      tab.classList.remove('dragging');
      _draggedTab      = null;
      _pointerDragging = false;
    });

    tab.addEventListener('pointercancel', () => {
      _pointerReady = false;
      tab.classList.remove('dragging');
      tabList.querySelectorAll('.tab.drag-target').forEach(t => t.classList.remove('drag-target'));
      _draggedTab = _pointerDragging ? null : _draggedTab;
      _pointerDragging = false;
    });

    if (isNew) activateTab(tab, '');
  }

  function activateTab(tab, content = null) {
    tabList.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    const filePath = tab.dataset.path ?? null;
    const name     = tab.dataset.name;
    state.activeFile = filePath;

    const resolvedContent = content !== null
      ? content
      : filePath
        ? (state.openFiles.has(filePath) ? state.openFiles.get(filePath).content : null)
        : (state.openFiles.has(`@ut:${name}`) ? state.openFiles.get(`@ut:${name}`).content : null);

    document.dispatchEvent(new CustomEvent('ln:activate-file', {
      detail: { path: filePath, name, content: resolvedContent }
    }));
  }

  function activateByPath(filePath, content) {
    const tab = findTabByPath(filePath);
    if (tab) activateTab(tab, content);
  }

  function activateByName(name) {
    for (const tab of tabList.children) {
      if (tab.dataset.name === name) { activateTab(tab, ''); return; }
    }
  }

  function closeTab(tab) {
    if (tab.classList.contains('pinned')) return;
    const dirty = tab.querySelector('.tab-dirty').style.display !== 'none';
    if (dirty && !confirm(`Discard unsaved changes to "${tab.dataset.name}"?`)) return;

    const wasActive = tab.classList.contains('active');
    const prev      = tab.previousElementSibling;
    const next      = tab.nextElementSibling;
    const filePath  = tab.dataset.path;
    if (filePath) state.openFiles.delete(filePath);
    state.openFiles.delete(`@ut:${tab.dataset.name}`);
    tab.remove();
    document.dispatchEvent(new CustomEvent('ln:tabs-changed'));

    if (wasActive) {
      const sibling = prev || next;
      if (sibling) {
        activateTab(sibling);
      } else {
        state.activeFile = null;
        document.dispatchEvent(new CustomEvent('ln:no-active-file'));
      }
    }
  }

  function setDirty(filePath, dirty) {
    const tab = filePath ? findTabByPath(filePath) : tabList.querySelector('.tab.active');
    if (!tab) return;
    tab.querySelector('.tab-dirty').style.display = dirty ? '' : 'none';
    document.dispatchEvent(new CustomEvent('ln:dirty-changed'));
  }

  function closeActiveTab() {
    const active = tabList.querySelector('.tab.active');
    if (active) closeTab(active);
  }

  function closeAll() {
    for (const tab of [...tabList.querySelectorAll('.tab')]) {
      if (tab.classList.contains('pinned')) continue;
      const dirty = tab.querySelector('.tab-dirty').style.display !== 'none';
      if (dirty && !confirm(`Discard unsaved changes to "${tab.dataset.name}"?`)) continue;
      if (tab.dataset.path) state.openFiles.delete(tab.dataset.path);
      state.openFiles.delete(`@ut:${tab.dataset.name}`);
      tab.remove();
    }
    const remaining = tabList.querySelector('.tab');
    if (remaining) {
      activateTab(remaining);
    } else {
      state.activeFile = null;
      document.dispatchEvent(new CustomEvent('ln:no-active-file'));
    }
    document.dispatchEvent(new CustomEvent('ln:tabs-changed'));
  }

  function togglePin(tab) {
    const pinned = tab.classList.toggle('pinned');
    tab.querySelector('.tab-pin-icon').style.display = pinned ? '' : 'none';
    tab.querySelector('.tab-close').style.display    = pinned ? 'none' : '';
    document.dispatchEvent(new CustomEvent('ln:tabs-changed'));
  }

  function togglePinByPath(path) {
    const tab = path ? findTabByPath(path) : tabList.querySelector('.tab.active');
    if (tab) togglePin(tab);
  }

  function setPinnedByPath(path) {
    const tab = findTabByPath(path);
    if (tab && !tab.classList.contains('pinned')) togglePin(tab);
  }

  function renameTab(oldPath, newPath, newName) {
    const tab = oldPath ? findTabByPath(oldPath) : tabList.querySelector('.tab.active');
    if (!tab) return;
    tab.dataset.path = newPath;
    tab.dataset.name = newName;
    tab.querySelector('.tab-name').textContent = newName;
    tab.querySelector('.tab-dirty').style.display = 'none';
  }

  // Path-safe tab lookup — avoids CSS selector escaping issues with backslashes
  function findTabByPath(path) {
    for (const tab of tabList.children) {
      if (tab.dataset.path === path) return tab;
    }
    return null;
  }

  // Restore an untitled tab by name (content already placed in state.openFiles by autosave restore)
  function restoreUntitled(name) {
    if ([...tabList.children].some(t => t.dataset.name === name)) return; // already open
    createTab(null, name, false);
    // Keep tabIdSeq in sync so new tabs don't collide
    const num = parseInt(name.replace('untitled-', ''), 10);
    if (!isNaN(num) && num >= tabIdSeq) tabIdSeq = num;
  }

  function notifyFileMissing(path) { _showFileMissing(path, null); }

  return { openFile, newUntitled, restoreUntitled, setDirty, closeActiveTab, closeAll, renameTab, togglePinByPath, setPinnedByPath, notifyFileMissing };
}
