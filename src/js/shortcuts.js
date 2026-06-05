export function initShortcuts() {
  const overlay  = document.getElementById('shortcuts-overlay');
  const backdrop = document.getElementById('shortcuts-backdrop');
  const closeBtn = document.getElementById('shortcuts-close');

  const open  = () => { overlay.style.display = 'flex'; };
  const close = () => { overlay.style.display = 'none'; };

  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  return { open, close };
}
