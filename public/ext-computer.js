// Computer use, the panel: the dialog (/computer, the + menu item and MuseUI.openComputer), the list of kept runs and one run's timeline
// with its screenshots (MuseUI.openComputerRuns), and the app-wide limits in Settings › Safety. Loaded by ext.js and adds itself through
// window.MuseUI (the page script public/app.js defines it first).
//
// Start in the dialog is the consent (UI-ARCH 10.5): it saves the choices for this project (POST /api/computer/prefs) and hands the run to
// MuseUI.sendComputer, which sends it as one chat turn. Nothing here starts a run by itself. The cards, the model's notes and the "Your turn"
// box of a run are drawn by public/app.js. Every text is set with textContent, a screenshot is read with the Plenum token
// (MuseUI.computer.frameUrl) and shown as a data: image, and the styles are in ext-computer.css.
(function () {
  'use strict';

  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI || typeof MuseUI.api !== 'function' || !MuseUI.slots) return;
  const { api, span, button, icon, toast } = MuseUI;
  const CU = MuseUI.computer ?? {};

  // The limits the server checks too (lib/computer/policy.mjs); the page keeps to them so a refusal is rare.
  const STEPS = { min: 10, max: 2000, usual: 200 };
  const MINUTES = { min: 1, max: 480, usual: 30 };
  const MAX_APPS = 32;
  const EDGES = [[1280, '1280 px (default)'], [1600, '1600 px'], [2000, '2000 px'], [2576, '2576 px']];
  const UNKNOWN = [['ask', 'Ask each time'], ['refuse', 'Refuse'], ['allow', 'Any app, no asking']];
  const CONFIRMS = [
    ['send', 'Sending messages or email'], ['buy', 'Buying or paying'], ['delete', 'Deleting or discarding'],
    ['submit', 'Submitting forms'], ['terms', 'Agreeing to terms'], ['signin', 'Signing in'],
  ];
  const PAUSE = { min: 5, max: 480, usual: 60 };
  const PACE = { min: 100, max: 2000, usual: 300 };
  const LOG_DAYS = { min: 1, max: 90, usual: 7 };
  const LOG_MB = { min: 50, max: 5000, usual: 200 };
  const BUSY = 'A reply is running in this project. Wait for it to end, or press Esc to stop it.';
  const NO_PROJECT = 'Add a project folder first.';
  // Approve all answers this run's computer cards (amendment 5 of approve-all): the dialog says so, and offers the switch to ask again.
  const APPROVE_LINE = "Approve all is on: this run's cards will be answered for you.";

  // ---------- small builders (text only through textContent) ----------

  const el = (tag, cls = '', text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const para = (text, cls = '') => el('p', cls, text);
  const quietNote = (text, cls = 'note-quiet') => el('p', cls, text);
  const clip = (text, n) => {
    const s = String(text ?? '');
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  };
  const sizeText = n => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
  const mmss = ms => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
  const clampInt = (value, { min, max, usual }) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : usual;
  };

  // A field: a label, its control and a note under it (the relay form's look).
  function field(label, control, note = '') {
    const row = el('div', 'field');
    row.append(span('field-label', label), control);
    if (note) row.append(span('field-note', note));
    return row;
  }

  // A switch with its words: the label, and a small line under it when there is one.
  function switchRow(label, desc, checked, onChange) {
    const row = el('label', 'switch-row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    input.addEventListener('change', () => onChange(input.checked));
    const track = span('switch-track', '');
    track.setAttribute('aria-hidden', 'true');
    const text = el('span', 'switch-text');
    text.append(label);
    if (desc) text.append(el('small', '', desc));
    row.append(input, track, text);
    return row;
  }

  // ---------- the drawers: one open at a time; a draw still in flight for an earlier open does not paint into a later one ----------

  let openSeq = 0;
  function openPanel(title, render) {
    const mine = ++openSeq;
    const live = () => mine === openSeq;
    MuseUI.openDrawer(title, body => render(body, live));
  }

  // ---------- the + menu item (UI-ARCH 2) ----------

  // Offered only where computer use can run: the probe is read once, at load. /computer still opens the dialog, which explains.
  function openComputer(task = '') {
    if (!MuseUI.state.activeProject) {
      MuseUI.openAddForm?.();
      return toast(NO_PROJECT, 'bad');
    }
    // The task is the text after /computer when there is one, else the message being typed (a line that is a command is not a task).
    const draft = String(MuseUI.el?.input?.value ?? '').trim();
    const first = typeof task === 'string' && task.trim() ? task.trim() : draft.startsWith('/') ? '' : draft;
    return openPanel('Computer use', (body, live) => renderComputer(body, first, live));
  }

  // The composer's Computer button (UI-ARCH 2, until the + menu reads the plusMenu slot): a small button before the Mode menu, icon
  // and words, the words hidden on a narrow window. Built from DOM calls only (no markup from strings, no inline style).
  function addComposerButton() {
    const modeWrap = document.getElementById('modeWrap');
    if (!modeWrap || !modeWrap.parentNode || document.querySelector('.computer-seg')) return;
    const seg = document.createElement('div');
    seg.className = 'seg computer-seg';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn computer-btn';
    btn.title = 'Let the model use your mouse and keyboard for one task (/computer)';
    btn.setAttribute('aria-label', 'Computer use');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'ic');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-monitor');
    icon.append(use);
    const words = document.createElement('span');
    words.className = 'computer-words';
    words.textContent = 'Computer…';
    btn.append(icon, words);
    btn.addEventListener('click', () => openComputer());
    seg.append(btn);
    modeWrap.parentNode.insertBefore(seg, modeWrap);
  }

  api('/api/computer/probe')
    .then(probe => {
      if (probe && probe.available === true) {
        MuseUI.slots.add('plusMenu', 'computer', { label: 'Use the computer…', icon: 'monitor', run: () => openComputer() }, 30);
        addComposerButton();
      }
    })
    .catch(() => {});

  // ---------- the dialog ----------

  async function renderComputer(body, firstTask, live) {
    body.append(quietNote('Checking this computer…'));
    const projectId = MuseUI.state.activeProject;
    let probe;
    let wins;
    let prefs;
    try {
      [probe, wins, prefs] = await Promise.all([
        api('/api/computer/probe'),
        api('/api/computer/windows').catch(() => ({ windows: [] })),
        api(`/api/computer/prefs?project=${encodeURIComponent(projectId)}`).then(r => r.prefs).catch(() => null),
      ]);
    } catch (err) {
      if (!live()) return;
      const again = button('ghost small', 'Try again');
      again.addEventListener('click', () => MuseUI.refreshDrawer());
      body.replaceChildren(para(err.message), again);
      return;
    }
    if (!live()) return;
    body.replaceChildren();
    const project = MuseUI.state.projects?.find(p => p.id === projectId);
    // Approve all answers this run's computer cards when it is on for the project and covers them (the project's switch, else the app's).
    const approveAllOn = project?.approvals === 'all' && project?.approveAllCovers?.computer !== false;
    const hotkey = probe.hotkey?.label ?? 'Ctrl+Alt+Esc';
    const pastRuns = () => {
      const past = button('ghost small', 'Past runs');
      past.addEventListener('click', () => openComputerRuns());
      return past;
    };
    // The first thing that stops the dialog: the desktop app, Plan mode, the system's permissions, a model that can run.
    if (!probe.available) {
      body.append(para('Computer use needs the desktop app.'), pastRuns());
      return;
    }
    if (project?.chatMode === 'plan') {
      body.append(para(`Plan mode is on for ${project.name}, so Plenum will not control the computer here. Turn Plan off first.`), pastRuns());
      return;
    }
    if (!probe.supported) {
      body.append(para([probe.reason, probe.help].filter(Boolean).join(' ') || 'Computer use is not available on this computer.'));
      if (probe.platform === 'darwin') {
        const ask = button('primary small', 'Request permissions');
        ask.addEventListener('click', async () => {
          ask.disabled = true;
          try {
            await api('/api/computer/request-permissions', {});
            toast('Asked. Grant them in System Settings, then restart Plenum.');
          } catch (err) {
            toast(err.message, 'bad');
          }
          ask.disabled = false;
        });
        body.append(ask, quietNote('Restart Plenum after granting them.'));
      }
      return;
    }
    const ready = (probe.models ?? []).filter(m => m.ready);
    if (!ready.length) {
      body.append(para('No model here can use the computer yet. Every model is listed where you choose the model, with its reason when it cannot. The Claude models need an Anthropic API key in Accounts, the OpenAI and Google AI models need their key, and an API model can use the computer when its tools are allowed and it has a key.'), pastRuns());
      return;
    }

    // ---- what the person chose; the remembered choices are the defaults ----
    let all = wins.windows ?? [];
    let usable = all.filter(w => !w.denied);
    let barred = all.filter(w => w.denied);
    const displays = probe.displays ?? [];
    const exeOf = w => String(w.exe ?? '').toLowerCase();
    const d = {
      task: firstTask || '',
      choice: '',
      apps: new Set(),
      model: '',
      steps: prefs?.steps !== undefined ? prefs.steps : STEPS.usual,
      minutes: clampInt(prefs?.minutes ?? MINUTES.usual, MINUTES),
      confirmEvery: prefs?.confirmEvery === true,
      unknownApps: prefs?.unknownApps ?? 'ask',
      maxEdge: prefs?.maxEdge ?? 1280,
      numberGuard: prefs?.numberGuard !== false,
      confirm: Object.fromEntries(CONFIRMS.map(([id]) => [id, prefs?.confirm?.[id] !== false])),
      // Ask me anyway this run: it is for this run only, so the remembered choices never set it.
      askAnyway: false,
    };
    if (d.steps !== null) d.steps = clampInt(d.steps, STEPS);
    const remembered = new Set((prefs?.allowExes ?? []).map(e => String(e).toLowerCase()));
    if (prefs?.scope === 'display' && displays.length) {
      d.choice = `d:${displays[0].id}`;
      for (const w of usable) if (remembered.has(exeOf(w))) d.apps.add(exeOf(w));
    } else if (prefs?.targetExe) {
      const hit = usable.find(w => exeOf(w) === String(prefs.targetExe).toLowerCase());
      if (hit) d.choice = `w:${hit.id}`;
    }
    const current = project?.model ?? MuseUI.state.model;
    d.model = ready.find(m => m.ref === current)?.ref ?? ready.find(m => m.ref === prefs?.model)?.ref
      ?? ready.find(m => m.ref === 'anthropic:claude-opus-5-5')?.ref ?? ready[0].ref;

    const form = el('div', 'relay-form cu-form');

    // 1. The task.
    const taskBox = el('textarea', 'cu-task');
    taskBox.rows = 3;
    taskBox.maxLength = 2000;
    taskBox.value = d.task;
    taskBox.placeholder = 'What should the model do?';
    taskBox.setAttribute('aria-label', 'The task');
    taskBox.addEventListener('input', () => { d.task = taskBox.value; paint(); });
    form.append(field('Task', taskBox, 'Say it as you would to a person. The model asks before it sends, buys, deletes or signs in.'));

    // 2. What the model sees: a window or a whole display.
    const pick = el('select', 'cu-pick');
    pick.setAttribute('aria-label', 'What the model sees');
    const pickRow = el('div', 'hop-row');
    const refreshWins = button('ghost small', 'Refresh');
    pickRow.append(pick, refreshWins);
    const seeNote = span('field-note', '');
    const seeWarn = span('field-note cu-warn', '');
    const barredNote = span('field-note', '1Password and other password managers are never offered.');
    const seeField = field('What the model sees', pickRow);
    seeField.append(seeNote, seeWarn, barredNote);
    const otherNote = span('field-note', 'Other apps: ask each time. If an action lands in another app, a card asks you first.');
    seeField.append(otherNote);
    form.append(seeField);

    // The picker's options: the open windows (never-allowed programs are left out), then the displays.
    function buildPick() {
      const keep = d.choice;
      pick.replaceChildren();
      const placeholder = new Option('Choose a window or a display', '', true, true);
      placeholder.disabled = true;
      pick.append(placeholder);
      if (usable.length) {
        const group = el('optgroup');
        group.label = 'Windows';
        for (const w of usable) {
          const option = new Option(`${w.app} — ${clip(w.title || '(no title)', 70)}`, `w:${w.id}`);
          option.title = w.title || '';
          group.append(option);
        }
        pick.append(group);
      }
      if (displays.length) {
        const group = el('optgroup');
        group.label = 'Whole display';
        displays.forEach((disp, i) => group.append(new Option(`${disp.label || `Display ${i + 1}`} (every window on it)`, `d:${disp.id}`)));
        pick.append(group);
      }
      const still = [...pick.options].some(o => o.value === keep && !o.disabled);
      d.choice = still ? keep : '';
      pick.value = d.choice;
      barredNote.hidden = barred.length === 0;
    }
    buildPick();
    pick.addEventListener('change', () => { d.choice = pick.value; paintApps(); paint(); });
    // Refresh re-reads the windows and keeps what was typed and chosen.
    refreshWins.addEventListener('click', async () => {
      try {
        const fresh = await api('/api/computer/windows');
        if (!live()) return;
        all = fresh.windows ?? [];
        usable = all.filter(w => !w.denied);
        barred = all.filter(w => w.denied);
        buildPick();
        paintApps();
        paint();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });

    // 3. For a display: the apps the model may use.
    const appsBox = el('div', 'field cu-apps');
    form.append(appsBox);
    function paintApps() {
      appsBox.replaceChildren();
      const display = d.choice.startsWith('d:');
      appsBox.hidden = !display;
      if (!display) return;
      appsBox.append(span('field-label', 'Apps the model may use'));
      const byExe = new Map();
      for (const w of usable) {
        const key = exeOf(w);
        if (!byExe.has(key)) byExe.set(key, { first: w, count: 0 });
        byExe.get(key).count += 1;
      }
      const rank = key => (d.apps.has(key) ? 2 : 0) + (remembered.has(key) ? 1 : 0);
      const rows = [...byExe.entries()].sort((a, b) => rank(b[0]) - rank(a[0]));
      for (const [key, { first, count }] of rows) {
        const row = switchRow(first.app, `${clip(first.title || '(no title)', 60)}${count > 1 ? ` · ${count} windows` : ''}`, d.apps.has(key), on => {
          if (on && d.apps.size >= MAX_APPS) {
            toast(`Pick at most ${MAX_APPS} apps.`, 'bad');
            return paintApps();
          }
          if (on) d.apps.add(key); else d.apps.delete(key);
          paint();
        });
        if (first.flag) row.lastElementChild.append(' ', span('pill warn', first.flag === 'browser' ? 'browser' : 'runs commands'));
        appsBox.append(row);
      }
      for (const w of barred) {
        const row = el('div', 'note-quiet cu-barred');
        row.append(`${w.app} `, span('pill', 'never allowed'));
        appsBox.append(row);
      }
      if (!rows.length) appsBox.append(span('field-note', 'No windows are open. Open the apps the task needs, then press Refresh.'));
    }

    // 4. The model: every model is listed; one that cannot use the computer is shown disabled with the reason.
    const modelSel = el('select', 'cu-model');
    modelSel.setAttribute('aria-label', 'Model');
    for (const m of probe.models ?? []) {
      const option = new Option(`${m.name}${m.note ? ` (${m.note})` : ''}`, m.ref);
      option.disabled = !m.ready;
      modelSel.append(option);
    }
    modelSel.value = d.model;
    modelSel.addEventListener('change', () => { d.model = modelSel.value; paint(); });
    form.append(field('Model', modelSel, 'Models that cannot use the computer are shown disabled, with the reason. Each request goes to the model\'s provider with a screenshot.'));

    // 5. Limits and checks: closed, with its values in the summary.
    const more = el('details', 'cu-more');
    const moreSum = el('summary');
    more.append(moreSum);
    const moreBody = el('div', 'relay-form cu-more-body');
    more.append(moreBody);
    const steps = document.createElement('input');
    steps.type = 'number';
    steps.min = String(STEPS.min);
    steps.max = String(STEPS.max);
    steps.step = '1';
    steps.value = String(d.steps ?? STEPS.usual);
    steps.disabled = d.steps === null;
    steps.setAttribute('aria-label', 'Up to this many actions');
    steps.addEventListener('change', () => { d.steps = clampInt(steps.value, STEPS); steps.value = String(d.steps); paint(); });
    const noLimit = switchRow('No limit on actions', 'The bar then shows the step number only. Stop and the stop key still end the run.', d.steps === null, on => {
      d.steps = on ? null : clampInt(steps.value, STEPS);
      steps.disabled = on;
      if (!on) steps.value = String(d.steps);
      paint();
    });
    moreBody.append(field('Up to this many actions', steps, `${STEPS.min} to ${STEPS.max.toLocaleString('en-US')}. A click, a key press, a typing step and a scroll are one action each.`), noLimit);
    const minutes = document.createElement('input');
    minutes.type = 'number';
    minutes.min = String(MINUTES.min);
    minutes.max = String(MINUTES.max);
    minutes.step = '1';
    minutes.value = String(d.minutes);
    minutes.setAttribute('aria-label', 'Minutes of activity');
    minutes.addEventListener('change', () => { d.minutes = clampInt(minutes.value, MINUTES); minutes.value = String(d.minutes); paint(); });
    moreBody.append(field('Up to this many minutes of activity', minutes, 'Paused time does not count.'));
    moreBody.append(switchRow('Ask before every action', 'A card before each click, key and typing step. Slow; useful for a first try.', d.confirmEvery, on => { d.confirmEvery = on; paint(); }));
    // The other-apps choice is for a whole display only (a window run asks, as the note above says).
    const unknown = el('div', 'seg');
    unknown.setAttribute('role', 'group');
    unknown.setAttribute('aria-label', 'Other apps');
    const unknownField = field('Other apps', unknown, 'What happens when an action lands in an app that is not in the list.');
    moreBody.append(unknownField);
    const paintUnknown = () => {
      unknown.replaceChildren(...UNKNOWN.map(([value, label]) => {
        const b = button('seg-btn', label);
        b.setAttribute('aria-pressed', String(d.unknownApps === value));
        b.addEventListener('click', () => {
          d.unknownApps = value;
          paintUnknown();
          paint();
          if (value === 'allow') MuseUI.notice?.('computer-any-app', { after: unknownField });
        });
        return b;
      }));
    };
    const edge = document.createElement('select');
    edge.setAttribute('aria-label', 'Screenshot size');
    edge.append(...EDGES.map(([value, label]) => new Option(label, String(value))));
    edge.value = String(d.maxEdge);
    edge.addEventListener('change', () => { d.maxEdge = Number(edge.value); });
    moreBody.append(field('Screenshot size', edge, 'The long edge of each screenshot. Larger is sharper and costs more.'));
    moreBody.append(span('field-label', 'Ask first before the model'));
    for (const [id, label] of CONFIRMS) moreBody.append(switchRow(label, '', d.confirm[id], on => { d.confirm[id] = on; paint(); }));
    moreBody.append(switchRow('Block card, bank and id numbers', 'Off: the model may type numbers it reads in your chat or on the screen. Use that for test cards in your own app, not real ones.', d.numberGuard, on => { d.numberGuard = on; paint(); }));
    form.append(more);

    // 5b. Approve all answers this run's computer cards: the line says so, and the switch asks again for this run. Drawn only while Approve
    // all is on and covers computer cards (the switch is not kept in the remembered choices, see remember below).
    const approveBox = el('div', 'field cu-approve');
    approveBox.hidden = !approveAllOn;
    approveBox.append(para(APPROVE_LINE, 'field-note'), switchRow('Ask me anyway this run', 'Off: the cards are answered for you. On: this run asks you as it does without Approve all.', d.askAnyway, on => { d.askAnyway = on; paint(); }));
    form.append(approveBox);

    // 6. The note box: what never happens, what always asks, how to stop.
    const rules = el('p', 'field-note cu-rules');
    form.append(rules);

    // 7. The actions. The strip about the risk sits above Start: pressing Start is the consent.
    const start = button('primary', 'Start');
    const cancel = button('ghost', 'Cancel');
    const past = button('ghost small', 'Past runs');
    const missing = span('field-note', '');
    const actions = el('div', 'actions');
    actions.append(start, cancel, past);
    // Start is the consent: the model sees what was chosen as soon as it is pressed (lib/computer/run.mjs skips the start card here).
    form.append(actions, missing, quietNote(`The run starts when you press Start: the model sees what you chose at once. Press Stop or ${hotkey} to end it. Password managers, Plenum itself and system prompts stay off limits.`, 'field-note'));
    cancel.addEventListener('click', () => MuseUI.closeDrawer());
    past.addEventListener('click', () => openComputerRuns());
    body.append(form);
    MuseUI.notice?.('computer-use', { before: actions });

    // ---- keeping the page in step with the choices ----
    const stepsText = () => (d.steps === null ? 'no action limit' : `${d.steps} actions`);
    const asked = () => CONFIRMS.filter(([id]) => d.confirm[id]).map(([, label]) => label.toLowerCase());
    const targetWindow = () => (d.choice.startsWith('w:') ? usable.find(w => `w:${w.id}` === d.choice) ?? null : null);
    const chosenApps = () => [...d.apps].map(e => usable.find(x => exeOf(x) === e)).filter(Boolean);
    function paint() {
      const win = targetWindow();
      const display = d.choice.startsWith('d:');
      unknownField.hidden = !display;
      otherNote.hidden = !win;
      seeNote.textContent = win
        ? `The model sees this window with the menus and dialogs it opens, and can act only in ${win.app}.`
        : display ? 'The model sees every window on this display. Pick the apps it may use below.' : 'Pick the one window the model works in, or a whole display.';
      const warn = [];
      if (win?.flag === 'browser' || chosenApps().some(w => w.flag === 'browser')) {
        warn.push('A browser gives the model every site you are signed in to. The in-app browser is safer for web tasks.');
      }
      if (win?.flag === 'terminal') warn.push(`In ${win.app} the model can run commands, and Plenum's command rules do not apply there.`);
      for (const w of chosenApps()) {
        if (w.flag === 'terminal') warn.push(`In ${w.app} the model can run commands, and Plenum's command rules do not apply there.`);
      }
      seeWarn.textContent = [...new Set(warn)].join(' ');
      const otherWords = !display ? 'ask before other apps' : d.unknownApps === 'allow' ? 'any app, no asking' : d.unknownApps === 'refuse' ? 'other apps refused' : 'ask before other apps';
      moreSum.textContent = `Limits and checks: ${stepsText()} · ${d.minutes} minutes · ${otherWords}${d.confirmEvery ? ' · ask before every action' : ''}`;
      const asks = asked();
      // While Approve all covers this run's cards, the list says they are answered; the switch puts them back to asking.
      const answered = approveAllOn && !d.askAnyway;
      const askWords = `${asks.join(', ')}${display && d.unknownApps === 'ask' ? ', and any app not in the list' : ''}`;
      rules.textContent = `Never: typing passwords, codes${d.numberGuard ? ', card or bank details' : ''} (the model asks you to do those steps). ${asks.length ? `${answered ? 'Approve all answers these for this run' : 'Always asks first'}: ${askWords}. ` : ''}Auto-approve does not answer these cards; Approve all answers them only where Settings allow it. Moving the mouse pauses the run; press Resume to go on. Stop any time with Stop on the bar, or ${hotkey}.`;
      if (d.steps === null || d.steps > STEPS.usual || d.minutes > MINUTES.usual) MuseUI.notice?.('computer-limits', { after: more });
      const reason = !d.task.trim() ? 'Type what the model should do.'
        : !d.choice ? 'Choose a window or a display.'
          : display && !d.apps.size && d.unknownApps !== 'allow' ? 'Pick at least one app the model may use, or choose Any app.'
            : '';
      start.disabled = reason !== '';
      // A reply that runs is not a reason to grey Start: pressing it says so with a toast and keeps the dialog open.
      missing.textContent = reason || (MuseUI.computer?.busy?.() ? BUSY : '');
    }
    paintUnknown();
    paintApps();
    paint();

    start.addEventListener('click', async () => {
      if (CU.busy?.()) return toast(BUSY, 'bad');
      const win = targetWindow();
      const display = d.choice.startsWith('d:');
      const ids = [];
      if (display) {
        for (const exe of d.apps) {
          const w = usable.find(x => exeOf(x) === exe);
          if (w) ids.push(w.id);
        }
      }
      const names = display ? chosenApps().map(w => w.app) : [win?.app].filter(Boolean);
      const settings = {
        scope: display ? 'display' : 'window',
        target: d.choice.slice(2),
        ...(display ? { allow: ids } : {}),
        steps: d.steps,
        minutes: d.minutes,
        confirmEvery: d.confirmEvery,
        unknownApps: display ? d.unknownApps : 'ask',
        maxEdge: d.maxEdge,
        confirm: { ...d.confirm },
        numberGuard: d.numberGuard,
        // Read by lib/computer/policy.mjs: true answers this run's cards by hand, even while Approve all covers them (this run only).
        askAnyway: approveAllOn && d.askAnyway,
        appNames: names,
      };
      const remember = {
        scope: settings.scope,
        ...(win ? { targetExe: win.exe } : {}),
        allowExes: display ? [...d.apps] : prefs?.allowExes ?? [],
        steps: d.steps,
        minutes: d.minutes,
        confirmEvery: d.confirmEvery,
        unknownApps: d.unknownApps,
        maxEdge: d.maxEdge,
        confirm: { ...d.confirm },
        numberGuard: d.numberGuard,
        model: d.model,
      };
      start.disabled = true;
      // The remembered choices are a convenience; a project that cannot keep them still runs.
      await api('/api/computer/prefs', { project: projectId, prefs: remember }).catch(() => {});
      MuseUI.closeDrawer();
      await MuseUI.sendComputer(d.task.trim(), d.model, settings);
    });
  }

  // ---------- the kept runs ----------

  const STOP_WORDS = {
    done: 'finished', user: 'stopped by you', hotkey: 'stopped with the stop key', idle: 'left paused', limit: 'limit reached',
    budget: 'spend cap reached', cancelled: 'stopped', error: 'failed', declined: 'not started', interrupted: 'interrupted',
  };
  const wordOf = reason => (CU.stopWord ? CU.stopWord(reason) : STOP_WORDS[String(reason ?? '').split(':')[0].trim()] ?? 'stopped');

  // Opens the list of kept runs, or one run's timeline when id is given (the chat's Review button passes it).
  function openComputerRuns(id) {
    const runId = typeof id === 'string' && id ? id : null;
    return openPanel('Computer runs', (body, live) => (runId ? renderRun(body, runId, live) : renderRunList(body, live)));
  }

  function retentionText() {
    const cs = MuseUI.state.computerSettings ?? {};
    const days = Number.isFinite(cs.logDays) ? cs.logDays : LOG_DAYS.usual;
    const mb = Number.isFinite(cs.logMB) ? cs.logMB : LOG_MB.usual;
    return `kept on this computer for ${days} ${days === 1 ? 'day' : 'days'} or until they pass ${mb.toLocaleString('en-US')} MB in all`;
  }

  async function renderRunList(body, live) {
    body.append(quietNote('Loading…'));
    let runs;
    try {
      runs = (await api('/api/computer/runs')).runs ?? [];
    } catch (err) {
      if (!live()) return;
      body.replaceChildren(para(err.message));
      return;
    }
    if (!live()) return;
    body.replaceChildren(para(`Screenshots, actions and card answers from computer runs, ${retentionText()}. Nothing here is sent anywhere.`));
    if (!runs.length) {
      body.append(quietNote('No computer runs yet. Start one with /computer.'));
      return;
    }
    const list = el('div', 'log-list cu-runs');
    for (const r of runs) {
      const row = el('button', 'log-row cu-run-row');
      row.type = 'button';
      const when = r.startedAt ? new Date(r.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
      row.append(span('log-time', when), span('log-hop', MuseUI.modelName?.(r.model) || r.model || ''));
      row.append(span('log-chars', `${(r.apps ?? []).join(', ') || 'no app'} · ${r.actions ?? 0} actions · ${sizeText(r.bytes ?? 0)}`));
      row.append(span('pill', r.live ? 'running' : wordOf(r.stopReason)));
      row.addEventListener('click', () => openComputerRuns(r.id));
      list.append(row);
    }
    body.append(list);
    const all = button('ghost small cu-danger', 'Delete all runs');
    all.addEventListener('click', async () => {
      const ok = await MuseUI.confirm({ title: 'Delete all computer runs?', body: 'Delete every computer run’s screenshots and action lists? This cannot be undone.', action: 'Delete all', tone: 'danger', focusCancel: true });
      if (!ok) return;
      try {
        await api('/api/computer/runs/delete-all', {});
        openComputerRuns();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
    body.append(all);
  }

  // The timeline of one run: its facts, its task, then each screenshot with the actions taken on it and the cards and pauses between.
  async function renderRun(body, id, live) {
    body.append(quietNote('Loading…'));
    const back = () => {
      const b = button('ghost small', 'All runs');
      b.addEventListener('click', () => openComputerRuns());
      return b;
    };
    let run;
    try {
      run = await api(`/api/computer/run?id=${encodeURIComponent(id)}`);
    } catch (err) {
      if (!live()) return;
      body.replaceChildren(back(), para(err.message));
      return;
    }
    if (!live()) return;
    body.replaceChildren(back());
    const frames = Number.isInteger(run.frames) ? run.frames : 0;
    const sizes = Array.isArray(run.frameSizes) ? run.frameSizes : [];
    const acts = Array.isArray(run.actions) ? run.actions : [];
    const evs = Array.isArray(run.events) ? run.events : [];
    const scope = run.settings?.scope === 'display' ? 'a whole display' : 'one window';
    const apps = (run.settings?.allow ?? []).map(a => a.app).filter(Boolean).join(', ') || 'no app';
    const stopped = wordOf(run.result?.stopReason ?? null);
    const facts = [
      run.startedAt ? new Date(run.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '',
      MuseUI.modelName?.(run.model) || run.model || '',
      apps,
      scope,
      `${run.result?.actions ?? acts.filter(a => a.ok).length} actions`,
      `${frames} ${frames === 1 ? 'screenshot' : 'screenshots'}`,
      run.live ? 'still going' : stopped,
      sizeText(run.bytes ?? 0),
    ].filter(Boolean).join(' · ');
    body.append(el('p', 'cu-facts', facts));
    const taskText = String(run.task ?? '');
    const task = el('p', 'cu-task-text', taskText);
    body.append(task);
    if (taskText.length > 320) {
      const more = button('ghost small', 'Show all');
      more.addEventListener('click', () => {
        const open = task.classList.toggle('open');
        more.textContent = open ? 'Show less' : 'Show all';
      });
      body.append(more);
    }

    // Each screenshot (in order) is followed by the actions taken on it; the cards and pauses are placed by their time.
    const shotNumbers = Array.from({ length: frames }, (_, i) => i + 1);
    const items = [...acts.map(a => ({ kind: 'action', at: Number(a.at) || 0, a })), ...evs.map(e => ({ kind: 'event', at: Number(e.at) || 0, e }))]
      .sort((x, y) => x.at - y.at);
    const timeline = el('div', 'cu-timeline');
    const shots = [];
    let nextShot = 0;
    const figureFor = n => {
      const fig = el('figure', 'cu-fig');
      const wrap = span('cu-shot', '');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = `Screenshot ${n}`;
      img.className = 'cu-shot-img';
      const size = sizes[n - 1] ?? null;
      MuseUI.computer.frameUrl(run.id, n).then(url => { img.src = url; }, () => {
        img.replaceWith(quietNote('This screenshot is not kept.'));
      });
      wrap.append(img);
      for (const a of acts) {
        if (a.frame !== n || !a.point || !size || !(size.width > 0) || !(size.height > 0)) continue;
        const ring = span('cu-ring', '');
        ring.setAttribute('aria-hidden', 'true');
        ring.style.left = `${Math.min(100, Math.max(0, (a.point.x / size.width) * 100))}%`;
        ring.style.top = `${Math.min(100, Math.max(0, (a.point.y / size.height) * 100))}%`;
        wrap.append(ring);
      }
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'button');
      wrap.setAttribute('aria-label', `Open screenshot ${n}`);
      const shotIndex = shots.length;
      shots.push(n);
      const open = () => openViewer(run, shots, shotIndex, frames);
      wrap.addEventListener('click', open);
      wrap.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        open();
      });
      fig.append(wrap, el('figcaption', 'cu-cap', `Screenshot ${n}`));
      return fig;
    };
    const emitShotsUpTo = n => {
      while (nextShot < Math.min(n, frames)) {
        nextShot += 1;
        timeline.append(figureFor(nextShot));
      }
    };
    for (const it of items) {
      if (it.kind === 'action') {
        if (Number.isInteger(it.a.frame) && it.a.frame > nextShot) emitShotsUpTo(it.a.frame);
        const line = el('div', `cu-act${it.a.ok ? '' : ' bad'}`);
        const head = `#${it.a.n} ${it.a.summary || it.a.action || ''}${it.a.app ? ` · ${it.a.app}` : ''}`;
        if (it.a.ok) {
          line.append(icon('check'), span('cu-act-text', head));
        } else {
          line.append(span('cu-act-text', `${head} · refused: ${it.a.reason || 'not allowed'}`));
        }
        timeline.append(line);
      } else {
        const line = el('div', 'cu-event note-quiet', eventWords(it.e));
        timeline.append(line);
      }
    }
    emitShotsUpTo(frames);
    if (!shotNumbers.length && !items.length) timeline.append(quietNote('Nothing was recorded for this run.'));
    body.append(timeline);
    body.append(el('p', 'cu-ended note-quiet', run.live ? 'This run is still going.' : `Ended: ${stopped}.`));

    const del = button('ghost small cu-danger', 'Delete this run');
    del.disabled = run.live === true;
    if (run.live) body.append(quietNote('This run is still going, so it cannot be deleted. Stop it first.'));
    del.addEventListener('click', async () => {
      const ok = await MuseUI.confirm({ title: 'Delete this run?', body: 'Delete this run’s screenshots and action list? This cannot be undone.', action: 'Delete', tone: 'danger', focusCancel: true });
      if (!ok) return;
      try {
        await api('/api/computer/runs/delete', { id: run.id });
        openComputerRuns();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
    body.append(del);
  }

  // The words for a logged event: the person's answers, pauses, resumes and the model's own words, each in its own line.
  function eventWords(e) {
    const text = String(e.text ?? '');
    if (e.kind === 'card') {
      if (e.answer === 'approved') return `${e.by === 'Approve all' ? 'Approve all answered' : 'You approved'}: ${text}`;
      if (e.answer === 'denied') return `${e.by === 'stop' ? 'Stopped' : 'You denied'}: ${text}`;
      return text;
    }
    return text;
  }

  // A full-window view of one screenshot: Left and Right step through the run's screenshots, Esc or a click outside closes it.
  function openViewer(run, shots, index, total) {
    const root = el('div', 'cr-viewer');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Screenshot');
    const bar = el('div', 'cr-bar');
    const caption = el('p', 'cr-caption');
    const prev = button('ghost small', 'Previous (Left)');
    const next = button('ghost small', 'Next (Right)');
    const close = button('ghost small', 'Close (Esc)');
    bar.append(prev, caption, next, close);
    const stage = el('div', 'cr-stage');
    const img = document.createElement('img');
    img.className = 'cr-viewer-img';
    stage.append(img);
    root.append(bar, stage);
    let at = index;
    const show = i => {
      at = Math.min(shots.length - 1, Math.max(0, i));
      const n = shots[at];
      caption.textContent = `Screenshot ${n} of ${total}`;
      img.alt = `Screenshot ${n}`;
      img.removeAttribute('src');
      MuseUI.computer.frameUrl(run.id, n).then(url => { img.src = url; }, () => { caption.textContent = `Screenshot ${n} is not kept`; });
      prev.disabled = at <= 0;
      next.disabled = at >= shots.length - 1;
    };
    const closeViewer = () => {
      document.removeEventListener('keydown', onKey, true);
      root.remove();
    };
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeViewer();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        show(at - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        show(at + 1);
      }
    }
    prev.addEventListener('click', () => show(at - 1));
    next.addEventListener('click', () => show(at + 1));
    close.addEventListener('click', closeViewer);
    root.addEventListener('click', e => { if (e.target === root || e.target === stage) closeViewer(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(root);
    close.focus({ preventScroll: true });
    show(index);
  }

  // ---------- Settings › Safety: the limits that are the app's, not the project's ----------

  // The pause limit, the pace and the log's keeping. Each saves on change and says "Saved" only once the server has stored it (B-28).
  function renderLimits(body) {
    body.append(para('How long a computer run may sit paused, how fast the model acts, and how long its screenshots are kept. A run’s own limits (actions and minutes) are set in the Computer use dialog for each project.'));
    const cs = MuseUI.state.computerSettings ?? {};
    const rows = [
      { key: 'driveIdleMinutes', label: 'Pause limit', unit: 'minutes', range: PAUSE, value: Number.isFinite(cs.idleMinutes) ? cs.idleMinutes : PAUSE.usual, note: 'A paused run stops after this long without a Resume. Paused time is not counted in the minutes of activity.' },
      { key: 'computerPaceMs', label: 'Pace', unit: 'milliseconds between actions', range: PACE, value: Number.isFinite(cs.paceMs) ? cs.paceMs : PACE.usual, note: 'The pause between two actions. Lower is quicker; higher gives you time to watch.' },
      { key: 'computerLogDays', label: 'Keep run screenshots for', unit: 'days', range: LOG_DAYS, value: Number.isFinite(cs.logDays) ? cs.logDays : LOG_DAYS.usual, note: 'Older runs are deleted on the next run.' },
      { key: 'computerLogMB', label: 'Keep at most', unit: 'MB of run screenshots', range: LOG_MB, value: Number.isFinite(cs.logMB) ? cs.logMB : LOG_MB.usual, note: 'The oldest runs go first when the total is over this.' },
    ];
    for (const r of rows) {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(r.range.min);
      input.max = String(r.range.max);
      input.step = '1';
      input.value = String(r.value);
      input.setAttribute('aria-label', `${r.label} (${r.unit})`);
      const status = span('hint', '');
      status.setAttribute('role', 'status');
      input.addEventListener('change', async () => {
        const v = Math.floor(Number(input.value));
        if (!Number.isFinite(v) || v < r.range.min || v > r.range.max) {
          status.textContent = `Use a whole number from ${r.range.min} to ${r.range.max.toLocaleString('en-US')}.`;
          input.value = String(r.value);
          return;
        }
        status.textContent = 'Saving…';
        try {
          await api('/api/settings', { [r.key]: v });
          r.value = v;
          status.textContent = 'Saved';
        } catch (err) {
          status.textContent = err.message;
          input.value = String(r.value);
        }
      });
      body.append(field(r.label, input, `${r.unit[0].toUpperCase()}${r.unit.slice(1)}. ${r.note}`), status);
    }
  }

  if (typeof MuseUI.settings?.register === 'function') {
    MuseUI.settings.register({ id: 'computer-use', scope: 'app', title: 'Computer use', order: 60, group: 'safety', render: body => renderLimits(body) });
  }

  // ---------- the panel's entry points for the page ----------

  MuseUI.openComputer = openComputer;
  MuseUI.openComputerRuns = openComputerRuns;
})();
