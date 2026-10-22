// Rules panel: Settings > Rules. Edits AGENTS.md, CLAUDE.md and GEMINI.md in the project folder, and the global rules kept in the
// Plenum state folder (lib/rules.mjs, lib/routes/rules.mjs). Loaded by ext.js and adds itself through window.MuseUI.
// The server makes every check (hash, limits, links, running, checkpoints). This panel shows what the server says and never decides
// a save itself. Every piece of text is set with textContent. There are no inline scripts, no inline styles and no style attributes.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI, with its settings registry, before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI || !MuseUI.settings || typeof MuseUI.settings.register !== 'function') return;

  const SECTION_ID = 'rules';
  const POLL_MS = 10000;
  const GLOBAL = 'global';
  const PROJECT_DOCS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
  const ALL_DOCS = [...PROJECT_DOCS, GLOBAL];
  const LABEL = { 'AGENTS.md': 'AGENTS.md', 'CLAUDE.md': 'CLAUDE.md', 'GEMINI.md': 'GEMINI.md', [GLOBAL]: 'Global rules' };
  // The starter the panel inserts into an empty AGENTS.md, exactly as written in the spec.
  const STARTER = '# Project rules\n\n## What this project is\n\n## How to build and test\n- Build: \n- Test one file: \n- Full test suite (ask before running it): \n\n## Conventions\n- \n\n## Do not\n- \n';
  const TEXT = {
    loading: 'Loading the rules…',
    noProject: 'Add a project folder first.',
    intro: 'Plenum sends AGENTS.md and the global rules in its own prompt to every model in the chat and to the build\'s planner, coders and reviewer. CLAUDE.md and GEMINI.md are read by their own CLIs from the project folder. Council, relay, compare and pipeline seats get no rules: they are text-only roles without the project\'s files.',
    about: {
      'AGENTS.md': 'Plenum sends this file to every model in the chat and to the build\'s planner, coders and reviewer, as the project owner\'s instructions. Codex also reads it from the folder on its own. It is treated as data: it cannot approve an action, widen the project folder or turn a tool on.',
      'CLAUDE.md': 'Claude Code reads this file from the project folder on its own. Plenum does not add it to a prompt. Claude Code\'s docs suggest keeping it under 200 lines.',
      'GEMINI.md': 'The Gemini CLI reads this file from the project folder on its own. Plenum does not add it to a prompt. A running Gemini session sees a change after /memory reload or a new session.',
    },
    changed: 'The file changed on disk. Save is refused until you Reload.',
    running: 'A run is in progress.',
    planNotice: 'Plan mode is on: the model will not write files, but your own change here is saved.',
    globalOver: 'The global rules can be at most 16,000 characters. Shorten them to save.',
    patternsNote: 'The built-in rules and this project\'s own patterns are checked before every command, in every approval mode.',
    editPatterns: 'Edit patterns in Project settings',
    blocked: 'Blocked commands',
  };

  // The tab the person chose stays while the page is open.
  let chosenTab = 'AGENTS.md';
  // Counts the loads, so a late reply never paints over a newer panel.
  let loadSeq = 0;
  // The panel on screen, or null. A new draw ends the poll of the one it replaces.
  let current = null;

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(cls, text, onClick) {
    const b = make('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const count = n => Number(n).toLocaleString('en-US');
  // A textarea reads and writes \n line endings, so the loaded text is compared in that form.
  const lf = text => String(text ?? '').replace(/\r\n?/g, '\n');

  // The server's answer for one file, by name. Missing names read as absent, so a short answer never breaks the panel.
  function entryOf(data, name) {
    if (name === GLOBAL) return data.global ?? { exists: false, hash: 'absent', text: '', chars: 0, cut: false, editable: true, note: '' };
    return (data.files ?? []).find(f => f.name === name) ?? { name, exists: false, hash: 'absent', text: '', chars: 0, cut: false, editable: true, note: '' };
  }

  // What the panel keeps of the server's answer for a file: the text it compares with, and the hash a save must carry.
  function loadedOf(entry) {
    return {
      exists: Boolean(entry.exists),
      hash: String(entry.hash ?? 'absent'),
      text: lf(entry.text),
      chars: Number(entry.chars) || 0,
      cut: Boolean(entry.cut),
      editable: Boolean(entry.editable),
      note: typeof entry.note === 'string' ? entry.note : '',
    };
  }

  // Sets a document's loaded state and its editor text. Used when the panel opens and after a reload the person asked for.
  function setLoaded(d, entry) {
    d.loaded = loadedOf(entry);
    d.textarea.value = d.loaded.text;
    d.stale = false;
    d.onDisk = null;
  }

  const isDirty = d => d.textarea.value !== d.loaded.text;
  const saveLimit = (view, d) => (d.global ? view.limits.globalChars : view.limits.saveChars);
  const warnLimit = (view, d) => (d.global ? view.limits.globalChars : view.limits.projectChars);

  // Save is possible when the file can be edited, the text differs, the text fits, and no run is writing the project.
  // A stale file still allows the attempt: the server answers 409 until the person reloads, and the panel says why.
  function canSave(view, d) {
    if (d.busy || !d.loaded.editable || !isDirty(d)) return false;
    if (d.textarea.value.length > saveLimit(view, d)) return false;
    if (!d.global && view.running) return false;
    return true;
  }

  // The status line says the most urgent thing: a stale file first, then the file's own note, then a run, then the last action.
  function statusOf(view, d) {
    if (d.stale) return { text: TEXT.changed, bad: true };
    if (d.global && d.textarea.value.length > view.limits.globalChars) return { text: TEXT.globalOver, bad: true };
    if (!d.loaded.editable && d.loaded.note) return { text: d.loaded.note, bad: false };
    if (!d.global && view.running && isDirty(d)) return { text: TEXT.running, bad: false };
    return d.message ?? { text: '', bad: false };
  }

  function refresh(view, d) {
    const value = d.textarea.value;
    const n = d.loaded.editable ? value.length : d.loaded.chars;
    const limit = warnLimit(view, d);
    const over = n > limit;
    d.textarea.readOnly = !d.loaded.editable || d.busy;
    let text = `${count(n)} of ${count(limit)} characters`;
    if (over) text += d.global ? ' · Plenum reads only the first 16,000 characters' : ' · Plenum and Codex read only the first 32,000 characters';
    d.count.textContent = text;
    d.count.classList.toggle('warn', over);
    d.saveBtn.disabled = !canSave(view, d);
    d.revertBtn.disabled = d.busy || !isDirty(d);
    if (d.starterBtn) d.starterBtn.hidden = !(d.loaded.editable && !d.busy && value.trim() === '');
    d.planNote.hidden = d.global || !view.plan;
    const status = statusOf(view, d);
    d.statusText.textContent = status.text;
    d.status.classList.toggle('bad', Boolean(status.bad));
    d.reloadBtn.hidden = !d.stale;
  }

  // Shows a project tab when its file exists, when it was created in this page, or when it is the chosen tab.
  function tabShown(view, name) {
    if (name === 'AGENTS.md' || name === GLOBAL) return true;
    return view.docs[name].loaded.exists || view.created.has(name) || view.tab === name;
  }

  function refreshTabs(view) {
    for (const name of ALL_DOCS) {
      const d = view.docs[name];
      const selected = view.tab === name;
      d.tab.hidden = !tabShown(view, name);
      d.tab.setAttribute('aria-selected', String(selected));
      d.tab.tabIndex = selected ? 0 : -1;
      d.panel.hidden = !selected;
    }
    for (const name of PROJECT_DOCS.slice(1)) {
      const d = view.docs[name];
      d.createBtn.hidden = d.loaded.exists || view.created.has(name);
    }
    view.createRow.hidden = view.createRow.querySelectorAll('button:not([hidden])').length === 0;
    view.patternCount.textContent = `${count(view.denyPatterns)} project pattern${view.denyPatterns === 1 ? '' : 's'}`;
  }

  function refreshAll(view) {
    refreshTabs(view);
    for (const name of ALL_DOCS) refresh(view, view.docs[name]);
  }

  function select(view, name) {
    view.tab = name;
    chosenTab = name;
    refreshAll(view);
  }

  // Create: opens an empty editor for a rules file that is not there yet. Save creates the file.
  function create(view, name) {
    view.created.add(name);
    const d = view.docs[name];
    d.textarea.value = '';
    d.message = null;
    select(view, name);
    d.textarea.focus();
  }

  // Applies a server answer for one file during the 10 s poll. An unedited editor takes the new text at once. An edited one keeps
  // its text and the old hash, so a save is refused (409) until the person reloads and no change is written blind.
  function receive(view, d, entry) {
    if (d.busy) return;
    const next = loadedOf(entry);
    if (next.hash === d.loaded.hash) {
      d.loaded = { ...d.loaded, cut: next.cut, editable: next.editable, note: next.note, chars: next.chars };
      d.stale = false;
      return;
    }
    if (d.textarea.value === d.loaded.text) {
      setLoaded(d, entry);
      d.message = { text: `Reloaded: the file changed on disk at ${time()}.`, bad: false };
    } else {
      d.stale = true;
      d.onDisk = entry;
    }
  }

  // The plan and running state, the pattern count and the limits come with every answer, so they are kept up to date.
  function applyMeta(view, data) {
    view.plan = Boolean(data.project?.plan);
    view.running = Boolean(data.project?.running);
    view.denyPatterns = Number(data.denyPatterns) || 0;
    if (data.limits) view.limits = data.limits;
  }

  async function fetchState(projectId) {
    return MuseUI.api(`/api/rules?project=${encodeURIComponent(projectId)}`);
  }

  // A POST to the rules routes. The status is kept on the error, so a 409 can be told apart from other refusals.
  async function post(path, body) {
    const res = await MuseUI.request(path, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function confirmReload(name) {
    const title = `Reload ${name}?`;
    const detail = 'Your unsaved edits are lost.';
    if (typeof MuseUI.confirm === 'function') {
      try {
        return (await MuseUI.confirm({ title, body: detail, action: 'Reload', tone: 'bad' })) === true;
      } catch {
        return false;
      }
    }
    return window.confirm(`${title} ${detail}`);
  }

  async function save(view, d) {
    if (!canSave(view, d)) return;
    const text = d.textarea.value;
    d.busy = true;
    d.message = null;
    refresh(view, d);
    try {
      const data = d.global
        ? await post('/api/rules/global', { text, seen: d.loaded.hash })
        : await post('/api/rules', { project: view.projectId, name: d.name, text, seen: d.loaded.hash });
      d.busy = false;
      d.loaded = loadedOf(d.global ? data.global : data.file);
      // The editor keeps what the person typed after the save started. Only an unchanged editor takes the saved text.
      if (d.textarea.value === text) d.textarea.value = d.loaded.text;
      d.stale = false;
      d.onDisk = null;
      d.message = { text: `Saved at ${time()}`, bad: false };
      MuseUI.toast(d.global ? 'Saved the global rules. It applies from the next message.' : `Saved ${d.name}. It applies from the next message.`);
    } catch (err) {
      d.busy = false;
      if (err.status === 409 && /changed on disk/.test(err.message)) {
        d.stale = true;
      } else {
        MuseUI.toast(err.message, 'bad');
      }
    }
    refreshAll(view);
  }

  async function reload(view, d) {
    if (isDirty(d) && !(await confirmReload(d.name))) return;
    let data;
    try {
      data = await fetchState(view.projectId);
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
      return;
    }
    applyMeta(view, data);
    setLoaded(d, entryOf(data, d.name));
    d.message = { text: `Reloaded from disk at ${time()}`, bad: false };
    refreshAll(view);
  }

  // The poll: every 10 s while the panel is on screen. A project change or a closed Settings page ends it.
  async function poll(view) {
    if (current !== view || !view.root.isConnected) {
      clearInterval(view.timer);
      return;
    }
    if (MuseUI.el?.drawer?.hidden) return;
    let data;
    try {
      data = await fetchState(view.projectId);
    } catch {
      return;
    }
    if (current !== view || !view.root.isConnected) return;
    if (data.project?.id !== view.projectId) return;
    applyMeta(view, data);
    for (const name of ALL_DOCS) receive(view, view.docs[name], entryOf(data, name));
    refreshAll(view);
  }

  // Blocked commands are edited in Project settings (Settings > This project). The link opens it and scrolls to the patterns.
  function openPatterns() {
    try {
      if (typeof MuseUI.settings.open === 'function') MuseUI.settings.open('project');
      else document.querySelector('.proj-gear')?.click();
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
      return;
    }
    watchForPatterns();
  }

  // Scrolls to the first pattern box once it is drawn, and focuses its input. Gives up after 5 s.
  function watchForPatterns() {
    const reveal = () => {
      const box = document.querySelector('.ps-deny');
      if (!box) return false;
      box.scrollIntoView({ block: 'start' });
      box.querySelector('.ps-deny-input')?.focus();
      return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => {
      if (reveal()) {
        observer.disconnect();
        clearTimeout(stop);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const stop = setTimeout(() => observer.disconnect(), 5000);
  }

  function makeDoc(view, name, entry) {
    const global = name === GLOBAL;
    const label = LABEL[name];
    const d = {
      name,
      global,
      label,
      busy: false,
      stale: false,
      onDisk: null,
      message: null,
      loaded: loadedOf(entry),
    };
    d.tab = button('ext-rules-tab', label, () => select(view, name));
    d.tab.setAttribute('role', 'tab');
    d.tab.dataset.doc = name;

    d.panel = make('section', 'ext-rules-file');
    d.panel.dataset.doc = name;
    d.panel.setAttribute('aria-label', `${label}`);
    const about = global
      ? `Plenum adds these rules to every project, after the project's AGENTS.md, for the chat and for builds. They are kept in ${view.globalFile} and are never written to the CLIs' own global files.`
      : TEXT.about[name];
    d.panel.append(make('p', 'ext-rules-about', about));
    d.planNote = make('p', 'ext-rules-plan', TEXT.planNotice);
    d.planNote.hidden = true;
    d.panel.append(d.planNote);

    d.textarea = make('textarea', 'ext-rules-text');
    d.textarea.spellcheck = false;
    d.textarea.rows = 18;
    d.textarea.setAttribute('aria-label', `${label} text`);
    d.textarea.maxLength = global ? view.limits.globalChars : view.limits.saveChars;
    d.textarea.addEventListener('input', () => {
      if (d.message && !d.message.bad) d.message = null;
      refreshAll(view);
    });
    d.textarea.addEventListener('keydown', event => {
      // Ctrl+S (Cmd+S on a Mac) saves, as the panel's Save button does.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        save(view, d);
      }
    });
    d.panel.append(d.textarea);

    d.count = make('span', 'field-note ext-rules-count');
    const foot = make('div', 'ext-rules-foot');
    foot.append(d.count);
    d.status = make('div', 'ext-rules-status');
    d.status.setAttribute('role', 'status');
    d.statusText = make('span', 'ext-rules-status-text');
    d.reloadBtn = button('ghost small ext-rules-reload', 'Reload', () => reload(view, d));
    d.reloadBtn.hidden = true;
    d.status.append(d.statusText, d.reloadBtn);
    foot.append(d.status);
    d.panel.append(foot);

    const actions = make('div', 'ext-rules-actions');
    d.saveBtn = button('primary small', 'Save', () => save(view, d));
    d.revertBtn = button('ghost small', 'Revert', () => {
      d.textarea.value = d.loaded.text;
      d.message = null;
      refreshAll(view);
    });
    actions.append(d.saveBtn, d.revertBtn);
    if (name === 'AGENTS.md') {
      d.starterBtn = button('ghost small', 'Insert starter', () => {
        d.textarea.value = STARTER;
        d.textarea.focus();
        refreshAll(view);
      });
      actions.append(d.starterBtn);
    }
    d.panel.append(actions);

    if (PROJECT_DOCS.includes(name) && name !== 'AGENTS.md') {
      d.createBtn = button('ghost small', `Create ${name}`, () => create(view, name));
    }
    setLoaded(d, entry);
    return d;
  }

  // Draws the whole panel for the project's answer. Later answers only update parts of it, so the editor keeps focus.
  function build(root, data) {
    const view = {
      root,
      projectId: data.project.id,
      tab: ALL_DOCS.includes(chosenTab) ? chosenTab : 'AGENTS.md',
      created: new Set(),
      docs: {},
      timer: null,
      globalFile: data.globalFile,
      limits: data.limits,
      plan: false,
      running: false,
      denyPatterns: 0,
    };
    applyMeta(view, data);
    current = view;
    root.replaceChildren();
    root.append(make('p', 'ext-rules-intro', TEXT.intro));

    const tabs = make('div', 'ext-rules-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Rules files');
    for (const name of ALL_DOCS) view.docs[name] = makeDoc(view, name, entryOf(data, name));
    tabs.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const shown = ALL_DOCS.filter(name => !view.docs[name].tab.hidden);
      const at = shown.indexOf(view.tab);
      const next = shown[(at + (event.key === 'ArrowRight' ? 1 : shown.length - 1)) % shown.length];
      event.preventDefault();
      select(view, next);
      view.docs[next].tab.focus();
    });
    for (const name of ALL_DOCS) tabs.append(view.docs[name].tab);
    // Blocked commands is a link, not a tab: it opens Settings > This project at the patterns (UI-ARCH section 5).
    const link = button('ext-rules-tab-link', TEXT.blocked, openPatterns);
    view.patternCount = make('span', 'ext-rules-tab-note');
    view.patternCount.setAttribute('role', 'note');
    tabs.append(link, view.patternCount);
    view.createRow = make('div', 'ext-rules-create');
    for (const name of PROJECT_DOCS.slice(1)) view.createRow.append(view.docs[name].createBtn);
    root.append(tabs, view.createRow);
    for (const name of ALL_DOCS) root.append(view.docs[name].panel);

    const note = make('p', 'ext-rules-note');
    note.append(`${TEXT.patternsNote} `);
    note.append(button('primary small ext-rules-patterns', TEXT.editPatterns, openPatterns));
    root.append(note);

    refreshAll(view);
    view.timer = setInterval(() => poll(view), POLL_MS);
  }

  function render(body) {
    const root = make('div', 'ext-rules');
    body.append(root);
    const projectId = MuseUI.state.activeProject;
    if (!projectId) {
      root.append(make('p', 'ext-rules-note', TEXT.noProject));
      return;
    }
    root.append(make('p', 'ext-rules-note', TEXT.loading));
    const seq = ++loadSeq;
    fetchState(projectId)
      .then(data => {
        if (seq !== loadSeq || !root.isConnected) return;
        build(root, data);
      })
      .catch(err => {
        if (seq !== loadSeq || !root.isConnected) return;
        root.replaceChildren();
        root.append(make('p', 'ext-rules-error', err.message || 'The rules could not be loaded.'));
        root.append(button('ghost small', 'Try again', () => {
          root.remove();
          render(body);
        }));
      });
  }

  MuseUI.settings.register({
    id: SECTION_ID,
    scope: 'app',
    title: 'Rules',
    order: 15,
    render: body => render(body),
  });

  // The /rules command opens Settings at this section (UI-ARCH section 11).
  MuseUI.openRules = () => {
    MuseUI.settings.open('app');
    requestAnimationFrame(() => {
      document.querySelector(`[data-section="${SECTION_ID}"]`)?.scrollIntoView({ block: 'start' });
    });
  };
})();
