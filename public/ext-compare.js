// ext-compare. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// Quick compare: one prompt goes to two to four models at once. Each answer streams into its own column, and the
// user keeps the one to continue from. Only Keep writes to the chat. Replies are plain text, set with textContent.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TITLE = 'Quick compare';
  const MIN_SEATS = 2;
  const MAX_SEATS = 4;
  // Seat letters, in the order the models were picked. The server gives each seat the same letter.
  const SEAT_IDS = ['a', 'b', 'c', 'd'];
  // The providers a seat can use: the council's list (lib/council.mjs). The server applies the same rules again.
  const SEAT_PROVIDERS = ['muse', 'anthropic', 'codex', 'gemini', 'cursor', 'xai', 'openai', 'deepseek', 'mistral', 'googleai'];
  // The group names come from the provider registry (app.js PROVIDER_REGISTRY), so a new provider is named in one place.
  const GROUP_NAMES = Object.fromEntries(MuseUI.providerRegistry.map(p => [p.id, p.name]));
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  const STATUS_TEXT = { waiting: 'Waiting', writing: 'Writing', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
  const INTRO = 'Send one message to two to four models at once and compare the replies side by side. Nothing reaches the chat until you keep one.';
  const HINT = 'Ctrl+Enter to compare';

  // The picks, the draft and the effort survive a redraw, so closing the drawer loses nothing that was typed.
  let chosen = [];
  let draft = '';
  let effort = null;
  // The compare in progress, or the last one: { project, prompt, seats, active, kept, error }.
  let run = null;
  // A message about the controls (for example "Write a prompt first."), shown until the next change.
  let flash = null;
  // The drawer's elements. Each draw builds them again, so a stale reference is never painted.
  let view = null;
  let controller = null;
  let userStopped = false;
  let painting = false;

  // "Claude Opus 5.5", not "Muse Wonder Full (Muse Code subscribers)": the bracketed part is menu help.
  const refOf = c => `${c.provider}:${c.id}`;
  const shortLabel = c => c.label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  function labelFor(ref) {
    const hit = MuseUI.catalog.find(c => refOf(c) === ref);
    return hit ? shortLabel(hit) : ref;
  }

  // An element with a class and text. Text goes in with textContent, so nothing is read as HTML.
  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------- the side menu entry and the drawer ----------

  // The entry sits above Accounts in the side menu. It only opens the drawer.
  function sideButton() {
    const b = make('button', 'side-link');
    b.type = 'button';
    b.id = 'compareBtn';
    b.title = 'Send one prompt to several models and keep the reply you pick';
    b.append(MuseUI.icon('layers'), TITLE);
    b.addEventListener('click', openCompare);
    return b;
  }

  function openCompare() {
    MuseUI.openDrawer(TITLE, draw);
    view?.prompt.focus();
  }

  // Builds the whole panel from the module state. openDrawer and refreshDrawer both call it.
  function draw(body) {
    effort ??= MuseUI.state.effort || 'high';
    view = { checks: new Map(), shown: undefined };
    const panel = make('div', 'cmp-panel');
    view.grid = make('div', 'cmp-grid');
    const intro = make('p', 'cmp-intro', INTRO);
    panel.append(intro, modelsCard(), askCard(), view.grid);
    body.append(panel);
    // Several companies get the message here, so the multi-provider strip sits at the top of the panel (LEGAL multi-provider).
    MuseUI.notice?.('multi-provider', { before: intro });
    paint();
  }

  // ---------- the models ----------

  function modelsCard() {
    const card = make('section', 'card cmp-card');
    card.append(MuseUI.span('kicker', 'Models'));
    const groups = make('div', 'cmp-groups');
    for (const provider of SEAT_PROVIDERS) {
      const models = MuseUI.catalog.filter(c => c.provider === provider);
      if (!models.length) continue;
      const group = make('div', 'cmp-group');
      group.append(make('span', 'cmp-group-name', GROUP_NAMES[provider]));
      const chips = make('div', 'cmp-chips');
      for (const c of models) {
        const ref = refOf(c);
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = ref;
        box.checked = chosen.includes(ref);
        box.addEventListener('change', () => toggle(ref));
        const chip = make('label', 'cmp-chip');
        chip.append(box, make('span', null, shortLabel(c)));
        chips.append(chip);
        view.checks.set(ref, box);
      }
      group.append(chips);
      groups.append(group);
    }
    view.count = make('p', 'cmp-count');
    card.append(groups, view.count);
    return card;
  }

  // A pick adds or removes a model. Four is the most, so the other boxes stop accepting once four are chosen.
  function toggle(ref) {
    flash = null;
    chosen = chosen.includes(ref) ? chosen.filter(r => r !== ref) : [...chosen, ref].slice(0, MAX_SEATS);
    paint();
  }

  // ---------- the prompt and the controls ----------

  function askCard() {
    const card = make('section', 'card cmp-card');
    card.append(MuseUI.span('kicker', 'Prompt'));
    view.prompt = make('textarea', 'cmp-prompt');
    view.prompt.rows = 4;
    view.prompt.spellcheck = false;
    view.prompt.placeholder = 'Ask every model the same question';
    view.prompt.setAttribute('aria-label', 'Prompt');
    view.prompt.value = draft;
    view.prompt.addEventListener('input', () => {
      draft = view.prompt.value;
      flash = null;
      paint();
    });
    view.prompt.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        startRun();
      }
    });

    view.effort = document.createElement('select');
    view.effort.setAttribute('aria-label', 'Effort');
    for (const e of EFFORTS) view.effort.append(new Option(EFFORT_LABELS[e], e));
    view.effort.value = effort;
    view.effort.addEventListener('change', () => { effort = view.effort.value; });
    const effortField = make('label', 'cmp-effort');
    effortField.append(make('span', 'field-label', 'Effort'), view.effort);

    view.compare = MuseUI.button('primary small', 'Compare');
    view.compare.addEventListener('click', startRun);
    view.stop = MuseUI.button('ghost small', 'Stop');
    view.stop.addEventListener('click', stopRun);
    const actions = make('div', 'cmp-actions');
    actions.append(effortField, view.compare, view.stop, make('span', 'cmp-hint', HINT));

    view.status = make('p', 'cmp-status');
    view.status.setAttribute('role', 'status');
    card.append(view.prompt, actions, view.status);
    return card;
  }

  // Locks what cannot change while a run is going. The picks, the prompt and the effort wait for the run to end.
  function paintControls() {
    const busy = Boolean(run?.active);
    const picked = chosen.length;
    for (const [ref, box] of view.checks) {
      const on = chosen.includes(ref);
      box.checked = on;
      box.disabled = busy || (!on && picked >= MAX_SEATS);
    }
    view.count.textContent = `${picked} picked. Choose ${MIN_SEATS} to ${MAX_SEATS}.`;
    view.prompt.readOnly = busy;
    view.effort.disabled = busy;
    view.compare.disabled = busy || !MuseUI.state.activeProject;
    view.compare.hidden = busy;
    view.stop.hidden = !busy;
  }

  // The line under the controls: what to do next, what a run is doing, or how the last one ended.
  function paintStatus() {
    const project = MuseUI.state.activeProject;
    let text = 'Pick two to four models, write a prompt, then press Compare.';
    let bad = false;
    if (!project) {
      text = 'Add a project folder first. The kept reply goes into that project’s chat.';
      bad = true;
    } else if (flash) {
      text = flash.text;
      bad = flash.bad;
    } else if (run?.active) {
      const finished = run.seats.filter(s => s.status === 'done' || s.status === 'failed' || s.status === 'stopped').length;
      text = `${finished} of ${run.seats.length} finished.`;
    } else if (run?.error) {
      text = run.error;
      bad = true;
    } else if (run && run.seats.some(s => s.status === 'done')) {
      text = 'Keep the reply you want to continue from. The chat gets your prompt and that reply.';
    } else if (run && run.seats.every(s => s.status === 'stopped')) {
      text = 'Stopped before any reply finished.';
    } else if (run) {
      text = 'No model returned a reply. Each column says why.';
    }
    view.status.textContent = text;
    view.status.className = bad ? 'cmp-status bad' : 'cmp-status';
  }

  // ---------- the columns ----------

  // Brings the controls, the status line and the columns up to date with the run.
  function paint() {
    if (!view) return;
    paintColumns();
    paintControls();
    paintStatus();
  }

  // Text arrives in many small pieces, so the page is redrawn at most once per frame.
  function schedule() {
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      paint();
    });
  }

  // A run builds its columns once. While it runs, a column only takes new text and a status, so the Keep
  // buttons and the scroll positions stay where they are.
  function paintColumns() {
    if (view.shown !== run) {
      view.shown = run;
      view.cols = run ? run.seats.map(makeColumn) : [];
      view.grid.replaceChildren(...(run ? view.cols.map(c => c.root) : [make('p', 'cmp-empty', 'The replies appear here, one column per model.')]));
    }
    if (!run) return;
    for (const col of view.cols) updateColumn(col, run);
  }

  function makeColumn(seat) {
    const root = make('section', 'cmp-col');
    root.setAttribute('aria-label', seat.label);
    const pill = make('span', 'pill');
    const head = make('div', 'cmp-col-head');
    head.append(make('span', 'cmp-col-name', seat.label), pill);
    const text = make('div', 'cmp-col-text');
    const error = make('p', 'cmp-col-error');
    error.hidden = true;
    const keep = MuseUI.button('primary small', 'Keep this reply');
    keep.addEventListener('click', () => keepReply(seat));
    const foot = make('div', 'cmp-col-foot');
    foot.append(keep);
    root.append(head, text, error, foot);
    return { seat, root, pill, text, error, keep };
  }

  function updateColumn(col, current) {
    const { seat } = col;
    col.pill.textContent = STATUS_TEXT[seat.status];
    col.pill.className = seat.status === 'done' ? 'pill ok' : seat.status === 'failed' ? 'pill bad' : 'pill';
    // The reply follows its newest words, unless the reader has scrolled up to read earlier ones.
    const near = col.text.scrollHeight - col.text.scrollTop - col.text.clientHeight < 40;
    if (col.text.textContent !== seat.text) col.text.textContent = seat.text;
    col.text.dataset.empty = seat.status === 'waiting' ? 'Waiting for the first words…' : '';
    if (near) col.text.scrollTop = col.text.scrollHeight;
    col.error.hidden = !seat.error;
    col.error.textContent = seat.error;
    col.keep.disabled = seat.status !== 'done' || current.active || current.kept;
  }

  // ---------- running a compare ----------

  async function startRun() {
    if (run?.active) return;
    const project = MuseUI.state.activeProject;
    const prompt = draft.trim();
    flash = null;
    if (!project) flash = { text: 'Add a project folder first.', bad: true };
    else if (!prompt) flash = { text: 'Write a prompt first.', bad: true };
    else if (chosen.length < MIN_SEATS) flash = { text: `Pick at least ${MIN_SEATS} models.`, bad: true };
    if (flash) return paint();

    const current = {
      project,
      prompt,
      seats: chosen.map((ref, i) => ({ id: SEAT_IDS[i], ref, label: labelFor(ref), status: 'waiting', text: '', error: '' })),
      active: true,
      kept: false,
      error: '',
    };
    run = current;
    userStopped = false;
    controller = new AbortController();
    paint();
    try {
      const res = await MuseUI.request('/api/compare', {
        method: 'POST',
        body: { project, prompt, seats: chosen, effort },
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      // The run's id is claimed from its first event, so the events channel does not draw this compare as one started in
      // another window.
      await readSSE(res, ev => {
        MuseUI.claimRun?.(ev.runId);
        onEvent(current, ev);
      });
    } catch (err) {
      if (err.name !== 'AbortError') current.error = err.message;
    } finally {
      controller = null;
      current.active = false;
      // A seat that never finished is stopped when the user stopped the run, and failed otherwise.
      for (const s of current.seats) {
        if (s.status === 'done' || s.status === 'failed' || s.status === 'stopped') continue;
        s.status = userStopped ? 'stopped' : 'failed';
        s.error = userStopped ? '' : (current.error || 'The connection ended before this reply finished.');
      }
      paint();
    }
  }

  function stopRun() {
    if (!controller) return;
    userStopped = true;
    controller.abort();
  }

  // Folds one server event into the run: a delta extends its seat's text, and a done event ends that seat.
  function onEvent(current, ev) {
    const seat = current.seats.find(s => s.id === ev.seat);
    if (ev.type === 'delta' && seat) {
      seat.status = 'writing';
      seat.text += ev.text;
    } else if (ev.type === 'done' && seat) {
      seat.text = typeof ev.text === 'string' ? ev.text : seat.text;
      if (ev.ok) {
        seat.status = 'done';
        seat.error = '';
      } else if (ev.error === 'Stopped.') {
        seat.status = 'stopped';
        seat.error = '';
      } else {
        seat.status = 'failed';
        seat.error = ev.error || 'No reply came back.';
      }
    } else if (ev.type === 'error') {
      current.error = ev.message || 'The run failed.';
    }
    schedule();
  }

  // Reads a server-sent stream and hands each JSON event to handle. The framing is the same one app.js reads.
  async function readSSE(res, handle) {
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
        if (data) handle(JSON.parse(data));
      }
    }
  }

  // ---------- keeping a reply ----------

  // Keep writes the prompt and the chosen reply into the chat, then closes the drawer so the chat shows them.
  async function keepReply(seat) {
    const current = run;
    if (!current || current.active || current.kept || seat.status !== 'done' || !current.seats.includes(seat)) return;
    if (current.project !== MuseUI.state.activeProject) {
      flash = { text: 'Switch back to the project this compare ran in, then keep the reply.', bad: true };
      return paint();
    }
    current.kept = true;
    flash = null;
    paint();
    try {
      await MuseUI.api('/api/compare/keep', { project: current.project, prompt: current.prompt, seat: seat.ref, text: seat.text });
      MuseUI.toast(`Kept the ${seat.label} reply. It is in the chat.`);
      run = null;
      draft = '';
      MuseUI.closeDrawer();
      MuseUI.refresh();
    } catch (err) {
      current.kept = false;
      flash = { text: err.message, bad: true };
      paint();
    }
  }

  // Attach. The entry is added once, above Accounts, when the panel script loads.
  if (!document.getElementById('compareBtn')) MuseUI.el.accountsBtn.before(sideButton());
})();
