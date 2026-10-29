// The drive bars and the drive pills (UI-ARCH 2, 4, 7): what a model is doing with the screen or the browser, with Pause or Resume and
// Stop for each drive. Loaded by ext.js and adds itself through window.MuseUI. The bars sit in the banner slot above the message box, first
// in order, so the first row is the one closest to the composer; the pills sit in the title bar's drive-pill place. There is one row and
// one pill for each live drive (the first few; see MAX_ROWS and MAX_PILLS).
// The server is the source of truth: the state it sends (its drives and the stop key's state), GET /api/drive at load and while a
// drive is live, and the 'drive' events on the events channel. Nothing is stored here. The model's words and the screen's text are
// always set with textContent.
(function () {
  const MuseUI = window.MuseUI;
  // Without the slots and the events channel there is nothing to attach to.
  if (!MuseUI || !MuseUI.slots || !MuseUI.events) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const KIND_NAME = { computer: 'Computer', browser: 'Browser' };
  // The bar turns amber when this many steps, or this much time, are left.
  const LOW_STEPS = 5;
  const LOW_MS = 60_000;
  const POLL_MS = 2000;
  const TICK_MS = 1000;
  const STOP_TIP = 'Stop the model’s control now. It writes a short report of what it did; Esc in the composer stops the reply too.';
  // How many drives are shown. The bar has one row for each drive, up to MAX_ROWS; when there are more, its last row says how many it does
  // not show and stops them all. The title bar gives a pill to each drive, up to MAX_PILLS; with more than that, its last pill says how
  // many it does not show and stops them all, as the bar's last row does. So its items stay on screen at 480 px.
  const MAX_ROWS = 3;
  const MAX_PILLS = 2;

  // Live drives by id: { s: the server's summary, at: when this window received it }. A stopped drive is removed at once.
  const entries = new Map();
  // The stop key as the server reports it: { ok, accelerator, label, reason }.
  let hotkey = { ok: false, reason: '' };
  // True while a Pause, Resume or Stop request is on its way, so a second click waits.
  let busy = false;
  // What the live region last announced: the drive's id and its state, so only a change is said.
  let shownKey = '';
  let shownId = '';
  let clockTimer = 0;
  let pollTimer = 0;

  // The bar rows and the title bar's pills, in the order they were made. rows[0] is the slot item 'drive-bar', the first row of the bar.
  const rows = [];
  const pills = [];
  let live = null;
  // The title bar's drive-pill place (index.html: data-slot="drivePill"), or null where the page has none.
  let host = null;

  // The kind's icon, drawn here so no sprite symbol is needed. Strokes only, like the others in the sprite.
  function kindIcon(kind) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const shapes = kind === 'browser'
      ? [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18' }]]
      : [['rect', { x: '3', y: '4', width: '18', height: '12', rx: '2' }], ['path', { d: 'M8 20h8M12 16v4' }]];
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
      svg.append(shape);
    }
    return svg;
  }

  // m:ss for a number of milliseconds (the time left).
  function mmss(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  // The time used and left, from the summary and the moment it arrived here. Time counts only while the run is running.
  function clockOf(entry) {
    const s = entry.s;
    const used = s.activeMs + (s.state === 'running' ? Math.max(0, Date.now() - entry.at) : 0);
    const left = typeof s.limits?.activeMs === 'number' ? Math.max(0, s.limits.activeMs - used) : null;
    return { left };
  }

  const stepText = s => (typeof s.limits?.steps === 'number' ? `step ${s.steps} of ${s.limits.steps}` : `step ${s.steps}`);

  function projectNameOf(id) {
    return (MuseUI.state.projects ?? []).find(p => p.id === id)?.name ?? '';
  }

  // The words for one drive: the bar's text, its tone, the live region's words and whether it is low.
  function describe(entry) {
    const s = entry.s;
    const { left } = clockOf(entry);
    const timeLeft = left === null ? '' : ` · ${mmss(left)} left`;
    const label = s.label || KIND_NAME[s.kind];
    let text;
    let tone;
    let words;
    if (s.state === 'running') {
      text = `${KIND_NAME[s.kind]} · ${label} · ${stepText(s)}${timeLeft}`;
      tone = 'running';
      words = `The model is using ${label}.`;
    } else if (s.pausedBy === 'model') {
      // The model's own words are quoted and attributed; they are never shown as Plenum's words.
      const ask = s.note ? `the model asks: "${s.note}"` : 'the model is waiting for you';
      text = `Your turn · ${ask} · Resume when done`;
      tone = 'wait';
      words = 'Your turn.';
    } else if (s.pausedBy === 'card') {
      text = 'Waiting for your answer on the card in the chat';
      tone = 'wait';
      words = 'Waiting for your answer.';
    } else if (s.pausedBy === 'input') {
      text = `Paused: you used the mouse or keyboard · ${label} · ${stepText(s)}`;
      tone = 'paused';
      words = 'Paused.';
    } else {
      text = `Paused · ${label} · ${stepText(s)}${timeLeft}`;
      tone = 'paused';
      words = 'Paused.';
    }
    if (s.projectId !== MuseUI.state.activeProject) {
      const name = projectNameOf(s.projectId);
      if (name) text += ` · in ${name}`;
    }
    const low = (typeof s.limits?.steps === 'number' && s.limits.steps - s.steps <= LOW_STEPS) || (left !== null && left <= LOW_MS);
    return { text, tone, words, low, cardWait: s.pausedBy === 'card' };
  }

  // The live drives in the order they are shown: this project's first, then the computer's, then the rest. Within a group, the order they
  // came in. The first one is the drive the live region speaks for.
  function ordered() {
    const active = MuseUI.state.activeProject;
    const rank = e => (e.s.projectId === active ? 0 : e.s.kind === 'computer' ? 1 : 2);
    return [...entries.values()].sort((a, b) => rank(a) - rank(b));
  }

  // Keeps a summary the server sent. A stopped drive leaves the list; anything malformed is ignored.
  function take(s) {
    if (!s || typeof s.id !== 'string' || !KIND_NAME[s.kind]) return;
    if (s.state === 'stopped') entries.delete(s.id);
    else entries.set(s.id, { s, at: Date.now() });
  }

  function replaceAll(list) {
    entries.clear();
    for (const s of Array.isArray(list) ? list : []) take(s);
  }

  // The stop key's name for the accessibility tree, in the form aria-keyshortcuts expects.
  const ariaKeys = accelerator => String(accelerator).replace(/Ctrl/g, 'Control').replace(/Super/g, 'Meta');

  // Says a state change, once: "The model is using Notepad.", "Paused.", "Your turn.", "Waiting for your answer.", "Stopped.". The clock
  // is never read out. It speaks for the first drive only.
  function announce(entry, d) {
    const key = entry ? `${entry.s.id}|${entry.s.state}|${entry.s.pausedBy ?? ''}` : '';
    if (key === shownKey) return;
    let words = '';
    if (entry) words = d.words;
    else if (shownId) words = 'Stopped.';
    shownKey = key;
    shownId = entry ? entry.s.id : '';
    live.textContent = words;
  }

  function paint() {
    const list = ordered();
    const entry = list[0] ?? null;
    const d = entry ? describe(entry) : null;

    // The bar: a row for each drive up to MAX_ROWS. Past that, the last row counts the drives it does not show and stops them.
    const more = list.length > MAX_ROWS ? list.slice(MAX_ROWS - 1) : null;
    const shown = more ? list.slice(0, MAX_ROWS - 1) : list;
    shown.forEach((e, i) => paintRow(rowAt(i), e, null, i === 0));
    if (more) paintRow(rowAt(shown.length), null, more, false);
    for (let i = shown.length + (more ? 1 : 0); i < rows.length; i += 1) hideRow(rows[i]);

    // The title bar: a pill for each drive, up to MAX_PILLS. With more drives than that, the last pill counts the drives it does not show and
    // stops them all, as the bar's last row does.
    const pillMore = host && list.length > MAX_PILLS ? list.slice(MAX_PILLS - 1) : null;
    const pillList = host ? (pillMore ? list.slice(0, MAX_PILLS - 1) : list) : [];
    pillList.forEach((e, i) => paintPill(pillAt(i), e, null));
    if (pillMore) paintPill(pillAt(pillList.length), null, pillMore);
    for (let i = pillList.length + (pillMore ? 1 : 0); i < pills.length; i += 1) hidePill(pills[i]);

    announce(entry, d);
    manageTimers();
  }

  // The clock is repainted every second while a run runs; the list is read again every 2 seconds while any drive is live.
  function manageTimers() {
    const running = [...entries.values()].some(e => e.s.state === 'running');
    if (running && !clockTimer) clockTimer = setInterval(paint, TICK_MS);
    else if (!running && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = 0;
    }
    if (entries.size && !pollTimer) pollTimer = setInterval(load, POLL_MS);
    else if (!entries.size && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  // Reads GET /api/drive: the live drives and the stop key. A failed read keeps what is on screen; the next read tries again.
  async function load() {
    try {
      const res = await MuseUI.request('/api/drive');
      if (!res.ok) return;
      const data = await res.json();
      replaceAll(data.drives);
      if (data.hotkey && typeof data.hotkey === 'object') hotkey = data.hotkey;
      paint();
    } catch {
      // Offline or refused; the bar keeps its last state.
    }
  }

  // The page state the server sends (on connect and on every change) carries the drives and the stop key.
  function fromState(state) {
    if (!state || typeof state !== 'object') return;
    if (Array.isArray(state.drives)) replaceAll(state.drives);
    if (state.driveHotkey && typeof state.driveHotkey === 'object') hotkey = state.driveHotkey;
    paint();
  }

  // Pause, Resume or Stop for one drive. A refusal (409, 404) is toasted; the bar then reads the server again.
  // A Pause or Resume waits for the one before it, but Stop always goes out at once, even while another request is pending,
  // so a slow or stuck request can never hold up the emergency stop.
  async function act(entry, route) {
    const stopping = route === '/api/drive/stop';
    if (!entry || (busy && !stopping)) return;
    busy = true;
    paint();
    try {
      const data = await MuseUI.api(route, { id: entry.s.id });
      if (data.drive) take(data.drive);
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
      await load();
    } finally {
      busy = false;
      paint();
    }
  }

  // Stop for each drive in a list, one after the other: the bar's last row stops the drives it does not show.
  async function stopEach(list) {
    for (const entry of list) await act(entry, '/api/drive/stop');
  }

  // The name of the pill for assistive technology, while a drive runs: "A model is driving the computer: Notepad, step 12 of 80. Open the
  // run". A drive with no step limit says the step it is on, without the "of". A paused or waiting drive is named by its visible words.
  function pillName(s) {
    const label = s.label || KIND_NAME[s.kind];
    const step = typeof s.limits?.steps === 'number' ? `step ${s.steps} of ${s.limits.steps}` : `step ${s.steps}`;
    return `A model is driving the ${s.kind === 'browser' ? 'browser' : 'computer'}: ${label}, ${step}. Open the run`;
  }

  // The name of a drive's Stop for assistive technology: which drive it ends, so two Stop buttons do not read alike. The project is named
  // when the drive is in another project.
  function stopNameOf(s) {
    const project = s.projectId !== MuseUI.state.activeProject ? projectNameOf(s.projectId) : '';
    return `Stop the ${s.kind === 'browser' ? 'browser' : 'computer'} drive: ${s.label || KIND_NAME[s.kind]}${project ? ` in ${project}` : ''}`;
  }

  // The pill opens the run view of its drive: the computer runs (their steps and screenshots) for a computer drive, the browser pane for a
  // browser one.
  function openRunView(entry) {
    if (!entry) return;
    if (entry.s.kind === 'browser') MuseUI.pane?.open('browser');
    else MuseUI.openComputerRuns?.();
  }

  // One bar row: a .drivebar with its state, its Pause or Resume and its Stop. The row shows one drive, or, when it is the bar's last row
  // and there are more drives than the bar shows, the drives it does not show (their Stop is this row's Stop).
  function makeRow(index) {
    const bar = document.createElement('div');
    bar.className = 'drivebar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Model control');
    bar.hidden = true;
    const barDot = MuseUI.span('db-dot');
    barDot.setAttribute('aria-hidden', 'true');
    const kindEl = MuseUI.span('db-kind');
    kindEl.setAttribute('aria-hidden', 'true');
    const textEl = MuseUI.span('db-text');
    const actions = MuseUI.span('db-actions');
    const toggleBtn = MuseUI.button('ghost small db-toggle', 'Pause');
    const stopBtn = MuseUI.button('ghost small db-stop', 'Stop');
    stopBtn.title = STOP_TIP;
    // The first row keeps the ids the page's own tests use. An id is unique on the page, so the other rows have none.
    if (index === 0) {
      toggleBtn.id = 'dbToggle';
      stopBtn.id = 'dbStop';
    }
    const keyEl = document.createElement('kbd');
    keyEl.className = 'db-key';
    keyEl.hidden = true;
    actions.append(toggleBtn, stopBtn, keyEl);
    bar.append(barDot, kindEl, textEl, actions);

    const row = { bar, barDot, kindEl, kindShown: '', textEl, toggleBtn, stopBtn, keyEl, entry: null, more: null };
    toggleBtn.addEventListener('click', () => {
      if (row.entry) act(row.entry, row.entry.s.state === 'paused' ? '/api/drive/resume' : '/api/drive/pause');
    });
    stopBtn.addEventListener('click', () => {
      if (row.more) stopEach(row.more);
      else if (row.entry) act(row.entry, '/api/drive/stop');
    });
    return row;
  }

  // The row at an index, made and put in the banner slot the first time it is needed. Rows are never removed; an unused row is hidden.
  function rowAt(index) {
    while (rows.length <= index) {
      const row = makeRow(rows.length);
      MuseUI.slots.add('bannerSlot', `drive-bar-${rows.length + 1}`, row.bar, 0);
      rows.push(row);
    }
    return rows[index];
  }

  // Shows a drive in a row (entry), or the drives the bar does not show (more). first is true for the row that carries the stop key's name.
  function paintRow(row, entry, more, first) {
    const { bar, barDot, kindEl, textEl, toggleBtn, stopBtn, keyEl } = row;
    row.entry = entry;
    row.more = more;
    bar.hidden = !entry && !more;
    if (more) {
      const running = more.some(e => e.s.state === 'running');
      bar.dataset.tone = running ? 'running' : 'paused';
      bar.classList.remove('low');
      barDot.dataset.tone = running ? 'running' : 'paused';
      kindEl.replaceChildren();
      row.kindShown = '';
      textEl.textContent = `${more.length} more model ${more.length === 1 ? 'drive' : 'drives'}`;
      toggleBtn.hidden = true;
      stopBtn.textContent = 'Stop them';
      stopBtn.title = 'Stop the model drives this bar does not show.';
      stopBtn.setAttribute('aria-label', 'Stop them: the model drives this bar does not show');
      stopBtn.disabled = false;
      stopBtn.removeAttribute('aria-keyshortcuts');
      keyEl.hidden = true;
      return;
    }
    if (!entry) return;
    const d = describe(entry);
    const paused = entry.s.state === 'paused';
    toggleBtn.hidden = false;
    bar.dataset.tone = d.tone;
    bar.classList.toggle('low', d.low);
    barDot.dataset.tone = d.tone;
    if (row.kindShown !== entry.s.kind) {
      kindEl.replaceChildren(kindIcon(entry.s.kind));
      row.kindShown = entry.s.kind;
    }
    textEl.textContent = d.text;
    toggleBtn.textContent = paused ? 'Resume' : 'Pause';
    // A card waiting for the person is answered first; Resume would skip it, so the button waits.
    toggleBtn.disabled = busy || d.cardWait;
    toggleBtn.title = d.cardWait ? 'Answer the card in the chat first. Stop ends the run.' : (paused ? 'Let the model carry on' : 'Pause the model’s control');
    // Stop is the emergency control: it is never disabled, not even while a Pause or Resume is still on its way (see act).
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
    stopBtn.setAttribute('aria-label', stopNameOf(entry.s));
    stopBtn.title = STOP_TIP;
    // The stop key's name is shown once, on the first row.
    keyEl.hidden = !(first && hotkey.ok);
    keyEl.textContent = first && hotkey.ok ? String(hotkey.label ?? '') : '';
    if (first && hotkey.ok && hotkey.accelerator) stopBtn.setAttribute('aria-keyshortcuts', ariaKeys(hotkey.accelerator));
    else stopBtn.removeAttribute('aria-keyshortcuts');
  }

  function hideRow(row) {
    row.entry = null;
    row.more = null;
    row.bar.hidden = true;
  }

  // One title-bar pill: a .drive-pill in the drive-pill place, with its open part (the run view) and its own Stop beside it.
  function makePill() {
    const el = document.createElement('div');
    el.className = 'drive-pill';
    el.hidden = true;
    const dot = MuseUI.span('db-dot');
    dot.setAttribute('aria-hidden', 'true');
    const kind = MuseUI.span('db-kind');
    kind.setAttribute('aria-hidden', 'true');
    const text = MuseUI.span('dp-text');
    // The part of the pill that opens the run view is a button of its own. Stop is a second button beside it, never inside it.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'dp-open';
    open.append(dot, kind, text);
    const stop = MuseUI.button('ghost small dp-stop', 'Stop');
    stop.title = STOP_TIP;
    el.append(open, stop);
    const pill = { el, dot, kind, kindShown: '', text, open, stop, entry: null, more: null };
    open.addEventListener('click', () => openRunView(pill.entry));
    stop.addEventListener('click', () => {
      if (pill.more) stopEach(pill.more);
      else if (pill.entry) act(pill.entry, '/api/drive/stop');
    });
    return pill;
  }

  // The pill at an index, made and put in the title bar the first time it is needed.
  function pillAt(index) {
    while (pills.length <= index) {
      const pill = makePill();
      host.append(pill.el);
      pills.push(pill);
    }
    return pills[index];
  }

  // One pill: a drive (entry), or the drives the title bar does not show (more). The "more" pill names no one drive, so its open part is
  // off, and its Stop ends all of them.
  function paintPill(pill, entry, more) {
    pill.entry = entry;
    pill.more = more;
    pill.el.hidden = !entry && !more;
    pill.el.classList.toggle('more', !!more);
    if (more) {
      const running = more.some(e => e.s.state === 'running');
      const words = `${more.length} more model ${more.length === 1 ? 'drive' : 'drives'}`;
      pill.el.dataset.tone = running ? 'running' : 'paused';
      pill.el.classList.remove('low');
      pill.dot.dataset.tone = running ? 'running' : 'paused';
      pill.kind.replaceChildren();
      pill.kindShown = '';
      pill.text.textContent = words;
      pill.open.disabled = true;
      pill.open.title = words;
      pill.open.setAttribute('aria-label', words);
      pill.stop.disabled = false;
      pill.stop.setAttribute('aria-label', `Stop the ${more.length} drives not shown`);
      return;
    }
    if (!entry) return;
    const d = describe(entry);
    pill.el.dataset.tone = d.tone;
    pill.el.classList.toggle('low', d.low);
    pill.dot.dataset.tone = d.tone;
    if (pill.kindShown !== entry.s.kind) {
      pill.kind.replaceChildren(kindIcon(entry.s.kind));
      pill.kindShown = entry.s.kind;
    }
    pill.text.textContent = d.text;
    pill.open.disabled = false;
    pill.open.setAttribute('aria-label', entry.s.state === 'running' ? pillName(entry.s) : `${d.text}. Open the run`);
    pill.open.title = d.text;
    pill.stop.disabled = false;
    pill.stop.setAttribute('aria-label', stopNameOf(entry.s));
  }

  function hidePill(pill) {
    pill.entry = null;
    pill.more = null;
    pill.el.hidden = true;
    pill.open.removeAttribute('aria-label');
    pill.stop.removeAttribute('aria-label');
  }

  // The bar and the live region go in the banner slot (the first row takes the slot's name, 'drive-bar'); the pills go in the title bar.
  function build() {
    rows.push(makeRow(0));
    // The live region is its own slot item, so it still announces while the bar is hidden (the "Stopped." after a stop).
    live = MuseUI.span('sr', '');
    live.setAttribute('aria-live', 'polite');
    MuseUI.slots.add('bannerSlot', 'drive-bar', rows[0].bar, 0);
    MuseUI.slots.add('bannerSlot', 'drive-live', live, 0);
    // The pills go in the title bar's drive-pill place (index.html: data-slot="drivePill"). It is not yet a slot name, so it is mounted there
    // directly; the element is the shell's own.
    host = document.querySelector('[data-slot="drivePill"]');
  }

  build();

  // The live events: every change of a drive, and the page state that carries the drives and the stop key.
  MuseUI.events.on('drive', ev => {
    take(ev?.drive);
    paint();
  });
  MuseUI.events.on('hello', ev => fromState(ev?.state));
  MuseUI.events.on('state', ev => fromState(ev?.state));

  // The project name changes on every redraw of the title bar, which can change the "in <project>" words.
  new MutationObserver(paint).observe(MuseUI.el.projName, { childList: true, characterData: true, subtree: true });

  paint();
  (MuseUI.ready ?? Promise.resolve()).then(load);
})();
