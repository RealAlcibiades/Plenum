// The @ picker (pro-09). Typing @ in the message box opens a list above the box: the context items (@diff, @checkpoint, @checks and one
// @thread:<name> per other open thread) when they apply, then the project's files and folders from GET /api/files/index
// (lib/file-index.mjs), filtered by a fuzzy match on the text after the @. Enter or Tab inserts the highlighted entry as '@path ' and
// does not send; Escape closes the list and, with no run live, nothing else. While a run is live the same Escape also reaches the
// composer, which stops the run (the floor's emergency stop). The keys belong to the list only while it is open: a document capture
// listener takes them before app.js sees them. Inserting only changes the text of the message box; sending is the usual path.
// Text is written with textContent only, and there are no inline styles or scripts (CSP).
(function () {
  'use strict';
  const MU = window.MuseUI;
  if (!MU) return;

  const MAX_ROWS = 8;
  // A list fetched this long ago is shown at once and fetched again behind it. The server caches for 60 seconds too.
  const STALE_MS = 60_000;
  // The text before the caret that opens the list: an @ at the start or after a space, then the typed letters, with no space or @.
  const TOKEN = /(^|\s)@([^\s@]*)$/;
  const SEP = /[/._\- ]/;

  // ---------- pure helpers (also exposed as MuseUI.mentions for the tests) ----------

  // The best alignment of the query letters in t, from position from, leftmost first. A letter in the file name, a run of consecutive
  // letters, a start at a word boundary and an early start all add to the score; a gap costs a little.
  function align(t, q, from, base) {
    const marks = [];
    let pos = from;
    let prev = -2;
    let score = 0;
    for (let i = 0; i < q.length; i += 1) {
      const at = t.indexOf(q[i], pos);
      if (at < 0) return null;
      marks.push(at);
      score += 1;
      if (at >= base) score += 3;
      if (at === prev + 1) score += 4;
      if (at === 0 || SEP.test(t[at - 1])) score += 2;
      score -= (at - pos) * 0.2;
      prev = at;
      pos = at + 1;
    }
    return { score: score - marks[0] * 0.05, marks };
  }

  // The start of the file name in a path (a folder's trailing '/' is not part of its name).
  function baseIndex(t) {
    let end = t.length;
    if (end && t[end - 1] === '/') end -= 1;
    for (let i = end - 1; i >= 0; i -= 1) {
      if (t[i] === '/') return i + 1;
    }
    return 0;
  }

  // { score, marks } when the typed letters appear in text in order, or null. marks are code-point indexes into text. An empty query
  // matches everything with score 0.
  function fuzzy(text, typed) {
    const q = Array.from(String(typed).toLowerCase());
    if (!q.length) return { score: 0, marks: [] };
    const t = Array.from(String(text), c => c.toLowerCase());
    const base = baseIndex(t);
    const a = align(t, q, 0, base);
    if (!a) return null;
    const b = base > 0 ? align(t, q, base, base) : null;
    return b && b.score > a.score ? b : a;
  }

  // The slug of a thread name: lower case, every run of characters outside a to z and 0 to 9 becomes '-'. The server uses the same rule.
  const slugOf = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');

  MU.mentions = { fuzzy, slugOf, MAX_ROWS };

  const input = document.getElementById('input');
  const form = document.getElementById('composer');
  const sendBtn = document.getElementById('send');
  const palette = document.getElementById('palette');
  if (!input || !form) return;

  let list = null;          // the ul.ext-mentions, made once
  let open = false;
  let openStart = -1;       // index in the message of the @ that opened the list
  let query = '';
  let dismissedAt = -1;     // the @ an Escape closed: it stays closed until the caret is somewhere else
  let rows = [];            // { el, token, disabled }
  let sel = -1;
  let rowSeq = 0;

  // The file lists per project and thread, by key: { pid, tid, files, truncated, source, got, error }. pending holds the fetches in flight.
  const indexes = new Map();
  const pending = new Map();

  const keyOf = (pid, tid) => `${pid}|${tid}`;
  const projectId = () => MU.state?.activeProject ?? null;
  // The thread the picker is in. Threads (pro-01) keep their active id in the state; until they exist it is the project's own folder.
  function threadOf(pid) {
    const active = MU.state?.threads?.[pid]?.active;
    return typeof active === 'string' ? active : '';
  }

  // ---------- the file list ----------

  // Fetches the file list of a project and thread. refresh asks the server to rebuild it (at most once every two seconds there).
  function fetchIndex(pid, tid, refresh) {
    const key = keyOf(pid, tid);
    if (pending.has(key)) return pending.get(key);
    const q = new URLSearchParams({ project: pid });
    if (tid) q.set('thread', tid);
    if (refresh) q.set('refresh', '1');
    const job = MU.request(`/api/files/index?${q.toString()}`)
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${res.status})`);
        indexes.set(key, { pid, tid, files: Array.isArray(data.files) ? data.files : [], truncated: data.truncated === true, source: data.source, got: Date.now(), error: null });
      })
      .catch(err => {
        // The message is kept for the list to show. The next time the list opens, the fetch is tried again.
        const kept = indexes.get(key) ?? { pid, tid, files: [], truncated: false, source: null, got: 0 };
        indexes.set(key, { ...kept, error: err?.message || 'The file list did not load.' });
      })
      .finally(() => {
        pending.delete(key);
        if (open) render();
      });
    pending.set(key, job);
    return job;
  }

  // The list for the current project and thread. It is fetched when missing, failed or older than STALE_MS.
  function ensureIndex() {
    const pid = projectId();
    if (!pid) return;
    const tid = threadOf(pid);
    const have = indexes.get(keyOf(pid, tid));
    if (!have || have.error || Date.now() - have.got > STALE_MS) fetchIndex(pid, tid, false);
  }

  // A run has ended: every list fetched for this project is rebuilt (refresh=1), so new and removed files show up.
  function afterRun() {
    const pid = projectId();
    if (!pid) return;
    for (const entry of [...indexes.values()]) {
      if (entry.pid === pid) fetchIndex(entry.pid, entry.tid, true);
    }
  }

  // ---------- context items ----------

  // The context items that apply now, as { key, token, label }. The key is what the query is matched against.
  function contextItems(pid) {
    const items = [{ key: 'diff', token: '@diff', label: 'Working-tree diff' }];
    const log = Array.isArray(MU.state?.messages) ? MU.state.messages : [];
    const lastQuestion = [...log].reverse().find(m => m?.role === 'user');
    if (lastQuestion?.snap?.after) items.push({ key: 'checkpoint', token: '@checkpoint', label: 'What the last turn changed' });
    if (log.some(m => typeof m?.check?.output === 'string')) items.push({ key: 'checks', token: '@checks', label: 'Last check output' });
    const threads = MU.state?.threads?.[pid]?.list;
    const active = threadOf(pid);
    if (Array.isArray(threads)) {
      for (const t of threads) {
        if (!t || typeof t.name !== 'string' || typeof t.id !== 'string' || t.closedAt || t.id === active) continue;
        const slug = slugOf(t.name);
        items.push({ key: `thread:${slug}`, token: `@thread:${slug}`, label: `${t.name}'s last reply` });
      }
    }
    return items;
  }

  // ---------- rows ----------

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Writes chars[from..to) into parent, the letters at the marked indexes inside b elements.
  function paint(parent, chars, marks, from, to) {
    const hit = new Set(marks);
    let run = '';
    let on = false;
    const flush = () => {
      if (!run) return;
      parent.append(on ? el('b', '', run) : document.createTextNode(run));
      run = '';
    };
    for (let i = from; i < to; i += 1) {
      const isHit = hit.has(i);
      if (isHit !== on) {
        flush();
        on = isHit;
      }
      run += chars[i];
    }
    flush();
  }

  // A row for a file or folder: the folder part muted, the matched letters bold, and a tag for a folder or a name that may hold secrets.
  function fileRow(entry, match) {
    const chars = Array.from(entry.p);
    let end = chars.length;
    if (end && chars[end - 1] === '/') end -= 1;
    let cut = 0;
    for (let i = end - 1; i >= 0; i -= 1) {
      if (chars[i] === '/') {
        cut = i + 1;
        break;
      }
    }
    const path = el('span', 'ext-mentions-path');
    const dir = el('span', 'ext-mentions-dir');
    paint(dir, chars, match.marks, 0, cut);
    path.append(dir);
    paint(path, chars, match.marks, cut, chars.length);
    const tags = [];
    if (entry.dir) tags.push(el('span', 'ext-mentions-kind', 'folder'));
    if (entry.secret) tags.push(el('span', 'ext-mentions-tag', 'may hold secrets'));
    return { path, tags, token: `@${entry.p}`, disabled: entry.space === true };
  }

  // A row for a context item: its token with the matched letters bold, and what it is.
  function contextRow(item, match) {
    const chars = Array.from(`@${item.key}`);
    const path = el('span', 'ext-mentions-path');
    paint(path, chars, match.marks.map(m => m + 1), 0, chars.length);
    return { path, tags: [el('span', 'ext-mentions-desc', item.label)], token: item.token, disabled: false };
  }

  // The rows for the query: the context items that match, then files by score (a shorter path first on ties). At most MAX_ROWS.
  function computeRows(pid) {
    const out = [];
    for (const item of contextItems(pid)) {
      const match = fuzzy(item.key, query);
      if (match) out.push(contextRow(item, match));
    }
    const have = pid ? indexes.get(keyOf(pid, threadOf(pid))) : null;
    const scored = [];
    for (const entry of have?.files ?? []) {
      const match = fuzzy(entry.p, query);
      if (match) scored.push({ entry, match });
    }
    scored.sort((a, b) => b.match.score - a.match.score || a.entry.p.length - b.entry.p.length || (a.entry.p < b.entry.p ? -1 : a.entry.p > b.entry.p ? 1 : 0));
    for (const { entry, match } of scored) {
      if (out.length >= MAX_ROWS) break;
      out.push(fileRow(entry, match));
    }
    return { rows: out.slice(0, MAX_ROWS), have };
  }

  function render() {
    if (!list) return;
    const keep = rows[sel]?.token ?? null;
    list.replaceChildren();
    const pid = projectId();
    const { rows: built, have } = computeRows(pid);
    rows = [];
    for (const r of built) {
      rowSeq += 1;
      const li = el('li', 'ext-mentions-row');
      li.id = `ext-mention-${rowSeq}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      if (r.disabled) {
        li.classList.add('is-off');
        li.setAttribute('aria-disabled', 'true');
        li.title = 'This path has a space. Attach the file with the attach button instead.';
      }
      li.append(r.path, ...r.tags);
      const index = rows.length;
      rows.push({ el: li, token: r.token, disabled: r.disabled });
      li.addEventListener('mousedown', e => e.preventDefault());
      li.addEventListener('mouseenter', () => {
        if (!r.disabled) setSel(index);
      });
      li.addEventListener('click', () => insert(index));
      list.append(li);
    }
    if (!rows.length) {
      let text;
      if (have?.error) text = `The file list did not load: ${have.error} Type to try again.`;
      else if (!have) text = 'Looking for files…';
      else text = `No file or context matches @${query}.`;
      list.append(el('li', 'ext-mentions-note', text));
    }
    list.hidden = false;
    input.setAttribute('aria-controls', list.id);
    // The row that was highlighted stays highlighted when the list is drawn again (a file list that arrives late, say).
    const again = keep === null ? -1 : rows.findIndex(r => r.token === keep && !r.disabled);
    setSel(again >= 0 ? again : rows.findIndex(r => !r.disabled));
  }

  function setSel(index) {
    sel = index;
    rows.forEach((r, i) => r.el.setAttribute('aria-selected', i === index ? 'true' : 'false'));
    if (rows[index]) input.setAttribute('aria-activedescendant', rows[index].el.id);
    else input.removeAttribute('aria-activedescendant');
  }

  // Moves the highlight by one selectable row, wrapping round.
  function step(delta) {
    const picks = rows.map((r, i) => (r.disabled ? -1 : i)).filter(i => i >= 0);
    if (!picks.length) return;
    const at = picks.indexOf(sel);
    setSel(at < 0 ? picks[0] : picks[(at + delta + picks.length) % picks.length]);
  }

  // ---------- open, close, insert ----------

  function close() {
    open = false;
    openStart = -1;
    rows = [];
    sel = -1;
    if (list) {
      list.hidden = true;
      list.replaceChildren();
    }
    input.removeAttribute('aria-activedescendant');
    input.removeAttribute('aria-controls');
  }

  // Replaces the @ and the letters typed after it with the entry's token and a space. A folder keeps its trailing '/'. The message is not sent.
  function insert(index) {
    const row = rows[index];
    if (!row || row.disabled) return;
    const caret = input.selectionEnd;
    const m = TOKEN.exec(input.value.slice(0, caret));
    const start = m ? caret - m[2].length - 1 : openStart;
    if (start < 0 || input.value[start] !== '@') {
      close();
      return;
    }
    const text = `${row.token} `;
    input.value = input.value.slice(0, start) + text + input.value.slice(caret);
    const at = start + text.length;
    input.setSelectionRange(at, at);
    close();
    // The message box's own listener resizes it and looks at the / palette, which stays shut for an @ token.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  // Looks at the caret and opens, updates or closes the list. The rows are drawn again each time, and render keeps the highlighted token
  // selected, so a key that moved the highlight keeps it when the key goes up.
  function evaluate() {
    if (document.activeElement !== input || input.selectionStart !== input.selectionEnd || (palette && !palette.hidden)) {
      close();
      return;
    }
    const before = input.value.slice(0, input.selectionStart);
    const m = TOKEN.exec(before);
    if (!m) {
      dismissedAt = -1;
      close();
      return;
    }
    const start = before.length - m[2].length - 1;
    if (start === dismissedAt) {
      close();
      return;
    }
    open = true;
    openStart = start;
    query = m[2];
    ensureIndex();
    // Drawn again on every look, so a context item that appeared since the last draw shows. The highlighted row keeps its place.
    render();
  }

  // ---------- keys ----------

  // A run is live when the Send button shows Stop (app.js keeps that class in step with the run) or the page state says one is going.
  const runLive = () => Boolean(sendBtn?.classList.contains('stop')) || MU.state?.running === true;

  // The list takes its keys while it is open. Escape closes it, even with nothing to pick. With no run, it stops there and app.js never
  // sees the key. With a run live the key is left untouched after the list closes (no stopImmediatePropagation, no preventDefault), so the
  // composer's own Escape handler stops the run on the same press: Esc in the composer is an emergency stop that always works.
  // Arrow keys move the highlight; Enter and Tab insert it (Shift+Enter still makes a new line). With nothing to pick, the keys are left
  // alone and Enter sends as usual.
  function onKeydown(e) {
    if (!open || e.target !== input || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      if (!runLive()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      dismissedAt = openStart;
      close();
      return;
    }
    if (!rows.some(r => !r.disabled)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      step(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (plain && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      insert(sel);
    }
  }

  // ---------- wiring ----------

  list = el('ul', 'ext-mentions');
  list.id = 'extMentions';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Files and context');
  list.hidden = true;
  form.append(list);

  document.addEventListener('keydown', onKeydown, true);
  input.addEventListener('input', e => {
    // A newly typed @ opens the list again, even at the place an Escape closed one.
    if (e.data === '@') dismissedAt = -1;
    evaluate();
  });
  input.addEventListener('keyup', evaluate);
  input.addEventListener('click', evaluate);
  input.addEventListener('focus', evaluate);
  input.addEventListener('blur', () => close());

  // A run has ended when the send button loses its stop state.
  if (sendBtn) {
    let busy = sendBtn.classList.contains('stop');
    new MutationObserver(() => {
      const now = sendBtn.classList.contains('stop');
      if (busy && !now) afterRun();
      busy = now;
    }).observe(sendBtn, { attributes: true, attributeFilter: ['class'] });
  }
})();
