const invoke    = window.__TAURI__?.core.invoke;
const tauriEvt  = window.__TAURI__?.event;

function _loadHistory(shell) {
  try { return JSON.parse(localStorage.getItem(`ln:term-hist:${shell}`) || '[]'); } catch { return []; }
}
function _saveHistory(sess) {
  try { localStorage.setItem(`ln:term-hist:${sess.shell}`, JSON.stringify(sess.history.slice(0, 300))); } catch {}
}

// Programs that need a real TTY — routed through PTY instead of pipes
const INTERACTIVE_PROGS = new Set([
  'python','python3','py','node','ruby','irb','lua','php','ghci','julia','ipython','bpython','R','deno',
]);
function needsPty(cmd) {
  const name = cmd.trim().split(/\s+/)[0].toLowerCase().replace(/\.exe$/i, '');
  return INTERACTIVE_PROGS.has(name);
}

// ANSI SGR → HTML. Split on color codes first, then strip other control sequences from text parts.
function ansiToHtml(raw) {
  const FG = {
    30:'#555a64', 31:'#e06c75', 32:'#98c379', 33:'#e5c07b',
    34:'#61afef', 35:'#c678dd', 36:'#56b6c2', 37:'#abb2bf',
    90:'#808080', 91:'#ff7b7b', 92:'#b5e890', 93:'#ffd580',
    94:'#82aaff', 95:'#e5a0f0', 96:'#79d4e0', 97:'#ffffff',
  };

  // Split FIRST on SGR sequences (ESC [ ... m) so we don't accidentally strip them
  const parts = raw.split(/(\x1b\[[0-9;]*m)/);
  let html = '', bold = false, fg = null;

  for (const part of parts) {
    const sgr = part.match(/^\x1b\[([0-9;]*)m$/);
    if (sgr) {
      const codes = sgr[1] === '' ? [0] : sgr[1].split(';').map(Number);
      for (const c of codes) {
        if (c === 0)       { bold = false; fg = null; }
        else if (c === 1)  bold = true;
        else if (c === 22) bold = false;
        else if (c === 39) fg = null;
        else if (FG[c])    fg = FG[c];
      }
    } else if (part) {
      const clean = part
        .replace(/\x1b\[[0-9;?<>=!]*[A-Za-z~@^]/g, '') // CSI sequences
        .replace(/\x1b\][^\x07]*\x07/g, '')              // OSC sequences
        .replace(/\x1b./g, '');                          // any other ESC + char
      if (!clean) continue;
      const esc = clean.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const s = [];
      if (fg)   s.push(`color:${fg}`);
      if (bold) s.push('font-weight:bold');
      html += s.length ? `<span style="${s.join(';')}">${esc}</span>` : esc;
    }
  }
  return html;
}

let _getDefaultShell = () => null;
export function setDefaultShellGetter(fn) { _getDefaultShell = fn; }

export function initTerminal(state, tabs, editor) {
  const panel     = document.getElementById('terminal-panel');
  const termTabs  = document.getElementById('terminal-tabs');
  const output    = document.getElementById('terminal-output');
  const inputEl   = document.getElementById('terminal-input');
  const promptEl  = document.getElementById('terminal-prompt');
  const resizeHnd = document.getElementById('terminal-resize-handle');
  const closeBtn  = document.getElementById('btn-close-terminal');
  const newBtn    = document.getElementById('btn-new-terminal');

  let visible     = false;
  let sessionSeq  = 0;
  let globalCmdId = 0;
  let sessions    = [];
  let activeSess  = null;

  let availableShells = ['cmd'];

  async function detectShells() {
    if (!invoke) return;
    try { availableShells = await invoke('available_shells'); } catch {}
  }
  detectShells();

  const SHELL_LABELS = { cmd: 'CMD', powershell: 'PS', gitbash: 'BASH', sh: 'SH', bash: 'BASH', zsh: 'ZSH' };
  function shellLabel(shell) { return SHELL_LABELS[shell] ?? shell.toUpperCase(); }

  const shellPickerEl = document.createElement('div');
  shellPickerEl.id = 'shell-picker';
  shellPickerEl.style.display = 'none';
  document.body.appendChild(shellPickerEl);

  function showShellPicker() {
    if (availableShells.length <= 1) { newTerminal(availableShells[0] ?? 'cmd'); return; }
    const rect = newBtn.getBoundingClientRect();
    shellPickerEl.innerHTML = '';
    for (const shell of availableShells) {
      const btn = document.createElement('button');
      btn.className = 'shell-pick-btn';
      btn.textContent = shellLabel(shell);
      btn.addEventListener('click', () => { hideShellPicker(); show(); newTerminal(shell); });
      shellPickerEl.appendChild(btn);
    }
    shellPickerEl.style.display = 'block';
    const pr = shellPickerEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - pr.width, window.innerWidth - pr.width - 8));
    shellPickerEl.style.left = left + 'px';
    shellPickerEl.style.top  = (rect.top - pr.height - 6) + 'px';
  }

  function hideShellPicker() { shellPickerEl.style.display = 'none'; }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#shell-picker') && e.target !== newBtn) hideShellPicker();
  });

  function newTerminal(shell = availableShells[0] ?? 'cmd') {
    const initialCwd = activeSess?.cwd || state.folderPath || '';
    const sess = {
      id:          ++sessionSeq,
      shell,
      cwd:         initialCwd,
      branch:      '',
      history:     _loadHistory(shell),
      historyIdx:  -1,
      lines:       [],
      tab:         null,
      activePtyId: null,
      activePtyMode: false,
    };
    sessions.push(sess);

    const tab = document.createElement('span');
    tab.className = 'panel-tab';

    const label = document.createElement('span');
    label.className = 'term-tab-label';
    label.textContent = `${shellLabel(shell)} ${sess.id}`;

    const closeX = document.createElement('button');
    closeX.className = 'tab-close-term';
    closeX.textContent = '×';
    closeX.title = 'Close Terminal';
    closeX.addEventListener('click', (e) => { e.stopPropagation(); closeSession(sess); });

    tab.append(label, closeX);
    tab.addEventListener('click', () => activateSession(sess));
    termTabs.appendChild(tab);
    sess.tab = tab;

    if (!initialCwd && invoke) {
      invoke('get_cwd')
        .then(dir => { sess.cwd = dir; if (activeSess === sess) refreshPrompt(); })
        .catch(() => {});
    }

    activateSession(sess);
    document.dispatchEvent(new CustomEvent('ln:terminal-changed'));
    return sess;
  }

  function activateSession(sess) {
    activeSess = sess;
    for (const s of sessions) s.tab.classList.toggle('active', s === sess);

    output.innerHTML = '';
    for (const { text, type } of sess.lines) renderLine(text, type);
    output.scrollTop = output.scrollHeight;

    refreshPrompt();
    inputEl.focus();
  }

  function closeSession(sess) {
    if (sess.activePtyId !== null) {
      if (sess.activePtyMode) invoke?.('kill_pty', { id: sess.activePtyId }).catch(() => {});
      else                    invoke?.('kill_cmd', { id: sess.activePtyId }).catch(() => {});
      sess.activePtyId   = null;
      sess.activePtyMode = false;
    }
    const idx = sessions.indexOf(sess);
    if (idx < 0) return;

    sess.tab.remove();
    sessions.splice(idx, 1);

    if (sessions.length === 0) {
      activeSess = null;
      hide();
    } else {
      activateSession(sessions[Math.min(idx, sessions.length - 1)]);
    }
    document.dispatchEvent(new CustomEvent('ln:terminal-changed'));
  }

  const BASH_SHELLS = new Set(['gitbash', 'bash', 'sh', 'zsh']);

  function _renderPrompt(sess) {
    const shell  = sess.shell ?? 'cmd';
    const cwd    = sess.cwd ?? '';
    const branch = sess.branch ?? '';
    promptEl.textContent = '';

    if (shell === 'powershell') {
      const ps = document.createElement('span');
      ps.className = 'prompt-ps-prefix';
      ps.textContent = 'PS ';
      promptEl.appendChild(ps);
      const dir = cwd.replace(/\//g, '\\');
      promptEl.appendChild(document.createTextNode(dir ? `${dir}> ` : '> '));
      promptEl.className = 'prompt-powershell';
    } else if (BASH_SHELLS.has(shell)) {
      const dir = cwd.replace(/\\/g, '/');
      if (dir) promptEl.appendChild(document.createTextNode(dir));
      if (branch) {
        const b = document.createElement('span');
        b.className = 'prompt-branch';
        b.textContent = ` (${branch})`;
        promptEl.appendChild(b);
      }
      promptEl.appendChild(document.createTextNode(dir ? ' $ ' : '$ '));
      promptEl.className = 'prompt-bash';
    } else {
      const dir = cwd.replace(/\//g, '\\');
      promptEl.appendChild(document.createTextNode(dir ? `${dir}> ` : '> '));
      promptEl.className = 'prompt-cmd';
    }
  }

  function refreshPrompt() {
    if (!activeSess) return;
    _renderPrompt(activeSess);
    if (BASH_SHELLS.has(activeSess.shell) && activeSess.cwd && invoke) {
      const sess = activeSess;
      invoke('git_branch', { path: sess.cwd })
        .then(b => { sess.branch = b ?? ''; if (activeSess === sess) _renderPrompt(sess); })
        .catch(() => {});
    }
  }

  async function attemptCompletion(sess) {
    if (!invoke) return;
    const input  = inputEl.value;
    const tokens = input.split(/\s+/);
    const last   = tokens[tokens.length - 1];
    if (!last) return;

    const slashIdx = Math.max(last.lastIndexOf('/'), last.lastIndexOf('\\'));
    const dirPart  = slashIdx >= 0 ? last.slice(0, slashIdx + 1) : '';
    const pfx      = slashIdx >= 0 ? last.slice(slashIdx + 1)    : last;

    const isAbs = /^([A-Za-z]:[/\\]|\/)/.test(dirPart);
    const searchIn = dirPart
      ? (isAbs ? dirPart : `${sess.cwd || '.'}/${dirPart}`)
      : (sess.cwd || '.');

    try {
      const entries = await invoke('list_dir', { path: searchIn });
      const matches = entries.filter(e => e.name.toLowerCase().startsWith(pfx.toLowerCase()));
      if (!matches.length) return;
      if (matches.length === 1) {
        const completed = dirPart + matches[0].name + (matches[0].is_dir ? '/' : '');
        tokens[tokens.length - 1] = completed;
        inputEl.value = tokens.join(' ');
      } else {
        appendLine(matches.map(e => e.name + (e.is_dir ? '/' : '')).join('  '), 'system');
      }
    } catch {}
  }

  function show() {
    visible = true;
    panel.style.display = 'flex';
    if (sessions.length === 0) {
      const def = _getDefaultShell();
      newTerminal(def && availableShells.includes(def) ? def : availableShells[0] ?? 'cmd');
    } else inputEl.focus();
    document.dispatchEvent(new CustomEvent('ln:terminal-changed'));
  }

  function hide() {
    visible = false;
    panel.style.display = 'none';
    document.dispatchEvent(new CustomEvent('ln:terminal-changed'));
  }

  function toggle() { visible ? hide() : show(); }

  function getState() {
    return {
      sessions: sessions.map(s => ({ shell: s.shell })),
      visible,
    };
  }

  function restoreSessions(savedSessions, wasVisible) {
    if (!savedSessions || savedSessions.length === 0) return;
    for (const s of savedSessions) {
      newTerminal(s.shell ?? availableShells[0] ?? 'cmd');
    }
    if (wasVisible) show();
  }

  closeBtn.addEventListener('click', () => {
    for (const sess of [...sessions]) closeSession(sess);
    // closeSession calls hide() when the last session is removed;
    // if panel was already empty just hide directly
    if (sessions.length === 0) hide();
  });
  newBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    show();
    showShellPicker();
  });

  document.addEventListener('ln:folder-opened', (e) => {
    if (activeSess) { activeSess.cwd = e.detail.path; refreshPrompt(); }
  });

  let termDragging = false;
  let dragStartY   = 0;
  let dragStartH   = 0;

  resizeHnd.addEventListener('mousedown', (e) => {
    termDragging = true;
    dragStartY   = e.clientY;
    dragStartH   = panel.offsetHeight;
    resizeHnd.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!termDragging) return;
    const delta = dragStartY - e.clientY;
    const newH  = Math.max(80, Math.min(dragStartH + delta, window.innerHeight * 0.7));
    panel.style.height = newH + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!termDragging) return;
    termDragging = false;
    resizeHnd.classList.remove('dragging');
  });

  inputEl.addEventListener('keydown', async (e) => {
    const sess = activeSess;
    if (!sess) return;

    if (e.key === 'Tab') {
      e.preventDefault();
      if (sess.activePtyId !== null) {
        const fn = sess.activePtyMode ? 'write_pty' : 'write_cmd_stdin';
        invoke?.(fn, { id: sess.activePtyId, data: '\t' }).catch(() => {});
      } else {
        await attemptCompletion(sess);
      }
      return;
    }

    if (e.key === 'c' && e.ctrlKey && sess.activePtyId !== null) {
      e.preventDefault();
      if (sess.activePtyMode) invoke?.('write_pty',  { id: sess.activePtyId, data: '\x03' }).catch(() => {});
      else                    invoke?.('kill_cmd',    { id: sess.activePtyId }).catch(() => {});
      return;
    }

    if (e.key === 'd' && e.ctrlKey && sess.activePtyId !== null) {
      e.preventDefault();
      if (sess.activePtyMode) invoke?.('write_pty',       { id: sess.activePtyId, data: '\x04' }).catch(() => {});
      else                    invoke?.('write_cmd_stdin',  { id: sess.activePtyId, data: '\x04' }).catch(() => {});
      return;
    }

    if (e.key === 'Enter') {
      const raw = inputEl.value;

      if (sess.activePtyId !== null) {
        inputEl.value = '';
        const fn = sess.activePtyMode ? 'write_pty' : 'write_cmd_stdin';
        // PTY expects \r (carriage return) as Enter — that's what a real terminal sends.
        // \n alone is not recognized as line-complete by Windows readline/raw-mode PTY.
        const terminator = sess.activePtyMode ? '\r' : '\n';
        invoke?.(fn, { id: sess.activePtyId, data: raw + terminator }).catch(() => {});
        return;
      }

      const cmd = raw.trim();
      if (!cmd) return;
      sess.history.unshift(raw);
      _saveHistory(sess);
      sess.historyIdx = -1;
      inputEl.value = '';

      appendLine(`${promptEl.textContent}${raw}`, 'cmd');
      await dispatch(sess, cmd);
      inputEl.focus();
      refreshPrompt();
      return;
    }

    if (sess.activePtyId === null) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (sess.historyIdx < sess.history.length - 1) {
          sess.historyIdx++;
          inputEl.value = sess.history[sess.historyIdx];
        }
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (sess.historyIdx > 0) {
          sess.historyIdx--;
          inputEl.value = sess.history[sess.historyIdx];
        } else {
          sess.historyIdx = -1;
          inputEl.value = '';
        }
      }
    }
  });

  async function dispatch(sess, cmd) {
    if (!invoke || !tauriEvt) {
      appendLine('Shell not available.', 'system');
      return;
    }

    if (cmd === 'clear' || cmd === 'cls') {
      sess.lines = [];
      if (activeSess === sess) output.innerHTML = '';
      return;
    }

    const cdMatch = cmd.match(/^cd(?:\s+(.*))?$/i);
    if (cdMatch) {
      await doCd(sess, cdMatch[1]?.trim() ?? '');
      return;
    }

    await spawnCmd(sess, cmd);
  }

  async function doCd(sess, target) {
    if (!target || target === '~') {
      if (state.folderPath) sess.cwd = state.folderPath;
      return;
    }

    const isAbsWin  = /^[A-Za-z]:[\\/]/.test(target);
    const isAbsUnix = target.startsWith('/');
    let newPath;

    if (isAbsWin || isAbsUnix) {
      newPath = target;
    } else {
      const sep   = sess.cwd.includes('\\') ? '\\' : '/';
      const parts = sess.cwd.replace(/\\/g, '/').split('/').filter(Boolean);
      for (const p of target.replace(/\\/g, '/').split('/')) {
        if      (p === '..')  parts.pop();
        else if (p && p !== '.') parts.push(p);
      }
      newPath = sep === '\\'
        ? parts.join('\\')
        : '/' + parts.join('/');
    }

    try {
      await invoke('list_dir', { path: newPath });
      sess.cwd = newPath;
    } catch {
      appendLine(`cd: no such directory: ${target}`, 'stderr');
    }
  }

  async function spawnCmd(sess, cmd) {
    const id     = ++globalCmdId;
    const runCwd = sess.cwd || '.';
    const shell  = sess.shell ?? availableShells[0] ?? 'cmd';

    function renderCmdLine(text, type) {
      const line = document.createElement('div');
      line.className = 'terminal-line' + (type ? ` ${type}` : '');
      if (type === 'system' || type === 'cmd') {
        line.textContent = text;
      } else {
        const html = ansiToHtml(text);
        const plain = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        if (html === plain && tabs) {
          const linked = linkifyPaths(text, activeSess?.cwd ?? '');
          if (linked) { line.appendChild(linked); output.appendChild(line); output.scrollTop = output.scrollHeight; return; }
        }
        line.innerHTML = html;
      }
      output.appendChild(line);
      output.scrollTop = output.scrollHeight;
    }

    function appendToSess(text, type) {
      sess.lines.push({ text, type });
      if (activeSess === sess) renderCmdLine(text, type);
    }

    const pty = needsPty(cmd);
    sess.activePtyId   = id;
    sess.activePtyMode = pty;

    let ptyBuf = '', flushTimer = null;
    const flushBuf = () => { if (ptyBuf) { appendToSess(ptyBuf, ''); ptyBuf = ''; } flushTimer = null; };

    // PTY uses chunk events; regular commands use line events
    const dataEvent = pty ? 'pty-data' : 'term-data';
    const unlistenData = await tauriEvt.listen(dataEvent, (ev) => {
      if (ev.payload.id !== id) return;
      if (pty) {
        const cleaned = ev.payload.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        ptyBuf += cleaned;
        const parts = ptyBuf.split('\n');
        ptyBuf = parts.pop() ?? '';
        for (const part of parts) appendToSess(part, '');
        clearTimeout(flushTimer);
        if (ptyBuf) flushTimer = setTimeout(flushBuf, 80);
      } else {
        appendToSess(ev.payload.text.replace(/\r/g, ''), ev.payload.is_err ? 'stderr' : '');
      }
    });

    let resolveExit;
    const exitDone = new Promise(r => { resolveExit = r; });

    const unlistenExit = await tauriEvt.listen('term-exit', (ev) => {
      if (ev.payload.id !== id) return;
      if (pty) { clearTimeout(flushTimer); flushBuf(); }
      unlistenData();
      unlistenExit();
      if (ev.payload.code !== 0) appendToSess(`exit ${ev.payload.code}`, 'system');
      sess.activePtyId   = null;
      sess.activePtyMode = false;
      if (activeSess === sess) inputEl.focus();
      resolveExit();
    });

    try {
      if (pty) {
        // Always use 'cmd' shell for PTY — avoids PowerShell ConPTY init issues
        await invoke('start_pty', { id, cmd, cwd: runCwd, shell: 'cmd' });
      } else {
        await invoke('start_command', { id, cmd, cwd: runCwd, shell });
      }
      await exitDone;
    } catch (err) {
      if (pty) { clearTimeout(flushTimer); }
      unlistenData();
      unlistenExit();
      sess.activePtyId   = null;
      sess.activePtyMode = false;
      appendToSess(`Error: ${err}`, 'stderr');
    }
  }

  // Matches: C:\path\file.ext:10  ./path/file.ext:10:5  path/file.rs:10
  const PATH_RE = /((?:[A-Za-z]:[\\/]|\.\.?[\\/]|[\w][\w.\-]*[\\/])[^\s"'`<>|*?\x00-\x1f]*?\.[a-zA-Z]{1,10}):(\d+)(?::(\d+))?/g;

  function resolvePath(p, cwd) {
    if (/^[A-Za-z]:/.test(p) || p.startsWith('/')) return p;
    const base = (cwd || '').replace(/\\/g, '/').replace(/\/$/, '');
    if (!base) return p;
    const rel = p.replace(/\\/g, '/').replace(/^\.\//, '');
    return base + '/' + rel;
  }

  function openPathAtLine(filePath, line) {
    if (!tabs) return;
    const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
    tabs.openFile(filePath, name, { activate: true });
    const handler = (ev) => {
      if (ev.detail.path === filePath) {
        document.removeEventListener('ln:activate-file', handler);
        setTimeout(() => {
          const ta = editor?.getTextarea?.();
          if (!ta) return;
          const lines  = ta.value.split('\n');
          const target = Math.max(1, Math.min(line, lines.length));
          let offset = 0;
          for (let i = 0; i < target - 1; i++) offset += lines[i].length + 1;
          ta.selectionStart = ta.selectionEnd = offset;
          ta.focus();
          const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 21;
          ta.scrollTop = Math.max(0, (target - 1) * lineH - ta.clientHeight / 2);
        }, 60);
      }
    };
    document.addEventListener('ln:activate-file', handler);
  }

  function linkifyPaths(text, cwd) {
    PATH_RE.lastIndex = 0;
    let match;
    let lastIndex = 0;
    let hasLink   = false;
    const frag    = document.createDocumentFragment();

    while ((match = PATH_RE.exec(text)) !== null) {
      const [fullMatch, pathStr, lineStr] = match;
      const before = text.slice(lastIndex, match.index);
      if (before) frag.appendChild(document.createTextNode(before));

      const resolved = resolvePath(pathStr, cwd);
      const link = document.createElement('span');
      link.className = 'term-link';
      link.textContent = fullMatch;
      link.title = `Open ${pathStr} at line ${lineStr}`;
      link.addEventListener('click', () => openPathAtLine(resolved, parseInt(lineStr, 10)));
      frag.appendChild(link);
      lastIndex = match.index + fullMatch.length;
      hasLink = true;
    }

    if (!hasLink) return null;
    const tail = text.slice(lastIndex);
    if (tail) frag.appendChild(document.createTextNode(tail));
    return frag;
  }

  function appendLine(text, type = '') {
    if (activeSess) activeSess.lines.push({ text, type });
    renderLine(text, type);
  }

  function renderLine(text, type = '') {
    const line = document.createElement('div');
    line.className = 'terminal-line' + (type ? ` ${type}` : '');

    if (type !== 'cmd' && tabs) {
      const linked = linkifyPaths(text, activeSess?.cwd ?? '');
      if (linked !== null) {
        line.appendChild(linked);
        output.appendChild(line);
        output.scrollTop = output.scrollHeight;
        return;
      }
    }

    line.textContent = text;
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
  }

  document.addEventListener('ln:run-in-terminal', async (e) => {
    const cmd = e.detail?.cmd;
    if (!cmd) return;
    show();
    if (!activeSess) return;
    appendLine(`${promptEl.textContent}${cmd}`, 'cmd');
    await dispatch(activeSess, cmd);
    inputEl.focus();
    refreshPrompt();
  });

  return { show, hide, toggle, appendLine, getState, restoreSessions };
}
