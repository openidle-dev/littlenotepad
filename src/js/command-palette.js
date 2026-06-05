const invoke = window.__TAURI__?.core.invoke;

export function initCommandPalette(state, { fileTree, tabs, editor, terminal, findReplace, globalFind }) {
  const overlay     = document.getElementById('command-palette');
  const backdrop    = document.getElementById('palette-backdrop');
  const inputEl     = document.getElementById('palette-input');
  const resultsList = document.getElementById('palette-results');

  let focusedIdx   = -1;
  let mode         = 'command'; // 'command' | 'file'
  let allFiles     = [];
  let recentCmds   = [];

  const commands = [
    { label: 'Open Folder',        kbd: 'Ctrl+K O',       run: () => fileTree.openFolder() },
    { label: 'Open File',          kbd: 'Ctrl+O',         run: () => fileTree.openSingleFile() },
    { label: 'Close Folder',       kbd: '',               run: () => fileTree.closeFolder() },
    { label: 'New File',           kbd: 'Ctrl+N',         run: () => tabs.newUntitled() },
    { label: 'Save File',          kbd: 'Ctrl+S',         run: () => editor.saveActive() },
    { label: 'Save As',            kbd: 'Ctrl+Shift+S',   run: () => editor.saveAs() },
    { label: 'Close Tab',          kbd: 'Ctrl+W',         run: () => tabs.closeActiveTab() },
    { label: 'Close All Tabs',     kbd: '',               run: () => tabs.closeAll() },
    { label: 'Find',               kbd: 'Ctrl+F',         run: () => findReplace.open('find') },
    { label: 'Find and Replace',   kbd: 'Ctrl+H',         run: () => findReplace.open('replace') },
    { label: 'Find in Files',      kbd: 'Ctrl+Shift+F',   run: () => globalFind.open() },
    { label: 'Go to Line',         kbd: 'Ctrl+G',         run: () => editor.openGoToLine() },
    { label: 'Toggle Word Wrap',   kbd: 'Alt+Z',          run: () => editor.toggleWordWrap() },
    { label: 'Go to File',         kbd: 'Ctrl+P',         run: () => open('file') },
    { label: 'Toggle Terminal',    kbd: 'Ctrl+`',         run: () => terminal.toggle() },
    { label: 'Show Terminal',      kbd: '',               run: () => terminal.show() },
    { label: 'Hide Terminal',      kbd: '',               run: () => terminal.hide() },
  ];

  async function open(openMode = 'command') {
    mode = openMode;
    overlay.style.display = 'block';
    inputEl.value = '';
    focusedIdx = -1;

    if (mode === 'file') {
      inputEl.placeholder = 'Go to File…';
      await loadFiles();
      renderFiles(allFiles);
    } else {
      inputEl.placeholder = 'Type a command…';
      renderCommands([...recentCmds, ...commands]);
    }

    inputEl.focus();
  }

  function close() {
    overlay.style.display = 'none';
    focusedIdx = -1;
  }

  backdrop.addEventListener('click', close);

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }

    const items = resultsList.querySelectorAll('.palette-item');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIdx = Math.min(focusedIdx + 1, items.length - 1);
      applyFocus(items);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIdx = Math.max(focusedIdx - 1, 0);
      applyFocus(items);
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const focused = resultsList.querySelector('.palette-item.focused');
      if (focused) { close(); focused._run(); }
    }
  });

  inputEl.addEventListener('input', () => {
    const q   = inputEl.value.toLowerCase().trim();
    const all = mode === 'file' ? null : [...recentCmds, ...commands];
    if (mode === 'file') {
      const hits = q
        ? allFiles.filter(f => basename(f).toLowerCase().includes(q))
        : allFiles;
      renderFiles(hits.slice(0, 60));
    } else {
      const hits = q ? all.filter(c => c.label.toLowerCase().includes(q)) : all;
      renderCommands(hits);
    }
  });

  async function loadFiles() {
    if (!invoke || !state.folderPath) { allFiles = []; return; }
    try {
      allFiles = await invoke('list_all_files', { path: state.folderPath, maxDepth: 10 });
    } catch {
      allFiles = [];
    }
  }

  function renderCommands(list) {
    focusedIdx = list.length ? 0 : -1;
    resultsList.innerHTML = '';
    list.forEach((cmd, i) => {
      const li = document.createElement('li');
      li.className = 'palette-item' + (i === 0 ? ' focused' : '');

      const labelSpan = document.createElement('span');
      labelSpan.className = 'palette-item-label';
      labelSpan.textContent = cmd.label;

      const kbdSpan = document.createElement('span');
      kbdSpan.className = 'palette-item-kbd';
      if (cmd.kbd) {
        cmd.kbd.split(' ').forEach(k => {
          const el = document.createElement('kbd');
          el.textContent = k;
          kbdSpan.appendChild(el);
        });
      }

      li.append(labelSpan, kbdSpan);
      li._run = cmd.run;
      li.addEventListener('click', () => { close(); cmd.run(); });
      li.addEventListener('mousemove', () => {
        focusedIdx = i;
        applyFocus(resultsList.querySelectorAll('.palette-item'));
      });
      resultsList.appendChild(li);
    });
  }

  function renderFiles(files) {
    focusedIdx = files.length ? 0 : -1;
    resultsList.innerHTML = '';

    if (!files.length) {
      const li = document.createElement('li');
      li.className = 'palette-item';
      li.style.color = 'var(--fg-muted)';
      li.style.fontStyle = 'italic';
      li.style.pointerEvents = 'none';
      li.textContent = state.folderPath ? 'No files found' : 'Open a folder first (Ctrl+K O)';
      resultsList.appendChild(li);
      return;
    }

    files.forEach((filePath, i) => {
      const name = basename(filePath);
      const rel  = state.folderPath
        ? filePath.slice(state.folderPath.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
        : filePath.replace(/\\/g, '/');

      const li = document.createElement('li');
      li.className = 'palette-item' + (i === 0 ? ' focused' : '');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'palette-item-label';
      nameSpan.textContent = name;

      const pathSpan = document.createElement('span');
      pathSpan.className = 'palette-item-path';
      pathSpan.textContent = rel;

      li.append(nameSpan, pathSpan);
      li._run = () => tabs.openFile(filePath, name);

      li.addEventListener('click', () => { close(); li._run(); });
      li.addEventListener('mousemove', () => {
        focusedIdx = i;
        applyFocus(resultsList.querySelectorAll('.palette-item'));
      });
      resultsList.appendChild(li);
    });
  }

  function applyFocus(items) {
    items.forEach((el, i) => el.classList.toggle('focused', i === focusedIdx));
    items[focusedIdx]?.scrollIntoView({ block: 'nearest' });
  }

  function basename(path) {
    return path.replace(/\\/g, '/').split('/').pop() ?? path;
  }

  function setRecentFolders(list) {
    recentCmds = (Array.isArray(list) ? list : []).filter(Boolean).map(p => ({
      label: `Open Recent: ${p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p}`,
      kbd: '',
      run: () => fileTree.openFolder(p),
    }));
  }

  return { open, close, setRecentFolders };
}
