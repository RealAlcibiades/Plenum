// Checkpoints panel: list and restore file snapshots. Loaded by ext.js and adds itself through window.MuseUI.
// The server keeps a copy of a file just before the agent changes it (lib/checkpoints.mjs). This drawer lists those copies
// and restores one. A restore overwrites files, so the server asks first: its answer is a stream that carries the approval
// card, which this panel draws in the drawer, and then the result. Every piece of text is set with textContent.
// Show changes reads GET /api/checkpoints/diff, which only compares; viewing a diff writes nothing.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TITLE = 'Checkpoints';
  const BUTTON_ID = 'checkpointsBtn';
  const INTRO = 'Plenum keeps a copy of a file just before the agent changes it. Restore puts that copy back, after you approve.';
  const LOADING = 'Loading checkpoints…';
  const EMPTY = 'No checkpoints yet. One is kept each time the agent changes an existing file.';
  const GROUP = 'Group by file';
  const SHOW = 'Show changes';
  const HIDE = 'Hide changes';
  const LOADING_CHANGES = 'Comparing with the current file…';
  const SAME = 'No difference from the current file.';
  const MISSING = 'The file is missing now, so a restore creates it empty.';
  const BINARY = 'Binary file, no diff.';
  const TOO_LARGE = 'The file is too large to compare.';

  // Counts the loads, so a late reply never paints over a newer drawer.
  let loadSeq = 0;
  // The restore in progress, or null: { ctl, root }. Only one runs at a time.
  let pending = null;
  // Whether the list is grouped by file. It stays as it was left while the page is open.
  let grouped = false;

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function currentProject() {
    const S = MuseUI.state;
    return (S.projects ?? []).find(p => p.id === S.activeProject) ?? null;
  }

  function formatTime(ms) {
    return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // ---------- the side menu entry ----------

  // The link sits just above Commands. It opens the drawer, which is built fresh on each open.
  function sideLink() {
    const b = make('button', 'side-link');
    b.type = 'button';
    b.id = BUTTON_ID;
    b.title = 'Put back a file as it was before the agent changed it';
    b.append(MuseUI.icon('file'), TITLE);
    b.addEventListener('click', () => MuseUI.openDrawer(TITLE, renderPanel));
    return b;
  }

  // ---------- the drawer ----------

  function setStatus(view, text, tone) {
    view.status.textContent = text;
    view.status.className = tone ? `ext-checkpoints-status ${tone}` : 'ext-checkpoints-status';
  }

  function renderPanel(body) {
    const project = currentProject();
    if (!project) {
      body.append(MuseUI.para('Choose a project first. Its checkpoints show here.'));
      return;
    }
    const root = make('div', 'ext-checkpoints');
    const toggle = MuseUI.button('ghost small ext-checkpoints-toggle', GROUP);
    toggle.setAttribute('aria-pressed', String(grouped));
    const view = {
      project,
      root,
      status: make('div', 'ext-checkpoints-status'),
      ask: make('div', 'ext-checkpoints-ask'),
      list: make('div', 'ext-checkpoints-list'),
      buttons: [],
      items: null,
    };
    view.status.setAttribute('role', 'status');
    toggle.addEventListener('click', () => {
      grouped = !grouped;
      toggle.setAttribute('aria-pressed', String(grouped));
      paint(view);
    });
    const head = make('div', 'ext-checkpoints-head');
    head.append(make('p', 'ext-checkpoints-note', INTRO), toggle);
    root.append(head, view.status, view.ask, view.list);
    body.append(root);
    load(view, ++loadSeq);
  }

  async function load(view, seq) {
    setStatus(view, LOADING, '');
    let data;
    try {
      data = await MuseUI.api(`/api/checkpoints?project=${encodeURIComponent(view.project.id)}`);
    } catch (err) {
      if (seq === loadSeq) setStatus(view, err.message, 'bad');
      return;
    }
    if (seq !== loadSeq) return;
    const items = Array.isArray(data?.checkpoints) ? data.checkpoints : null;
    if (!items) return setStatus(view, 'The checkpoints did not come back. Try again.', 'bad');
    setStatus(view, items.length ? '' : EMPTY, '');
    view.items = items;
    paint(view);
  }

  // Draws the fetched checkpoints: one row each, or grouped under their file when grouping is on.
  function paint(view) {
    if (!view.items) return;
    view.buttons = [];
    if (!grouped) {
      view.list.replaceChildren(...view.items.map(item => row(view, item)));
      return;
    }
    const groups = groupByPath(view.items);
    const count = make('p', 'ext-checkpoints-count', `Files changed in this chat: ${groups.size}`);
    const sections = [...groups].map(([path, items]) => group(view, path, items));
    view.list.replaceChildren(count, ...sections);
  }

  // The checkpoints by file. The list is newest first, so the files come out newest first too.
  function groupByPath(items) {
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.path)) groups.set(item.path, []);
      groups.get(item.path).push(item);
    }
    return groups;
  }

  // One file: its path and how many checkpoints it has, then those checkpoints as rows.
  function group(view, path, items) {
    const section = make('section', 'ext-checkpoints-group');
    section.setAttribute('aria-label', path);
    const n = items.length;
    const head = make('div', 'ext-checkpoints-group-head');
    head.append(make('span', 'ext-checkpoints-path', path), make('span', 'ext-checkpoints-meta', `${n} ${n === 1 ? 'checkpoint' : 'checkpoints'}`));
    section.append(head, ...items.map(item => row(view, item)));
    return section;
  }

  // One checkpoint: the path, then the time and size, then the label if it has one, and the buttons. Show changes opens
  // the diff under the row.
  function row(view, item) {
    const node = make('div', 'ext-checkpoints-item');
    const line = make('div', 'ext-checkpoints-line');
    const main = make('div', 'ext-checkpoints-main');
    const more = item.count > 1 ? ` (+${item.count - 1} more)` : '';
    main.append(
      make('span', 'ext-checkpoints-path', `${item.path}${more}`),
      make('span', 'ext-checkpoints-meta', `${formatTime(item.time)} · ${formatSize(item.size)}`),
    );
    if (item.label) main.append(make('span', 'ext-checkpoints-label', item.label));
    const changes = make('div', 'ext-checkpoints-changes');
    changes.hidden = true;
    const changesBtn = MuseUI.button('ghost small', SHOW);
    changesBtn.setAttribute('aria-expanded', 'false');
    changesBtn.addEventListener('click', changesToggle(view, item, changesBtn, changes));
    const restoreBtn = MuseUI.button('ghost small', 'Restore');
    restoreBtn.setAttribute('aria-label', `Restore ${item.path} from ${formatTime(item.time)}`);
    restoreBtn.addEventListener('click', () => restore(view, item));
    // A list redrawn during a restore keeps its Restore buttons off until that restore ends.
    restoreBtn.disabled = Boolean(pending && pending.root === view.root);
    view.buttons.push(restoreBtn);
    line.append(main, changesBtn, restoreBtn);
    node.append(line, changes);
    return node;
  }

  // ---------- changes ----------

  function setToggle(btn, open) {
    btn.textContent = open ? HIDE : SHOW;
    btn.setAttribute('aria-expanded', String(open));
  }

  // The Show changes button of a row or of the approval card. The changes are fetched on each show, so they are current, and
  // a second click hides them. A reply that arrives after the box was hidden, or after a newer click, is dropped.
  function changesToggle(view, item, btn, box) {
    let seq = 0;
    return async () => {
      if (!box.hidden) {
        seq++;
        box.hidden = true;
        setToggle(btn, false);
        return;
      }
      const mine = ++seq;
      box.hidden = false;
      setToggle(btn, true);
      box.replaceChildren(make('p', 'ext-checkpoints-diff-note', LOADING_CHANGES));
      let data;
      try {
        data = await MuseUI.api(`/api/checkpoints/diff?project=${encodeURIComponent(view.project.id)}&id=${encodeURIComponent(item.id)}`);
      } catch (err) {
        if (mine === seq) box.replaceChildren(make('p', 'ext-checkpoints-diff-note bad', err.message));
        return;
      }
      if (mine === seq) box.replaceChildren(...changeBlocks(data));
    };
  }

  // What a restore would change, one block per file: the diff, or a line saying there is no diff to show.
  function changeBlocks(data) {
    const files = Array.isArray(data?.files) ? data.files : [];
    const blocks = [];
    for (const f of files) {
      if (files.length > 1) blocks.push(make('p', 'ext-checkpoints-diff-path', f.path));
      if (f.tooLarge) blocks.push(make('p', 'ext-checkpoints-diff-note', TOO_LARGE));
      else if (f.binary) blocks.push(make('p', 'ext-checkpoints-diff-note', BINARY));
      else if (f.same && f.exists === false) blocks.push(make('p', 'ext-checkpoints-diff-note', MISSING));
      else if (f.same) blocks.push(make('p', 'ext-checkpoints-diff-note', SAME));
      else blocks.push(diffPre(String(f.diff ?? '')));
    }
    if (!blocks.length) blocks.push(make('p', 'ext-checkpoints-diff-note', SAME));
    return blocks;
  }

  // A unified diff as a pre element: one span per line, coloured by what the line is. The two header lines stay plain.
  function diffPre(text) {
    const pre = make('pre', 'ext-checkpoints-diff');
    pre.append(...text.split('\n').map((line, i) => make('span', lineClass(line, i), line)));
    return pre;
  }

  function lineClass(line, i) {
    if (i < 2) return '';
    if (line.startsWith('@@')) return 'd-hunk';
    if (line.startsWith('+')) return 'd-add';
    if (line.startsWith('-')) return 'd-del';
    return '';
  }

  // ---------- restoring ----------

  // Reads a server-sent stream and hands each event to onEvent.
  async function readEvents(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (data) onEvent(JSON.parse(data));
      }
    }
  }

  function lock(view, on) {
    for (const b of view.buttons) b.disabled = on;
  }

  async function restore(view, item) {
    if (pending) return;
    const ctl = new AbortController();
    pending = { ctl, root: view.root };
    lock(view, true);
    setStatus(view, 'Checking the files…', '');
    // Becomes true once the stream says how the restore ended. A stream that ends without that was cut short.
    let ended = false;
    try {
      // MuseUI.request adds the Plenum token. The run's id is claimed from its first event, so the events channel does not
      // draw this restore as one started in another window.
      const res = await MuseUI.request('/api/checkpoints/restore', {
        method: 'POST',
        body: { project: view.project.id, id: item.id },
        signal: ctl.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      await readEvents(res, ev => {
        MuseUI.claimRun?.(ev.runId);
        if (ev.type === 'approval') {
          setStatus(view, 'Waiting for your approval…', '');
          showApproval(view, ev, item);
        } else if (ev.type === 'restored') {
          ended = true;
          const files = Array.isArray(ev.files) ? ev.files : [];
          const text = files.length === 1 ? `Restored ${files[0]}.` : `Restored ${files.length} files: ${files.join(', ')}.`;
          setStatus(view, text, 'ok');
          MuseUI.toast(files.length === 1 ? `Restored ${files[0]}` : `Restored ${files.length} files`);
        } else if (ev.type === 'declined') {
          ended = true;
          setStatus(view, 'Nothing was restored.', '');
        } else if (ev.type === 'error') {
          ended = true;
          setStatus(view, String(ev.message || 'The restore failed.'), 'bad');
        }
      });
      if (!ended) setStatus(view, 'The restore stopped before it finished. Nothing was changed.', '');
    } catch (err) {
      if (err.name === 'AbortError') setStatus(view, 'The restore was cancelled. Nothing was changed.', '');
      else setStatus(view, err.message, 'bad');
    } finally {
      view.ask.replaceChildren();
      pending = null;
      lock(view, false);
    }
  }

  // The approval card the server asked for. It uses the look of the approval card in the chat. Approve and Deny answer
  // through /api/approve, the same call the chat's card makes. Show changes puts the diff of this restore above the buttons.
  function showApproval(view, ev, item) {
    const card = make('div', 'approval ext-checkpoints-card');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', 'Approval needed');
    const head = MuseUI.span('approval-head', 'Approval needed');
    head.prepend(MuseUI.icon('shield'));
    card.append(head, MuseUI.span('approval-summary', String(ev.summary ?? '')));
    if (ev.detail) card.append(make('pre', 'approval-detail', String(ev.detail)));
    const changes = make('div', 'ext-checkpoints-changes');
    changes.hidden = true;
    const actions = make('div', 'approval-actions');
    const yes = MuseUI.button('primary', 'Approve restore');
    const no = MuseUI.button('ghost', 'Deny');
    const changesBtn = MuseUI.button('ghost small', SHOW);
    changesBtn.setAttribute('aria-expanded', 'false');
    changesBtn.addEventListener('click', changesToggle(view, item, changesBtn, changes));
    const decide = async allow => {
      yes.disabled = true;
      no.disabled = true;
      setStatus(view, allow ? 'Restoring…' : 'Cancelling…', '');
      try {
        await MuseUI.api('/api/approve', { approvalId: ev.approvalId, allow });
      } catch (err) {
        MuseUI.toast(err.message, 'bad');
      }
      card.remove();
    };
    yes.addEventListener('click', () => decide(true));
    no.addEventListener('click', () => decide(false));
    actions.append(yes, no, changesBtn, MuseUI.span('hint', 'Times out after 5 minutes.'));
    card.append(changes, actions);
    view.ask.replaceChildren(card);
    card.scrollIntoView({ block: 'nearest' });
    // Deny takes the focus, so a stray Enter cannot approve an overwrite.
    no.focus();
  }

  // A restore waiting for approval is cancelled when its drawer is closed or drawn again, so a card nobody can see never
  // holds the project busy until it times out. Aborting the request makes the server treat the card as denied.
  function dropStale() {
    if (pending && (MuseUI.el.drawer.hidden || !pending.root.isConnected)) pending.ctl.abort();
  }
  new MutationObserver(dropStale).observe(MuseUI.el.drawerBody, { childList: true });
  new MutationObserver(dropStale).observe(MuseUI.el.drawer, { attributes: true, attributeFilter: ['hidden'] });

  // Attach. The link goes in before Commands, the last link in the sidebar footer.
  if (!document.getElementById(BUTTON_ID)) MuseUI.el.helpBtn.before(sideLink());
})();
