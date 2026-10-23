// Checkpoints panel: list and restore file snapshots. Loaded by ext.js and adds itself through window.MuseUI.
// The server keeps a copy of a file just before the agent changes it (lib/checkpoints.mjs). This drawer lists those copies
// and restores one. A restore overwrites files, so the server asks first: its answer is a stream that carries the approval
// card, which this panel draws in the drawer, and then the result. Every piece of text is set with textContent.
// Show changes reads GET /api/checkpoints/diff, which only compares; viewing a diff writes nothing.
// window.MuseRestore.run({ title, url, payload, diffUrl, approveText, onEnd }) runs any other approval-gated write the same way in a
// drawer of its own: a rewind of the code (public/ext-turns.js) uses it. The stream, the card, Deny's focus, Show changes and the
// drawer closing (which cancels a card nobody can see) are the same for every flow.
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
  const NO_TEXT = 'No text difference to show for this file.';
  const MISSING = 'The file is missing now, so a restore creates it empty.';
  const BINARY = 'Binary file, no diff.';
  const TOO_LARGE = 'The file is too large to compare.';
  // The seconds a restore card waits: the server stops waiting after the same five minutes (APPROVAL_TIMEOUT_MS in server.mjs).
  const APPROVAL_SECONDS = 300;
  const REASON = 'Reason for denying (optional)';
  // Shown on the card while plan mode is on (amend-31): a restore is the person's own change, so it goes ahead.
  const PLAN_NOTICE = 'Plan mode is on: the model will not write files, but your own change here is saved.';

  // Counts the loads, so a late reply never paints over a newer drawer.
  let loadSeq = 0;
  // The flow in progress, or null: { ctl, root, answered, opts, view }. Only one runs at a time. answered is set once the person has
  // answered its card, after which closing the drawer no longer cancels the flow.
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

  // The address of the comparison for one checkpoint: what its restore would change. It is a path under /api/ (see changesToggle).
  function checkpointDiffUrl(view, item) {
    return `checkpoints/diff?project=${encodeURIComponent(view.project.id)}&id=${encodeURIComponent(item.id)}`;
  }

  // A comparison address a caller gives as /api/<route>?query. Anything else is no address at all, so the page reads nothing it did not name.
  function diffRoute(url) {
    const rel = String(url ?? '').replace(/^\/api\//, '');
    return /^[a-z]+(\/[a-z]+)*\?[A-Za-z0-9=&_%.-]*$/.test(rel) ? rel : '';
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
    changesBtn.addEventListener('click', changesToggle(view, checkpointDiffUrl(view, item), changesBtn, changes));
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
  function changesToggle(view, url, btn, box) {
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
        data = await MuseUI.api(`/api/${url}`);
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
      else if (!String(f.diff ?? '')) blocks.push(make('p', 'ext-checkpoints-diff-note', NO_TEXT));
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

  // The status line after a write. A rewind's answer has removed as well as restored files; a restore's has only the files.
  function restoredText(ev) {
    const files = Array.isArray(ev.files) ? ev.files : [];
    if (Array.isArray(ev.removed)) return `Rewound ${files.length} files and removed ${ev.removed.length}.`;
    return files.length === 1 ? `Restored ${files[0]}.` : `Restored ${files.length} files: ${files.join(', ')}.`;
  }

  // Runs one approval-gated flow in a view: it posts opts.payload to the route opts.route (a path under /api/), shows the card the
  // stream asks for, and reports the answer. opts: { route, payload, diffUrl, approveText, busyText, planNote, nothing, restoredText,
  // onEnd(lastEvent, view) }. Returns false when a flow is already waiting, and true otherwise.
  async function runFlow(view, opts) {
    if (pending) return false;
    const run = { ctl: new AbortController(), root: view.root, answered: false, opts, view };
    pending = run;
    lock(view, true);
    setStatus(view, 'Checking the files…', '');
    // Becomes true once the stream says how the flow ended. A stream that ends without that was cut short.
    let ended = false;
    let last = null;
    const nothing = opts.nothing || 'Nothing was changed.';
    try {
      // MuseUI.request adds the Plenum token. The run's id is claimed from its first event, so the events channel does not
      // draw this flow as one started in another window.
      const res = await MuseUI.request(`/api/${opts.route}`, { method: 'POST', body: opts.payload, signal: run.ctl.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      await readEvents(res, ev => {
        MuseUI.claimRun?.(ev.runId);
        if (ev.type === 'approval') {
          setStatus(view, 'Waiting for your approval…', '');
          showApproval(view, ev, run);
        } else if (ev.type === 'restored') {
          ended = true;
          last = ev;
          const files = Array.isArray(ev.files) ? ev.files : [];
          const text = opts.restoredText ? String(opts.restoredText(ev)) : restoredText(ev);
          setStatus(view, text, 'ok');
          MuseUI.toast(Array.isArray(ev.removed) ? text : files.length === 1 ? `Restored ${files[0]}` : `Restored ${files.length} files`);
        } else if (ev.type === 'declined') {
          ended = true;
          last = ev;
          // The reason, if one was typed, is shown here only. Nothing else reads it.
          const reason = typeof ev.reason === 'string' ? ev.reason.trim() : '';
          setStatus(view, reason ? `${nothing} Your reason: ${reason}` : nothing, '');
        } else if (ev.type === 'error') {
          ended = true;
          setStatus(view, String(ev.message || 'The change failed.'), 'bad');
        }
      });
      if (!ended) setStatus(view, 'The change stopped before it finished. Nothing was changed.', '');
    } catch (err) {
      if (err.name === 'AbortError') {
        // The drawer was closed while the card waited, so the flow was cancelled. The toast says so, since the drawer is hidden.
        const text = 'The change was cancelled. Nothing was changed.';
        setStatus(view, text, '');
        MuseUI.toast(text);
      } else setStatus(view, err.message, 'bad');
    } finally {
      view.ask.replaceChildren();
      if (pending === run) pending = null;
      lock(view, false);
      if (last && opts.onEnd) {
        try {
          opts.onEnd(last, view);
        } catch (err) {
          console.error('The change could not finish its page:', err);
        }
      }
    }
    return true;
  }

  // A restore of one checkpoint, from the list.
  function restore(view, item) {
    runFlow(view, {
      route: 'checkpoints/restore',
      payload: { project: view.project.id, id: item.id },
      diffUrl: checkpointDiffUrl(view, item),
      approveText: 'Approve restore',
      busyText: 'Restoring…',
      planNote: true,
      nothing: 'Nothing was restored.',
    });
  }

  // The approval card the server asked for. It uses the look of the approval card in the chat. Approve and Deny answer
  // through /api/approve, the same call the chat's card makes. Show changes puts the diff of this change above the buttons.
  // The card counts down to the server's timeout from the moment it is shown, as the chat's card does. Deny takes an optional
  // reason; the server returns it with the denial and the drawer shows it. It goes to no model: a restore has no chat step.
  // A card the server marks clickOnly is answered by a click only: this card has no Y or N keys at all, so none of them answers it.
  // run is the flow this card belongs to: { ctl, root, answered, opts, view }.
  function showApproval(view, ev, run) {
    const opts = run.opts;
    const card = make('div', 'approval ext-checkpoints-card');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', 'Approval needed');
    if (ev.clickOnly) card.dataset.clickOnly = '1';
    const head = MuseUI.span('approval-head', 'Approval needed');
    head.prepend(MuseUI.icon('shield'));
    card.append(head, MuseUI.span('approval-summary', String(ev.summary ?? '')));
    if (ev.detail) card.append(make('pre', 'approval-detail', String(ev.detail)));
    if (opts.planNote && currentProject()?.chatMode === 'plan') card.append(MuseUI.span('approval-note', PLAN_NOTICE));
    const changes = make('div', 'ext-checkpoints-changes');
    changes.hidden = true;
    const why = make('input', 'approval-reason');
    why.type = 'text';
    why.maxLength = 300;
    why.placeholder = REASON;
    why.setAttribute('aria-label', REASON);
    const actions = make('div', 'approval-actions');
    const yes = MuseUI.button('primary', opts.approveText || 'Approve restore');
    const no = MuseUI.button('ghost', 'Deny');
    const changesBtn = MuseUI.button('ghost small', SHOW);
    changesBtn.setAttribute('aria-expanded', 'false');
    changesBtn.addEventListener('click', changesToggle(view, opts.diffUrl, changesBtn, changes));
    const hint = MuseUI.span('hint', '');
    const shownAt = Date.now();
    // Set once the card is answered or has timed out. Nothing can answer it after that.
    let answered = false;
    let tick = 0;
    const lockCard = () => {
      yes.disabled = true;
      no.disabled = true;
      why.disabled = true;
    };
    const decide = async allow => {
      if (answered) return;
      answered = true;
      clearInterval(tick);
      lockCard();
      // Set before the answer is sent, so closing the drawer while the answer is on its way cannot cancel the change.
      run.answered = true;
      setStatus(view, allow ? (opts.busyText || 'Restoring…') : 'Cancelling…', '');
      const body = allow
        ? { approvalId: ev.approvalId, allow: true }
        : { approvalId: ev.approvalId, allow: false, reason: why.value.trim().slice(0, 300) };
      try {
        await MuseUI.api('/api/approve', body);
      } catch (err) {
        MuseUI.toast(err.message, 'bad');
      }
      card.remove();
    };
    yes.addEventListener('click', () => decide(true));
    no.addEventListener('click', () => decide(false));
    // Enter in the reason box denies, as the chat's card does. Nothing approves from there.
    why.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing && !e.repeat) {
        e.preventDefault();
        decide(false);
      }
    });
    // The hint counts down. At zero the server has already denied the card, so nothing is left to answer.
    const paint = () => {
      const left = Math.max(0, Math.ceil((shownAt + APPROVAL_SECONDS * 1000 - Date.now()) / 1000));
      if (left > 0) {
        hint.textContent = `Waiting for you. Times out in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        return;
      }
      answered = true;
      run.answered = true;
      clearInterval(tick);
      lockCard();
      hint.textContent = `Timed out: ${(opts.nothing || 'Nothing was changed.').replace(/^Nothing/, 'nothing')}`;
    };
    paint();
    if (!answered) {
      tick = setInterval(() => {
        if (card.isConnected) paint();
        else clearInterval(tick);
      }, 1000);
    }
    actions.append(yes, no, changesBtn, hint);
    card.append(changes, why, actions);
    view.ask.replaceChildren(card);
    card.scrollIntoView({ block: 'nearest' });
    // Deny takes the focus, so a stray Enter cannot approve an overwrite.
    no.focus();
  }

  // A restore waiting for approval is cancelled when its drawer is closed or drawn again, so a card nobody can see never
  // holds the project busy until it times out. Aborting the request makes the server treat the card as denied. A restore
  // that has been answered is not cancelled: the server has the answer and finishes the restore. The cancel is announced
  // by a toast in runFlow(), since the drawer is hidden.
  function dropStale() {
    if (pending && !pending.answered && (MuseUI.el.drawer.hidden || !pending.root.isConnected)) pending.ctl.abort();
  }
  new MutationObserver(dropStale).observe(MuseUI.el.drawerBody, { childList: true });
  new MutationObserver(dropStale).observe(MuseUI.el.drawer, { attributes: true, attributeFilter: ['hidden'] });

  // ---------- the shared flow for other panels ----------

  // window.MuseRestore.run opens a drawer titled opts.title and runs the flow in it. opts.payload.project names the project. onEnd gets
  // the last event (restored or declined) and the view, whose `actions` element is below the status line for the caller's own buttons.
  window.MuseRestore = {
    run(opts = {}) {
      if (pending && pending.root.isConnected && !pending.answered) {
        MuseUI.toast('An approval for another change is still waiting. Answer it first.', 'bad');
        return false;
      }
      // A flow whose drawer was replaced and that nobody answered is cancelled here, so its card never waits on the server.
      if (pending && !pending.answered) pending.ctl.abort();
      const projectId = typeof opts.payload?.project === 'string' ? opts.payload.project : currentProject()?.id;
      if (!projectId) {
        MuseUI.toast('Choose a project first.', 'bad');
        return false;
      }
      // The route is a path under /api/ and nothing else: a page cannot send this flow anywhere but the app's own routes.
      const route = String(opts.url ?? '').replace(/^\/api\//, '');
      if (!/^[a-z]+(\/[a-z]+)*$/.test(route)) {
        MuseUI.toast('That change has no route to send to.', 'bad');
        return false;
      }
      MuseUI.openDrawer(String(opts.title || 'Restore'), body => {
        const root = make('div', 'ext-checkpoints');
        const view = {
          project: { id: projectId },
          root,
          status: make('div', 'ext-checkpoints-status'),
          ask: make('div', 'ext-checkpoints-ask'),
          // Buttons a caller adds after the answer (an Undo, say) sit in the approval card's own button row.
          actions: make('div', 'approval-actions'),
          buttons: [],
          items: null,
        };
        view.status.setAttribute('role', 'status');
        root.append(view.status, view.ask, view.actions);
        body.append(root);
        runFlow(view, {
          route,
          payload: opts.payload ?? {},
          diffUrl: diffRoute(opts.diffUrl),
          approveText: String(opts.approveText ?? ''),
          busyText: 'Working…',
          planNote: false,
          restoredText: typeof opts.restoredText === 'function' ? opts.restoredText : null,
          onEnd: opts.onEnd,
        });
      });
      return true;
    },
  };

  // Attach. The link goes in before Commands, the last link in the sidebar footer.
  if (!document.getElementById(BUTTON_ID)) MuseUI.el.helpBtn.before(sideLink());
})();
