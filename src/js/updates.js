const invoke = window.__TAURI__?.core.invoke;
const RELEASES_URL = 'https://github.com/openidle-dev/littlenotepad/releases';

let _getChannelLabel = () => 'Stable';
let _pendingUpdate   = null;

export function setUpdatesChannelGetter(fn)      { _getChannelLabel = fn; }
export function setUpdatesChannelValueGetter(fn) { /* channel handled server-side via endpoint */ }

function _setBadge(show) {
  const badge = document.getElementById('update-badge');
  if (badge) badge.style.display = show ? '' : 'none';
}

export function initUpdates() {
  const overlay     = document.getElementById('updates-overlay');
  const closeBtn    = document.getElementById('updates-close');
  const triggerBtn  = document.getElementById('btn-updates');
  const laterBtn    = document.getElementById('updates-later');
  const downloadBtn = document.getElementById('updates-download');
  const allReleases = document.getElementById('updates-all-releases');
  const footerVer   = document.getElementById('updates-footer-version');
  const okSub       = document.getElementById('updates-ok-sub');
  const restartBtn  = document.getElementById('updates-restart');

  function showPage(id) {
    document.querySelectorAll('.updates-page').forEach(p =>
      p.classList.toggle('active', p.id === id));
  }

  async function _loadVersion() {
    if (!invoke) return 'v?';
    try {
      const info = await invoke('get_app_info');
      return `v${info.version}`;
    } catch { return 'v?'; }
  }

  async function _silentCheck() {
    try {
      const result = await invoke('check_update');
      if (result) {
        _pendingUpdate = result;
        _setBadge(true);
      }
    } catch {}
  }

  async function _check() {
    showPage('updates-page-checking');
    const ver = await _loadVersion();
    if (footerVer) footerVer.textContent = `Current: ${ver} · ${_getChannelLabel()}`;

    let result;
    try { result = await invoke('check_update'); }
    catch (err) {
      console.error('[updates] check failed:', err);
      showPage('updates-page-error');
      return;
    }

    if (!result) {
      _pendingUpdate = null;
      _setBadge(false);
      if (okSub) okSub.textContent = `LittleNotepad ${ver} is the latest version.`;
      showPage('updates-page-ok');
      return;
    }

    _pendingUpdate = result;
    _setBadge(true);
    _showUpdateAvailable(result.version, ver, result.body ?? '');
  }

  async function _install() {
    if (!_pendingUpdate) return;
    showPage('updates-page-downloading');
    const progressEl = document.getElementById('updates-download-progress');
    try {
      if (progressEl) progressEl.textContent = 'Downloading update…';
      await invoke('install_update');
      showPage('updates-page-installing');
    } catch (err) {
      console.error('[updates] install failed:', err);
      showPage('updates-page-error');
    }
  }

  async function open() {
    overlay.style.display = 'flex';
    if (_pendingUpdate) {
      const ver = await _loadVersion();
      if (footerVer) footerVer.textContent = `Current: ${ver} · ${_getChannelLabel()}`;
      _showUpdateAvailable(_pendingUpdate.version, ver, _pendingUpdate.body ?? '');
    } else {
      await _check();
    }
  }

  function close() { overlay.style.display = 'none'; }

  triggerBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  laterBtn?.addEventListener('click', close);
  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  document.getElementById('updates-check-again')?.addEventListener('click', _check);
  document.getElementById('updates-check-error-retry')?.addEventListener('click', _check);
  downloadBtn?.addEventListener('click', _install);
  restartBtn?.addEventListener('click', () => invoke?.('restart_app').catch(() => {}));
  allReleases?.addEventListener('click', () => {
    invoke?.('open_url', { url: RELEASES_URL }).catch(() => {});
  });

  setTimeout(_silentCheck, 60_000);

  return { open, close, showUpdateAvailable: _showUpdateAvailable };

  function _showUpdateAvailable(newVer, currentVer, notes) {
    document.getElementById('updates-new-version').textContent = `v${newVer}`;
    document.getElementById('updates-new-meta').textContent    = `${currentVer} → v${newVer}`;
    const body = document.getElementById('updates-whats-new');
    if (body) {
      const esc = (notes || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      body.innerHTML = esc
        ? `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;font-size:0.92em">${esc}</pre>`
        : '<p>See release notes on GitHub.</p>';
    }
    showPage('updates-page-available');
  }
}
