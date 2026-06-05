const invoke = window.__TAURI__?.core.invoke;

const CATEGORY_COLORS = {
  'Editor':          '#007acc',
  'Source Control':  '#f05033',
  'Terminal':        '#569cd6',
  'Formatter':       '#c678dd',
  'Linter':          '#d19a66',
  'Language Server': '#98c379',
  'Runtime':         '#56b6c2',
};

// One entry per language. LSP auto-starts when a matching file is opened.
export const LSP_SERVERS = [
  {
    id:         'python',
    name:       'Python',
    langId:     'python',
    icon:       '🐍',
    desc:       'Completions, diagnostics, hover, and code actions (Extract Variable/Method) for Python files.',
    binary:     'pylsp',
    args:       [],
    package:    'python-lsp-server',
    install:    'pip install python-lsp-server pyflakes pylsp-rope',
    uninstall:  'pip uninstall -y python-lsp-server pyflakes pylsp-rope',
    extensions: ['.py'],
  },
  {
    id:         'rust',
    name:       'Rust',
    langId:     'rust',
    icon:       '🦀',
    desc:       'Completions, diagnostics, and hover for Rust files.',
    binary:     'rust-analyzer',
    args:       [],
    package:    'rust-analyzer (via rustup)',
    install:    'rustup component add rust-analyzer',
    uninstall:  'rustup component remove rust-analyzer',
    extensions: ['.rs'],
  },
  {
    id:         'javascript',
    name:       'JavaScript / TypeScript',
    langId:     null,
    icon:       '🟨',
    desc:       'Completions, diagnostics, and hover for JS, TS, JSX, and TSX files.',
    binary:     'typescript-language-server',
    args:       ['--stdio'],
    package:    'typescript-language-server (via npm)',
    install:    'npm install -g typescript typescript-language-server',
    uninstall:  'npm uninstall -g typescript typescript-language-server',
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'],
  },
];

const _probed   = {};  // id → { installed, version, path }
const _disabled = {};  // id → bool — persisted in prefs

let _lspClient = null;
export function setLspClient(client) { _lspClient = client; }
export function isLspDisabled(id)    { return !!_disabled[id]; }

async function _saveDisabled() {
  await invoke?.('save_pref', { key: 'lsp_disabled', value: JSON.stringify(_disabled) }).catch(() => {});
}

async function detectServers() {
  if (!invoke) return;
  await Promise.all(LSP_SERVERS.map(async s => {
    try { _probed[s.id] = await invoke('lsp_probe', { name: s.binary }); }
    catch { _probed[s.id] = { installed: false, version: '', path: '' }; }
  }));
}

const APPS = [
  { id: 'minimap',          name: 'Minimap',             version: '1.0.0', category: 'Editor',         builtin: true,  desc: 'Visual code overview panel on the right side of the editor.' },
  { id: 'breadcrumb',       name: 'Breadcrumb Bar',      version: '1.0.0', category: 'Editor',         builtin: true,  desc: 'File path breadcrumb displayed above the editor area.' },
  { id: 'code-folding',     name: 'Code Folding',        version: '1.0.0', category: 'Editor',         builtin: true,  desc: 'Collapse and expand { } blocks, comment blocks, and import groups.' },
  { id: 'multi-cursor',     name: 'Multiple Cursors',    version: '1.0.0', category: 'Editor',         builtin: true,  desc: 'Alt+Click, Ctrl+D, Ctrl+Alt+Up/Down for simultaneous editing.' },
  { id: 'markdown-preview', name: 'Markdown Preview',    version: '1.0.0', category: 'Editor',         builtin: true,  desc: 'Live Markdown render in a split pane for .md files.' },
  { id: 'word-count',       name: 'Word Count',          version: '1.0.0', category: 'Editor',         builtin: true,  desc: 'Word count and reading time displayed in the status bar.' },
  { id: 'file-watcher',     name: 'File Watcher',        version: '1.0.0', category: 'Editor',         builtin: true,  desc: 'Detects when files change on disk and prompts to reload.' },
  { id: 'autosave',         name: 'Auto Save',           version: '1.0.0', category: 'Editor',         builtin: true,  desc: 'Periodically saves dirty and untitled files to a backup location.' },
  { id: 'git-status',       name: 'Git Status',          version: '1.0.0', category: 'Source Control', builtin: true,  desc: 'M / A / D / U markers next to modified files in the explorer.' },
  { id: 'terminal',         name: 'Integrated Terminal', version: '1.0.0', category: 'Terminal',       builtin: true,  desc: 'Multi-session terminal supporting CMD, PowerShell and Git Bash.' },
];

