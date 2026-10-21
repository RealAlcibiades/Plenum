// ext-shortcuts. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// Keyboard shortcuts. Each one only clicks a control the page already has, so every rule behind that control still applies.
// Nothing here changes Ask first or Auto-approve, and there is no shortcut for them. The full list is the Keyboard shortcuts
// drawer: Ctrl+/ opens it, and the Commands drawer links to it.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const SHEET = 'Keyboard shortcuts';
  const SWITCHER = 'Switch project';
  const COMMANDS = 'Commands';
  const SECTION = 'ext-shortcuts-entry';
  // On macOS the shortcut key is Cmd, so the sheet names the key the reader actually presses.
  const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
  const MOD = MAC ? 'Cmd' : 'Ctrl';

  // The rows of the sheet: the keys pressed, then what they do.
  const ROWS = [
    { keys: ['Enter'], action: 'Send the message.' },
    { keys: ['Shift', 'Enter'], action: 'New line in the message.' },
    { keys: ['Enter'], action: 'During a run, queue the message behind it.' },
    { keys: ['Esc'], action: 'Close the list, then stop the run.' },
    { keys: ['/'], action: 'Focus the message box.' },
    { keys: ['Up'], action: 'In an empty message box, recall your last message.' },
    { keys: [MOD, 'K'], action: 'Switch project.' },
    { keys: [MOD, 'Shift', 'P'], action: 'Plan mode on or off.' },
    { keys: [MOD, 'Shift', 'C'], action: 'Council mode on or off.' },
    { keys: [MOD, 'Shift', 'A'], action: 'Open Accounts.' },
    { keys: [MOD, 'Enter'], action: 'Start a run in Quick compare or Pipelines.' },
    { keys: ['Y'], action: 'Approve the focused approval card (not a blocked command or a checkpoint restore: click those).' },
    { keys: ['N'], action: 'Deny the focused approval card.' },
    { keys: [MOD, ','], action: 'Open Settings.' },
    { keys: [MOD, '/'], action: 'Show this list.' },
  ];

  // Ctrl on Windows and Linux, Cmd on macOS.
  function modKey(e) {
    return MAC ? e.metaKey : e.ctrlKey;
  }

  // True when the key was typed into a text field. The message box does not count, so the shortcuts work from it.
  function inTextField(e) {
    const t = e.target;
    if (!t || t === MuseUI.el.input) return false;
    if (t.isContentEditable) return true;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
  }

  // A line of quiet text for the sheet, the switcher and the Commands entry.
  function note(text) {
    const p = MuseUI.para(text);
    p.className = 'ext-shortcuts-note';
    return p;
  }

  // ---------- switch project (Ctrl+K) ----------

  // The folder a project sits in, shown muted under its name. A long path keeps its last two folders, as parentHint does in app.js.
  function parentOf(fullPath) {
    const path = String(fullPath ?? '');
    const sep = path.includes('\\') ? '\\' : '/';
    const parts = path.split(/[\\/]+/).filter(Boolean);
    parts.pop();
    if (parts.length === 0) return '';
    return parts.length > 2 ? `…${sep}${parts.slice(-2).join(sep)}` : parts.join(sep);
  }

  // The projects that match the search, each with its place in MuseUI.state.projects. The name and the folder are searched.
  function matches(query) {
    const q = query.trim().toLowerCase();
    return (MuseUI.state.projects ?? [])
      .map((p, index) => ({ p, index }))
      .filter(({ p }) => q === '' || String(p.name ?? '').toLowerCase().includes(q) || String(p.path ?? '').toLowerCase().includes(q));
  }

  // The rows of the project list are in state order, so the row at this place is the project. Its own click runs switchProject.
  function pickProject(index) {
    const rows = [...MuseUI.el.projects.querySelectorAll('.proj-item')];
    rows[index]?.click();
    MuseUI.closeDrawer();
    MuseUI.el.input.focus();
  }

  function openSwitcher() {
    MuseUI.openDrawer(SWITCHER, renderSwitcher);
    return true;
  }

  function renderSwitcher(body) {
    if ((MuseUI.state.projects ?? []).length === 0) {
      const add = MuseUI.button('primary small', 'Add a project folder');
      add.addEventListener('click', () => {
        // The drawer covers the sidebar, so it closes first and the add form shows where the page expects it.
        MuseUI.closeDrawer();
        MuseUI.el.addProjectBtn.click();
      });
      body.append(note('No projects yet. Add a project folder to start.'), add);
      return;
    }
    const box = document.createElement('div');
    box.className = 'ext-shortcuts-switch';
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'ext-shortcuts-search';
    search.placeholder = 'Find a project';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.setAttribute('aria-label', 'Find a project');
    const list = document.createElement('div');
    list.className = 'ext-shortcuts-list';
    box.append(search, list);
    body.append(box);

    // Redraws the list for the search. The first match is the one Enter picks.
    const draw = () => {
      const hits = matches(search.value);
      list.replaceChildren(...hits.map(({ p, index }) => projectPick(p, index)));
      if (hits.length === 0) list.append(note('No project matches.'));
    };
    search.addEventListener('input', draw);
    search.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      list.querySelector('.ext-shortcuts-pick')?.click();
    });
    draw();
    search.focus();
  }

  // One project in the list: its name, and its folder muted underneath. The active project is marked.
  function projectPick(p, index) {
    const b = MuseUI.button('ext-shortcuts-pick', '');
    if (p.id === MuseUI.state.activeProject) b.setAttribute('aria-current', 'true');
    b.title = String(p.path ?? '');
    b.append(MuseUI.span('ext-shortcuts-name', p.name), MuseUI.span('ext-shortcuts-path', parentOf(p.path)));
    b.addEventListener('click', () => pickProject(index));
    return b;
  }

  // ---------- the sheet (Ctrl+/) ----------

  function openSheet() {
    MuseUI.openDrawer(SHEET, renderSheet);
    return true;
  }

  function renderSheet(body) {
    const table = document.createElement('table');
    table.className = 'ext-shortcuts-table';
    const headRow = document.createElement('tr');
    for (const title of ['Key', 'Action']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = title;
      headRow.append(th);
    }
    const thead = document.createElement('thead');
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    for (const row of ROWS) {
      const tr = document.createElement('tr');
      const keys = document.createElement('td');
      keys.className = 'ext-shortcuts-keys';
      row.keys.forEach((k, i) => {
        if (i > 0) keys.append(MuseUI.span('ext-shortcuts-plus', '+'));
        keys.append(Object.assign(document.createElement('kbd'), { textContent: k }));
      });
      const action = document.createElement('td');
      action.textContent = row.action;
      tr.append(keys, action);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    body.append(table, note('The Ask first and Auto-approve setting has no shortcut. Change it with the mouse.'));
  }

  // ---------- the entry in the Commands drawer ----------

  function commandsOpen() {
    const { drawer, drawerTitle } = MuseUI.el;
    return !drawer.hidden && drawerTitle.textContent === COMMANDS;
  }

  // Runs on every change to the drawer body. The entry is added once per render. Adding it triggers this again, but the
  // entry is already there by then, so nothing loops.
  function syncEntry() {
    const body = MuseUI.el.drawerBody;
    if (!commandsOpen() || body.children.length === 0) return;
    if (body.querySelector(`:scope > .${SECTION}`)) return;
    body.append(entrySection());
  }

  function entrySection() {
    const section = document.createElement('section');
    section.className = SECTION;
    section.setAttribute('aria-label', SHEET);
    const heading = document.createElement('h3');
    heading.className = 'ext-shortcuts-title';
    heading.textContent = SHEET;
    const open = MuseUI.button('ghost small', 'Show all shortcuts');
    open.addEventListener('click', () => openSheet());
    section.append(heading, note(`${MOD}+/ opens this list from anywhere.`), open);
    return section;
  }

  new MutationObserver(syncEntry).observe(MuseUI.el.drawerBody, { childList: true });
  syncEntry();

  // ---------- the message box: Up recalls the last message ----------

  // The text of the newest message the user sent in chat, or null when there is none.
  function lastUserMessage() {
    const list = MuseUI.state.messages ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (m?.role === 'user' && m.kind === 'chat' && typeof m.content === 'string' && m.content !== '') return m.content;
    }
    return null;
  }

  MuseUI.el.input.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' || e.isComposing || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const input = MuseUI.el.input;
    // Only an empty box, and not while the command list is open (Up moves through that list then).
    if (input.value !== '' || !MuseUI.el.palette.hidden) return;
    const text = lastUserMessage();
    if (text === null) return;
    e.preventDefault();
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    // The page reads the input event to resize the box and to update the command list.
    input.dispatchEvent(new Event('input'));
  });

  // ---------- the page keys ----------

  // Plan mode: the same button the top of the composer shows. Its own toast says what happened.
  function togglePlan() {
    const btn = document.querySelector('.plan-btn');
    if (!btn) return false;
    btn.click();
    return true;
  }

  // Council mode: the mode button that is not pressed now. Chat and Council take turns.
  function toggleCouncil() {
    const other = [...document.querySelectorAll('.seg-btn[data-mode]')].find(b => b.getAttribute('aria-pressed') === 'false');
    if (!other) return false;
    other.click();
    return true;
  }

  function openAccountsPanel() {
    MuseUI.el.accountsBtn.click();
    return true;
  }

  // Y approves and N denies, but only on an approval card that has the focus. A card for a blocked command puts Deny first
  // and carries a note, and Y does not approve that card: Approve has to be clicked. N always denies.
  function answerApproval(e, key) {
    const card = typeof e.target?.closest === 'function' ? e.target.closest('.approval') : null;
    if (!card || inTextField(e)) return false;
    if (key === 'y' && card.querySelector('.approval-note')) return false;
    const want = key === 'y' ? 'Approve' : 'Deny';
    const button = [...card.querySelectorAll('.approval-actions button')].find(b => b.textContent === want);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }

  document.addEventListener('keydown', e => {
    if (e.isComposing) return;
    const key = String(e.key ?? '').toLowerCase();
    let fired = false;
    if (modKey(e) && !e.altKey) {
      // Ctrl+K and Ctrl+/ work everywhere, text fields included.
      if (!e.shiftKey && key === 'k') fired = openSwitcher();
      else if (key === '/' || key === '?') fired = openSheet();
      // The others leave text fields alone, and a held key does not repeat a toggle.
      else if (e.shiftKey && !e.repeat && !inTextField(e)) {
        if (key === 'p') fired = togglePlan();
        else if (key === 'c') fired = toggleCouncil();
        else if (key === 'a') fired = openAccountsPanel();
      }
    } else if (!modKey(e) && !e.altKey && !e.shiftKey && (key === 'y' || key === 'n')) {
      fired = answerApproval(e, key);
    }
    if (fired) e.preventDefault();
  });
})();
