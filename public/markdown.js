// Markdown and code colouring for chat messages. Loaded before app.js; defines md() and highlight().
//
// Safety: replies are untrusted text. Every character of a reply is escaped before it is placed in
// HTML, and the only tags that reach the page are the ones written in this file. Links are limited
// to http and https. The scanners below work forwards through the text once, so hostile input
// cannot make them stall.
const { md, highlight } = (() => {
  const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ---------- code colouring ----------

  const words = s => new Set(s.split(' '));
  const C_LINE = ['//'];
  const C_BLOCK = ['/*', '*/'];
  const LANGS = {
    js: {
      line: C_LINE, block: C_BLOCK, quotes: '"\'`', calls: true, types: true,
      kw: words('as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return set static switch throw try type typeof var void while with yield declare namespace abstract keyof infer satisfies is'),
      lit: words('true false null undefined NaN Infinity this super'),
    },
    py: {
      line: ['#'], quotes: '"\'', triple: true, decorators: true, calls: true, types: true,
      kw: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'),
      lit: words('True False None self cls'),
    },
    sh: {
      line: ['#'], hashNeedsGap: true, quotes: '"\'', vars: true, flags: true, commands: true, dashWords: true,
      kw: words('if then else elif fi for in do done while until case esac function return export local readonly declare unset set source alias exit break continue eval exec trap shift'),
      lit: words('true false'),
    },
    ps: {
      line: ['#'], block: ['<#', '#>'], hashNeedsGap: true, quotes: '"\'', vars: true, flags: true, commands: true, dashWords: true, anyCase: true,
      kw: words('if else elseif foreach for while do until switch function param return try catch finally throw begin process end filter in break continue exit class enum using'),
      lit: words(''),
    },
    sql: {
      line: ['--'], block: C_BLOCK, quotes: '\'"', anyCase: true, calls: true,
      kw: words('select from where and or not in is as join inner left right full outer cross on group by order having limit offset insert into values update set delete create table alter drop index view primary key foreign references unique default constraint union all distinct case when then else end exists between like asc desc with returning begin commit rollback if replace trigger database schema grant revoke'),
      lit: words('null true false'),
    },
    c: {
      line: C_LINE, block: C_BLOCK, quotes: '"\'`', calls: true, types: true,
      kw: words('auto break case catch char class const constexpr continue default delete do double else enum explicit export extern final finally float for friend goto if inline int long namespace new noexcept operator override private protected public register return short signed sizeof static struct switch template throw try typedef typename union unsigned using virtual void volatile while abstract async await boolean byte extends implements import instanceof interface native package super synchronized throws transient var let fn mut impl trait pub use mod crate where match loop move ref dyn unsafe func go defer chan map range select type string bool i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 usize isize str val fun object when is in as internal sealed data suspend guard protocol extension lazy weak'),
      lit: words('true false null nil nullptr None Some Ok Err iota self Self this'),
    },
    json: { line: C_LINE, block: C_BLOCK, quotes: '"', keysBefore: ':', kw: words(''), lit: words('true false null') },
    yaml: { line: ['#'], hashNeedsGap: true, quotes: '"\'', lineKeys: ':', dashWords: true, kw: words(''), lit: words('true false null yes no on off') },
    toml: { line: ['#', ';'], hashNeedsGap: true, quotes: '"\'', lineKeys: '=', dashWords: true, kw: words(''), lit: words('true false') },
  };
  const ALIASES = {
    javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', node: 'js',
    python: 'py', python3: 'py', py3: 'py',
    bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', shellsession: 'sh', terminal: 'sh', bat: 'sh', cmd: 'sh', batch: 'sh', dockerfile: 'sh', makefile: 'sh',
    powershell: 'ps', pwsh: 'ps', ps1: 'ps',
    postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql', psql: 'sql',
    java: 'c', kotlin: 'c', kt: 'c', 'c++': 'c', cpp: 'c', h: 'c', hpp: 'c', cs: 'c', csharp: 'c', 'c#': 'c', swift: 'c', php: 'c', go: 'c', golang: 'c', rust: 'c', rs: 'c', scala: 'c', dart: 'c', zig: 'c',
    jsonc: 'json', json5: 'json', yml: 'yaml', ini: 'toml', conf: 'toml', env: 'toml',
    scss: 'css', less: 'css', xml: 'html', svg: 'html', vue: 'html', htm: 'html', xhtml: 'html', patch: 'diff',
  };
  const HIGHLIGHT_LIMIT = 150_000;
  const NUMBER = /0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[a-zA-Z%]{0,4}/y;
  const WORD = /[A-Za-z_$][\w$]*/y;
  const DASH_WORD = /[A-Za-z_][\w-]*/y;
  const SHELL_VAR = /\$(?:\{[^}\n]{0,200}\}|[A-Za-z_][\w:]*|[?@#$!*0-9])/y;
  const FLAG = /--?[A-Za-z][\w-]*/y;
  const DECORATOR = /@[\w.]+/y;
  const at = (re, text, i) => {
    re.lastIndex = i;
    const m = re.exec(text);
    return m ? m[0] : '';
  };

  // The end of a quoted string that starts at i, or -1 when the quote never closes on its line.
  function stringEnd(code, i, quote, triple) {
    if (triple && code.startsWith(quote.repeat(3), i)) {
      const end = code.indexOf(quote.repeat(3), i + 3);
      return end < 0 ? code.length : end + 3;
    }
    for (let j = i + 1; j < code.length; j++) {
      const ch = code[j];
      if (ch === '\\') j++;
      else if (ch === quote) return j + 1;
      else if (ch === '\n' && quote !== '`') return quote === '"' ? j : -1;
    }
    return quote === '\'' ? -1 : code.length;
  }

  // One pass over the code. Anything not recognised is copied through as plain (escaped) text.
  function lex(code, L) {
    const n = code.length;
    let out = '';
    let i = 0;
    let plain = 0;
    let lineStart = true; // nothing but spaces (and a YAML "- ") since the last newline
    let command = true; // the next word is a command name (shells)
    const put = (cls, end) => {
      out += `${esc(code.slice(plain, i))}<span class="tk-${cls}">${esc(code.slice(i, end))}</span>`;
      i = end;
      plain = end;
    };
    while (i < n) {
      const ch = code[i];
      if (ch === '\n') { lineStart = true; command = true; i++; continue; }
      if (ch === ' ') { i++; continue; }
      const startOfLine = lineStart;
      lineStart = false;
      // In "NAME=value command", the value does not use up the command slot.
      const stillCommand = command && code[i - 1] === '=';

      const gapBefore = i === 0 || code[i - 1] === ' ' || code[i - 1] === '\n';
      if (L.line.some(p => code.startsWith(p, i)) && (ch !== '#' || !L.hashNeedsGap || gapBefore)) {
        const end = code.indexOf('\n', i);
        put('c', end < 0 ? n : end);
        continue;
      }
      if (L.block && code.startsWith(L.block[0], i)) {
        const end = code.indexOf(L.block[1], i + L.block[0].length);
        put('c', end < 0 ? n : end + L.block[1].length);
        continue;
      }
      if (L.quotes.includes(ch)) {
        const end = stringEnd(code, i, ch, L.triple);
        if (end < 0) { i++; continue; }
        let cls = 's';
        if (L.keysBefore) {
          let j = end;
          while (code[j] === ' ') j++;
          if (code[j] === L.keysBefore) cls = 'p';
        }
        put(cls, end);
        command = stillCommand;
        continue;
      }
      if (ch >= '0' && ch <= '9') {
        put('n', i + at(NUMBER, code, i).length);
        command = stillCommand;
        continue;
      }
      if (L.vars && ch === '$') {
        const v = at(SHELL_VAR, code, i);
        if (v) { put('v', i + v.length); command = stillCommand; continue; }
      }
      if (L.flags && ch === '-' && gapBefore) {
        const f = at(FLAG, code, i);
        if (f) { put('p', i + f.length); continue; }
      }
      if (L.decorators && ch === '@' && startOfLine) {
        const d = at(DECORATOR, code, i);
        if (d.length > 1) { put('f', i + d.length); continue; }
      }
      const word = at(L.dashWords ? DASH_WORD : WORD, code, i);
      if (word) {
        const end = i + word.length;
        const key = L.anyCase ? word.toLowerCase() : word;
        let j = end;
        while (code[j] === ' ') j++;
        const wasCommand = command;
        command = false;
        if (L.kw.has(key)) { put('k', end); command = !!L.commands; }
        else if (L.lit.has(key)) put('l', end);
        else if (L.lineKeys && startOfLine && code[j] === L.lineKeys) put('p', end);
        else if (L.commands && code[end] === '=') { put('v', end); command = true; }
        else if (L.commands && wasCommand) put('f', end);
        else if (L.types && word[0] >= 'A' && word[0] <= 'Z') put('t', end);
        else if (L.calls && code[j] === '(') put('f', end);
        else i = end;
        continue;
      }
      if (L.commands && (ch === '|' || ch === ';' || ch === '&' || ch === '(')) command = true;
      if (L.lineKeys && startOfLine && ch === '-') lineStart = true; // "- key: value" in YAML
      if (L.lineKeys === '=' && startOfLine && ch === '[') { // a [section] line in TOML
        const end = code.indexOf('\n', i);
        put('t', end < 0 ? n : end);
        continue;
      }
      i++;
    }
    return out + esc(code.slice(plain));
  }

  const TAG_PARTS = /("[^"]*"|'[^']*')|([\w:@.-]+)(?=\s*=)|^(<\/?)([\w:-]+)/g;
  function lexHtml(code) {
    let out = '';
    let i = 0;
    while (i < code.length) {
      const open = code.indexOf('<', i);
      if (open < 0) break;
      out += esc(code.slice(i, open));
      if (code.startsWith('<!--', open)) {
        const end = code.indexOf('-->', open + 4);
        i = end < 0 ? code.length : end + 3;
        out += `<span class="tk-c">${esc(code.slice(open, i))}</span>`;
        continue;
      }
      const close = code.indexOf('>', open);
      const tag = code.slice(open, close < 0 ? code.length : close + 1);
      i = open + tag.length;
      if (!/^<[\/!?A-Za-z]/.test(tag) || tag.length > 2000) { out += esc(tag); continue; }
      let last = 0;
      let part;
      TAG_PARTS.lastIndex = 0;
      while ((part = TAG_PARTS.exec(tag))) {
        out += esc(tag.slice(last, part.index));
        if (part[1]) out += `<span class="tk-s">${esc(part[1])}</span>`;
        else if (part[2]) out += `<span class="tk-p">${esc(part[2])}</span>`;
        else out += `${esc(part[3])}<span class="tk-tag">${esc(part[4])}</span>`;
        last = part.index + part[0].length;
      }
      out += esc(tag.slice(last));
    }
    return out + esc(code.slice(i));
  }

  const CSS_WORD = /-{0,2}[A-Za-z_][\w-]*/y;
  const CSS_HASH = /#[\da-fA-F]{3,8}\b/y;
  function lexCss(code) {
    const n = code.length;
    let out = '';
    let i = 0;
    let plain = 0;
    let depth = 0;
    const put = (cls, end) => {
      out += `${esc(code.slice(plain, i))}<span class="tk-${cls}">${esc(code.slice(i, end))}</span>`;
      i = end;
      plain = end;
    };
    while (i < n) {
      const ch = code[i];
      if (code.startsWith('/*', i)) {
        const end = code.indexOf('*/', i + 2);
        put('c', end < 0 ? n : end + 2);
      } else if (ch === '"' || ch === '\'') {
        const end = stringEnd(code, i, ch, false);
        if (end < 0) i++;
        else put('s', end);
      } else if (ch === '{') { depth++; i++; }
      else if (ch === '}') { depth = Math.max(0, depth - 1); i++; }
      else if (ch === '@') put('k', i + 1 + at(CSS_WORD, code, i + 1).length);
      else if (ch === '#' && at(CSS_HASH, code, i)) put('n', i + at(CSS_HASH, code, i).length);
      else if (ch >= '0' && ch <= '9') put('n', i + at(NUMBER, code, i).length);
      else {
        const word = at(CSS_WORD, code, i);
        if (!word) { i++; continue; }
        const end = i + word.length;
        let j = end;
        while (code[j] === ' ') j++;
        if (depth > 0 && code[j] === ':') put('p', end);
        else if (code[end] === '(') put('f', end);
        else if (depth === 0) put('t', end);
        else i = end;
      }
    }
    return out + esc(code.slice(plain));
  }

  // Each line of a diff is one block, so added and removed lines can be tinted edge to edge.
  function lexDiff(code) {
    return code.split('\n').map((line, index, all) => {
      const text = esc(line) + (index < all.length - 1 ? '\n' : '');
      const cls = /^(\+\+\+|---|diff |index |\\ No newline)/.test(line) ? 'meta'
        : line.startsWith('@@') ? 'hunk'
          : line.startsWith('+') ? 'add'
            : line.startsWith('-') ? 'del' : 'same';
      return `<span class="tk-line tk-${cls}">${text}</span>`;
    }).join('');
  }

  // Code with no language named: recognise a diff or JSON, and leave anything else plain.
  function guess(code) {
    const head = code.slice(0, 2000);
    if (/^(diff --git |--- \S|\+\+\+ \S|@@ -\d)/m.test(head)) return 'diff';
    if (/^\s*[{[]\s*("|\n|\]|\})/.test(head)) return 'json';
    return '';
  }

  function highlight(code, lang) {
    code = String(code ?? '');
    if (code.length > HIGHLIGHT_LIMIT) return esc(code);
    let name = String(lang ?? '').toLowerCase();
    if (Object.hasOwn(ALIASES, name)) name = ALIASES[name];
    if (!name) name = guess(code);
    if (name === 'diff') return lexDiff(code);
    if (name === 'html') return lexHtml(code);
    if (name === 'css') return lexCss(code);
    return Object.hasOwn(LANGS, name) ? lex(code, LANGS[name]) : esc(code);
  }

  // ---------- inline text ----------

  // Private-use characters stand in for finished pieces (code spans, links) while emphasis is applied.
  const HOLD_OPEN = '';
  const HOLD_CLOSE = '';
  const INLINE_START = /`|\[|https?:\/\//g;
  const LINK = /\[([^[\]\n]{1,1000})\]\(([^()\s<>]{1,2000})\)/y;
  const BARE_URL = /https?:\/\/[^\s<>"'`]{1,2000}/y;
  const SAFE_URL = /^https?:\/\//i;

  const anchor = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

  // The index of the next run of exactly n backticks at or after `from`, or -1.
  function closingTicks(text, n, from) {
    let i = text.indexOf('`', from);
    while (i >= 0) {
      let len = 1;
      while (text[i + len] === '`') len++;
      if (len === n) return i;
      i = text.indexOf('`', i + len);
    }
    return -1;
  }

  function emphasis(text) {
    return esc(text)
      .replace(/\\([*_~|`[\]#\\])/g, (_, c) => `&#${c.charCodeAt(0)};`)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])__([^_\n]+)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^\w*\\])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/(^|[^\w_])_([^_\s](?:[^_\n]*[^_\s])?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  }

  function inline(text, insideLink = false) {
    const held = [];
    const hold = html => `${HOLD_OPEN}${held.push(html) - 1}${HOLD_CLOSE}`;
    const noCloser = new Set(); // backtick run lengths known to have no partner further on
    let out = '';
    let i = 0;
    while (i < text.length) {
      INLINE_START.lastIndex = i;
      const m = INLINE_START.exec(text);
      if (!m) break;
      out += text.slice(i, m.index);
      i = m.index;
      if (m[0] === '`') {
        let n = 1;
        while (text[i + n] === '`') n++;
        const close = noCloser.has(n) ? -1 : closingTicks(text, n, i + n);
        if (close < 0) {
          noCloser.add(n);
          out += text.slice(i, i + n);
          i += n;
        } else {
          out += hold(`<code>${esc(text.slice(i + n, close).trim())}</code>`);
          i = close + n;
        }
      } else if (m[0] === '[') {
        LINK.lastIndex = i;
        const link = insideLink ? null : LINK.exec(text);
        if (link && SAFE_URL.test(link[2])) {
          // An image is shown as a link to it: the page loads nothing from outside.
          if (out.endsWith('!')) out = out.slice(0, -1);
          out += hold(anchor(link[2], inline(link[1], true)));
          i += link[0].length;
        } else if (link && !link[2].includes(':')) {
          // A link to a file or heading has nowhere to go here, so only its label is shown.
          out += hold(`<span class="ref" title="${esc(link[2])}">${inline(link[1], true)}</span>`);
          i += link[0].length;
        } else {
          out += '[';
          i++;
        }
      } else {
        BARE_URL.lastIndex = i;
        const found = insideLink || /\w/.test(text[i - 1] ?? '') ? null : BARE_URL.exec(text);
        const url = found ? found[0].replace(/[.,;:!?)\]}*_~]+$/, '') : '';
        if (url.length > m[0].length) {
          out += hold(anchor(url, esc(url)));
          i += url.length;
        } else {
          out += m[0];
          i += m[0].length;
        }
      }
    }
    out += text.slice(i);
    return emphasis(out).replace(/\n/g, '<br>').replace(/(\d+)/g, (_, k) => held[k] ?? '');
  }

  // ---------- blocks ----------

  const MAX_DEPTH = 6;
  const FENCE = /^( *)(`{3,}|~{3,}) *([\w+#.-]*)/;
  const HEADING = /^ {0,3}(#{1,6}) +(.*)$/;
  const QUOTE = /^ {0,3}> ?(.*)$/;
  const ITEM = /^( *)([-*+•]|\d{1,9}[.)])(?: +(.*))?$/;
  const TASK = /^\[([ xX])\] +(.*)$/;
  const indentOf = line => line.length - line.trimStart().length;

  function codeBlock(lang, code) {
    return `<div class="codeblock"><div class="cb-head"><span>${esc(lang || 'text')}</span><button class="copy" type="button">Copy</button></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
  }

  // An opening code fence on this line, or null. A backtick fence cannot have backticks after it.
  function fenceAt(line) {
    const m = FENCE.exec(line);
    if (!m) return null;
    if (m[2][0] === '`' && line.indexOf('`', m[0].length) >= 0) return null;
    return { indent: m[1].length, mark: m[2][0], length: m[2].length, lang: m[3] };
  }

  // Three or more of the same -, * or _ with nothing else on the line.
  function isRule(line) {
    const t = line.trim();
    const mark = t[0];
    if (mark !== '-' && mark !== '*' && mark !== '_') return false;
    let count = 0;
    for (const ch of t) {
      if (ch === mark) count++;
      else if (ch !== ' ') return false;
    }
    return count >= 3;
  }

  // Splits a table row into cells. A pipe inside backticks or after a backslash stays in its cell.
  function cells(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    const out = [];
    let cell = '';
    let inCode = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === '`') inCode = !inCode;
      if (ch === '\\' && t[i + 1] === '|') { cell += '|'; i++; }
      else if (ch === '|' && !inCode) { out.push(cell.trim()); cell = ''; }
      else cell += ch;
    }
    out.push(cell.trim());
    return out;
  }

  // The column alignments if this is a table's divider row (| --- | :--: |), otherwise null.
  function dividerRow(line) {
    if (line === undefined || !line.includes('-')) return null;
    const out = [];
    for (const cell of cells(line)) {
      const m = /^(:?)-+(:?)$/.exec(cell);
      if (!m) return null;
      out.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : '');
    }
    return out;
  }

  function tableAt(lines, i) {
    if (!lines[i].includes('|')) return null;
    const align = dividerRow(lines[i + 1]);
    const head = align && cells(lines[i]);
    return head && head.length === align.length ? { head, align } : null;
  }

  // True when this line begins something other than a paragraph.
  function startsBlock(lines, i, depth) {
    const line = lines[i];
    if (fenceAt(line) || HEADING.test(line) || isRule(line) || tableAt(lines, i)) return true;
    return depth < MAX_DEPTH && (QUOTE.test(line) || ITEM.test(line));
  }

  function table(lines, start, found) {
    const cell = (tag, text, k) => `<${tag}${found.align[k] ? ` class="a-${found.align[k]}"` : ''}>${inline(text ?? '')}</${tag}>`;
    let i = start + 2;
    let body = '';
    while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !fenceAt(lines[i])) {
      const row = cells(lines[i]);
      body += `<tr>${found.head.map((_, k) => cell('td', row[k], k)).join('')}</tr>`;
      i++;
    }
    const head = `<tr>${found.head.map((text, k) => cell('th', text, k)).join('')}</tr>`;
    return { html: `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`, next: i };
  }

  // A list is its items plus whatever is indented under them. Each item's body is parsed as blocks
  // again, which is how nested lists and code inside a list item come out right.
  function list(lines, start, depth) {
    const first = ITEM.exec(lines[start]);
    const base = first[1].length;
    const isOrdered = marker => marker[0] >= '0' && marker[0] <= '9';
    const ordered = isOrdered(first[2]);
    const items = [];
    let offset = 0; // where the current item's text starts; deeper lines are trimmed back to here
    let loose = false;
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const after = j < lines.length ? ITEM.exec(lines[j]) : null;
        const sameList = after && Math.abs(after[1].length - base) <= 1 && isOrdered(after[2]) === ordered;
        if (j >= lines.length || !(sameList || indentOf(lines[j]) >= base + 2)) break;
        if (sameList) loose = true;
        else items[items.length - 1].push('');
        i = j;
        continue;
      }
      const item = ITEM.exec(line);
      const indent = indentOf(line);
      if (item && Math.abs(indent - base) <= 1) {
        if (isOrdered(item[2]) !== ordered) break;
        items.push([item[3] ?? '']);
        offset = indent + item[2].length + 1;
      } else if (indent >= base + 2) {
        items[items.length - 1].push(line.slice(Math.min(indent, offset)));
      } else if (item || !lines[i - 1].trim() || startsBlock(lines, i, depth)) {
        break;
      } else {
        items[items.length - 1].push(line.trim());
      }
      i++;
    }
    const body = items.map(itemLines => {
      const task = TASK.exec(itemLines[0]);
      if (task) itemLines[0] = task[2];
      let html = blocks(itemLines, depth + 1);
      if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
      const cls = task ? ` class="task${task[1] === ' ' ? '' : ' done'}"` : '';
      return `<li${cls}>${html}</li>`;
    }).join('');
    const from = ordered ? parseInt(first[2], 10) : 1;
    const tag = ordered ? 'ol' : 'ul';
    return { html: `<${tag}${ordered && from !== 1 ? ` start="${from}"` : ''}>${body}</${tag}>`, next: i };
  }

  function blocks(lines, depth) {
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const fence = fenceAt(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length) {
          const t = lines[i].trim();
          if (t.length >= fence.length && t[0] === fence.mark && t === fence.mark.repeat(t.length)) { i++; break; }
          body.push(lines[i].slice(Math.min(indentOf(lines[i]), fence.indent)));
          i++;
        }
        html += codeBlock(fence.lang, body.join('\n'));
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        const level = Math.min(heading[1].length + 1, 5);
        html += `<h${level}>${inline(heading[2].trim())}</h${level}>`;
        i++;
        continue;
      }

      if (isRule(line)) { html += '<hr>'; i++; continue; }

      if (depth < MAX_DEPTH && QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          inner.push(QUOTE.exec(lines[i])[1]);
          i++;
        }
        html += `<blockquote>${blocks(inner, depth + 1)}</blockquote>`;
        continue;
      }

      const found = tableAt(lines, i);
      if (found) {
        const t = table(lines, i, found);
        html += t.html;
        i = t.next;
        continue;
      }

      if (depth < MAX_DEPTH && ITEM.test(line)) {
        const l = list(lines, i, depth);
        html += l.html;
        i = l.next;
        continue;
      }

      const para = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i, depth)) {
        para.push(lines[i].trim());
        i++;
      }
      html += `<p>${inline(para.join('\n'))}</p>`;
    }
    return html;
  }

  function md(src) {
    const text = String(src ?? '').replace(/\r\n?/g, '\n').replace(/[]/g, '').replace(/\t/g, '    ');
    return blocks(text.split('\n'), 0);
  }

  return { md, highlight };
})();
