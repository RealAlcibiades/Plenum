// ext-projects. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// The project settings drawer: a gear beside the project name opens it. The drawer holds the
// project's own defaults (model, effort, approvals, relay), its own blocked-command patterns and the tool options
// from ext-tools.js.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TITLE = 'Project settings';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The model menu's groups, in the order the composer's menu uses.
  const GROUP_NAMES = { muse: 'Muse Code', anthropic: 'Claude', codex: 'Codex', gemini: 'Gemini', xai: 'Grok', openai: 'OpenAI', deepseek: 'DeepSeek', mistral: 'Mistral', googleai: 'Google AI', openrouter: 'OpenRouter', echo: 'Test' };
  const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  const APPROVAL_LABELS = { ask: 'Ask first', auto: 'Auto-approve', all: 'Approve all' };
  // The coder setting (lib/projects.mjs codersCannotAsk): 'run' starts a Codex or Gemini coder that cannot ask, 'refuse' does not.
  const CODER_CHOICES = [['run', 'Run anyway'], ['refuse', 'Refuse']];
  // The Approve all coverage switches (approveAllCovers): null follows the app's value.
  const COVER_CHOICES = [['', 'Follow the app default'], ['on', 'Yes'], ['off', 'No']];
  // The app's relay defaults. A relay that is not saved yet reads the same way the app reads it.
  const RELAY_DEFAULTS = { autoRoute: false, countdownSec: 3, hops: null, stopOnError: true, dedupe: false };
  const HOP_CHOICES = [['none', 'No limit'], ['2', '2'], ['4', '4'], ['8', '8'], ['custom', 'Custom']];
  // The limits on a project's own blocked-command patterns. They are the same as in lib/denylist.mjs, which checks them again.
  const DENY_MAX = 50;
  const DENY_MAX_CHARS = 120;
  // The server counts characters (code points), so an emoji is one; the box counts UTF-16 units, so it must hold twice as many or it cuts a
  // pattern of astral characters in the middle of a pair. The count against DENY_MAX_CHARS is made on characters (charCount).
  const DENY_MAX_UNITS = DENY_MAX_CHARS * 2;
  const charCount = text => Array.from(String(text)).length;
  // A control character, a line break or an invisible character, which the server refuses in a pattern.
  const hiddenChar = text => [...text].some(ch => {
    const c = ch.codePointAt(0);
    return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xad || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) || c === 0xfeff;
  });

  // view is what the server last returned for the open project: { projectId, settings, effective, global }.
  let view = null;
  // A load that finishes after the drawer has moved on is dropped, so it cannot paint over newer content.
  let loadSeq = 0;
  // Saves run one at a time, and each one starts from the settings the last save returned.
  // Two quick changes therefore never overwrite each other.
  let queue = Promise.resolve();
  // How many saves are queued or running. Controls repaint only when the last one has finished.
  let pending = 0;
  // One repaint function per control. A saved change shows by repainting, so focus and open menus survive.
  let painters = [];

  // ---------- the gear in the top bar ----------

  // A gear outline drawn as one path. The sprite in index.html has no gear symbol, so it is made here.
  function gearPath() {
    const teeth = 8;
    const c = 12;
    const tip = 9.4;   // radius at the top of a tooth
    const root = 7.1;  // radius between the teeth
    const hole = 3;
    const step = Math.PI / teeth;
    const at = (angle, r) => `${(c + r * Math.cos(angle)).toFixed(2)} ${(c + r * Math.sin(angle)).toFixed(2)}`;
    let d = '';
    for (let i = 0; i < teeth; i++) {
      const a = i * 2 * step - Math.PI / 2;
      // Four corners per tooth: root, tip, tip, root. The stretch between two teeth stays on the root circle.
      const corners = [[a - 0.62 * step, root], [a - 0.36 * step, tip], [a + 0.36 * step, tip], [a + 0.62 * step, root]];
      corners.forEach(([angle, r], k) => { d += `${i === 0 && k === 0 ? 'M' : 'L'}${at(angle, r)}`; });
    }
    // The hole in the middle is a second, closed circle.
    return `${d}Z M${c + hole} ${c} A${hole} ${hole} 0 1 0 ${c - hole} ${c} A${hole} ${hole} 0 1 0 ${c + hole} ${c}Z`;
  }

  function gearButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'proj-gear';
    b.title = TITLE;
    b.setAttribute('aria-label', TITLE);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', gearPath());
    svg.append(path);
    b.append(svg);
    b.addEventListener('click', openProjectSettings);
    return b;
  }

  // The gear sits right after the project name. renderTop only changes the name's text, so the gear stays put.
  if (!document.querySelector('.proj-gear')) MuseUI.el.projName.after(gearButton());

  // MuseUI.settings.open('project') opens this drawer through here (app.js).
  MuseUI.openProjectSettings = openProjectSettings;

  // ---------- opening and loading the drawer ----------

  function openProjectSettings() {
    // Settings are read again on every open, because the app defaults can change while the drawer is shut.
    view = null;
    MuseUI.openDrawer(TITLE, renderDrawer);
  }

  // True only while this drawer is the one on screen. A late reply checks this before it paints.
  function drawerIsOpen(body) {
    const { drawer, drawerTitle, drawerBody } = MuseUI.el;
    return !drawer.hidden && drawerBody === body && drawerTitle.textContent === TITLE;
  }

  // openDrawer clears the body before it calls this, so this only appends.
  function renderDrawer(body) {
    const pid = MuseUI.state.activeProject;
    if (!pid) {
      body.append(MuseUI.para('Add a project folder first. Each project keeps its own settings.'));
      return;
    }
    if (view && view.projectId === pid) {
      buildDrawer(body);
      return;
    }
    view = null;
    const seq = ++loadSeq;
    body.append(MuseUI.para('Loading this project’s settings…'));
    MuseUI.api(`/api/project-settings?project=${encodeURIComponent(pid)}`)
      .then(data => {
        if (seq !== loadSeq || !drawerIsOpen(body)) return;
        view = { projectId: pid, ...data };
        body.replaceChildren();
        buildDrawer(body);
      })
      .catch(err => {
        if (seq !== loadSeq || !drawerIsOpen(body)) return;
        body.replaceChildren(MuseUI.para(err.message));
      });
  }

  function buildDrawer(body) {
    painters = [];
    const name = MuseUI.state.projects?.find(p => p.id === view.projectId)?.name ?? 'this project';
    const root = document.createElement('div');
    root.className = 'ps';
    root.append(MuseUI.para(`Settings for ${name}. Each one follows the app default until you change it here. A change saves as you make it.`));
    root.append(defaultsCard(), approveAllCard(), denyCard(), toolsCard(), ...projectSectionCards());
    // The computer-use switch sits right after the Approve all card, which it belongs beside.
    root.querySelector('.ps-approve-all')?.after(computerCard());
    body.append(root);
    paintAll();
  }

  // Sections that panels register for project settings (MuseUI.settings.register with scope 'project') come after Tools, one
  // card each. A section is given the project record, its saved settings, the queued edit, save and a refresh of this drawer.
  // project and saved are read when a section asks, so they are current after a save.
  function projectSectionCards() {
    const sections = typeof MuseUI.settings?.sections === 'function' ? MuseUI.settings.sections('project') : [];
    return sections.map(section => {
      const card = cardSection(section.title);
      const ctx = {
        get project() { return view; },
        get saved() { return view?.settings ?? {}; },
        edit,
        save: saveChange,
        refresh: () => MuseUI.refreshDrawer(),
      };
      const showFailure = err => card.append(MuseUI.para(`This section could not load: ${err?.message ?? err}`));
      try {
        const out = section.render(card, ctx);
        if (out && typeof out.then === 'function') out.catch(showFailure);
      } catch (err) {
        showFailure(err);
      }
      return card;
    });
  }

  // ---------- saving ----------

  // Queues one change to the project's settings. The change is applied to the latest saved settings.
  function edit(change) {
    pending += 1;
    queue = queue
      .then(() => saveChange(change))
      .catch(err => MuseUI.toast(err.message, 'bad'))
      .finally(() => { pending -= 1; });
    return queue;
  }

  async function saveChange(change) {
    if (!view) return;
    const { projectId } = view;
    try {
      const settings = JSON.parse(JSON.stringify(view.settings));
      change(settings);
      const data = await MuseUI.api('/api/project-settings', { project: projectId, settings });
      // A reply for a project that is no longer open does not replace what the drawer shows.
      if (view && view.projectId === projectId) view = { projectId, ...data };
    } catch (err) {
      // The server says why it refused. The controls then go back to the settings in force.
      MuseUI.toast(err.message, 'bad');
    }
    // An earlier reply must not reset a control the user changed after it was sent; the last save repaints everything.
    if (pending <= 1) paintAll();
    MuseUI.refresh();
  }

  function paintAll() {
    if (!view) return;
    for (const paint of painters) paint();
  }

  // ---------- the defaults card ----------

  function defaultsCard() {
    const card = cardSection('Defaults for this project');
    card.append(modelField(), effortField(), approvalField(), relayField());
    return card;
  }

  // Approve all's own switches for this project, and the coder setting. The Approve all mode itself is set above (and from the
  // Mode menu). These switches are kept when the mode changes, and they change only this project.
  function approveAllCard() {
    const card = cardSection('Approve all and coders');
    card.classList.add('ps-approve-all');
    card.append(MuseUI.para('Approve all answers every approval card for this project. These switches change what it answers. They are saved with the project, and Approve all takes them into account only while it is on. The coder setting also applies in Ask first.'));
    card.append(approveAllBlockedField(), approveAllCoversField(), codersField());
    return card;
  }

  // The switch that lets the model start computer use itself (lib/projects.mjs computerSelfStart). Off by default. Turning it on shows
  // the computer-use notice where the switch is. The start card in the chat still asks first (Approve all answers it only where the
  // computer-use cards are covered), and nothing here lets a model type a password or reach a password manager.
  function computerCard() {
    const card = cardSection('Computer use');
    const { row, input } = switchRow(
      'The model may start computer use itself',
      'Off by default. On, the model can take the mouse and keyboard for one task whenever it decides it needs to, in the apps you picked last time in the Computer panel (/computer). A card in the chat asks you first. Stop on the bar or the stop key ends it at once.',
      on => {
        if (on) MuseUI.notice?.('computer-use', { before: row });
        edit(s => { s.computerSelfStart = on; });
      },
    );
    const box = document.createElement('div');
    box.className = 'field ps-field ps-computer';
    box.append(row);
    card.append(box);
    painters.push(() => { input.checked = view.settings.computerSelfStart === true; });
    return card;
  }

  // Whether Approve all also answers the blocked-command cards. Turning it on shows the danger notice where the switch is.
  function approveAllBlockedField() {
    const { row, input } = switchRow(
      'Approve all also answers blocked-command cards',
      'Covers the built-in rules that wipe a disk or the system, force-push, shutdown and piped installs, and this project’s own patterns. Off, those cards still wait for you, with Deny focused.',
      on => {
        if (on) MuseUI.notice?.('approve-all-blocked', { before: row });
        edit(s => { s.approveAllBlocked = on; });
      },
    );
    const box = document.createElement('div');
    box.className = 'field ps-field';
    box.append(row);
    painters.push(() => { input.checked = view.settings.approveAllBlocked === true; });
    return box;
  }

  // Approve all for computer use and for the browser: each is Yes, No or the app's value. Each one keeps the other as it is.
  function approveAllCoversField() {
    const box = document.createElement('div');
    box.className = 'field ps-field';
    const rows = [['computer', 'Approve all also answers computer-use cards'], ['browser', 'Approve all also answers browser cards']];
    const selects = {};
    for (const [key, label] of rows) {
      const select = document.createElement('select');
      select.className = 'ps-covers';
      select.setAttribute('aria-label', label);
      select.append(...COVER_CHOICES.map(([value, text]) => new Option(text, value)));
      select.addEventListener('change', () => {
        const value = select.value === 'on' ? true : select.value === 'off' ? false : null;
        if (value === true) MuseUI.notice?.('approve-all-covers', { before: select });
        edit(s => {
          const covers = s.approveAllCovers && typeof s.approveAllCovers === 'object' ? { ...s.approveAllCovers } : {};
          covers[key] = value;
          s.approveAllCovers = covers;
        });
      });
      selects[key] = select;
      box.append(MuseUI.span('field-label', label), rowOf(select));
    }
    painters.push(() => {
      const covers = view.settings.approveAllCovers ?? {};
      for (const key of Object.keys(selects)) {
        const v = covers[key];
        selects[key].value = v === true ? 'on' : v === false ? 'off' : '';
      }
    });
    return box;
  }

  // What a Codex or Gemini coder that cannot ask does in this project (amend-22). 'run' is the default.
  function codersField() {
    const select = document.createElement('select');
    select.className = 'ps-coders';
    select.setAttribute('aria-label', 'Coders that cannot ask');
    select.append(...CODER_CHOICES.map(([value, text]) => new Option(text, value)));
    const f = fieldBox('Coders that cannot ask', () => edit(s => { s.codersCannotAsk = null; }));
    select.addEventListener('change', () => {
      const value = select.value;
      edit(s => { s.codersCannotAsk = value === 'refuse' ? 'refuse' : null; });
    });
    f.box.append(rowOf(select), f.note);
    painters.push(() => {
      const set = view.settings.codersCannotAsk === 'refuse';
      select.value = set ? 'refuse' : 'run';
      f.note.textContent = 'Codex and Gemini coders cannot ask before they write. Run anyway starts them in their own sandbox or auto-edit mode; Refuse does not start them.';
      f.resetBtn.disabled = !set;
    });
    return f.box;
  }

  function cardSection(title) {
    const card = document.createElement('section');
    card.className = 'card ps-card';
    card.append(MuseUI.span('kicker', title));
    return card;
  }

  // One setting: its label and reset on one line. The caller adds the control and the note under it.
  function fieldBox(label, reset) {
    const box = document.createElement('div');
    box.className = 'field ps-field';
    const head = document.createElement('div');
    head.className = 'ps-head';
    const resetBtn = MuseUI.button('ghost small ps-reset', 'Use app default');
    resetBtn.title = 'Follow the app default again';
    resetBtn.addEventListener('click', reset);
    head.append(MuseUI.span('field-label', label), resetBtn);
    box.append(head);
    return { box, note: MuseUI.span('field-note', ''), resetBtn };
  }

  function rowOf(...controls) {
    const row = document.createElement('div');
    row.className = 'ps-row';
    row.append(...controls);
    return row;
  }

  // The app default, as the server reports it. A missing value falls back to the app's own default.
  const appEffort = () => view.global.effort ?? 'high';
  const appApprovals = () => view.global.approvals ?? 'ask';

  function modelField() {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Model for this project');
    const f = fieldBox('Model', () => edit(s => { s.model = null; }));
    // The value is read now, when the user changes the menu. A save queued behind another one must not read it later.
    select.addEventListener('change', () => {
      const ref = select.value;
      edit(s => { s.model = ref; });
    });
    f.box.append(rowOf(select), f.note);
    painters.push(() => {
      const set = Boolean(view.settings.model);
      fillModels(select, view.effective.model ?? view.global.model);
      f.note.textContent = `${set ? 'This project. App default: ' : 'Inherits: '}${modelLabel(view.global.model)}`;
      f.resetBtn.disabled = !set;
    });
    return f.box;
  }

  function effortField() {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Effort for this project');
    select.append(...Object.entries(EFFORT_LABELS).map(([value, label]) => new Option(label, value)));
    const f = fieldBox('Effort', () => edit(s => { s.effort = null; }));
    select.addEventListener('change', () => {
      const level = select.value;
      edit(s => { s.effort = level; });
    });
    f.box.append(rowOf(select), f.note);
    painters.push(() => {
      const set = Boolean(view.settings.effort);
      select.value = view.effective.effort ?? 'high';
      f.note.textContent = `${set ? 'This project. App default: ' : 'Inherits: '}${EFFORT_LABELS[appEffort()]}`;
      f.resetBtn.disabled = !set;
    });
    return f.box;
  }

  function approvalField() {
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Edits and commands for this project');
    const segRow = rowOf(seg);
    const buttons = Object.entries(APPROVAL_LABELS).map(([key, label]) => {
      const b = MuseUI.button('seg-btn', label);
      b.dataset.approvals = key;
      // Pressing the choice already in force changes nothing, so it does not save.
      b.addEventListener('click', async () => {
        if (b.getAttribute('aria-pressed') === 'true') return;
        // Approve all is asked first, the same question as the Mode menu asks. Cancel leaves the choice in force.
        if (key === 'all' && !(await MuseUI.askApproveAll())) return;
        edit(s => { s.approvals = key; }).then(() => {
          // Auto-approve is a strip where the choice is made (UI-ARCH 10.7). It informs; the switch has already gone on.
          if (key === 'auto' && view?.effective?.approvals === 'auto') MuseUI.notice?.('auto-approve', { before: segRow });
        });
      });
      seg.append(b);
      return b;
    });
    const f = fieldBox('Edits and commands', () => edit(s => { s.approvals = null; }));
    f.box.append(segRow, f.note);
    painters.push(() => {
      const set = Boolean(view.settings.approvals);
      const shown = view.effective.approvals ?? 'ask';
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.approvals === shown));
      f.note.textContent = `${set ? 'This project. App default: ' : 'Inherits: '}${APPROVAL_LABELS[appApprovals()]}`;
      f.resetBtn.disabled = !set;
    });
    return f.box;
  }

  // The relay controls. Each change keeps the rest of the relay as it is in force, so one switch never resets another.
  function relayField() {
    const f = fieldBox('Relay', () => edit(s => { s.relay = null; }));
    const relayShown = () => ({ ...RELAY_DEFAULTS, ...(view.effective.relay ?? {}) });
    const editRelay = patch => edit(s => { s.relay = { ...relayShown(), ...patch }; });

    const auto = switchRow('Auto relay', 'Routes run on their own until a limit, a stop or an error. Off: nothing is passed on without you.', v => editRelay({ autoRoute: v }));

    // The number follows the slider as it moves. The save waits for the release, so one drag is one save.
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '10';
    range.step = '1';
    range.setAttribute('aria-label', 'Countdown before each hop, in seconds');
    const out = document.createElement('output');
    range.addEventListener('input', () => { out.textContent = `${range.value} s`; });
    range.addEventListener('change', () => editRelay({ countdownSec: Number(range.value) }));
    const rangeRow = document.createElement('div');
    rangeRow.className = 'range-row';
    rangeRow.append(range, out);

    // Custom shows a number box. Choosing Custom saves a limit at once, so the menu never shows a limit that is not in force.
    const hopSel = document.createElement('select');
    hopSel.setAttribute('aria-label', 'Hop limit');
    for (const [value, label] of HOP_CHOICES) hopSel.append(new Option(label, value));
    const custom = document.createElement('input');
    custom.type = 'number';
    custom.min = '1';
    custom.max = '50';
    custom.step = '1';
    custom.setAttribute('aria-label', 'Custom hop limit');
    hopSel.addEventListener('change', () => {
      if (hopSel.value !== 'custom') {
        editRelay({ hops: hopSel.value === 'none' ? null : Number(hopSel.value) });
        return;
      }
      const n = wholeHops(custom.value) ?? 3;
      custom.value = String(n);
      editRelay({ hops: n });
    });
    custom.addEventListener('change', () => {
      const n = wholeHops(custom.value);
      // Refused here, before the server is asked, so the user sees why at once.
      if (n == null) {
        MuseUI.toast('A hop limit is a whole number from 1 to 50.', 'bad');
        paintAll();
        return;
      }
      editRelay({ hops: n });
    });
    const hopRow = document.createElement('div');
    hopRow.className = 'hop-row';
    hopRow.append(hopSel, custom);

    const stop = switchRow('Stop when a hop fails', 'On: the route stops at the first error. Off: it goes on with the last good reply.', v => editRelay({ stopOnError: v }));
    const dedupe = switchRow('Skip repeats', 'Do not send a reply that was already sent in this route. Off by default, since a repeated answer is sometimes the right one.', v => editRelay({ dedupe: v }));

    const rows = document.createElement('div');
    rows.className = 'ps-relay-rows';
    rows.append(auto.row, subField('Countdown before each hop', rangeRow), subField('Hop limit', hopRow), stop.row, dedupe.row);
    f.box.append(rows, f.note);

    painters.push(() => {
      const set = Boolean(view.settings.relay);
      const r = relayShown();
      auto.input.checked = Boolean(r.autoRoute);
      stop.input.checked = r.stopOnError !== false;
      dedupe.input.checked = Boolean(r.dedupe);
      range.value = String(r.countdownSec);
      out.textContent = `${r.countdownSec} s`;
      hopSel.value = r.hops == null ? 'none' : [2, 4, 8].includes(r.hops) ? String(r.hops) : 'custom';
      custom.value = String(r.hops ?? 3);
      custom.hidden = hopSel.value !== 'custom';
      f.note.textContent = `${set ? 'This project. App default: ' : 'Inherits: '}${relaySummary(view.global.relay)}`;
      f.resetBtn.disabled = !set;
    });
    return f.box;
  }

  // ---------- the blocked commands card ----------

  // The built-in deny list is stated here and cannot be changed: a project can only add patterns of its own.
  function denyCard() {
    const card = cardSection('Blocked commands');
    card.append(MuseUI.para('Plenum blocks these commands in every mode. A blocked command shows a card with Deny focused. Approve all answers that card only when “Approve all also answers blocked-command cards” is on, in the card above. The built-in rules are: a recursive delete of a drive root, your home folder or the project folder; format, diskpart, reg delete, schtasks /create, bcdedit, shutdown and cipher /w; a download piped into a shell; git push --force; and writes to the Windows or Linux system folders.'));

    const box = document.createElement('div');
    box.className = 'field ps-field ps-deny';
    const chips = document.createElement('div');
    chips.className = 'chips ps-deny-chips';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ps-deny-input';
    input.maxLength = DENY_MAX_UNITS;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Type a pattern and press Enter';
    input.setAttribute('aria-label', 'New blocked command pattern');
    const add = MuseUI.button('ghost small', 'Add');
    const row = document.createElement('div');
    row.className = 'ps-deny-add';
    row.append(input, add);
    const err = document.createElement('p');
    err.className = 'ps-deny-err';
    err.setAttribute('aria-live', 'polite');
    const count = MuseUI.span('field-note', '');
    const help = MuseUI.span('field-note', `A pattern is plain text. A command that contains it, in any letter case, is blocked. A chain such as a && b is checked one command at a time. Up to ${DENY_MAX} patterns of ${DENY_MAX_CHARS} characters.`);
    box.append(MuseUI.span('field-label', 'Your own patterns'), chips, row, err, count, help);
    card.append(box);

    const current = () => view.settings.denyPatterns ?? [];
    const complain = msg => { err.textContent = msg; };

    // The text is read now, and the change is applied to the latest saved list, so two quick edits never overwrite each other.
    function addPattern() {
      const text = input.value.trim();
      const list = current();
      if (!text) complain('Type a pattern first.');
      else if (hiddenChar(input.value)) complain('A pattern cannot contain control characters.');
      else if (charCount(text) > DENY_MAX_CHARS) complain(`A pattern can be at most ${DENY_MAX_CHARS} characters.`);
      else if (list.length >= DENY_MAX) complain(`At most ${DENY_MAX} patterns are allowed.`);
      else if (list.some(p => p.toLowerCase() === text.toLowerCase())) complain('That pattern is already in the list.');
      else {
        complain('');
        input.value = '';
        edit(s => { s.denyPatterns = [...(s.denyPatterns ?? []), text]; });
      }
      input.focus();
    }
    add.addEventListener('click', addPattern);
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      addPattern();
    });
    input.addEventListener('input', () => complain(''));

    const chipFor = item => {
      const chip = MuseUI.span('chip', item);
      const x = MuseUI.button('chip-x', '');
      x.append(MuseUI.icon('x'));
      x.title = `Remove ${item}`;
      x.setAttribute('aria-label', `Remove the pattern ${item}`);
      x.addEventListener('click', () => {
        edit(s => { s.denyPatterns = (s.denyPatterns ?? []).filter(p => p !== item); });
        input.focus();
      });
      chip.append(x);
      return chip;
    };

    painters.push(() => {
      const list = current();
      chips.replaceChildren(...(list.length ? list.map(chipFor) : [MuseUI.span('note-quiet', 'None yet')]));
      count.textContent = `${list.length} of ${DENY_MAX} patterns`;
    });
    return card;
  }

  // ---------- the tools card ----------

  function toolsCard() {
    const card = cardSection('Tools');
    const slot = document.createElement('div');
    slot.className = 'ps-tools';
    card.append(slot);
    // ext-tools.js builds the tool options. If it did not load, say so instead of showing an empty card.
    if (typeof window.MuseTools?.renderSection !== 'function') {
      slot.append(MuseUI.para('The tools section did not load. public/ext-tools.js is missing, so the tool options cannot be shown here.'));
      return card;
    }
    const showFailure = err => slot.replaceChildren(MuseUI.para(`The tools section could not load: ${err.message}`));
    try {
      Promise.resolve(window.MuseTools.renderSection(slot, {
        projectId: view.projectId,
        tools: view.settings.tools ?? {},
        onChange: (cli, next) => edit(s => { s.tools = { ...(s.tools ?? {}), [cli]: next }; }),
      })).catch(showFailure);
    } catch (err) {
      showFailure(err);
    }
    return card;
  }

  // ---------- small helpers ----------

  // The model menu: the catalog grouped by provider. A model the catalog does not list still shows by name.
  function fillModels(select, shown) {
    const catalog = MuseUI.catalog ?? [];
    const byProvider = new Map();
    for (const c of catalog) {
      if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
      byProvider.get(c.provider).push(c);
    }
    const nodes = [];
    for (const [provider, items] of byProvider) {
      const group = document.createElement('optgroup');
      group.label = GROUP_NAMES[provider] ?? provider;
      for (const c of items) group.append(new Option(c.label, `${c.provider}:${c.id}`));
      nodes.push(group);
    }
    if (shown && !catalog.some(c => `${c.provider}:${c.id}` === shown)) nodes.unshift(new Option(shown, shown));
    select.replaceChildren(...nodes);
    select.value = shown ?? '';
  }

  // "Claude Opus 5.5", from the catalog. A note in brackets, such as "(Muse Code default)", is left out.
  function modelLabel(ref) {
    if (!ref) return 'none';
    const hit = (MuseUI.catalog ?? []).find(c => `${c.provider}:${c.id}` === ref);
    return (hit?.label ?? ref).replace(/\s*\(.*\)$/, '');
  }

  function relaySummary(saved) {
    const r = { ...RELAY_DEFAULTS, ...(saved ?? {}) };
    return [
      r.autoRoute ? 'Auto relay on' : 'Auto relay off',
      `${r.countdownSec} s countdown`,
      r.hops == null ? 'no hop limit' : `${r.hops} hop limit`,
    ].join(' · ');
  }

  // A whole number from 1 to 50, or null. The server enforces the same limit.
  function wholeHops(text) {
    const n = Number(String(text).trim());
    return Number.isInteger(n) && n >= 1 && n <= 50 ? n : null;
  }

  function switchRow(label, desc, onChange) {
    const row = document.createElement('label');
    row.className = 'switch-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    const track = MuseUI.span('switch-track', '');
    track.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.append(label);
    if (desc) text.append(Object.assign(document.createElement('small'), { textContent: desc }));
    row.append(input, track, text);
    return { row, input };
  }

  function subField(label, control) {
    const box = document.createElement('div');
    box.className = 'field';
    box.append(MuseUI.span('field-label', label), control);
    return box;
  }
})();