let _state = {};  // { [id]: boolean } — true = enabled

function _applyToggle(id, enabled) {
  switch (id) {
    case 'minimap': {
      const el = document.getElementById('minimap');
      if (el) el.style.display = enabled ? '' : 'none';
      break;
    }
    case 'breadcrumb': {
      const el = document.getElementById('breadcrumb-bar');
      if (el && !enabled) el.style.display = 'none';
      break;
    }
    case 'code-folding': {
      const el = document.getElementById('fold-gutter');
      if (el) el.style.display = enabled ? '' : 'none';
      break;
    }
    case 'word-count': {
      const el = document.getElementById('status-wordcount');
      if (el) el.style.display = enabled ? '' : 'none';
      break;
    }
  }
  document.dispatchEvent(new CustomEvent('ln:app-toggled', { detail: { id, enabled } }));
}

async function _saveState() {
  if (!invoke) return;
  try { await invoke('save_pref', { key: 'apps', value: JSON.stringify(_state) }); } catch {}
}

export function initApps() {
  const overlay    = document.getElementById('apps-overlay');
  const closeBtn   = document.getElementById('apps-close');
  const triggerBtn = document.getElementById('btn-apps');
  const searchEl   = document.getElementById('apps-search');
  const listEl     = document.getElementById('apps-list');

  (async () => {
    try {
      const raw = invoke ? await invoke('load_pref', { key: 'apps' }).catch(() => null) : null;
      if (raw) _state = JSON.parse(raw);
    } catch {}
    for (const app of APPS) {
      if (app.builtin && _state[app.id] === undefined) _state[app.id] = true;
    }
    for (const app of APPS) {
      if (app.builtin && _state[app.id] === false) _applyToggle(app.id, false);
    }
    try {
      const raw = invoke ? await invoke('load_pref', { key: 'lsp_disabled' }).catch(() => null) : null;
      if (raw) Object.assign(_disabled, JSON.parse(raw));
    } catch {}
  })();

  let _query = '';

  function _renderLspRow(srv) {
    const probe     = _probed[srv.id] ?? { installed: false, version: '', path: '' };
    const installed = probe.installed;

    const row = document.createElement('div');
    row.className = 'apps-row';

    const icon = document.createElement('div');
    icon.className = 'apps-icon apps-icon--lang';
    icon.textContent = srv.icon;
    row.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'apps-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'apps-name-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'apps-name';
    nameEl.textContent = srv.name;
    nameRow.appendChild(nameEl);

    const isDisabled = installed && !!_disabled[srv.id];
    const badge = document.createElement('span');
    badge.className = `apps-lsp-badge ${!installed ? 'badge--none' : isDisabled ? 'badge--disabled' : 'badge--installed'}`;
    badge.textContent = !installed ? 'not installed' : isDisabled ? 'disabled' : 'installed';
    nameRow.appendChild(badge);

    info.appendChild(nameRow);

    const pkgEl = document.createElement('div');
    pkgEl.className = 'apps-package';
    pkgEl.textContent = installed && probe.version
      ? `${srv.package}  ·  ${probe.version}`
      : srv.package;
    info.appendChild(pkgEl);

    const descEl = document.createElement('div');
    descEl.className = 'apps-desc';
    descEl.textContent = srv.desc;
    info.appendChild(descEl);

    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'apps-actions';

    if (!installed) {
      const btn = document.createElement('button');
      btn.className = 'apps-btn apps-btn--install';
      btn.textContent = 'Install';
      btn.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('ln:run-in-terminal', { detail: { cmd: srv.install } }));
        close();
      });
      actions.appendChild(btn);
    } else {
      const isDisabled = !!_disabled[srv.id];

      const toggleBtn = document.createElement('button');
      toggleBtn.className = `apps-btn ${isDisabled ? 'apps-btn--enable' : 'apps-btn--disable'}`;
      toggleBtn.textContent = isDisabled ? 'Enable' : 'Disable';
      toggleBtn.addEventListener('click', async () => {
        _disabled[srv.id] = !isDisabled;
        if (_disabled[srv.id] && _lspClient?.running) await _lspClient.stop();
        await _saveDisabled();
        _render();
      });
      actions.appendChild(toggleBtn);

      const unBtn = document.createElement('button');
      unBtn.className = 'apps-btn apps-btn--uninstall';
      unBtn.textContent = 'Uninstall';
      unBtn.addEventListener('click', () => {
        if (_lspClient?.running) _lspClient.stop();
        document.dispatchEvent(new CustomEvent('ln:run-in-terminal', { detail: { cmd: srv.uninstall } }));
        close();
      });
      actions.appendChild(unBtn);
    }

    row.appendChild(actions);
    return row;
  }

  function _render() {
    listEl.innerHTML = '';

    const lspServers = LSP_SERVERS.filter(s => {
      if (!_query) return true;
      const q = _query.toLowerCase();
      return s.name.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q) || s.category.toLowerCase().includes(q);
    });

    if (lspServers.length) {
      const header = document.createElement('div');
      header.className = 'apps-section-header';
      header.textContent = 'Language Servers';
      listEl.appendChild(header);
      for (const srv of lspServers) listEl.appendChild(_renderLspRow(srv));
    }

    const builtinApps = APPS.filter(a => !a.builtin).filter(a => {
      if (!_query) return true;
      const q = _query.toLowerCase();
      return a.name.toLowerCase().includes(q) || a.category.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q);
    });

    if (!lspServers.length && !builtinApps.length) {
      const empty = document.createElement('div');
      empty.className = 'apps-empty';
      empty.textContent = _query ? 'No apps match your search.' : 'No apps currently available.';
      listEl.appendChild(empty);
      return;
    }

    for (const app of builtinApps) {
      const enabled = app.builtin ? (_state[app.id] !== false) : false;
      const color   = CATEGORY_COLORS[app.category] ?? '#607d8b';

      const row = document.createElement('div');
      row.className = 'apps-row';

      const icon = document.createElement('div');
      icon.className = 'apps-icon';
      icon.style.background = color;
      icon.textContent = app.name[0].toUpperCase();
      row.appendChild(icon);

      const info = document.createElement('div');
      info.className = 'apps-info';
      const nameRow = document.createElement('div');
      nameRow.className = 'apps-name-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'apps-name';
      nameEl.textContent = app.name;
      nameRow.appendChild(nameEl);
      const verEl = document.createElement('span');
      verEl.className = 'apps-version';
      verEl.textContent = `v${app.version}`;
      nameRow.appendChild(verEl);
      const catEl = document.createElement('span');
      catEl.className = 'apps-category';
      catEl.textContent = app.category;
      nameRow.appendChild(catEl);
      info.appendChild(nameRow);
      const descEl = document.createElement('div');
      descEl.className = 'apps-desc';
      descEl.textContent = app.desc;
      info.appendChild(descEl);
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'apps-actions';
      const toggleBtn = document.createElement('button');
      toggleBtn.className = `apps-btn ${enabled ? 'apps-btn--disable' : 'apps-btn--enable'}`;
      toggleBtn.textContent = enabled ? 'Disable' : 'Enable';
      toggleBtn.addEventListener('click', () => {
        const newEnabled = !enabled;
        _state[app.id] = newEnabled;
        _applyToggle(app.id, newEnabled);
        _saveState();
        _render();
      });
      actions.appendChild(toggleBtn);
      row.appendChild(actions);
      listEl.appendChild(row);
    }
  }

  async function open() {
    overlay.style.display = 'flex';
    searchEl.value = '';
    _query = '';
    _render(); // render immediately with cached state
    await detectServers();
    _render(); // re-render with fresh detection
    setTimeout(() => searchEl.focus(), 40);
  }


  function close() { overlay.style.display = 'none'; }

  searchEl?.addEventListener('input', () => { _query = searchEl.value; _render(); });
  triggerBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  return { open, close };
}
