// Regex-based syntax tokenizer.
// Supports: JS/TS, Rust, Python, JSON, HTML, CSS, Markdown, TOML, YAML, Shell, Go.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build a combined-regex tokenizer from ordered [regex, cssClass] pairs.
// All regexes must use only non-capturing groups (?:...) internally.
function buildTokenizer(patterns) {
  const src = patterns
    .map(([re], i) => `(?<G${i}>${re instanceof RegExp ? re.source : re})`)
    .join('|');
  let re;
  try { re = new RegExp(src, 'gs'); } catch { return null; }
  const cls = patterns.map(([, c]) => c);

  return function tokenize(code) {
    let out = '', last = 0;
    for (const m of code.matchAll(re)) {
      if (m.index > last) out += escapeHtml(code.slice(last, m.index));
      let c = '';
      for (let i = 0; i < cls.length; i++) {
        if (m.groups[`G${i}`] !== undefined) { c = cls[i]; break; }
      }
      out += c ? `<span class="${c}">${escapeHtml(m[0])}</span>` : escapeHtml(m[0]);
      last = m.index + m[0].length;
    }
    if (last < code.length) out += escapeHtml(code.slice(last));
    return out + '\n';
  };
}

const _jsKw = /\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|global|if|implements|import|in|infer|instanceof|interface|is|keyof|let|module|namespace|new|of|override|package|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|undefined|unique|unknown|var|void|while|with|yield)\b/;
const _jsType = /\b(?:Array|BigInt|Boolean|Date|Error|Function|Map|NaN|Infinity|Number|Object|Promise|Proxy|Reflect|RegExp|Set|String|Symbol|WeakMap|WeakRef|WeakSet|any|boolean|never|null|number|object|string|true|false)\b/;

