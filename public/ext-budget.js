// Spend limit chip in the top bar. Loaded by ext.js and adds itself through window.MuseUI.
// A chip after the cost line shows what this project's API-key models have cost and its limit. A warning turns the chip the
// warning colour and says so once per project per session; a cap makes the server refuse the next send to an API-key model.
// The limit is set in a drawer. The server keeps the limit and the running spend (GET and POST /api/budget, POST
// /api/budget/reset, lib/budget.mjs); this file only words what the server sends. Subscription CLIs are never capped and are
// not counted here.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TITLE = 'Spend limit';
  const NOTE = 'Counts chat replies, reviews and /compact summaries from API-key models, estimated from published prices. A reply whose price or token count is not known adds nothing, so the cap cannot count it. Council, quick compare, pipeline, relay and build runs are not counted yet. Subscription CLIs (Claude Code, Codex, Gemini CLI, Muse Code) bill to your plan and are never capped.';

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'ext-budget-chip';
  chip.hidden = true;

  // The last answer from the server and the project it is for. The chip shows it only while that project is the active one.
  let state = null;
  let stateFor = null;
  // The project whose last read gave no answer, so the drawer can say so instead of reading forever.
  let failedFor = null;
  // Counts the requests, so a late answer never paints over a newer one.
  let seq = 0;
  // The level each project had at its last answer, and the projects already toasted in this session.
  const levels = new Map();
  const warned = new Set();
  // The open drawer: its root, the limits its inputs were filled with, its spend line, and whether a save is on its way.
  let drawerRoot = null;
  let shown = null;
  let spentLine = null;
  let busy = false;

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function projectId() {
    return MuseUI.state.activeProject ?? null;
  }

  // The chip goes after the cost line when the page has one, else straight after the project name. It is checked on every
  // paint, so a line another panel adds later stays ahead of it.
  function place() {
    const anchor = document.querySelector('.cost-line') ?? MuseUI.el.projName;
    if (chip.previousElementSibling !== anchor) anchor.after(chip);
  }

  const money = n => `$${Number(n || 0).toFixed(2)}`;
  const hasLimit = v => typeof v === 'number';
  // The day the running total started, written the way the page writes dates. A date that does not read is named vaguely.
  const sinceOf = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? 'an earlier day' : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  };

  // The chip's words: the spend against the cap, the spend against the warning, or "Spend limit" when none is set.
  function chipText(s) {
    if (hasLimit(s.capUsd)) return `${money(s.spent)} of ${money(s.capUsd)} cap`;
    if (hasLimit(s.warnUsd)) return `${money(s.spent)} · warn at ${money(s.warnUsd)}`;
    return 'Spend limit';
  }

  // The hover text: what has been spent, the limits and what they do.
  function hoverText(s) {
    const lines = [`Spent since ${sinceOf(s.since)}: ${money(s.spent)} on API-key models in this project, estimated from published prices. The total keeps counting after /clear.`];
    if (hasLimit(s.warnUsd)) lines.push(`Warning at ${money(s.warnUsd)}.`);
    if (hasLimit(s.capUsd)) lines.push(`Cap at ${money(s.capUsd)}: the next send to an API-key model is refused once the spend reaches it.`);
    if (!hasLimit(s.warnUsd) && !hasLimit(s.capUsd)) lines.push('No limit set.');
    lines.push('Subscription CLIs are never capped. Click to set or change the limit.');
    return lines.join('\n');
  }

  // ---------- the chip ----------

  function paint() {
    place();
    const id = projectId();
    // Hidden with no project, before the first answer for this project, and while the server cannot be reached.
    if (!id || !state || stateFor !== id) {
      chip.hidden = true;
    } else {
      chip.hidden = false;
      // The full words show on a wide window. A phone-width window shows only the amount spent (ext-budget.css picks one).
      chip.replaceChildren(make('span', 'ext-budget-long', chipText(state)), make('span', 'ext-budget-short', money(state.spent)));
      chip.title = hoverText(state);
      chip.setAttribute('aria-label', `${chipText(state)}. Opens the spend limit.`);
      chip.classList.toggle('warn', state.level === 'warn');
      chip.classList.toggle('cap', state.level === 'cap');
    }
    // Closing the drawer only hides it, so its contents are kept until the next open replaces them.
    if (drawerRoot && !drawerRoot.isConnected) drawerRoot = null;
  }

  // Reads the spend and the limits of the active project.
  async function refresh() {
    const id = projectId();
    const mine = ++seq;
    if (!id) {
      state = null;
      stateFor = null;
      failedFor = null;
      paint();
      return;
    }
    let answer = null;
    try {
      answer = await MuseUI.api(`/api/budget?project=${encodeURIComponent(id)}`);
    } catch {
      // No answer (the server is down or the request failed): the chip stays hidden until one comes.
      answer = null;
    }
    // A newer request, or another project, has taken over since this one was sent.
    if (mine !== seq || projectId() !== id) return;
    accept(id, answer);
  }

  // Takes an answer for a project: repaints the chip, toasts a first crossing of the warning, and refills the drawer when a
  // limit changed. A spend that only moved updates the spend line, so what is being typed in the drawer is kept.
  function accept(id, answer) {
    state = answer && typeof answer === 'object' ? answer : null;
    stateFor = state ? id : null;
    // No answer for this project is remembered, so an open drawer says the read failed rather than still reading.
    failedFor = state ? null : id;
    if (state) noteLevel(id, state.level);
    paint();
    if (!drawerRoot || !drawerRoot.isConnected || MuseUI.el.drawer.hidden) return;
    if (!state) {
      // A drawer that already shows limits keeps them; an empty one (still reading) shows the failed read.
      if (!shown) fillDrawer(drawerRoot);
      return;
    }
    if (!shown || state.warnUsd !== shown.warnUsd || state.capUsd !== shown.capUsd) fillDrawer(drawerRoot);
    else if (spentLine) spentLine.textContent = spentText(state);
  }

  // One toast per project per session, when its spend goes from under the warning to the warning or the cap. The first
  // answer for a project only records its level, so a page that opens over the warning says nothing.
  function noteLevel(id, level) {
    const before = levels.get(id);
    levels.set(id, level);
    if (before === 'ok' && level !== 'ok' && !warned.has(id)) {
      warned.add(id);
      MuseUI.toast('This project passed its spend warning.');
    }
  }

  // ---------- the drawer ----------

  const spentText = s => `Spent since ${sinceOf(s.since)}: ${money(s.spent)} on API-key models in this project. The total keeps counting after /clear or /compact.`;

  // One amount box. A blank box is no limit.
  function amountBox(label, value, aria) {
    const box = make('label', 'field ext-budget-field');
    box.append(make('span', 'field-label', label));
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.01';
    input.inputMode = 'decimal';
    input.placeholder = 'No limit';
    input.setAttribute('aria-label', aria);
    input.value = hasLimit(value) ? String(value) : '';
    box.append(input);
    return { box, input };
  }

  // Builds the drawer from the last answer: the spend, the two amounts and the buttons.
  function fillDrawer(root) {
    root.replaceChildren();
    spentLine = null;
    if (!state || stateFor !== projectId()) {
      shown = null;
      if (failedFor === projectId()) {
        // The read ended with no answer. Say so, and offer to read again.
        const failed = make('p', 'ext-budget-error', 'The spend limit could not be read.');
        failed.setAttribute('role', 'status');
        const again = MuseUI.button('ghost small', 'Try again');
        again.addEventListener('click', () => refresh());
        const retry = make('div', 'ext-budget-actions');
        retry.append(again);
        root.append(failed, retry);
        return;
      }
      root.append(make('p', 'ext-budget-note', 'Reading the spend limit…'));
      return;
    }
    shown = { warnUsd: state.warnUsd, capUsd: state.capUsd };
    spentLine = make('p', 'ext-budget-note', spentText(state));
    const warn = amountBox('Warn at $', state.warnUsd, 'Warning amount in dollars');
    const cap = amountBox('Cap at $', state.capUsd, 'Cap amount in dollars');
    const line = make('p', 'ext-budget-error');
    line.setAttribute('role', 'status');
    const save = MuseUI.button('primary small', 'Save');
    const clear = MuseUI.button('ghost small', 'Remove limits');
    const reset = MuseUI.button('ghost small', 'Reset spend');
    const controls = [save, clear, reset];
    save.addEventListener('click', () => saveFrom(warn.input, cap.input, line, controls));
    clear.addEventListener('click', () => saveLimits(null, null, line, controls));
    reset.addEventListener('click', () => resetFrom(line, controls));
    for (const input of [warn.input, cap.input]) {
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        save.click();
      });
    }
    const actions = make('div', 'ext-budget-actions');
    actions.append(save, clear, reset);
    root.append(spentLine, warn.box, cap.box, line, actions, make('p', 'ext-budget-note', NOTE));
  }

  function renderDrawer(body) {
    const root = make('div', 'ext-budget');
    body.append(root);
    drawerRoot = root;
    shown = null;
    fillDrawer(root);
    refresh();
  }

  // A blank box is no limit. Anything else must be a number; the server checks the range and that the warning is not above the cap.
  function amountOf(text) {
    const t = String(text ?? '').trim();
    if (t === '') return null;
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error('Type an amount in dollars, for example 5 or 0.50.');
    return n;
  }

  function saveFrom(warnInput, capInput, line, controls) {
    let warnUsd;
    let capUsd;
    try {
      warnUsd = amountOf(warnInput.value);
      capUsd = amountOf(capInput.value);
    } catch (err) {
      line.textContent = err.message;
      return;
    }
    saveLimits(warnUsd, capUsd, line, controls);
  }

  // Saves the two amounts for the active project. The server's answer repaints the chip and, when a limit changed, the drawer.
  function saveLimits(warnUsd, capUsd, line, controls) {
    const id = projectId();
    if (!id) return;
    const removed = warnUsd === null && capUsd === null;
    return send(id, '/api/budget', { project: id, warnUsd, capUsd }, line, controls, removed ? 'Spend limit removed.' : 'Spend limit saved.');
  }

  // Starts the running spend again from nothing. The limits stay. It asks first, because the total cannot be put back.
  function resetFrom(line, controls) {
    const id = projectId();
    if (!id || busy) return;
    if (!window.confirm('Reset this project’s spend to $0? The total starts counting again from now, and the limits stay.')) return;
    return send(id, '/api/budget/reset', { project: id }, line, controls, 'Spend reset.');
  }

  // One request for the project the drawer is about. The controls are off while it is on its way, and the answer is painted
  // only if that project is still the active one.
  async function send(id, path, body, line, controls, done) {
    if (busy) return;
    busy = true;
    for (const c of controls) c.disabled = true;
    line.textContent = '';
    try {
      const answer = await MuseUI.api(path, body);
      if (projectId() === id) accept(id, answer);
      MuseUI.toast(done);
    } catch (err) {
      line.textContent = err.message;
      MuseUI.toast(err.message, 'bad');
    } finally {
      busy = false;
      for (const c of controls) c.disabled = false;
    }
  }

  chip.addEventListener('click', () => MuseUI.openDrawer(TITLE, renderDrawer));

  // ---------- when to read it again ----------

  // The page redraws the top bar after each refresh and on a project switch, so the chip is read again then. A different
  // project clears the chip until its own answer arrives, so one project's spend is never shown under another's name.
  let seen = projectId();
  new MutationObserver(() => {
    const id = projectId();
    if (id !== seen) {
      seen = id;
      state = null;
      stateFor = null;
      failedFor = null;
      shown = null;
      paint();
    }
    refresh();
  }).observe(MuseUI.el.projName, { childList: true, characterData: true, subtree: true });

  place();
  paint();
  refresh();
})();
