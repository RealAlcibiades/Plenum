// The drive bar and the drive pill (UI-ARCH 2, 4, 7): what a model is doing with the screen or the browser, with Pause or Resume and
// Stop for it. Loaded by ext.js and adds itself through window.MuseUI. The bar sits in the banner slot above the message box, first in
// order, so it is the row closest to the composer; the pill sits in the title bar's drive-pill place.
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

  let bar = null;
  let kindEl = null;
  let kindShown = '';
  let textEl = null;
  let toggleBtn = null;
  let stopBtn = null;
  let keyEl = null;
  let live = null;
  let pillEl = null;
  let pillKind = null;
  let pillKindShown = '';
  let pillText = null;
  let pillDot = null;
  let pillOpen = null;
  let pillStop = null;
  let barDot = null;

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

  // The drive the bar shows: this project's live drive, else a computer drive (it controls the whole machine).
  function current() {
    const list = [...entries.values()];
    const active = MuseUI.state.activeProject;
    return list.find(e => e.s.projectId === active) ?? list.find(e => e.s.kind === 'computer') ?? null;
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
  // is never read out.
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
    const entry = current();
    const d = entry ? describe(entry) : null;
    const paused = entry?.s.state === 'paused';

    bar.hidden = !entry;
    if (entry) {
      bar.dataset.tone = d.tone;
      bar.classList.toggle('low', d.low);
      barDot.dataset.tone = d.tone;
      if (kindShown !== entry.s.kind) {
        kindEl.replaceChildren(kindIcon(entry.s.kind));
        kindShown = entry.s.kind;
      }
      textEl.textContent = d.text;
      toggleBtn.textContent = paused ? 'Resume' : 'Pause';
      // A card waiting for the person is answered first; Resume would skip it, so the button waits.
      toggleBtn.disabled = busy || d.cardWait;
      toggleBtn.title = d.cardWait ? 'Answer the card in the chat first. Stop ends the run.' : (paused ? 'Let the model carry on' : 'Pause the model’s control');
    }
    // Stop is the emergency control: it is never disabled, not even while a Pause or Resume is still on its way (see act).
    stopBtn.disabled = false;

    keyEl.hidden = !hotkey.ok;
    keyEl.textContent = hotkey.ok ? String(hotkey.label ?? '') : '';
    if (hotkey.ok && hotkey.accelerator) stopBtn.setAttribute('aria-keyshortcuts', ariaKeys(hotkey.accelerator));
    else stopBtn.removeAttribute('aria-keyshortcuts');

    if (pillEl) {
      pillEl.hidden = !entry;
      if (entry) {
        pillEl.dataset.tone = d.tone;
        pillEl.classList.toggle('low', d.low);
        pillDot.dataset.tone = d.tone;
        if (pillKindShown !== entry.s.kind) {
          pillKind.replaceChildren(kindIcon(entry.s.kind));
          pillKindShown = entry.s.kind;
        }
        pillText.textContent = d.text;
        pillOpen.setAttribute('aria-label', entry.s.state === 'running' ? pillName(entry.s) : `${d.text}. Open the run`);
        pillOpen.title = d.text;
        pillStop.disabled = false;
        pillStop.title = STOP_TIP;
      }
    }

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

  // The name of the pill for assistive technology, while a drive runs: "A model is driving the computer: Notepad, step 12 of 80. Open the
  // run". A drive with no step limit says the step it is on, without the "of". A paused or waiting drive is named by its visible words.
  function pillName(s) {
    const label = s.label || KIND_NAME[s.kind];
    const step = typeof s.limits?.steps === 'number' ? `step ${s.steps} of ${s.limits.steps}` : `step ${s.steps}`;
    return `A model is driving the ${s.kind === 'browser' ? 'browser' : 'computer'}: ${label}, ${step}. Open the run`;
  }

  // The pill opens the run view: the computer runs (their steps and screenshots) for a computer drive, the browser pane for a browser one.
  function openRunView() {
    const entry = current();
    if (!entry) return;
    if (entry.s.kind === 'browser') MuseUI.pane?.open('browser');
    else MuseUI.openComputerRuns?.();
  }

  function build() {
    bar = document.createElement('div');
    bar.className = 'drivebar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Model control');
    bar.hidden = true;
    barDot = MuseUI.span('db-dot');
    barDot.setAttribute('aria-hidden', 'true');
    kindEl = MuseUI.span('db-kind');
    kindEl.setAttribute('aria-hidden', 'true');
    textEl = MuseUI.span('db-text');
    const actions = MuseUI.span('db-actions');
    toggleBtn = MuseUI.button('ghost small db-toggle', 'Pause');
    toggleBtn.id = 'dbToggle';
    stopBtn = MuseUI.button('ghost small db-stop', 'Stop');
    stopBtn.id = 'dbStop';
    stopBtn.title = STOP_TIP;
    keyEl = document.createElement('kbd');
    keyEl.className = 'db-key';
    keyEl.hidden = true;
    actions.append(toggleBtn, stopBtn, keyEl);
    bar.append(barDot, kindEl, textEl, actions);

    // The live region is its own slot item, so it still announces while the bar is hidden (the "Stopped." after a stop).
    live = MuseUI.span('sr', '');
    live.setAttribute('aria-live', 'polite');
    MuseUI.slots.add('bannerSlot', 'drive-bar', bar, 0);
    MuseUI.slots.add('bannerSlot', 'drive-live', live, 0);

    toggleBtn.addEventListener('click', () => {
      const entry = current();
      if (entry) act(entry, entry.s.state === 'paused' ? '/api/drive/resume' : '/api/drive/pause');
    });
    stopBtn.addEventListener('click', () => {
      const entry = current();
      if (entry) act(entry, '/api/drive/stop');
    });

    // The pill goes in the title bar's drive-pill place (index.html: data-slot="drivePill"). It is not yet a slot name, so it is mounted
    // there directly; the element is the shell's own.
    const host = document.querySelector('[data-slot="drivePill"]');
    if (host) {
      pillEl = document.createElement('div');
      pillEl.className = 'drive-pill';
      pillEl.hidden = true;
      pillDot = MuseUI.span('db-dot');
      pillDot.setAttribute('aria-hidden', 'true');
      pillKind = MuseUI.span('db-kind');
      pillKind.setAttribute('aria-hidden', 'true');
      pillText = MuseUI.span('dp-text');
      // The part of the pill that opens the run view is a button of its own. Stop is a second button beside it, never inside it.
      pillOpen = document.createElement('button');
      pillOpen.type = 'button';
      pillOpen.className = 'dp-open';
      pillOpen.append(pillDot, pillKind, pillText);
      pillOpen.addEventListener('click', openRunView);
      pillStop = MuseUI.button('ghost small dp-stop', 'Stop');
      pillEl.append(pillOpen, pillStop);
      host.append(pillEl);
      pillStop.addEventListener('click', () => {
        const entry = current();
        if (entry) act(entry, '/api/drive/stop');
      });
    }
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
