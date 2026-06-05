export function renderMarkdown(src) {
  if (!src) return '';
  const lines = src.split('\n');
  const out   = [];
  let i = 0;

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    s = esc(s);
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*(.+?)\*\*/g,      '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g,           '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g,         '<em>$1</em>');
    s = s.replace(/_([^_]+)_/g,           '<em>$1</em>');
    s = s.replace(/~~(.+?)~~/g,           '<del>$1</del>');
    s = s.replace(/`([^`]+)`/g,           '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
    return s;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = esc(line.slice(3).trim());
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(esc(lines[i]));
        i++;
      }
      i++;
      out.push(`<pre><code${lang ? ` class="lang-${lang}"` : ''}>${code.join('\n')}</code></pre>`);
      continue;
    }

    // ATX heading
    const hm = line.match(/^(#{1,6}) +(.*)/);
    if (hm) {
      const lvl = hm[1].length;
      out.push(`<h${lvl}>${inline(hm[2])}</h${lvl}>`);
      i++; continue;
    }

    // Horizontal rule
    if (/^(?:---+|___+|\*\*\*+) *$/.test(line)) {
      out.push('<hr>');
      i++; continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const bq = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        bq.push(lines[i].slice(2));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(bq.join('\n'))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*+] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+] /.test(lines[i])) {
        items.push(`<li>${inline(lines[i].slice(2))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    const om = line.match(/^(\d+)\. (.*)/);
    if (om) {
      const start = parseInt(om[1], 10);
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\d+\. /, ''))}</li>`);
        i++;
      }
      out.push(`<ol start="${start}">${items.join('')}</ol>`);
      continue;
    }

    // Paragraph
    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !lines[i].startsWith('#') && !lines[i].startsWith('```') &&
      !lines[i].startsWith('> ') && !/^[-*+] /.test(lines[i]) &&
      !/^\d+\. /.test(lines[i]) && !/^(?:---+|___+|\*\*\*+) *$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }

  return out.join('');
}
