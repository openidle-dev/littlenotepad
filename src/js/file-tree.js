import { detectLanguage } from './syntax.js';

const invoke = window.__TAURI__?.core.invoke;

export function initFileTree(state, tabs, editor, splitPane = null) {
  const treeEl        = document.getElementById('file-tree');
  const sidebarEmpty  = document.getElementById('sidebar-empty');
  const workspaceRoot = document.getElementById('workspace-root');
  const workspaceName = document.getElementById('workspace-name');

  const expandedPaths = new Set(JSON.parse(localStorage.getItem('ln:tree-expanded') || '[]'));

  let _gitStatus = {};

  async function refreshGitStatus() {
    if (!state.folderPath || !invoke) return;
    try {
      _gitStatus = await invoke('git_status', { path: state.folderPath });
      applyGitStatus();
    } catch (_) {}
  }

  function applyGitStatus() {
    if (!state.folderPath) return;
    const root = normPath(state.folderPath);
    treeEl.querySelectorAll('.tree-item[data-type="file"]').forEach(item => {
      const rel = normPath(item.dataset.path).slice(root.length + 1);
      const st  = _gitStatus[rel];
      let badge = item.querySelector('.git-status-badge');
      if (st) {
        if (!badge) {
          badge = document.createElement('span');
          item.appendChild(badge);
        }
        badge.className = `git-status-badge git-${st.toLowerCase()}`;
        badge.textContent = st;
      } else if (badge) {
        badge.remove();
      }
    });
  }

  setInterval(refreshGitStatus, 10_000);
  window.addEventListener('focus', refreshGitStatus);
  function saveExpandedPaths() {
    localStorage.setItem('ln:tree-expanded', JSON.stringify([...expandedPaths]));
  }

  document.getElementById('btn-open-folder').addEventListener('click', openFolder);
  document.getElementById('btn-open-folder-2').addEventListener('click', openFolder);
  document.getElementById('btn-open-file').addEventListener('click', openSingleFile);
  document.getElementById('btn-open-file-2').addEventListener('click', openSingleFile);
  document.getElementById('btn-close-folder').addEventListener('click', closeFolder);

  document.getElementById('btn-new-file').addEventListener('click', () => {
    if (!state.folderPath) return;
    startNew('file', state.folderPath, treeEl, 0, null);
  });
  document.getElementById('btn-new-folder').addEventListener('click', () => {
    if (!state.folderPath) return;
    startNew('folder', state.folderPath, treeEl, 0, null);
  });

  async function openFolder(path) {
    if (!invoke) { console.warn('Tauri not available'); return; }
    const picked = typeof path === 'string' ? path : await invoke('pick_folder').catch(() => null);
    if (!picked) return;
    state.folderPath = picked;
    treeEl.innerHTML = '';
    showWorkspace(picked);
    await loadDir(picked, treeEl, 0);
    refreshGitStatus();
    document.dispatchEvent(new CustomEvent('ln:folder-opened', { detail: { path: picked } }));
    invoke('save_pref', { key: 'lastFolder', value: picked }).catch(() => {});
  }

  async function openSingleFile() {
    if (!invoke) return;
    const path = await invoke('pick_file').catch(() => null);
    if (!path) return;
    const name = path.replace(/\\/g, '/').split('/').pop() || path;
    tabs.openFile(path, name);
  }

  function closeFolder() {
    state.folderPath = null;
    treeEl.innerHTML = '';
    workspaceRoot.style.display = 'none';
    sidebarEmpty.style.display  = '';
    expandedPaths.clear();
    saveExpandedPaths();
  }

  function showWorkspace(path) {
    const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path;
    workspaceName.textContent  = name.toUpperCase();
    sidebarEmpty.style.display = 'none';
    workspaceRoot.style.display = 'block';
  }

  async function loadDir(dirPath, container, depth) {
    let entries;
    try {
      entries = await invoke('list_dir', { path: dirPath });
    } catch (err) {
      const errEl = document.createElement('div');
      errEl.className = 'tree-item';
      errEl.style.paddingLeft = (depth * 12 + 8) + 'px';
      errEl.style.color = '#f48771';
      errEl.textContent = `Error: ${err}`;
      container.appendChild(errEl);
      return;
    }
    for (const entry of entries) await renderEntry(entry, container, depth);
  }

  async function renderEntry(entry, container, depth) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.paddingLeft = (depth * 12 + 8) + 'px';
    item.dataset.path = entry.path;
    item.dataset.type = entry.is_dir ? 'dir' : 'file';

    const icon  = document.createElement('span');
    icon.className = 'tree-icon';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = entry.name;

    item.appendChild(icon);
    item.appendChild(label);

    if (entry.is_dir) {
      icon.textContent = '▶';
      const children = document.createElement('div');
      children.className = 'tree-children';
      children.style.display = 'none';
      let loaded = false;

      if (expandedPaths.has(entry.path)) {
        icon.classList.add('open');
        children.style.display = 'block';
        loaded = true;
        await loadDir(entry.path, children, depth + 1);
      }

      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const open = icon.classList.contains('open');
        icon.classList.toggle('open', !open);
        children.style.display = open ? 'none' : 'block';
        if (!open) {
          expandedPaths.add(entry.path);
          if (!loaded) { loaded = true; await loadDir(entry.path, children, depth + 1); }
        } else {
          expandedPaths.delete(entry.path);
        }
        saveExpandedPaths();
      });

      container.appendChild(item);
      container.appendChild(children);
    } else {
      icon.innerHTML = fileIcon(entry.name);

      const rel = normPath(entry.path).slice(normPath(state.folderPath || '').length + 1);
      const st  = _gitStatus[rel];
      if (st) {
        const badge = document.createElement('span');
        badge.className = `git-status-badge git-${st.toLowerCase()}`;
        badge.textContent = st;
        item.appendChild(badge);
      }

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('#file-tree .tree-item.active').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        if (splitPane?.getFocusedPane() === 'b') {
          splitPane.openInPaneB(entry.path, entry.name);
        } else {
          tabs.openFile(entry.path, entry.name);
        }
      });
      container.appendChild(item);
    }
  }

  function showInlineInput(container, depth, callback) {
    const inputItem = document.createElement('div');
    inputItem.className = 'tree-item tree-input-item';
    inputItem.style.paddingLeft = (depth * 12 + 8) + 'px';

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.innerHTML = '<span style="color:#858585">·</span>';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tree-inline-input';
    input.autocomplete = 'off';
    input.spellcheck = false;

    inputItem.appendChild(icon);
    inputItem.appendChild(input);
    container.prepend(inputItem);

    let done = false;

    // Double-RAF: wait for layout + paint so WebView2 reliably accepts focus
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!done) input.focus();
      });
    });

    async function confirm() {
      if (done) return;
      done = true;
      const name = input.value.trim();
      inputItem.remove();
      if (name) await callback(name);
    }

    function cancel() {
      if (done) return;
      done = true;
      inputItem.remove();
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); confirm(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    });

    input.addEventListener('blur', () => setTimeout(cancel, 300));
  }

  // Listen on workspaceRoot so right-clicking the folder header also works
  workspaceRoot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const treeItem = e.target.closest('.tree-item');

    if (!treeItem || treeItem.classList.contains('tree-input-item')) {
      if (!state.folderPath) return;
      showTreeCtx([
        { label: 'New File',   run: () => startNew('file',   state.folderPath, treeEl, 0, null) },
        { label: 'New Folder', run: () => startNew('folder', state.folderPath, treeEl, 0, null) },
      ], e.clientX, e.clientY);
      return;
    }

    const path  = treeItem.dataset.path;
    const isDir = treeItem.dataset.type === 'dir';
    const name  = path.replace(/\\/g, '/').split('/').pop();
    const depth = Math.round((parseInt(treeItem.style.paddingLeft || '8', 10) - 8) / 12);

    const menuItems = isDir
      ? [
          { label: 'New File',   run: () => startNew('file',   path, treeItem.nextElementSibling, depth + 1, treeItem) },
          { label: 'New Folder', run: () => startNew('folder', path, treeItem.nextElementSibling, depth + 1, treeItem) },
          'sep',
          { label: 'Rename', run: () => renameItem(treeItem, path, name) },
          { label: 'Delete', run: () => deleteItem(path, name) },
        ]
      : [
          { label: 'Open', run: () => tabs.openFile(path, name) },
          { label: 'Open to the Side', run: () => splitPane ? splitPane.openInPaneB(path, name) : tabs.openFile(path, name) },
          'sep',
          { label: 'New File', run: () => {
              const parentPath = normPath(path).split('/').slice(0, -1).join('/') || normPath(state.folderPath || '');
              startNew('file', parentPath, treeItem.parentElement, depth, null);
            }
          },
          'sep',
          { label: 'Rename', run: () => renameItem(treeItem, path, name) },
          { label: 'Delete', run: () => deleteItem(path, name) },
        ];

    showTreeCtx(menuItems, e.clientX, e.clientY);
  });

  function startNew(kind, dirPath, container, depth, dirItem) {
    if (container && dirItem) {
      container.style.display = 'block';
      const icon = dirItem.querySelector('.tree-icon');
      if (icon) icon.classList.add('open');
    }
    showInlineInput(container || treeEl, depth, async (name) => {
      const sep  = dirPath.includes('\\') ? '\\' : '/';
      const full = dirPath + sep + name;
      try {
        if (kind === 'file') {
          await invoke('create_file_cmd', { path: full });
          await refreshDir(dirPath);
          tabs.openFile(full, name);
        } else {
          await invoke('create_dir_cmd', { path: full });
          await refreshDir(dirPath);
        }
      } catch (err) { alert(`Error: ${err}`); }
    });
  }

  function showTreeCtx(items, x, y) {
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    for (const item of items) {
      if (item === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'ctx-item';
      const lbl = document.createElement('span');
      lbl.textContent = item.label;
      btn.appendChild(lbl);
      btn.addEventListener('mousedown', ev => ev.preventDefault());
      btn.addEventListener('click', () => {
        menu.style.display = 'none';
        item.run();
      });
      menu.appendChild(btn);
    }
    menu.style.left = '-9999px'; menu.style.top = '-9999px';
    menu.style.display = 'block';
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth  - rect.width  - 4) + 'px';
    menu.style.top  = Math.min(y, window.innerHeight - rect.height - 4) + 'px';
  }

  function renameItem(treeItem, path, oldName) {
    const label = treeItem.querySelector('.tree-label');
    if (!label) return;
    const originalText = label.textContent;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tree-inline-input';
    input.value = oldName;
    input.autocomplete = 'off';
    input.spellcheck = false;
    label.replaceWith(input);

    requestAnimationFrame(() => { requestAnimationFrame(() => { input.focus(); input.select(); }); });

    let done = false;

    function restoreLabel(text) {
      const span = document.createElement('span');
      span.className = 'tree-label';
      span.textContent = text;
      if (input.parentNode) input.replaceWith(span);
    }

    async function confirmRename() {
      if (done) return;
      done = true;
      const newName = input.value.trim();
      restoreLabel(newName || originalText);
      if (!newName || newName === oldName) return;
      const sep   = path.includes('\\') ? '\\' : '/';
      const parts = path.replace(/\\/g, '/').split('/');
      parts[parts.length - 1] = newName;
      const newPath = parts.join(sep);
      const parent  = normPath(path).split('/').slice(0, -1).join('/');
      try {
        await invoke('rename_path', { oldPath: path, newPath });
        if (state.openFiles.has(path)) {
          state.openFiles.set(newPath, state.openFiles.get(path));
          state.openFiles.delete(path);
        }
        if (state.activeFile === path) state.activeFile = newPath;
        tabs.renameTab(path, newPath, newName);
        await refreshDir(parent);
      } catch (err) { alert(`Error: ${err}`); }
    }

    function cancelRename() {
      if (done) return;
      done = true;
      restoreLabel(originalText);
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); confirmRename(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRename(); }
    });
    input.addEventListener('blur', () => setTimeout(cancelRename, 300));
  }

  async function deleteItem(path, name) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const parent = normPath(path).split('/').slice(0, -1).join('/');
    try {
      await invoke('delete_path', { path });
      await refreshDir(parent);
    } catch (err) { alert(`Error: ${err}`); }
  }

  async function refreshDir(dirPath) {
    if (!state.folderPath) return;
    const nDir  = normPath(dirPath);
    const nRoot = normPath(state.folderPath);

    if (nDir === nRoot) {
      treeEl.innerHTML = '';
      await loadDir(state.folderPath, treeEl, 0);
      applyGitStatus();
      return;
    }

    let found = null;
    for (const el of treeEl.querySelectorAll('.tree-item[data-type="dir"]')) {
      if (normPath(el.dataset.path) === nDir) { found = el; break; }
    }

    if (found) {
      const children = found.nextElementSibling;
      if (children?.classList.contains('tree-children')) {
        children.innerHTML = '';
        const pd = Math.round((parseInt(found.style.paddingLeft || '8', 10) - 8) / 12);
        await loadDir(found.dataset.path, children, pd + 1);
        children.style.display = 'block';
        const icon = found.querySelector('.tree-icon');
        if (icon) icon.classList.add('open');
        return;
      }
    }

    treeEl.innerHTML = '';
    await loadDir(state.folderPath, treeEl, 0);
    applyGitStatus();
  }

  function normPath(p) { return p.replace(/\\/g, '/'); }

  function fileIcon(name) {
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    const iconMap = {
      js:    ['JS',  '#f7df1e'], mjs:  ['JS',  '#f7df1e'], cjs:  ['JS',  '#f7df1e'],
      ts:    ['TS',  '#3178c6'], tsx:  ['TSX', '#61dafb'], jsx:  ['JSX', '#61dafb'],
      rs:    ['RS',  '#ce422b'],
      py:    ['PY',  '#4b8bbe'], pyw:  ['PY',  '#4b8bbe'],
      html:  ['HT',  '#e44d26'], htm:  ['HT',  '#e44d26'],
      css:   ['CS',  '#264de4'], scss: ['SC',  '#c6538c'], sass: ['SA',  '#c6538c'],
      json:  ['{}',  '#cbcb41'], jsonc: ['{}', '#cbcb41'],
      xml:   ['XM',  '#f48771'],
      yaml:  ['YL',  '#cb171e'], yml:  ['YL',  '#cb171e'],
      toml:  ['TM',  '#9c4221'],
      csv:   ['CV',  '#89d185'],
      md:    ['MD',  '#4ec9b0'], mdx:  ['MDX', '#4ec9b0'],
      txt:   ['TX',  '#858585'],
      go:    ['GO',  '#00add8'],
      sh:    ['SH',  '#89d185'], bash: ['SH',  '#89d185'], zsh: ['SH', '#89d185'],
      fish:  ['SH',  '#89d185'], ps1:  ['PS',  '#5391fe'],
      c:     ['C',   '#a8b9cc'], h:    ['H',   '#a8b9cc'],
      cpp:   ['C++', '#9c33c2'], cc:   ['C++', '#9c33c2'], cxx: ['C++', '#9c33c2'],
      hpp:   ['H++', '#9c33c2'],
      java:  ['JV',  '#b07219'],
      rb:    ['RB',  '#cc342d'],
      php:   ['PH',  '#8892bf'],
      swift: ['SW',  '#f05138'],
      kt:    ['KT',  '#7f52ff'], kts: ['KT',  '#7f52ff'],
      cs:    ['C#',  '#9b4f96'],
      lua:   ['LU',  '#000080'],
      r:     ['R',   '#276dc3'],
      dart:  ['DA',  '#0175c2'],
      ex:    ['EX',  '#6e4a7e'], exs: ['EX',  '#6e4a7e'],
      sql:   ['SQ',  '#e38d13'],
      env:   ['EV',  '#ecc94b'],
      lock:  ['LK',  '#858585'],
      svg:   ['SV',  '#ffb13b'],
      vue:   ['VU',  '#41b883'],
      astro: ['AS',  '#ff5d01'],
      dockerfile: ['DO', '#2496ed'],
    };
    const base = name.toLowerCase();
    if (base === '.gitignore' || base === '.gitattributes') return _icon('GI', '#f05133');
    if (base === '.env' || base.startsWith('.env.'))         return _icon('EV', '#ecc94b');
    if (base === 'dockerfile')                               return _icon('DO', '#2496ed');
    if (base === 'makefile' || base === 'gnumakefile')       return _icon('MK', '#6d8086');

    const entry = iconMap[ext];
    return entry ? _icon(entry[0], entry[1]) : '<span style="color:#858585;font-size:10px">·</span>';
  }

  function _icon(label, color) {
    return `<span class="file-icon-badge" style="color:${color}">${label}</span>`;
  }

  return { openFolder, openSingleFile, closeFolder, loadDir, refreshDir };
}
