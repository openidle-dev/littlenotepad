export function initMinimap(textarea) {
  const canvas = document.getElementById('minimap-canvas');
  const vp     = document.getElementById('minimap-viewport');
  if (!canvas || !vp) return { update: () => {}, syncViewport: () => {} };

  const ctx  = canvas.getContext('2d');
  const CW   = 1;    // CSS px per character
  const LH   = 2;    // CSS px per line
  const PAD  = 2;    // left padding px

  let _lines = [];
  let _raf   = 0;
  let _cssH  = 0;
  let _dpr   = 1;

  function resize() {
    _dpr = window.devicePixelRatio || 1;
    // Observe the textarea — it always has the correct editor height
    const h = textarea.offsetHeight;
    if (h <= 0) return;
    if (_cssH === h) return;
    _cssH = h;
    canvas.style.height = h + 'px';
    canvas.width  = Math.round(80 * _dpr);
    canvas.height = Math.round(h * _dpr);
    ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
    render();
  }
  new ResizeObserver(resize).observe(textarea);
  requestAnimationFrame(resize);

  let C = {};
  function refreshColors() {
    const s = getComputedStyle(document.documentElement);
    const g = (v, fb) => s.getPropertyValue(v).trim() || fb;
    C = {
      bg:  g('--bg-base',     '#1e1e1e'),
      def: g('--fg-default',  '#c8c8c8'),
      kw:  g('--syn-keyword', '#569cd6'),
      str: g('--syn-string',  '#ce9178'),
      cmt: g('--syn-comment', '#6a9955'),
      num: g('--syn-number',  '#b5cea8'),
      typ: g('--syn-type',    '#4ec9b0'),
    };
  }

  const KW = new Set([
    'abstract','as','async','await','break','case','catch','class','const',
    'continue','debugger','declare','default','delete','do','else','enum',
    'export','extends','false','finally','fn','for','from','function','if',
    'impl','import','in','instanceof','interface','let','match','mod','new',
    'null','of','override','pub','readonly','return','self','static','struct',
    'super','switch','this','throw','trait','true','try','type','typeof',
    'undefined','union','use','var','void','where','while','yield',
  ]);

  function tokenize(line) {
    // Returns [{start, len, color}]
    const out = [];
    let i = 0;
    const n = line.length;

    while (i < n) {
      const ch = line[i];

      // Whitespace — skip (draws as background gap)
      if (ch === ' ' || ch === '\t') { i++; continue; }

      // Line comment // or #
      if ((ch === '/' && line[i+1] === '/') || ch === '#') {
        out.push({ start: i, len: n - i, color: C.cmt });
        break;
      }
      // Block comment start /*
      if (ch === '/' && line[i+1] === '*') {
        out.push({ start: i, len: n - i, color: C.cmt });
        break;
      }
      // Inside block comment (line starts with *)
      if (ch === '*') {
        out.push({ start: i, len: n - i, color: C.cmt });
        break;
      }

      // String " ' `
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1;
        while (j < n && line[j] !== ch) { if (line[j] === '\\') j++; j++; }
        j++;
        out.push({ start: i, len: j - i, color: C.str });
        i = j;
        continue;
      }

      // Number
      if (ch >= '0' && ch <= '9') {
        let j = i + 1;
        while (j < n && (line[j] >= '0' && line[j] <= '9' || line[j] === '.')) j++;
        out.push({ start: i, len: j - i, color: C.num });
        i = j;
        continue;
      }

      // Identifier / keyword / type
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') {
        let j = i + 1;
        while (j < n && (
          (line[j] >= 'a' && line[j] <= 'z') ||
          (line[j] >= 'A' && line[j] <= 'Z') ||
          (line[j] >= '0' && line[j] <= '9') ||
          line[j] === '_' || line[j] === '$'
        )) j++;
        const word = line.slice(i, j);
        const color = KW.has(word)
          ? C.kw
          : (word[0] >= 'A' && word[0] <= 'Z') ? C.typ : C.def;
        out.push({ start: i, len: j - i, color });
        i = j;
        continue;
      }

      // Operator / punctuation — short dim mark
      out.push({ start: i, len: 1, color: C.def });
      i++;
    }
    return out;
  }

  function compute() {
    const H        = _cssH || 1;
    const scrollH  = textarea.scrollHeight || 1;
    const clientH  = textarea.clientHeight || 1;
    const totalH   = (_lines.length || 1) * LH;
    const maxScroll = Math.max(0, scrollH - clientH);
    const frac = maxScroll > 0 ? textarea.scrollTop / maxScroll : 0;

    if (totalH <= H) {
      // Whole file fits in canvas — content stays at top, indicator slides within content
      const vpH        = Math.max(8, (clientH / scrollH) * totalH);
      const vpCanvasTop = frac * (totalH - vpH);
      return { offset: 0, vpCanvasTop, vpH };
    } else {
      // File taller than canvas — scroll content so indicator stays visible
      const vpH        = Math.max(8, Math.min(H, (clientH / scrollH) * H));
      const vpCanvasTop = frac * (H - vpH);
      const vpContentTop = (textarea.scrollTop / scrollH) * totalH;
      const offset      = vpContentTop - vpCanvasTop;
      return { offset, vpCanvasTop, vpH };
    }
  }

  function draw(offset) {
    const W = 80;     // CSS px
    const H = _cssH;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    const first = Math.max(0, Math.floor(offset / LH) - 1);

    for (let i = first; i < _lines.length; i++) {
      const y = i * LH - offset;
      if (y > H) break;
      if (y < -LH) continue;

      const line = _lines[i];
      if (!line.trim()) continue;

      const tokens = tokenize(line);
      for (const tok of tokens) {
        const x = PAD + tok.start * CW;
        if (x >= W) break;
        const w = Math.min(tok.len * CW, W - x);
        ctx.fillStyle   = tok.color;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x, y, w, LH - 0.5);
      }
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(() => {
      refreshColors();
      const { offset, vpCanvasTop, vpH } = compute();
      draw(offset);
      vp.style.top    = Math.max(0, vpCanvasTop) + 'px';
      vp.style.height = vpH + 'px';
    });
  }

  document.addEventListener('ln:settings-changed', render);

  function update(text) {
    _lines = text.split('\n');
    _cssH = 0;  // force resize to re-measure
    resize();
  }
  function syncViewport() { render(); }

  let _drag = false;
  function jumpTo(clientY) {
    const rect     = canvas.getBoundingClientRect();
    const { offset } = compute();
    const contentY = (clientY - rect.top) + offset;
    const totalH   = (_lines.length || 1) * LH;
    textarea.scrollTop = Math.max(0, Math.min(1, contentY / totalH)) * textarea.scrollHeight;
  }
  canvas.addEventListener('pointerdown', e => {
    _drag = true; canvas.setPointerCapture(e.pointerId); jumpTo(e.clientY); e.preventDefault();
  });
  canvas.addEventListener('pointermove',   e => { if (_drag) jumpTo(e.clientY); });
  canvas.addEventListener('pointerup',     () => { _drag = false; });
  canvas.addEventListener('pointercancel', () => { _drag = false; });

  return { update, syncViewport };
}
