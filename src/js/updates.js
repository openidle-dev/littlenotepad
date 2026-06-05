const invoke = window.__TAURI__?.core.invoke;
const RELEASES_URL = 'https://github.com/openidle-dev/littlenotepad/releases';
const API_URL      = 'https://api.github.com/repos/openidle-dev/littlenotepad/releases';

let _getChannelLabel = () => 'Stable';
let _getChannelValue = () => 'stable';
let _pendingRelease  = null;
let _platform        = 'windows';

export function setUpdatesChannelGetter(fn)      { _getChannelLabel = fn; }
export function setUpdatesChannelValueGetter(fn) { _getChannelValue = fn; }

function _semverGt(a, b) {
  const parse = v => v.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}

async function _fetchLatest() {
  const res = await fetch(API_URL, {
    headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const releases = await res.json();
  const isBeta = _getChannelValue() === 'beta';
  return releases.find(r => !r.draft && (isBeta || !r.prerelease)) ?? null;
}

function _pickAsset(release) {
  const assets = release.assets ?? [];
  if (_platform === 'windows') {
    return assets.find(a => a.name.endsWith('.msi'))
        ?? assets.find(a => a.name.endsWith('.exe'));
  }
  if (_platform === 'linux') {
    return assets.find(a => a.name.endsWith('.AppImage'))
        ?? assets.find(a => a.name.endsWith('.deb'));
  }
  if (_platform === 'macos') {
    return assets.find(a => a.name.endsWith('.dmg'));
  }
  return null;
}

function _renderNotes(md) {
  if (!md?.trim()) return '<p>See release notes on GitHub.</p>';
  const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;font-size:0.92em">${esc}</pre>`;
}

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

  invoke?.('get_platform').then(p => { _platform = p; }).catch(() => {});

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
      const ver     = await _loadVersion();
      const release = await _fetchLatest();
      if (!release) return;
      if (ver !== 'v?' && _semverGt(release.tag_name, ver)) {
        _pendingRelease = release;
        _setBadge(true);
      }
    } catch {}
  }

  async function _check() {
    showPage('updates-page-checking');
    const ver = await _loadVersion();
    if (footerVer) footerVer.textContent = `Current: ${ver} · ${_getChannelLabel()}`;

    let release;
    try { release = await _fetchLatest(); }
    catch { showPage('updates-page-error'); return; }

    if (!release) {
      if (okSub) okSub.textContent = `LittleNotepad ${ver} — no releases published yet.`;
      showPage('updates-page-ok');
      return;
    }

    if (ver !== 'v?' && _semverGt(release.tag_name, ver)) {
      _pendingRelease = release;
      _setBadge(true);
      showUpdateAvailable(release.tag_name, `${ver} → ${release.tag_name}`, _renderNotes(release.body ?? ''));
    } else {
      _pendingRelease = null;
      _setBadge(false);
      if (okSub) okSub.textContent = `LittleNotepad ${ver} is the latest version.`;
      showPage('updates-page-ok');
    }
  }

  async function _downloadAndInstall() {
    if (!_pendingRelease) return;
    const asset = _pickAsset(_pendingRelease);
    if (!asset) {
      invoke?.('open_url', { url: RELEASES_URL }).catch(() => {});
      return;
    }

    showPage('updates-page-downloading');
    const progressEl = document.getElementById('updates-download-progress');
    try {
      if (progressEl) progressEl.textContent = `Downloading ${asset.name}…`;
      const path = await invoke('download_update', {
        url: asset.browser_download_url,
        filename: asset.name,
      });
      if (progressEl) progressEl.textContent = 'Launching installer…';
      await invoke('run_installer', { path });
      showPage('updates-page-installing');
    } catch {
      invoke?.('open_url', { url: RELEASES_URL }).catch(() => {});
      showPage('updates-page-error');
    }
  }

  async function open() {
    overlay.style.display = 'flex';
    if (_pendingRelease) {
      const ver = await _loadVersion();
      if (footerVer) footerVer.textContent = `Current: ${ver} · ${_getChannelLabel()}`;
      showUpdateAvailable(
        _pendingRelease.tag_name,
        `${ver} → ${_pendingRelease.tag_name}`,
        _renderNotes(_pendingRelease.body ?? '')
      );
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
  downloadBtn?.addEventListener('click', _downloadAndInstall);
  allReleases?.addEventListener('click', () => {
    invoke?.('open_url', { url: RELEASES_URL }).catch(() => {});
  });

  // Auto-check 1 minute after startup
  setTimeout(_silentCheck, 60_000);

  return { open, close, showUpdateAvailable };

  function showUpdateAvailable(newVer, meta, whatsNew) {
    document.getElementById('updates-new-version').textContent = newVer;
    document.getElementById('updates-new-meta').textContent    = meta ?? '';
    const body = document.getElementById('updates-whats-new');
    if (body) body.innerHTML = whatsNew ?? '<p>See release notes on GitHub.</p>';
    showPage('updates-page-available');
  }
}
