const invoke = window.__TAURI__?.core.invoke;
const GITHUB_URL = 'https://github.com/openidle-dev/littlenotepad';
const API_URL    = 'https://api.github.com/repos/openidle-dev/littlenotepad/releases';

let _getChannelLabel = () => 'Stable';
let _whatsNewLoaded  = false;

export function setChannelGetter(fn) { _getChannelLabel = fn; }

export function initHelp() {
  const overlay  = document.getElementById('help-overlay');
  const backdrop = document.getElementById('help-backdrop');
  const closeBtn = document.getElementById('help-close');
  const helpBtn  = document.getElementById('btn-help');
  const titleEl  = document.getElementById('help-content-title');

  const PAGE_TITLES = { about: 'About', 'whats-new': "What's New", 'log-issue': 'Log New Issue', tips: 'Useful Tips' };

  const navItems = document.querySelectorAll('.help-nav-item[data-page]');
  const pages    = document.querySelectorAll('.help-page');

  function switchPage(name) {
    navItems.forEach(b => b.classList.toggle('active', b.dataset.page === name));
    pages.forEach(p => p.classList.toggle('active', p.dataset.page === name));
    if (titleEl) titleEl.textContent = PAGE_TITLES[name] ?? name;
    if (name === 'whats-new' && !_whatsNewLoaded) loadWhatsNew();
  }

  navItems.forEach(btn => btn.addEventListener('click', () => switchPage(btn.dataset.page)));

  function open() { overlay.style.display = 'flex'; loadAppInfo(); }
  function close() { overlay.style.display = 'none'; }

  helpBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  document.getElementById('help-github-btn')?.addEventListener('click', () => {
    invoke?.('open_url', { url: GITHUB_URL }).catch(() => {});
  });

  document.getElementById('help-create-issue')?.addEventListener('click', () => {
    const title = encodeURIComponent(document.getElementById('help-issue-title')?.value.trim() ?? '');
    const body  = encodeURIComponent(document.getElementById('help-issue-body')?.value.trim() ?? '');
    const type  = document.querySelector('.help-type-btn.active')?.dataset.type ?? 'bug';
    const label = type === 'feature' ? 'enhancement' : type === 'question' ? 'question' : 'bug';
    const url   = `${GITHUB_URL}/issues/new?labels=${label}&title=${title}&body=${body}`;
    invoke?.('open_url', { url }).catch(() => {});
  });

  document.querySelectorAll('.help-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.help-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  async function loadAppInfo() {
    if (!invoke) return;
    try {
      const info = await invoke('get_app_info');
      const v = `v${info.version}`;
      const p = info.platform.charAt(0).toUpperCase() + info.platform.slice(1);

      const badge    = document.getElementById('help-app-version-badge');
      const verCard  = document.getElementById('help-version');
      const platCard = document.getElementById('help-platform');
      const cpuCard  = document.getElementById('help-cpu');
      const meta     = document.getElementById('help-issue-meta');

      if (badge)    badge.textContent    = v;
      if (verCard)  verCard.textContent  = v;
      if (platCard) platCard.textContent = p;
      if (cpuCard)  cpuCard.textContent  = info.cpu ?? '—';
      if (meta)     meta.textContent     = `App: ${v} · OS: ${p}`;
      const chCard = document.getElementById('help-channel');
      if (chCard) chCard.textContent = _getChannelLabel();
    } catch {}
  }

  async function loadWhatsNew() {
    _whatsNewLoaded = true;
    const container = document.getElementById('help-whats-new-container');
    if (!container) return;
    try {
      const res = await fetch(API_URL, {
        headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
      });
      if (!res.ok) throw new Error();
      const releases = await res.json();
      const published = releases.filter(r => !r.draft);
      if (!published.length) {
        container.innerHTML = '<div style="padding:20px;opacity:0.5;text-align:center">No releases yet.</div>';
        return;
      }
      container.innerHTML = published.map(r => {
        const date = r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : '';
        const esc  = (r.body ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const body = esc.trim()
          ? `<pre style="white-space:pre-wrap;font-family:inherit;margin:8px 0 0;font-size:12px;line-height:1.7;opacity:0.85">${esc}</pre>`
          : '<p style="opacity:0.4;font-size:12px;margin:8px 0 0">No release notes.</p>';
        return `<div class="help-changelog">
          <div class="help-changelog-version">
            <span class="help-ver-tag">${r.tag_name}</span>
            ${date ? `<span class="help-ver-date">${date}</span>` : ''}
            ${r.prerelease ? '<span class="help-ver-beta">Beta</span>' : ''}
          </div>
          ${body}
        </div>`;
      }).join('');
    } catch {
      _whatsNewLoaded = false;
      container.innerHTML = '<div style="padding:20px;opacity:0.5;text-align:center">Could not load release notes. Check your connection.</div>';
    }
  }

  return { open, close };
}