const jsPatterns = [
  [/\/\/[^\n]*/, 'syn-comment'],
  [/\/\*[\s\S]*?\*\//, 'syn-comment'],
  [/`(?:[^`\\]|\\.)*`/, 'syn-string'],
  [/"(?:[^"\\]|\\.)*"/, 'syn-string'],
  [/'(?:[^'\\]|\\.)*'/, 'syn-string'],
  [/\b(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?n?)\b/, 'syn-number'],
  [_jsKw, 'syn-keyword'],
  [_jsType, 'syn-type'],
  [/\b[A-Z][A-Za-z0-9_]*(?=\s*[<(])/, 'syn-type'],
  [/\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\()/, 'syn-function'],
];

const _rustKw = /\b(?:as|async|await|become|box|break|const|continue|crate|do|dyn|else|enum|extern|false|final|fn|for|if|impl|in|let|loop|macro|match|mod|move|mut|override|priv|pub|ref|return|self|static|struct|super|trait|true|try|type|typeof|union|unsafe|unsized|use|virtual|where|while|yield)\b/;
const _rustType = /\b(?:Arc|Box|Cow|HashMap|HashSet|Option|Rc|Result|Self|String|Vec|bool|char|f32|f64|i8|i16|i32|i64|i128|isize|str|u8|u16|u32|u64|u128|usize)\b/;

const rustPatterns = [
  [/\/\/[^\n]*/, 'syn-comment'],
  [/\/\*[\s\S]*?\*\//, 'syn-comment'],
  [/b?r(?:###"[\s\S]*?"###|##"[\s\S]*?"##|#"[\s\S]*?"#|"[\s\S]*?")/, 'syn-string'],
  [/b?"(?:[^"\\]|\\.)*"/, 'syn-string'],
  [/b?'(?:[^'\\]|\\.)'/, 'syn-string'],
  [/'[a-zA-Z_][a-zA-Z0-9_]*(?!\s*['a-zA-Z])/, 'syn-type'],
  [/\b(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|[\d_]+(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64)?)\b/, 'syn-number'],
  [_rustKw, 'syn-keyword'],
  [_rustType, 'syn-type'],
  [/\b[a-zA-Z_][a-zA-Z0-9_]*!(?=\s*[\[({"'])/, 'syn-function'],
  [/\b[A-Z][A-Za-z0-9_]*/, 'syn-type'],
  [/\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/, 'syn-function'],
];

const _pyKw = /\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/;

const pythonPatterns = [
  [/#[^\n]*/, 'syn-comment'],
  [/[fFrRbBuU]{0,2}"""[\s\S]*?"""/, 'syn-string'],
  [/[fFrRbBuU]{0,2}'''[\s\S]*?'''/, 'syn-string'],
  [/[fFrRbBuU]{0,2}"(?:[^"\\]|\\.)*"/, 'syn-string'],
  [/[fFrRbBuU]{0,2}'(?:[^'\\]|\\.)*'/, 'syn-string'],
  [/@[A-Za-z_][A-Za-z0-9_.]*/, 'syn-type'],
  [/\b(?:0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?j?)\b/, 'syn-number'],
  [_pyKw, 'syn-keyword'],
  [/\b(?:bool|bytearray|bytes|complex|dict|enumerate|filter|float|frozenset|int|len|list|map|object|print|range|reversed|set|slice|sorted|str|super|tuple|type|zip)\b/, 'syn-type'],
  [/\b[A-Z][A-Za-z0-9_]*/, 'syn-type'],
  [/\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/, 'syn-function'],
];

const jsonPatterns = [
  [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'syn-attr'],
  [/"(?:[^"\\]|\\.)*"/, 'syn-string'],
  [/\b(?:true|false|null)\b/, 'syn-keyword'],
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'syn-number'],
];

const htmlPatterns = [
  [/<!--[\s\S]*?-->/, 'syn-comment'],
  [/<(?:!DOCTYPE|!doctype)[^>]*>/, 'syn-comment'],
  [/<\/?[A-Za-z][A-Za-z0-9.-]*/, 'syn-tag'],
  [/\/?>/, 'syn-tag'],
  [/[A-Za-z:_][\w:.-]*(?=\s*=)/, 'syn-attr'],
  [/"(?:[^"\\]|\\.)*"/, 'syn-string'],
  [/'(?:[^'\\]|\\.)*'/, 'syn-string'],
  [/&(?:#\d+|#x[\da-fA-F]+|[A-Za-z]+);/, 'syn-keyword'],
];

const cssPatterns = [
  [/\/\*[\s\S]*?\*\//, 'syn-comment'],
  [/"(?:[^"\\]|\\.)*"/, 'syn-string'],
  [/'(?:[^'\\]|\\.)*'/, 'syn-string'],
  [/@[A-Za-z-]+/, 'syn-keyword'],
  [/#[\da-fA-F]{3,8}\b/, 'syn-number'],
  [/-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|vh|vw|vmin|vmax|svh|svw|dvh|dvw|%|s|ms|deg|fr|ch|ex|cm|mm|in|pt|pc)?\b/, 'syn-number'],
  [/\b(?:inherit|initial|revert|revert-layer|unset|auto|none|normal|bold|italic|underline|solid|dashed|dotted|hidden|visible|absolute|relative|fixed|sticky|flex|grid|block|inline(?:-block|-flex|-grid)?|center|left|right|top|bottom|middle|space-between|space-around|space-evenly|stretch|baseline|wrap|nowrap|row|column|transparent|currentColor|calc|var|env|min|max|clamp|fit-content)\b/, 'syn-keyword'],
  [/(?:--?[A-Za-z][A-Za-z0-9-]*)(?=\s*:(?!:))/, 'syn-attr'],
  [/::[A-Za-z-]+/, 'syn-type'],
  [/:[A-Za-z-]+(?=[\s{(,])/, 'syn-type'],
];

const mdPatterns = [
  [/```[\s\S]*?```/, 'syn-string'],
  [/`[^`\n]+`/, 'syn-string'],
  [/#{1,6} [^\n]+/, 'syn-keyword'],
  [/\*\*(?:[^*]|\*(?!\*))+\*\*|__(?:[^_]|_(?!_))+__/, 'syn-type'],
  [/\*[^*\n]+\*|_[^_\n]+_/, 'syn-function'],
  [/!\[[^\]]*\]\([^)]+\)/, 'syn-attr'],
  [/\[[^\]]+\]\([^)]+\)/, 'syn-attr'],
];

const tomlPatterns = [
  [/#[^\n]*/, 'syn-comment'],
  [/"""[\s\S]*?"""/, 'syn-string'],
  [/'''[\s\S]*?'''/, 'syn-string'],
  [/"(?:[^"\\]|\\.)*"/, 'syn-string'],
  [/'[^'\n]*'/, 'syn-string'],
  [/\[+[^\]\n]+\]+/, 'syn-type'],
  [/\b(?:true|false)\b/, 'syn-keyword'],
  [/\d{4}-\d{2}-\d{2}(?:T[\d:.Z+-]+)?/, 'syn-number'],
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'syn-number'],
  [/[A-Za-z0-9_.-]+(?=\s*=)/, 'syn-attr'],
];

const yamlPatterns = [
  [/#[^\n]*/, 'syn-comment'],
  [/"(?:[^"\\]|\\.)*"/, 'syn-string'],
  [/'[^'\n]*'/, 'syn-string'],
  [/\b(?:true|false|null|yes|no|on|off|True|False|Null|YES|NO|ON|OFF)\b/, 'syn-keyword'],
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'syn-number'],
  [/&[A-Za-z_][A-Za-z0-9_]*|\*[A-Za-z_][A-Za-z0-9_]*/, 'syn-type'],
  [/![!A-Za-z]+/, 'syn-type'],
  [/[A-Za-z_][A-Za-z0-9_.-]*(?=\s*:)/, 'syn-attr'],
];

const _shellKw = /\b(?:if|then|else|elif|fi|for|do|done|while|until|case|in|esac|function|return|export|local|readonly|declare|source|echo|cd|exit|break|continue|alias|unset|shift|eval|exec|set|trap)\b/;

