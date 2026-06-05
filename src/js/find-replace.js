export function initFindReplace(editor) {
  const panel       = document.getElementById('find-panel');
  const findInput   = document.getElementById('find-input');
  const replInput   = document.getElementById('replace-input');
  const replRow     = document.getElementById('replace-row');
  const findCount   = document.getElementById('find-count');
  const btnPrev     = document.getElementById('find-prev');
  const btnNext     = document.getElementById('find-next');
  const btnToggleR  = document.getElementById('find-toggle-replace');
  const btnClose    = document.getElementById('find-close');
  const btnReplace  = document.getElementById('replace-btn');
  const btnReplAll  = document.getElementById('replace-all-btn');

  const textarea    = editor.getTextarea();
  const syncScroll  = editor.getSyncScroll();

  let matches    = [];
  let currentIdx = -1;
  let mode       = 'find';   // 'find' | 'replace'

  function open(openMode = 'find') {
    mode = openMode;
    panel.style.display = 'block';
    replRow.style.display = (mode === 'replace') ? 'flex' : 'none';
    findInput.focus();
    findInput.select();
    runSearch();
  }

  function close() {
    panel.style.display = 'none';
    editor.setFindMarks([]);
    matches    = [];
    currentIdx = -1;
    findCount.textContent = '';
    textarea.focus();
  }

  function runSearch() {
    const q = findInput.value;
    matches    = q ? findAll(textarea.value, q) : [];
    currentIdx = matches.length ? 0 : -1;
    applyMarks();
    updateCount();
    if (matches.length && currentIdx >= 0) scrollToMatch(currentIdx);
  }

  function findAll(text, query) {
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    const result = [];
    let pos = 0;
    while (pos < t.length) {
      const idx = t.indexOf(q, pos);
      if (idx < 0) break;
      result.push({ start: idx, end: idx + query.length });
      pos = idx + query.length || pos + 1;
    }
    return result;
  }

  function applyMarks() {
    const marks = matches.map((m, i) => ({
      start: m.start,
      end:   m.end,
      cls:   i === currentIdx ? 'syn-find-current' : 'syn-find-match',
    }));
    editor.setFindMarks(marks);
  }

  function updateCount() {
    if (!matches.length) {
      findCount.textContent = findInput.value ? 'No results' : '';
    } else {
      findCount.textContent = `${currentIdx + 1}/${matches.length}`;
    }
  }

  function scrollToMatch(idx) {
    if (idx < 0 || idx >= matches.length) return;
    const m = matches[idx];
    textarea.selectionStart = m.start;
    textarea.selectionEnd   = m.end;
    // Do NOT steal focus — user may be typing in the find input
    const before  = textarea.value.substring(0, m.start);
    const lineNum = (before.match(/\n/g) ?? []).length;
    const lineH   = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
    const targetY = lineNum * lineH;
    if (targetY < textarea.scrollTop || targetY > textarea.scrollTop + textarea.clientHeight) {
      textarea.scrollTop = Math.max(0, targetY - textarea.clientHeight / 2);
    }
    syncScroll();
    editor.getUpdateCursor()();
  }

  function next() {
    if (!matches.length) return;
    currentIdx = (currentIdx + 1) % matches.length;
    applyMarks();
    updateCount();
    scrollToMatch(currentIdx);
  }

  function prev() {
    if (!matches.length) return;
    currentIdx = (currentIdx - 1 + matches.length) % matches.length;
    applyMarks();
    updateCount();
    scrollToMatch(currentIdx);
  }

  function doReplace() {
    if (currentIdx < 0 || !matches.length) return;
    const m   = matches[currentIdx];
    const val = textarea.value;
    textarea.value = val.slice(0, m.start) + replInput.value + val.slice(m.end);
    textarea.dispatchEvent(new Event('input'));
    runSearch();
  }

  function doReplaceAll() {
    const q = findInput.value;
    if (!q) return;
    const newVal = textarea.value.split(q).join(replInput.value);
    textarea.value = newVal;
    textarea.dispatchEvent(new Event('input'));
    runSearch();
  }

  findInput.addEventListener('input', runSearch);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.shiftKey ? prev() : next(); e.preventDefault(); }
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
  replInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });

  btnNext.addEventListener('click', next);
  btnPrev.addEventListener('click', prev);
  btnClose.addEventListener('click', close);
  btnReplace.addEventListener('click', doReplace);
  btnReplAll.addEventListener('click', doReplaceAll);
  btnToggleR.addEventListener('click', () => {
    mode = mode === 'replace' ? 'find' : 'replace';
    replRow.style.display = mode === 'replace' ? 'flex' : 'none';
    findInput.focus();
  });

  document.addEventListener('ln:activate-file', () => {
    if (panel.style.display !== 'none') { matches = []; currentIdx = -1; runSearch(); }
  });

  return { open, close };
}
