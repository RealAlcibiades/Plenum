// Threads (pro-01): several chats per project, shown as tabs above the chat. Loaded by ext.js; it adds itself through window.MuseUI.
//
// A thread is a chat of its own with its own name, model, queue, plan mode and CLI sessions. The first one, Main, is the project's chat
// from before. Threads run at the same time: each tab shows whether its thread is running (a pulsing dot), waits for your approval (amber)
// or has a reply you have not read (accent), and a shield on a thread that is read-only because another thread is the project's writer.
// The data comes from the page state (MuseUI.state.threads, activeThread, closedThreads, projectBusy, threadsOff, writerThread, multiWriter);
// every change is a request to /api/threads/* (lib/routes/threads.mjs), and the answer is the new page state (MuseUI.threads.adopt).
//
// What this file draws:
//   div.ext-threads          the tab row above the chat (role tablist): a tab per open thread, a "..." menu on each, "+ Thread" last.
//   div.ext-threads-header   the thread header row under the tabs, only when the thread has state to show: the read-only line with
//                            "Make this thread the writer". Other panels add to it through MuseUI.threads.header (pro-02's branch chip).
//   the New thread drawer    Name, Model, plan mode, the slot window.MuseThreadDialogExtras, the one-writer switch, Closed threads, and
//                            export and import of the project's threads. Ctrl+T opens it in the desktop app (a browser keeps Ctrl+T).
// Every piece of text from the server or the user is set with textContent. Nothing here sets an inline style attribute in markup.
(function () {
  const MU = window.MuseUI;
  // app.js defines MuseUI (and MuseUI.threads) before the extra panels load. Without it there is nothing to attach to.
  if (!MU || !MU.threads) return;
  const T = MU.threads;

  const TITLE_NEW = 'New thread (Ctrl+T)';
  const TITLE_OFF = 'Threads are off: Plenum could not back up the state file first.';
  const TITLE_FULL = 'This project has 8 open threads. Close one first.';
  const TITLE_WAIT = 'Wait until every thread is idle';
  const MULTI_NOTICE = 'Two agents editing one folder can overwrite each other’s uncommitted work. Use an isolated copy for the second thread, or commit first.';
  const SEEN_KEY = 'plenum.threads.seen';
  const HIDE_NOTICE_KEY = 'plenum.threads.hide-multiwriter-notice';
  const MAX_OPEN = 8;
  const NAME_MAX = 40;
  const IS_DESKTOP = document.documentElement.dataset.shell === 'desktop';
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
  const narrowQuery = window.matchMedia ? window.matchMedia('(max-width: 480px)') : null;

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const state = () => MU.state;
  const project = () => (state().projects ?? []).find(p => p.id === state().activeProject) ?? null;
  const threadList = () => (Array.isArray(state().threads) ? state().threads : []);
  const activeId = () => state().activeThread;
  const providerOfRef = ref => (typeof ref === 'string' && ref.includes(':') ? ref.slice(0, ref.indexOf(':')) : '');
  // The model a thread uses: its own, and for Main the app's model (the selector).
  const modelOf = t => t.model || state().model;
  const writerOf = () => threadList().find(t => t.id === state().writerThread) ?? threadList().find(t => t.main) ?? null;
  const multiWriter = () => state().multiWriter === true;

  // ---------- what this viewer has seen (a finished run that was not on screen shows as unread) ----------

  const seen = (() => {
    try {
      const value = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
      if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).filter(([, at]) => Number.isFinite(at)));
    } catch {
      // Without storage the marks are kept for this page only.
    }
    return {};
  })();
  // thread id -> when its last run ended, from the Agents board's events (lib/activity.mjs).
  const ended = new Map();

  function writeSeen() {
    const ids = Object.keys(seen);
    if (ids.length > 200) for (const id of ids.slice(0, ids.length - 200)) delete seen[id];
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch {
      // The marks are kept for this page only.
    }
  }

  function markSeen(id) {
    if (!id) return;
    const at = Math.max(Date.now(), ended.get(id) ?? 0);
    if ((seen[id] ?? 0) >= at) return;
    seen[id] = at;
    writeSeen();
  }

  const unread = t => t.id !== activeId() && (ended.get(t.id) ?? 0) > (seen[t.id] ?? 0);

  // The status of a tab, most urgent first: waiting for the person, running, or a reply not read yet.
  function statusOf(t) {
    if ((t.waiting ?? 0) > 0) return 'waiting';
    if (t.running || T.isRunning(t.id)) return 'running';
    if (unread(t)) return 'unread';
    return '';
  }
  const STATUS_TITLE = { waiting: 'Waiting for your approval', running: 'Running', unread: 'New reply you have not seen' };

  // ---------- the tab row ----------

  const bar = make('div', 'ext-threads');
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'Threads');
  bar.hidden = true;
  const header = make('div', 'ext-threads-header ext-threads-banner');
  header.setAttribute('role', 'status');
  header.hidden = true;
  const readOnlyLine = make('div', 'ext-thread-readonly');
  const headerExtra = make('div', 'ext-thread-header-extra');
  header.append(readOnlyLine, headerExtra);
  MU.el.chat.before(bar, header);

  let drawnSignature = '';
  let menuState = null; // { menu, opener }
  let renaming = null;  // the thread id whose name is being edited

  function signature() {
    const list = threadList();
    return JSON.stringify([
      state().activeProject, activeId(), state().threadsOff, state().projectBusy, state().writerThread, multiWriter(), narrowQuery?.matches === true, renaming,
      list.map(t => [t.id, t.name, modelOf(t), t.writer, t.chatMode, statusOf(t)]),
    ]);
  }

  function swatch(t) {
    const sw = make('span', 'sw');
    const provider = providerOfRef(modelOf(t));
    if (provider) sw.dataset.p = provider;
    sw.setAttribute('aria-hidden', 'true');
    return sw;
  }

  function dot(status) {
    const d = make('span', 'ext-thread-dot');
    d.dataset.state = status;
    d.title = STATUS_TITLE[status] ?? '';
    d.setAttribute('role', 'img');
    d.setAttribute('aria-label', STATUS_TITLE[status] ?? '');
    return d;
  }

  // The label of a tab: swatch, name, status dot, shield. The accessible name says the status too, so it is not colour alone.
  function tabLabel(t) {
    const status = statusOf(t);
    const label = make('span', 'ext-thread-label');
    label.append(swatch(t), make('span', 'ext-thread-name', t.name));
    if (status) label.append(dot(status));
    if (t.writer === false) {
      const shield = MU.icon('shield', 'ext-thread-shield');
      const tip = writerOf() ? `Read-only: ${writerOf().name} is the writer` : 'Read-only';
      shield.setAttribute('role', 'img');
      shield.setAttribute('aria-label', tip);
      const wrap = make('span', 'ext-thread-ro');
      wrap.title = tip;
      wrap.append(shield);
      label.append(wrap);
    }
    return label;
  }

  function accessibleName(t) {
    const status = statusOf(t);
    return [t.name, STATUS_TITLE[status], t.writer === false ? 'read-only' : ''].filter(Boolean).join(', ');
  }

  function tabEl(t) {
    const selected = t.id === activeId();
    const wrap = make('div', 'ext-thread-tab');
    wrap.setAttribute('role', 'presentation');
    wrap.dataset.thread = t.id;
    if (selected) wrap.dataset.selected = 'true';
    const btn = make('button', 'ext-thread-btn');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(selected));
    btn.setAttribute('aria-label', accessibleName(t));
    btn.tabIndex = selected ? 0 : -1;
    btn.dataset.thread = t.id;
    btn.append(tabLabel(t));
    btn.addEventListener('click', () => choose(t.id));
    btn.addEventListener('keydown', onTabKey);
    wrap.append(btn);
    if (renaming === t.id) {
      wrap.dataset.renaming = 'true';
      btn.hidden = true;
      wrap.append(renameInput(t));
    }
    const more = make('button', 'ext-thread-more', '…');
    more.type = 'button';
    more.title = `Thread actions for ${t.name}`;
    more.setAttribute('aria-label', `Actions for ${t.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.dataset.thread = t.id;
    more.addEventListener('click', e => {
      e.stopPropagation();
      openMenu(more, actionsFor(t));
    });
    wrap.append(more);
    return wrap;
  }

  function newButton() {
    const b = make('button', 'ext-thread-new');
    b.type = 'button';
    b.append(MU.icon('plus'), make('span', 'ext-thread-new-text', 'Thread'));
    b.setAttribute('aria-label', 'New thread');
    const full = threadList().length >= MAX_OPEN;
    if (state().threadsOff) {
      b.disabled = true;
      b.title = TITLE_OFF;
    } else if (full) {
      b.disabled = true;
      b.title = TITLE_FULL;
    } else {
      b.title = TITLE_NEW;
    }
    b.addEventListener('click', () => openNewDialog());
    return b;
  }

  // The collapsed form for a window of 480 px or less: "Main" with a chevron that lists the threads, and "+".
  function collapsed() {
    const list = threadList();
    const current = list.find(t => t.id === activeId()) ?? list[0];
    const wrap = make('div', 'ext-thread-tab ext-thread-collapsed');
    wrap.setAttribute('role', 'presentation');
    wrap.dataset.selected = 'true';
    const btn = make('button', 'ext-thread-btn');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'true');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-label', `${accessibleName(current)}. Choose a thread`);
    btn.append(tabLabel(current), MU.icon('chevron', 'ext-thread-chev'));
    const others = list.filter(t => statusOf(t) === 'waiting' && t.id !== current.id).length;
    if (others) {
      const badge = MU.ui.badge(others, 'amber');
      badge.title = 'Other threads waiting for your approval';
      btn.append(badge);
    }
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openMenu(btn, [
        ...list.map(t => ({ label: t.name, checked: t.id === current.id, status: statusOf(t), run: () => choose(t.id) })),
        { separator: true },
        ...actionsFor(current),
      ]);
    });
    wrap.append(btn);
    return wrap;
  }

  // The @ picker (public/ext-mentions.js) reads MuseUI.state.threads[projectId] = { active, list }, the shape state.json keeps. The page state
  // sends the open threads of the active project as a list, so the same data is attached to that list under the project id, where the
  // picker looks for it (a list's own properties do not travel in JSON, so nothing is sent back to the server).
  function shareWithMentions() {
    const st = state();
    if (!Array.isArray(st.threads) || !st.activeProject) return;
    st.threads[st.activeProject] = { active: st.activeThread, list: st.threads.map(t => ({ id: t.id, name: t.name })) };
  }

  function paint() {
    shareWithMentions();
    const p = project();
    const list = threadList();
    if (!p || !list.length) {
      bar.hidden = true;
      header.hidden = true;
      drawnSignature = '';
      return;
    }
    // The active thread is seen from the moment it is on screen.
    markSeen(activeId());
    const sig = signature();
    paintHeader();
    if (sig === drawnSignature && !bar.hidden) return;
    drawnSignature = sig;
    const focused = document.activeElement instanceof Element && bar.contains(document.activeElement)
      ? { thread: document.activeElement.dataset.thread, more: document.activeElement.classList.contains('ext-thread-more'), isNew: document.activeElement.classList.contains('ext-thread-new') }
      : null;
    bar.hidden = false;
    const tabs = narrowQuery?.matches ? [collapsed()] : list.map(tabEl);
    bar.replaceChildren(...tabs, newButton());
    if (focused) {
      const target = focused.isNew ? bar.querySelector('.ext-thread-new')
        : bar.querySelector(focused.more ? `.ext-thread-more[data-thread="${CSS.escape(focused.thread ?? '')}"]` : `.ext-thread-btn[data-thread="${CSS.escape(focused.thread ?? '')}"]`);
      target?.focus({ preventScroll: true });
    }
    bar.querySelector('[data-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  // The header row: the read-only line while the thread on screen is not the writer. pro-02 adds its branch chip to headerExtra.
  function paintHeader() {
    const t = threadList().find(x => x.id === activeId());
    const readOnly = Boolean(t) && t.writer === false && !multiWriter();
    readOnlyLine.replaceChildren();
    if (readOnly) {
      const writer = writerOf();
      readOnlyLine.append(make('span', 'ext-thread-readonly-text', `Read-only: ${writer ? writer.name : 'another thread'} is this project’s writer, and two writers would share this folder.`));
      const make1 = make('button', 'ghost small ext-thread-make-writer', 'Make this thread the writer');
      make1.type = 'button';
      const busy = state().projectBusy === true;
      make1.disabled = busy;
      make1.title = busy ? TITLE_WAIT : 'Make this the thread that changes files in the project folder';
      make1.addEventListener('click', () => makeWriter(t));
      const several = make('button', 'ghost small ext-thread-several', 'Allow several writers…');
      several.type = 'button';
      several.title = 'Open the New thread panel, which holds the project switch';
      several.addEventListener('click', () => openNewDialog());
      readOnlyLine.append(make1, several);
    }
    readOnlyLine.hidden = !readOnly;
    header.hidden = !readOnly && !headerExtra.childElementCount;
  }

  // ---------- actions ----------

  async function call(path, body) {
    try {
      const data = await MU.api(path, { project: state().activeProject, ...body });
      T.adopt(data);
      return data;
    } catch (err) {
      MU.toast(err.message, 'bad');
      return null;
    }
  }

  async function choose(id) {
    if (!id || id === activeId()) return;
    try {
      await T.switchTo(id);
    } catch (err) {
      MU.toast(err.message, 'bad');
    }
  }

  async function makeWriter(t) {
    const data = await call('/api/threads/writer', { thread: t.id });
    if (data) MU.toast(`${t.name} is now the writer. The other threads are read-only.`);
  }

  async function closeThread(t) {
    const data = await call('/api/threads/close', { thread: t.id });
    if (data) MU.toast(`${t.name} was closed. Its chat is kept under Closed threads.`);
  }

  function actionsFor(t) {
    const items = [];
    if (!t.main) items.push({ label: 'Rename', run: () => startRename(t) });
    const isWriter = t.writer === true;
    const busy = state().projectBusy === true;
    items.push({
      label: 'Make writer',
      disabled: isWriter || busy || multiWriter(),
      title: multiWriter() ? 'This project lets every thread write' : isWriter ? 'This thread is the writer' : busy ? TITLE_WAIT : 'Make this the thread that changes files',
      run: () => makeWriter(t),
    });
    if (!t.main) {
      const running = t.running || T.isRunning(t.id);
      items.push({ label: 'Close thread', disabled: running, title: running ? 'Stop the run first' : 'Close the thread and keep its chat', run: () => closeThread(t) });
    }
    return items;
  }

  // ---------- the menu ----------

  function closeMenu({ focus = false } = {}) {
    if (!menuState) return;
    const { menu, opener } = menuState;
    menuState = null;
    menu.remove();
    opener?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onResize);
    if (focus) opener?.focus({ preventScroll: true });
  }

  const onOutside = e => {
    if (menuState && !menuState.menu.contains(e.target) && e.target !== menuState.opener) closeMenu();
  };
  const onResize = () => closeMenu();

  function onMenuKey(e) {
    if (!menuState) return;
    const items = [...menuState.menu.querySelectorAll('[role^="menuitem"]:not(:disabled)')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu({ focus: true });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items.at(-1)?.focus();
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  }

  // items: [{ label, run, disabled?, title?, checked?, status?, separator? }]
  function openMenu(opener, items) {
    closeMenu();
    const menu = make('div', 'ext-thread-menu');
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.separator) {
        menu.append(make('div', 'ext-thread-menu-sep'));
        continue;
      }
      const b = make('button', 'ext-thread-menu-item');
      b.type = 'button';
      b.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
      if (item.checked !== undefined) b.setAttribute('aria-checked', String(item.checked));
      if (item.checked) b.dataset.current = 'true';
      b.append(make('span', 'ext-thread-menu-label', item.label));
      if (item.status) b.append(dot(item.status));
      if (item.title) b.title = item.title;
      b.disabled = item.disabled === true;
      b.addEventListener('click', () => {
        closeMenu();
        item.run();
      });
      menu.append(b);
    }
    document.body.append(menu);
    const r = opener.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    const width = menu.offsetWidth || 180;
    menu.style.left = `${Math.max(8, Math.min(Math.round(r.left), window.innerWidth - width - 8))}px`;
    opener.setAttribute('aria-expanded', 'true');
    menuState = { menu, opener };
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onResize);
    (menu.querySelector('[data-current="true"]:not(:disabled)') ?? menu.querySelector('[role^="menuitem"]:not(:disabled)'))?.focus();
  }

  // ---------- rename in place ----------

  function renameInput(t) {
    const input = make('input', 'ext-thread-rename');
    input.type = 'text';
    input.value = t.name;
    input.maxLength = NAME_MAX;
    input.setAttribute('aria-label', `New name for ${t.name}`);
    input.spellcheck = false;
    let finished = false;
    const stop = () => {
      finished = true;
      renaming = null;
      drawnSignature = '';
      paint();
    };
    input.addEventListener('keydown', async e => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stop();
        T.focusTab?.(t.id);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const name = input.value.trim();
        if (!name || name === t.name) {
          stop();
          return;
        }
        input.disabled = true;
        const data = await call('/api/threads/update', { thread: t.id, name });
        if (data) {
          finished = true;
          renaming = null;
          drawnSignature = '';
          paint();
          bar.querySelector(`.ext-thread-btn[data-thread="${CSS.escape(t.id)}"]`)?.focus({ preventScroll: true });
        } else {
          input.disabled = false;
          input.focus();
        }
      }
    });
    input.addEventListener('blur', () => {
      if (!finished && renaming === t.id && !input.disabled) stop();
    });
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return input;
  }

  function startRename(t) {
    renaming = t.id;
    drawnSignature = '';
    paint();
  }

  // Left and Right move between the tabs, Home and End go to the first and last one. Enter or Space on a tab shows it (a button's own click).
  function onTabKey(e) {
    const tabs = [...bar.querySelectorAll('.ext-thread-btn:not([hidden])')];
    const at = tabs.indexOf(e.currentTarget);
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else if (e.key === 'F10' && e.shiftKey) {
      e.preventDefault();
      e.currentTarget.closest('.ext-thread-tab')?.querySelector('.ext-thread-more')?.click();
      return;
    }
    if (next < 0 || !tabs.length) return;
    e.preventDefault();
    for (const tab of tabs) tab.tabIndex = -1;
    tabs[next].tabIndex = 0;
    tabs[next].focus();
  }

  // ---------- the New thread panel ----------

  function modelSelect(initial) {
    const select = make('select', 'ext-thread-model');
    select.setAttribute('aria-label', 'Model');
    const registry = MU.providerRegistry;
    const catalog = Array.isArray(MU.catalog) ? MU.catalog : [];
    const seenRefs = new Set();
    for (const entry of registry) {
      const items = catalog.filter(c => c.provider === entry.id);
      if (!items.length) continue;
      const group = document.createElement('optgroup');
      group.label = entry.name;
      for (const c of items) {
        const ref = `${c.provider}:${c.id}`;
        seenRefs.add(ref);
        group.append(new Option(c.label, ref));
      }
      select.append(group);
    }
    // A model that is not in the catalog (an OpenRouter id, say) is still offered when it is the one on screen.
    if (initial && !seenRefs.has(initial)) select.prepend(new Option(MU.modelName(initial) || initial, initial));
    if (initial) select.value = initial;
    return select;
  }

  function extrasOf() {
    const fns = [];
    if (Array.isArray(window.MuseThreadDialogExtras)) fns.push(...window.MuseThreadDialogExtras);
    try {
      for (const item of MU.slots.list('threadDialogExtras')) if (typeof item.value === 'function') fns.push(item.value);
    } catch {
      // The slot is optional.
    }
    return fns.filter(fn => typeof fn === 'function');
  }

  function fieldRow(label, control, note) {
    const row = make('label', 'ext-thread-field');
    row.append(make('span', 'field-label', label), control);
    if (note) row.append(make('span', 'field-note', note));
    return row;
  }

  function renderNewThread(body) {
    const p = project();
    if (!p) {
      body.append(make('p', 'ext-thread-empty', 'Add a project folder first.'));
      return;
    }
    const list = threadList();
    const off = state().threadsOff === true;
    const full = list.length >= MAX_OPEN;
    // The note names what the new thread will be allowed to do.
    body.append(make('p', 'ext-thread-intro', 'A thread is another chat in this project, with its own model, queue and plan mode. Threads run at the same time. Only one thread changes files in the folder (the writer); the others are read-only.'));
    if (off) body.append(make('p', 'ext-thread-note bad', TITLE_OFF));

    const form = make('form', 'ext-thread-form');
    const name = make('input', 'ext-thread-name-input');
    name.type = 'text';
    name.maxLength = NAME_MAX;
    name.autocomplete = 'off';
    name.spellcheck = false;
    name.placeholder = `Thread ${nextNumber(list)}`;
    name.setAttribute('aria-label', 'Name');
    const select = modelSelect(MU.el.model.value || state().model);
    const plan = make('input', 'ext-thread-plan');
    plan.type = 'checkbox';
    const planLabel = make('label', 'ext-thread-check');
    planLabel.append(plan, make('span', '', 'Start in plan mode (read-only)'));
    const readOnlyNow = !multiWriter();
    const readOnlyNote = make('p', 'ext-thread-note', 'Read-only until it is the writer or has its own copy.');
    // The plan box is a statement while another thread is the writer (the new thread is read-only by that rule). The project's switch for
    // several writers takes the rule away, so the box follows it at once without redrawing the panel (what was typed stays).
    let touched = false;
    plan.addEventListener('change', () => { touched = true; });
    const syncPlan = () => {
      const readOnly = !multiWriter();
      plan.disabled = readOnly;
      if (readOnly) plan.checked = true;
      else if (!touched) plan.checked = false;
      readOnlyNote.hidden = !readOnly;
    };
    syncPlan();
    form.append(fieldRow('Name', name), fieldRow('Model', select), planLabel, readOnlyNote);

    // Other panels add fields here (pro-02's isolated copy). Each extra is fn(container, ctx) -> { fields() }; fields() is merged into the body.
    const extras = [];
    const extraBox = make('div', 'ext-thread-extras');
    const ctx = { project: p, threads: list, multiWriter: multiWriter(), readOnly: readOnlyNow, plan, name, select };
    for (const fn of extrasOf()) {
      try {
        const got = fn(extraBox, ctx);
        if (got && typeof got.fields === 'function') extras.push(got);
      } catch (err) {
        console.error(err);
      }
    }
    if (extraBox.childElementCount) form.append(extraBox);

    const actions = make('div', 'actions');
    const create = make('button', 'primary', 'Create thread');
    create.type = 'submit';
    create.disabled = off || full;
    if (off) create.title = TITLE_OFF;
    else if (full) create.title = TITLE_FULL;
    const problem = make('p', 'ext-thread-note bad');
    problem.hidden = true;
    problem.setAttribute('role', 'alert');
    actions.append(create);
    form.append(actions, problem);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      create.disabled = true;
      problem.hidden = true;
      // The plan box is only a statement while another thread is the writer: the thread is read-only by that rule, and it must not stay in
      // plan mode once it is made the writer. So only a box the person could change is sent.
      const request = { project: p.id, model: select.value, plan: plan.disabled ? false : plan.checked };
      const typed = name.value.trim();
      if (typed) request.name = typed;
      for (const extra of extras) {
        try {
          Object.assign(request, extra.fields() ?? {});
        } catch (err) {
          problem.textContent = err.message;
          problem.hidden = false;
          create.disabled = false;
          return;
        }
      }
      try {
        const data = await MU.api('/api/threads', request);
        const made = (data.threads ?? []).find(t => t.id === data.thread);
        T.adopt(data);
        MU.closeDrawer();
        MU.toast(`Created ${made?.name ?? 'the thread'}.`);
        MU.el.input.focus({ preventScroll: true });
      } catch (err) {
        problem.textContent = err.message;
        problem.hidden = false;
        create.disabled = false;
      }
    });
    body.append(form);

    body.append(projectOptions(p, syncPlan));
    body.append(closedSection(p));
    body.append(moveSection(p));
    queueMicrotask(() => name.focus());
  }

  function nextNumber(list) {
    const names = new Set(list.map(t => t.name.toLowerCase()));
    for (let n = 2; n < 1000; n += 1) if (!names.has(`thread ${n}`)) return n;
    return list.length + 1;
  }

  // The per-project switch "Several threads may write in this folder" (amend-29). It is off by default; turning it on takes the read-only
  // rule away for this project and shows a notice that says what can go wrong. Builds and restores still wait until every thread is idle.
  function projectOptions(p, onChange = () => {}) {
    const section = make('section', 'ext-thread-section');
    section.append(make('h3', 'ext-thread-h', 'This project'));
    const row = make('label', 'setting-switch ext-thread-switch');
    const sw = make('span', 'switch');
    const input = make('input');
    input.type = 'checkbox';
    input.checked = multiWriter();
    input.setAttribute('aria-label', 'Several threads may write in this folder');
    sw.append(input, make('span', 'switch-track'));
    const text = make('span', 'setting-text');
    text.append(make('span', 'field-label', 'Several threads may write in this folder'), make('span', 'field-note', 'Off by default: one thread writes and the others are read-only. On, every thread writes in the project folder and each turn keeps a snapshot for Rewind. Builds and restores still wait until every thread is idle.'));
    row.append(sw, text);
    const notice = make('div', 'ext-thread-warning');
    notice.setAttribute('role', 'note');
    notice.append(make('span', 'ext-thread-warning-text', MULTI_NOTICE));
    const hide = make('button', 'ghost small', 'Don’t show again');
    hide.type = 'button';
    hide.addEventListener('click', () => {
      try {
        localStorage.setItem(HIDE_NOTICE_KEY, '1');
      } catch {
        // The notice stays for this page only.
      }
      notice.hidden = true;
      noticeHidden = true;
    });
    const ok = make('button', 'ghost small', 'OK');
    ok.type = 'button';
    ok.addEventListener('click', () => { notice.hidden = true; });
    notice.append(ok, hide);
    let noticeHidden = false;
    try {
      noticeHidden = localStorage.getItem(HIDE_NOTICE_KEY) === '1';
    } catch {
      noticeHidden = false;
    }
    notice.hidden = !input.checked || noticeHidden;
    const status = make('p', 'ext-thread-note');
    status.setAttribute('role', 'status');
    status.hidden = true;
    input.addEventListener('change', async () => {
      input.disabled = true;
      status.hidden = true;
      try {
        T.adopt(await MU.api('/api/threads/multiwriter', { project: p.id, on: input.checked }));
        onChange();
        notice.hidden = !input.checked || noticeHidden;
        status.textContent = input.checked ? 'Saved. Every thread of this project may write in its folder.' : 'Saved. One thread writes; the others are read-only.';
        status.hidden = false;
      } catch (err) {
        input.checked = !input.checked;
        status.textContent = err.message;
        status.classList.add('bad');
        status.hidden = false;
      }
      input.disabled = false;
    });
    section.append(row, notice, status);
    return section;
  }

  function fmtDate(ts) {
    return Number.isFinite(ts) ? new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  }

  function closedSection() {
    const section = make('section', 'ext-thread-section');
    section.append(make('h3', 'ext-thread-h', 'Closed threads'));
    const closed = Array.isArray(state().closedThreads) ? state().closedThreads : [];
    if (!closed.length) {
      section.append(make('p', 'ext-thread-empty', 'No closed threads. A thread you close keeps its chat here.'));
      return section;
    }
    const list = make('ul', 'ext-thread-closed');
    for (const t of closed) {
      const li = make('li', 'ext-thread-closed-row');
      li.append(make('span', 'ext-thread-closed-name', t.name), make('span', 'ext-thread-closed-when', fmtDate(t.closedAt)));
      const reopen = make('button', 'ghost small', 'Reopen');
      reopen.type = 'button';
      reopen.setAttribute('aria-label', `Reopen ${t.name}`);
      reopen.disabled = state().threadsOff === true || threadList().length >= MAX_OPEN;
      if (threadList().length >= MAX_OPEN) reopen.title = TITLE_FULL;
      reopen.addEventListener('click', async () => {
        reopen.disabled = true;
        const data = await call('/api/threads/reopen', { thread: t.id });
        if (data) {
          MU.toast(`${t.name} is open again.`);
          MU.refreshDrawer();
        } else {
          reopen.disabled = false;
        }
      });
      const remove = make('button', 'ghost small danger', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${t.name}`);
      remove.addEventListener('click', async () => {
        const yes = await MU.confirm({ title: `Remove ${t.name}?`, body: `Remove ${t.name} and its chat? This cannot be undone.`, action: 'Remove thread', tone: 'danger', focusCancel: true });
        if (!yes) return;
        const data = await call('/api/threads/remove', { thread: t.id });
        if (data) {
          MU.toast(`${t.name} was removed.`);
          MU.refreshDrawer();
        }
      });
      li.append(reopen, remove);
      list.append(li);
    }
    section.append(list);
    return section;
  }

  // Export and import of the project's threads (GET /api/project/export, POST /api/project/import).
  function moveSection(p) {
    const section = make('section', 'ext-thread-section');
    section.append(make('h3', 'ext-thread-h', 'Move chats'));
    section.append(make('p', 'ext-thread-note', 'Export saves every thread of this project and its chat in one file. Import adds the threads of such a file to this project as new threads; nothing here is replaced.'));
    const row = make('div', 'actions');
    const exportLink = make('a', 'ghost small ext-thread-export', 'Export threads');
    exportLink.href = `/api/project/export?project=${encodeURIComponent(p.id)}`;
    exportLink.download = '';
    exportLink.setAttribute('role', 'button');
    const pick = make('button', 'ghost small', 'Import threads…');
    pick.type = 'button';
    const file = make('input', 'ext-thread-file');
    file.type = 'file';
    file.accept = 'application/json,.json';
    file.hidden = true;
    file.setAttribute('aria-label', 'Project file to import');
    pick.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      pick.disabled = true;
      try {
        let data;
        try {
          data = JSON.parse(await chosen.text());
        } catch {
          throw new Error('That file is not valid JSON.');
        }
        const answer = await MU.api('/api/project/import', { project: p.id, data });
        T.adopt(answer);
        const n = Array.isArray(answer.imported) ? answer.imported.length : 0;
        MU.toast(`Imported ${n} ${n === 1 ? 'thread' : 'threads'}.`);
        MU.refreshDrawer();
      } catch (err) {
        MU.toast(err.message, 'bad');
      }
      pick.disabled = false;
    });
    row.append(exportLink, pick, file);
    section.append(row);
    return section;
  }

  function openNewDialog() {
    if (!project()) {
      MU.openAddForm?.();
      MU.toast('Add a project folder first.', 'bad');
      return;
    }
    MU.openDrawer('New thread', renderNewThread);
  }

  // ---------- keys ----------

  // Ctrl+T opens the New thread panel in the desktop app (a browser keeps Ctrl+T for its own new tab). In the Browser pane tab it belongs to
  // the browser (it opens a browser tab, public/ext-browser.js), so it is left alone while the pane has the focus. Ctrl+Tab and Ctrl+Shift+Tab
  // go to the next and the previous thread, desktop app only.
  document.addEventListener('keydown', e => {
    if (!IS_DESKTOP || e.defaultPrevented || e.altKey || e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (!e.shiftKey && e.key.toLowerCase() === 't') {
      if (MU.el.pane && !MU.el.pane.hidden && MU.el.pane.contains(document.activeElement) && MU.pane?.active?.() === 'browser') return;
      if (MU.dialogOpen?.()) return;
      e.preventDefault();
      openNewDialog();
    } else if (e.key === 'Tab') {
      const list = threadList();
      if (list.length < 2 || MU.dialogOpen?.()) return;
      e.preventDefault();
      const at = list.findIndex(t => t.id === activeId());
      const next = list[(at + (e.shiftKey ? -1 : 1) + list.length) % list.length];
      choose(next.id);
    }
  });
  (window.MuseShortcutRows = window.MuseShortcutRows || []).push(
    { keys: [MOD, 'T'], action: 'New thread (desktop app).' },
    { keys: [MOD, 'Tab'], action: 'Next thread (desktop app). Shift for the previous one.' },
  );

  // ---------- events ----------

  // A finished run in a thread that is not on screen is unread. Runs that ended before this window opened come from the Agents board snapshot.
  function takeRun(run) {
    if (!run || typeof run.scope !== 'string' || !Number.isFinite(run.endedAt)) return;
    if ((ended.get(run.scope) ?? 0) < run.endedAt) ended.set(run.scope, run.endedAt);
  }

  window.addEventListener('plenum:event', e => {
    const ev = e.detail;
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'activity' && ev.op === 'run-end') {
      takeRun(ev.run);
      paint();
    } else if (ev.type === 'hello') {
      loadSnapshot();
    }
  });

  // A card was raised in a thread that is not on screen (app.js). The tab turns amber from the state's waiting count, which the server
  // publishes with the card; this only makes sure the row is drawn again at once.
  window.addEventListener('plenum:thread-waiting', () => {
    drawnSignature = '';
    paint();
  });

  async function loadSnapshot() {
    try {
      const snap = await MU.api('/api/activity');
      for (const run of Array.isArray(snap?.recent) ? snap.recent : []) takeRun(run);
      paint();
    } catch {
      // The tabs work without the history of finished runs.
    }
  }

  // ---------- opening a thread from elsewhere (the Agents board, History) ----------

  // Shows the thread with this scope id, switching to its project first when it belongs to another one. A project id shows that project.
  async function open(scope) {
    if (typeof scope !== 'string' || !scope) return false;
    const projects = state().projects ?? [];
    const owner = projects.find(p => scope === p.id || scope.startsWith(`${p.id}-t`));
    if (!owner) return false;
    try {
      if (owner.id !== state().activeProject) await MU.update({ activeProject: owner.id });
      if (scope !== owner.id || activeId() !== owner.id) await T.switchTo(scope);
      return true;
    } catch (err) {
      MU.toast(err.message, 'bad');
      return false;
    }
  }

  // ---------- wiring ----------

  Object.assign(T, {
    header: headerExtra,       // the thread header row's slot for other panels (pro-02's branch chip): add a node, and call T.repaint()
    repaint: () => { drawnSignature = ''; paint(); },
    openNew: openNewDialog,
    open,
    focusTab: id => bar.querySelector(`.ext-thread-btn[data-thread="${CSS.escape(String(id))}"]`)?.focus({ preventScroll: true }),
    unread: id => { const t = threadList().find(x => x.id === id); return Boolean(t) && unread(t); },
    status: id => { const t = threadList().find(x => x.id === id); return t ? statusOf(t) : ''; },
  });

  // The Agents board opens a run by its scope (MuseUI.board.openScope); a thread's scope is not a project id, so it is taken here.
  function wrapBoard() {
    const board = MU.board;
    if (!board || typeof board.openScope !== 'function' || board.openScope.threadAware) return;
    const original = board.openScope;
    const wrapped = scope => {
      if (typeof scope === 'string' && (state().projects ?? []).some(p => scope.startsWith(`${p.id}-t`))) {
        open(scope);
        return;
      }
      original(scope);
    };
    wrapped.threadAware = true;
    board.openScope = wrapped;
  }
  wrapBoard();
  window.addEventListener('load', wrapBoard);
  setTimeout(wrapBoard, 1500);

  T.onRender(paint);
  narrowQuery?.addEventListener?.('change', () => { drawnSignature = ''; paint(); });
  window.addEventListener('plenum:connection', () => paint());
  paint();
  loadSnapshot();
})();
