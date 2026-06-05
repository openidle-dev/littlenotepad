const invoke = window.__TAURI__?.core.invoke;

const DEFAULTS = { fontSize: 14, termFontSize: 13, tabSize: 2, indentType: 'spaces', wordWrap: false, mdPreview: true, rulerCol: 0, theme: 'dark', launchTerminalOnStartup: false, defaultShell: '', updateChannel: 'stable', autoSave: true, autoSaveInterval: 30, autoSavePath: '' };
let _s = { ...DEFAULTS };

export function getSettings() { return { ..._s }; }

export async function loadSettings() {
  if (!invoke) return { ..._s };
  try {
    const raw = await invoke('load_pref', { key: 'settings' });
    if (raw) _s = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  _applyCSS();
  return { ..._s };
}

export function setFontSize(size) {
  _s.fontSize = Math.max(8, Math.min(40, size));
  _applyCSS();
  _persist();
  _fire();
}

function _applyCSS() {
  const r = document.documentElement.style;
  r.setProperty('--editor-font-size', _s.fontSize + 'px');
  r.setProperty('--term-font-size', (_s.termFontSize ?? 13) + 'px');
  r.setProperty('--tab-size', String(_s.tabSize));
  r.setProperty('--ruler-col', String(_s.rulerCol || 0));
  document.documentElement.dataset.theme = _s.theme || 'dark';
}

function _persist() {
  if (!invoke) return;
  invoke('save_pref', { key: 'settings', value: JSON.stringify(_s) }).catch(() => {});
}

function _fire() {
  document.dispatchEvent(new CustomEvent('ln:settings-changed', { detail: { ..._s } }));
}

export function initSettings() {
  const overlay   = document.getElementById('settings-overlay');
  const closeBtn  = document.getElementById('settings-close');
  const gearBtn   = document.getElementById('btn-settings');
  const fontVal   = document.getElementById('setting-font-size');
  const fontDecr  = document.getElementById('setting-font-decr');
  const fontIncr  = document.getElementById('setting-font-incr');
  const termFontVal  = document.getElementById('setting-term-font-size');
  const termFontDecr = document.getElementById('setting-term-font-decr');
  const termFontIncr = document.getElementById('setting-term-font-incr');
  const wrapChk           = document.getElementById('setting-word-wrap');
  const mdPreviewChk      = document.getElementById('setting-md-preview');
  const launchTermChk     = document.getElementById('setting-launch-terminal');
  const defaultShellRow   = document.getElementById('setting-default-shell-row');
  const defaultShellSel   = document.getElementById('setting-default-shell');
  const searchInput       = document.getElementById('settings-search');
  const searchClear       = document.getElementById('settings-search-clear');
  const noResults         = document.getElementById('settings-no-results');
  const tabsNav           = document.getElementById('settings-tabs');

  function _syncUI() {
    fontVal.value = _s.fontSize;
    if (termFontVal) termFontVal.value = _s.termFontSize ?? 13;
    document.querySelectorAll('[data-setting="tabSize"]').forEach(b =>
      b.classList.toggle('seg-active', b.dataset.val === String(_s.tabSize)));
    document.querySelectorAll('[data-setting="indentType"]').forEach(b =>
      b.classList.toggle('seg-active', b.dataset.val === _s.indentType));
    document.querySelectorAll('[data-setting="rulerCol"]').forEach(b =>
      b.classList.toggle('seg-active', b.dataset.val === String(_s.rulerCol)));
    document.querySelectorAll('[data-setting="theme"]').forEach(b =>
      b.classList.toggle('seg-active', b.dataset.val === (_s.theme || 'dark')));
    wrapChk.checked      = _s.wordWrap;
    mdPreviewChk.checked = _s.mdPreview;
    if (launchTermChk) launchTermChk.checked = _s.launchTerminalOnStartup ?? false;
    if (defaultShellSel) defaultShellSel.value = _s.defaultShell ?? '';
    _syncChannel(_s.updateChannel ?? 'stable');
    const asEnabled = document.getElementById('setting-autosave-enabled');
    const asInterval = document.getElementById('setting-autosave-interval');
    const asIntervalRow = document.getElementById('setting-autosave-interval-row');
    const asPath = document.getElementById('setting-autosave-path');
    if (asEnabled)  asEnabled.checked  = _s.autoSave ?? true;
    if (asInterval) asInterval.value   = _s.autoSaveInterval ?? 30;
    if (asPath)     asPath.value       = _s.autoSavePath ?? '';
    if (asIntervalRow) asIntervalRow.style.display = (_s.autoSave ?? true) ? '' : 'none';
  }

  function _syncChannel(ch) {
    document.querySelectorAll('.channel-card').forEach(c =>
      c.classList.toggle('selected', c.dataset.channel === ch));
    const warn = document.getElementById('channel-beta-warning');
    if (warn) warn.style.display = ch === 'beta' ? '' : 'none';
    // Reflect in About dialog immediately if open
    const helpChannel = document.getElementById('help-channel');
    if (helpChannel) helpChannel.textContent = ch === 'beta' ? 'Beta' : 'Stable';
  }

  function _set(key, val) {
    _s[key] = val;
    _syncUI();
    _applyCSS();
    _persist();
    _fire();
  }

  function _activateTab(name) {
    document.querySelectorAll('.settings-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.settings-page').forEach(p => {
      p.classList.toggle('active', p.dataset.page === name);
      p.style.display = '';
    });
  }

  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _clearSearch();
      _activateTab(tab.dataset.tab);
    });
  });

  const TAB_LABELS = { appearance: 'Appearance', editor: 'Editor', terminal: 'Terminal', updates: 'Updates', autosave: 'Auto Save' };

  function _doSearch(q) {
    const query = q.trim().toLowerCase();
    document.querySelectorAll('.setting-tab-badge').forEach(b => b.remove());

    if (!query) {
      tabsNav.style.display = '';
      noResults.style.display = 'none';
      document.querySelectorAll('.settings-page').forEach(p => {
        p.style.display = '';
        p.querySelectorAll('.setting-row, .settings-section-title').forEach(el => el.style.display = '');
      });
      _activateTab(document.querySelector('.settings-tab.active')?.dataset.tab ?? 'appearance');
      return;
    }

    tabsNav.style.display = 'none';
    let totalVisible = 0;

    document.querySelectorAll('.settings-page').forEach(p => {
      p.classList.add('active');
      p.style.display = 'block';
      const tabLabel = TAB_LABELS[p.dataset.page] ?? p.dataset.page;

      const rows = [...p.querySelectorAll('.setting-row')];
      rows.forEach(row => {
        const labelEl = row.querySelector('.setting-label');
        const text    = labelEl?.textContent.toLowerCase() ?? '';
        const match   = text.includes(query);
        row.style.display = match ? '' : 'none';
        if (match) {
          totalVisible++;
          const badge = document.createElement('span');
          badge.className   = 'setting-tab-badge';
          badge.textContent = tabLabel;
          labelEl?.appendChild(badge);
        }
      });

      const kids = [...p.children];
      kids.forEach((child, i) => {
        if (!child.classList.contains('settings-section-title')) return;
        let hasVisible = false;
        for (let j = i + 1; j < kids.length; j++) {
          if (kids[j].classList.contains('settings-section-title')) break;
          if (kids[j].classList.contains('setting-row') && kids[j].style.display !== 'none') {
            hasVisible = true; break;
          }
        }
        child.style.display = hasVisible ? '' : 'none';
      });

      p.style.display = rows.some(r => r.style.display !== 'none') ? 'block' : 'none';
    });

    noResults.style.display = totalVisible === 0 ? 'block' : 'none';
  }

  function _clearSearch() {
    document.querySelectorAll('.setting-tab-badge').forEach(b => b.remove());
    if (searchInput) searchInput.value = '';
    if (searchClear) searchClear.style.display = 'none';
    _doSearch('');
  }

  searchInput?.addEventListener('input', () => {
    const q = searchInput.value;
    if (searchClear) searchClear.style.display = q ? '' : 'none';
    _doSearch(q);
  });
  searchClear?.addEventListener('click', () => { _clearSearch(); searchInput?.focus(); });

  const resetBtn = document.getElementById('settings-reset');

  const open  = () => { _syncUI(); overlay.style.display = 'flex'; };
  const close = () => { overlay.style.display = 'none'; _clearSearch(); };

  gearBtn?.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  resetBtn?.addEventListener('click', () => {
    _s = { ...DEFAULTS };
    _syncUI();
    _applyCSS();
    _persist();
    _fire();
  });

  fontDecr.addEventListener('click', () => _set('fontSize', Math.max(8,  _s.fontSize - 1)));
  fontIncr.addEventListener('click', () => _set('fontSize', Math.min(40, _s.fontSize + 1)));
  fontVal.addEventListener('change', () => {
    const v = parseInt(fontVal.value, 10);
    if (!isNaN(v)) _set('fontSize', Math.max(8, Math.min(40, v)));
  });

  termFontDecr?.addEventListener('click', () => _set('termFontSize', Math.max(8,  (_s.termFontSize ?? 13) - 1)));
  termFontIncr?.addEventListener('click', () => _set('termFontSize', Math.min(40, (_s.termFontSize ?? 13) + 1)));
  termFontVal?.addEventListener('change', () => {
    const v = parseInt(termFontVal.value, 10);
    if (!isNaN(v)) _set('termFontSize', Math.max(8, Math.min(40, v)));
  });

  document.querySelectorAll('[data-setting="tabSize"]').forEach(b =>
    b.addEventListener('click', () => _set('tabSize', parseInt(b.dataset.val, 10))));
  document.querySelectorAll('[data-setting="indentType"]').forEach(b =>
    b.addEventListener('click', () => _set('indentType', b.dataset.val)));
  document.querySelectorAll('[data-setting="rulerCol"]').forEach(b =>
    b.addEventListener('click', () => _set('rulerCol', parseInt(b.dataset.val, 10))));
  document.querySelectorAll('[data-setting="theme"]').forEach(b =>
    b.addEventListener('click', () => _set('theme', b.dataset.val)));
  wrapChk.addEventListener('change',       () => _set('wordWrap',                wrapChk.checked));
  mdPreviewChk.addEventListener('change',  () => _set('mdPreview',               mdPreviewChk.checked));
  launchTermChk?.addEventListener('change', () => _set('launchTerminalOnStartup', launchTermChk.checked));
  defaultShellSel?.addEventListener('change', () => _set('defaultShell', defaultShellSel.value));

  document.querySelectorAll('.channel-card').forEach(card => {
    card.addEventListener('click', () => {
      _set('updateChannel', card.dataset.channel);
      _syncChannel(card.dataset.channel);
    });
  });

  const asEnabledChk   = document.getElementById('setting-autosave-enabled');
  const asIntervalInp  = document.getElementById('setting-autosave-interval');
  const asIntervalDecr = document.getElementById('setting-autosave-decr');
  const asIntervalIncr = document.getElementById('setting-autosave-incr');
  const asIntervalRow  = document.getElementById('setting-autosave-interval-row');
  const asPathInp      = document.getElementById('setting-autosave-path');

  asEnabledChk?.addEventListener('change', () => {
    _set('autoSave', asEnabledChk.checked);
    if (asIntervalRow) asIntervalRow.style.display = asEnabledChk.checked ? '' : 'none';
    document.dispatchEvent(new CustomEvent('ln:autosave-settings-changed'));
  });
  asIntervalDecr?.addEventListener('click', () => { _set('autoSaveInterval', Math.max(5, (_s.autoSaveInterval ?? 30) - 5)); document.dispatchEvent(new CustomEvent('ln:autosave-settings-changed')); });
  asIntervalIncr?.addEventListener('click', () => { _set('autoSaveInterval', Math.min(600, (_s.autoSaveInterval ?? 30) + 5)); document.dispatchEvent(new CustomEvent('ln:autosave-settings-changed')); });
  asIntervalInp?.addEventListener('change', () => {
    const v = parseInt(asIntervalInp.value, 10);
    if (!isNaN(v)) { _set('autoSaveInterval', Math.max(5, Math.min(600, v))); document.dispatchEvent(new CustomEvent('ln:autosave-settings-changed')); }
  });
  asPathInp?.addEventListener('change', () => {
    _set('autoSavePath', asPathInp.value.trim());
    document.dispatchEvent(new CustomEvent('ln:autosave-settings-changed'));
  });

  if (defaultShellSel && invoke) {
    const SHELL_LABELS = { cmd: 'CMD', powershell: 'PowerShell', gitbash: 'Git Bash', sh: 'Sh', bash: 'Bash', zsh: 'Zsh' };
    invoke('available_shells').then(shells => {
      defaultShellSel.innerHTML = '';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = 'Auto (first available)';
      defaultShellSel.appendChild(auto);
      for (const s of shells) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = SHELL_LABELS[s] ?? s;
        defaultShellSel.appendChild(opt);
      }
      defaultShellSel.value = _s.defaultShell ?? '';
    }).catch(() => {});
  }

  return { open, close };
}