const shellPatterns = [
  [/#![^\n]*/, 'syn-comment'],
  [/#[^\n]*/, 'syn-comment'],
  [/"(?:[^"\\]|\\.)*"/, 'syn-string'],
  [/'[^']*'/, 'syn-string'],
  [/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$\d+|\$[@*#?$!0]/, 'syn-type'],
  [_shellKw, 'syn-keyword'],
  [/\b\d+\b/, 'syn-number'],
];

const _goKw = /\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/;
const _goBuiltin = /\b(?:bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr|true|false|nil|iota|append|cap|close|complex|copy|delete|imag|len|make|new|panic|print|println|real|recover)\b/;

const goPatterns = [
  [/\/\/[^\n]*/, 'syn-comment'],
  [/\/\*[\s\S]*?\*\//, 'syn-comment'],
  [/`[^`]*`/, 'syn-string'],
  [/"(?:[^"\\]|\\.)*"/, 'syn-string'],
  [/'(?:[^'\\]|\\.)*'/, 'syn-string'],
  [/\b(?:0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/, 'syn-number'],
  [_goKw, 'syn-keyword'],
  [_goBuiltin, 'syn-type'],
  [/\b[A-Z][A-Za-z0-9_]*/, 'syn-type'],
  [/\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/, 'syn-function'],
];

const LANG_PATTERNS = {
  javascript: jsPatterns,
  typescript: jsPatterns,
  rust:       rustPatterns,
  python:     pythonPatterns,
  json:       jsonPatterns,
  html:       htmlPatterns,
  css:        cssPatterns,
  markdown:   mdPatterns,
  toml:       tomlPatterns,
  yaml:       yamlPatterns,
  shell:      shellPatterns,
  go:         goPatterns,
};

const TOKENIZERS = {};

function getTokenizer(lang) {
  if (TOKENIZERS[lang]) return TOKENIZERS[lang];
  const patterns = LANG_PATTERNS[lang];
  if (!patterns) return null;
  TOKENIZERS[lang] = buildTokenizer(patterns);
  return TOKENIZERS[lang];
}

export function detectLanguage(filename) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
    rs: 'rust',
    py: 'python',
    html: 'html', htm: 'html',
    css: 'css', scss: 'css', less: 'css',
    json: 'json', jsonc: 'json',
    md: 'markdown', mdx: 'markdown',
    toml: 'toml', yaml: 'yaml', yml: 'yaml',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    go: 'go', java: 'java', cpp: 'cpp', c: 'c', cs: 'csharp',
    rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
    sql: 'sql', graphql: 'graphql',
  };
  return map[ext] ?? 'plaintext';
}

// Inject <mark> spans at text-position ranges into already-generated highlight HTML.
// marks: [{start, end, cls}] — positions in original text, not in HTML.
export function injectMarks(html, marks) {
  if (!marks || !marks.length) return html;

  // Build a flat event list: open and close at each text position
  const events = [];
  for (const m of marks) {
    events.push({ pos: m.start, open: true,  cls: m.cls, msg: m.msg, code: m.code });
    events.push({ pos: m.end,   open: false, cls: m.cls });
  }
  // Close before open at same pos; sort by position
  events.sort((a, b) => a.pos - b.pos || (a.open ? 1 : -1));

  let result  = '';
  let textPos = 0;
  let htmlPos = 0;
  let eIdx    = 0;

  while (htmlPos < html.length) {
    while (eIdx < events.length && events[eIdx].pos === textPos) {
      const ev = events[eIdx++];
      if (ev.open) {
        let attrs = `class="${ev.cls}"`;
        if (ev.msg  != null) attrs += ` data-msg="${ev.msg.replace(/"/g, '&quot;')}"`;
        if (ev.code != null) attrs += ` data-code="${String(ev.code).replace(/"/g, '&quot;')}"`;
        result += `<mark ${attrs}>`;
      } else {
        result += '</mark>';
      }
    }
    const ch = html[htmlPos];
    if (ch === '<') {
      const end = html.indexOf('>', htmlPos);
      if (end < 0) { result += html.slice(htmlPos); htmlPos = html.length; break; }
      result += html.slice(htmlPos, end + 1);
      htmlPos = end + 1;
    } else if (ch === '&') {
      const end = html.indexOf(';', htmlPos);
      if (end < 0) { result += html.slice(htmlPos); htmlPos = html.length; break; }
      result += html.slice(htmlPos, end + 1);
      htmlPos = end + 1;
      textPos++;
    } else {
      result += ch;
      htmlPos++;
      textPos++;
    }
  }
  while (eIdx < events.length) {
    if (!events[eIdx++].open) result += '</mark>';
  }
  return result;
}

export function highlight(code, language) {
  const tokenizer = getTokenizer(language);
  if (!tokenizer) return escapeHtml(code) + '\n';
  try {
    return tokenizer(code);
  } catch {
    return escapeHtml(code) + '\n';
  }
}
