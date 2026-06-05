const invoke = window.__TAURI__?.core.invoke;
const GITHUB_URL = 'https://github.com/openidle-dev/littlenotepad';

let _getChannelLabel = () => 'Stable';

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

  return { open, close };
}
