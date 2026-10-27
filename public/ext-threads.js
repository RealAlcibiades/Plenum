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
//   div.ext-thread-split     split view (threads phase 2): a second open thread of the project on the right, beside the one on the left
//                            (the active thread). Ctrl-click a tab, Open beside, or Ctrl+Shift+\ opens it. Built on the first opening only.
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
  // ---------- split view (threads phase 2): constants and what the window keeps ----------

  const SPLIT_KEY = 'plenum.threads.split';
  const NEED_TWO = 'Split view needs a second thread. Make one with + Thread.';
  const COMMANDS_LEFT = 'Commands run in the left message box. Swap sides to run one for this thread.';
  const DRIVE_KEEP = 'A model is driving, so the left pane stays in view with its drive bar.';
  const FOLD_NARROW = 'The window is narrower than 1100 px, so one thread shows at a time.';
  const FOLD_PANE = 'The side pane is open, so one thread shows at a time.';
  const IDLE_HINT = 'Enter to send · Shift+Enter for a new line';
  const BUSY_HINT = 'Working… Esc stops · Enter queues what you type';
  const PLAN_TITLE = 'Plan mode: no file edits or commands in this thread. Swap sides to change it.';
  const MODEL_TITLE = 'The model of this thread. Swap sides to change it.';
  const DIVIDER_LABEL = 'Resize the two panes';
  const DIVIDER_TITLE = 'Drag to resize. Double-click for equal halves.';
  const LOADING = 'Loading the chat…';
  const QUEUE_ONE = '1 message queued. It starts when the current run in this thread ends.';
  const CLEAR_TITLE = 'Drop the waiting messages. The run in progress is not stopped';
  const EDIT_FULL = 'The composer already has text. Send or clear it first.';
  const RATIOS = [35, 40, 45, 50, 55, 60, 65];
  const SP = MU.threads.split ?? null;   // app.js's hook; without it split view stays off
  const WIDE = window.matchMedia ? window.matchMedia('(min-width: 1100px)') : null;
  const appEl = document.getElementById('app');
  // The widths and each project's right thread, as plenum.threads.split keeps them. Read once, here, next to the seen marks.
  const remembered = (() => {
    const kept = { ratio: 50, beside: {} };
    try {
      const value = JSON.parse(localStorage.getItem(SPLIT_KEY) || '{}');
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (RATIOS.includes(value.ratio)) kept.ratio = value.ratio;
        if (value.beside && typeof value.beside === 'object' && !Array.isArray(value.beside)) {
          for (const [project, thread] of Object.entries(value.beside)) {
            if (project && typeof thread === 'string' && thread) kept.beside[project] = thread;
          }
        }
      }
    } catch {
      // Without storage the split view starts closed, at the even widths.
    }
    const keys = Object.keys(kept.beside);
    for (const key of keys.slice(0, Math.max(0, keys.length - 50))) delete kept.beside[key];
    return kept;
  })();
  // The right thread of each project during this page. Closing split view keeps it here, so Ctrl+Shift+\ opens it again.
  const lastBeside = new Map();
  // messages: the saved chat of the right thread (null until read); unsaved: the messages sent from this pane that the saved chat does not
  // have yet; seq: the number of reads asked, so an answer that a newer read has overtaken is dropped.
  const split = { project: null, beside: null, ratio: remembered.ratio, focus: 'primary', lastActive: null, messages: null, unsaved: [], seq: 0, loadError: '', gen: 0, wasBusy: false, lastRight: '', lastLeft: '' };
  let pending = null;          // { id, messages }: the left thread's chat, handed to the right pane by swap()
  let wrapped = false;         // the parts are in the page (ensureWrapped ran)
  let besideStream = null;     // the .stream now in the right transcript
  let besideQueueDrawn = [];   // the queued messages the right queue rows show
  let readOnlySig = '';        // what the right read-only line was built for
  let dividerDrag = false;     // a pointer drag on the divider is going on
  const drafts = new Map();    // thread id -> the text typed in the right box while another thread is there

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
      split.beside, split.focus, Boolean(split.beside) && folded(),
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
    if (t.writer === false) label.append(shieldEl(t));
    return label;
  }

  // The read-only shield of a thread: its tab, its pane's head and the read-only line say the same.
  function shieldEl(t) {
    const shield = MU.icon('shield', 'ext-thread-shield');
    const tip = writerOf() ? `Read-only: ${writerOf().name} is the writer` : 'Read-only';
    shield.setAttribute('role', 'img');
    shield.setAttribute('aria-label', tip);
    const wrap = make('span', 'ext-thread-ro');
    wrap.title = tip;
    wrap.append(shield);
    return wrap;
  }

  // Where a thread sits while split view is on: 'on the left' for the active thread, 'on the right' for the thread beside it.
  function sideOf(t) {
    if (!split.beside) return '';
    if (t.id === split.beside) return 'on the right';
    return t.id === activeId() ? 'on the left' : '';
  }

  function accessibleName(t) {
    const status = statusOf(t);
    return [t.name, STATUS_TITLE[status], t.writer === false ? 'read-only' : '', sideOf(t)].filter(Boolean).join(', ');
  }

  function tabEl(t) {
    const selected = t.id === activeId();
    const wrap = make('div', 'ext-thread-tab');
    wrap.setAttribute('role', 'presentation');
    wrap.dataset.thread = t.id;
    if (selected) wrap.dataset.selected = 'true';
    if (split.beside && t.id === split.beside) wrap.dataset.beside = 'true';
    // The pane that has the focus marks its tab: the left thread's, or the right thread's.
    if (split.beside && (split.focus === 'primary' ? selected : t.id === split.beside)) wrap.dataset.paneFocus = 'true';
    const btn = make('button', 'ext-thread-btn');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(selected));
    btn.setAttribute('aria-label', accessibleName(t));
    btn.tabIndex = selected ? 0 : -1;
    btn.dataset.thread = t.id;
    const side = sideOf(t);
    if (side === 'on the left') btn.title = 'On the left';
    else if (side === 'on the right') btn.title = `On the right. ${MOD}-click to close split view`;
    else if (threadList().length >= 2) btn.title = `${MOD}-click to show it on the right`;
    btn.append(tabLabel(t));
    btn.addEventListener('click', e => {
      // Ctrl-click (Cmd-click) puts the thread on the right, or closes split view when it is there already.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        toggleBeside(t.id);
      } else {
        goTo(t.id);
      }
    });
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
    // A right click on a tab opens the same "…" menu.
    wrap.addEventListener('contextmenu', e => {
      if (renaming === t.id) return;
      e.preventDefault();
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
        ...list.map(t => ({ label: t.name, checked: t.id === current.id, status: statusOf(t), run: () => goTo(t.id) })),
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
    paintSplit();
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
    if (split.beside && wrapped && !besideEl.hidden) markSeen(split.beside);
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
    const parts = readOnlyParts(t);
    readOnlyLine.replaceChildren(...parts);
    readOnlyLine.hidden = parts.length === 0;
    header.hidden = parts.length === 0 && !headerExtra.childElementCount;
  }

  // The read-only line of a thread that is not the writer: the words and the two buttons. Nothing for the writer, or while several threads
  // may write. The header row and the right pane of split view use the same parts.
  function readOnlyParts(t) {
    if (!t || t.writer !== false || multiWriter()) return [];
    const writer = writerOf();
    const text = make('span', 'ext-thread-readonly-text', `Read-only: ${writer ? writer.name : 'another thread'} is this project’s writer, and two writers would share this folder.`);
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
    return [text, make1, several];
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
    if (canSplit()) items.push(...splitItemsOf(t));
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
    // Ctrl+Enter (Cmd+Enter) on a focused tab is the keyboard form of Ctrl-click.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      toggleBeside(e.currentTarget.dataset.thread);
      return;
    }
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
      // Ctrl+Tab cycles the thread on the left; the thread on the right is passed over.
      const list = threadList().filter(t => t.id !== split.beside);
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
    { keys: [MOD, 'Shift', '\\'], action: 'Split view on or off. The last thread on the right, or the next one, opens there.' },
    { keys: [MOD, 'Click'], action: 'On a thread tab: show it on the right, or close split view.' },
    { keys: [MOD, 'Enter'], action: `On a focused thread tab: the same as ${MOD}-click.` },
    { keys: [MOD, '1'], action: 'Split view: go to the left message box (desktop app).' },
    { keys: [MOD, '2'], action: 'Split view: go to the right message box (desktop app).' },
    { keys: ['F6'], action: 'Move between the sidebar, the chats, the message boxes and the side pane. Shift for back.' },
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
      // The right pane's transcript is read again when its thread's run ends, whichever window started the run.
      if (ev.run?.scope === split.beside) loadBeside();
      paint();
    } else if (ev.type === 'hello') {
      loadSnapshot();
      if (split.beside) loadBeside();
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

  // ---------- split view (threads phase 2) ----------

  // The parts, built once. The first opening puts them into the page (ensureWrapped); until then nothing in the page moves.
  const splitEl = make('div', 'ext-thread-split');
  const primaryEl = make('div', 'ext-thread-pane ext-thread-primary');
  const dividerEl = make('div', 'ext-thread-divider');
  const besideEl = make('section', 'ext-thread-pane ext-thread-beside');
  besideEl.dataset.threadPane = 'beside';
  besideEl.hidden = true;
  dividerEl.title = DIVIDER_TITLE;
  dividerEl.tabIndex = 0;
  dividerEl.hidden = true;
  dividerEl.setAttribute('role', 'separator');
  dividerEl.setAttribute('aria-orientation', 'vertical');
  dividerEl.setAttribute('aria-label', DIVIDER_LABEL);
  dividerEl.setAttribute('aria-valuemin', String(RATIOS[0]));
  dividerEl.setAttribute('aria-valuemax', String(RATIOS[RATIOS.length - 1]));

  // A pane's head: swatch, name, marks, a line for screen readers, Show, Swap sides (the right pane only) and ×.
  function paneHead(side) {
    const el = make('div', 'ext-thread-pane-head');
    const sw = make('span', 'sw');
    sw.setAttribute('aria-hidden', 'true');
    const name = make('h2', 'ext-thread-pane-name');
    const marks = make('span', 'ext-thread-pane-marks');
    const spacer = make('span', 'ext-thread-pane-spacer');
    spacer.setAttribute('aria-hidden', 'true');
    const status = make('span', 'sr ext-thread-pane-status');
    status.setAttribute('role', 'status');
    const show = make('button', 'ghost small ext-thread-pane-show');
    show.type = 'button';
    show.hidden = true;
    const swap = side === 'beside' ? make('button', 'ghost small ext-thread-pane-swap', 'Swap sides') : null;
    if (swap) swap.type = 'button';
    const close = make('button', 'icon-btn ext-thread-pane-close');
    close.type = 'button';
    close.append(MU.icon('x'));
    el.append(sw, name, marks, spacer, status, show, ...(swap ? [swap] : []), close);
    el.hidden = true;
    return { el, sw, name, marks, status, show, swap, close, key: '' };
  }
  const leftHead = paneHead('primary');
  const rightHead = paneHead('beside');
  leftHead.show.addEventListener('click', () => showPane('beside'));
  rightHead.show.addEventListener('click', () => showPane('primary'));
  leftHead.close.addEventListener('click', () => closeLeft());
  rightHead.close.addEventListener('click', () => closeSplit());
  rightHead.swap.addEventListener('click', () => swap());

  // The right pane: a read-only line (the thread is not the writer), its transcript, and its own composer.
  const rightReadOnly = make('div', 'ext-threads-header ext-thread-pane-readonly');
  rightReadOnly.setAttribute('role', 'status');
  rightReadOnly.hidden = true;
  const rightReadOnlyLine = make('div', 'ext-thread-readonly');
  rightReadOnly.append(rightReadOnlyLine);
  const rightChat = make('section', 'ext-thread-pane-chat');
  rightChat.tabIndex = -1;
  rightChat.setAttribute('aria-live', 'off');
  const rightDock = make('div', 'composer-wrap');
  const rightQueue = make('div', 'queue-line');
  rightQueue.setAttribute('role', 'status');
  rightQueue.hidden = true;
  const rightQueueText = make('span', 'ql-text');
  const rightQueueList = make('ul', 'queue-list');
  const rightQueueClear = make('button', 'ghost small', 'Clear queue');
  rightQueueClear.type = 'button';
  rightQueueClear.title = CLEAR_TITLE;
  rightQueue.append(rightQueueText, rightQueueList, rightQueueClear);
  const rightForm = make('form', 'composer');
  const rightInput = make('textarea', 'ext-thread-pane-input');
  rightInput.rows = 1;
  rightInput.spellcheck = false;
  const rightBar = make('div', 'composer-bar');
  const rightModel = make('span', 'pill ext-thread-pane-model');
  const rightModelSw = make('span', 'sw');
  rightModelSw.setAttribute('aria-hidden', 'true');
  const rightModelName = make('span', 'ext-thread-pane-model-name');
  rightModel.append(rightModelSw, rightModelName);
  const rightPlan = MU.ui.pill('Plan', 'accent');
  rightPlan.hidden = true;
  const rightSend = make('button', 'send');
  rightSend.type = 'submit';
  rightSend.append(MU.icon('arrow-up', 'ic-send'), MU.icon('stop', 'ic-stop'));
  rightBar.append(rightModel, rightPlan, rightSend);
  rightForm.append(rightInput, rightBar);
  const rightHint = make('span', 'hint', IDLE_HINT);
  const rightFoot = make('div', 'foot');
  rightFoot.append(rightHint);
  rightDock.append(rightQueue, rightForm, rightFoot);
  besideEl.append(rightHead.el, rightReadOnly, rightChat, rightDock);

  // Whether the window is too narrow for two panes (under 1100 px, or the side pane open): one pane shows then.
  const phone = () => document.documentElement.dataset.surface === 'phone';
  const folded = () => !(WIDE ? WIDE.matches : true) || appEl?.hasAttribute('data-pane-open') === true;
  const foldReason = () => (WIDE && !WIDE.matches ? FOLD_NARROW : FOLD_PANE);
  const driving = () => Array.isArray(state().drives) && state().drives.length > 0;
  const infoOf = id => threadList().find(t => t.id === id) ?? null;
  const planOn = t => t.chatMode === 'plan' || project()?.chatMode === 'plan';
  const canSplit = () => Boolean(SP) && !phone() && state().threadsOff !== true && threadList().length >= 2;
  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };
  const setAttr = (node, name, value) => {
    const v = String(value);
    if (node.getAttribute(name) !== v) node.setAttribute(name, v);
  };

  // Puts the parts into the page, after the tab row: the thread header row through the composer dock move into the left pane, in order.
  // Once done it stays. Returns false when the page is not as expected, and then split view stays off.
  function ensureWrapped() {
    if (wrapped) return true;
    const dock = MU.el.composerWrap;
    if (!dock || dock.parentElement !== bar.parentElement || !(bar.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    const had = document.activeElement;
    bar.after(splitEl);
    splitEl.append(primaryEl, dividerEl, besideEl);
    primaryEl.append(leftHead.el);
    for (let node = splitEl.nextSibling; node; ) {
      const next = node.nextSibling;
      primaryEl.append(node);
      if (node === dock) break;
      node = next;
    }
    wrapped = true;
    MU.el.chat.scrollTo({ top: MU.el.chat.scrollHeight, behavior: 'instant' });   // a moved scroller starts at the top
    if (had instanceof HTMLElement && had !== document.body && had.isConnected) had.focus({ preventScroll: true });
    return true;
  }

  // Remembers the widths and each project's right thread. A project keeps its right thread only while split view is on; closing it
  // removes the entry. Every call is inside try, as the seen marks are.
  function remember() {
    if (split.project) {
      delete remembered.beside[split.project];
      if (split.beside) remembered.beside[split.project] = split.beside;
    }
    remembered.ratio = split.ratio;
    const keys = Object.keys(remembered.beside);
    for (const key of keys.slice(0, Math.max(0, keys.length - 50))) delete remembered.beside[key];
    try {
      localStorage.setItem(SPLIT_KEY, JSON.stringify(remembered));
    } catch {
      // The split view is kept for this page only.
    }
  }

  // Changes the right thread. This is the one place that does it: the text in the right box goes with its thread.
  function setBeside(id) {
    const next = id || null;
    if (split.beside === next) return;
    if (split.beside) {
      if (rightInput.value.trim()) drafts.set(split.beside, rightInput.value);
      else drafts.delete(split.beside);
    }
    split.beside = next;
    if (next && split.project) lastBeside.set(split.project, next);
    split.gen += 1;                       // an answer for the thread that was there is dropped
    split.wasBusy = false;
    split.lastRight = '';
    split.loadError = '';
    split.unsaved = [];
    split.messages = pending && pending.id === next ? pending.messages : null;
    pending = null;
    besideQueueDrawn = [];
    readOnlySig = '';
    rightInput.value = next ? drafts.get(next) ?? '' : '';
    remember();
    if (next) {
      drawBeside({ bottom: true });
      loadBeside();
    }
  }

  // Opens a thread on the right (Ctrl-click, Open beside, Ctrl+Enter on a tab, Ctrl+Shift+\). The message box gets the focus.
  function openBeside(id) {
    if (!canSplit() || !id || id === activeId() || !infoOf(id)) return false;
    setBeside(id);
    split.focus = 'beside';
    paint();
    rightInput.focus({ preventScroll: true });
    return true;
  }

  // Ends split view. No thread is closed: both stay open as tabs.
  function closeSplit() {
    if (!split.beside) return;
    const hadFocus = besideEl.contains(document.activeElement);
    setBeside(null);
    split.focus = 'primary';
    paint();
    if (hadFocus) MU.el.input.focus({ preventScroll: true });
  }

  // Ctrl-click on a tab: puts the thread on the right, or closes split view when it is there already.
  function toggleBeside(id) {
    if (!id || id === activeId()) return;
    if (split.beside === id) closeSplit();
    else openBeside(id);
  }

  // Ctrl+Shift+\: closes split view; else opens the thread this project had on the right, or the next tab after the left one.
  function toggleSplit() {
    if (split.beside) {
      closeSplit();
      return;
    }
    if (threadList().length < 2) {
      MU.toast(NEED_TWO);
      return;
    }
    if (!canSplit()) return;
    const left = activeId();
    const again = lastBeside.get(split.project);
    if (again && again !== left && infoOf(again)) {
      openBeside(again);
      return;
    }
    const list = threadList();
    const at = list.findIndex(t => t.id === left);
    openBeside(list[(at + 1) % list.length].id);
  }

  // Shows one pane while split view is folded (or moves the focus to it). While a model drives, the left pane stays in view.
  function showPane(side) {
    if (!split.beside) return;
    let target = side;
    if (target === 'beside' && folded() && driving()) {
      MU.toast(DRIVE_KEEP);
      target = 'primary';
    }
    split.focus = target;
    paint();
    (target === 'beside' ? rightInput : MU.el.input).focus({ preventScroll: true });
  }

  // A click on a tab (the click table of section 1.5).
  function goTo(id) {
    if (split.beside && id === split.beside) {
      showPane('beside');
      return;
    }
    if (split.beside && id === activeId()) {
      showPane('primary');
      return;
    }
    choose(id);
  }

  // Swap sides: the right thread becomes the active one (the server call), and the thread that was on the left goes to the right. Both
  // message boxes change sides with their threads.
  async function swap() {
    const left = activeId();
    const right = split.beside;
    if (!left || !right) return false;
    const leftText = MU.el.input.value;
    const rightText = rightInput.value;
    // The render that follows the switch puts the old left thread on the right (paintSplit); pending hands it the chat it had, so the
    // right pane does not flash "Loading".
    pending = { id: left, messages: Array.isArray(state().messages) ? state().messages.slice() : null };
    try {
      await T.switchTo(right);
    } catch (err) {
      pending = null;
      MU.toast(err.message, 'bad');
      return false;
    }
    if (split.beside !== left) return false;
    MU.el.input.value = rightText;
    MU.el.input.dispatchEvent(new Event('input', { bubbles: true }));
    rightInput.value = leftText;
    drafts.delete(right);
    return true;
  }

  // The × of the left pane: the right thread takes the whole column (swap, then close).
  async function closeLeft() {
    if (await swap()) closeSplit();
  }

  // The split items of a thread's "…" menu: Open beside, or Swap sides and Close split view for the two threads on screen.
  function splitItemsOf(t) {
    const on = Boolean(split.beside);
    const isLeft = t.id === activeId();
    const isRight = on && t.id === split.beside;
    if (on && (isLeft || isRight)) {
      const rightName = infoOf(split.beside)?.name ?? '';
      return [
        { label: 'Swap sides', title: 'Put each thread on the other side', run: () => swap() },
        { label: 'Close split view', title: `Close the right pane. ${rightName} stays open as a tab.`, run: () => closeSplit() },
      ];
    }
    if (isLeft) return [];
    const leftName = infoOf(activeId())?.name ?? '';
    return [{ label: 'Open beside', title: `Show ${t.name} on the right, next to ${leftName}`, run: () => openBeside(t.id) }];
  }

  // Reads the right thread's chat again (GET /api/threads/chat). An answer for a thread that is no longer there is dropped (the generation),
  // and so is an answer that a newer read has overtaken (the sequence). A message sent from this pane that the answer does not have yet
  // stays on screen after the saved messages, until a saved chat has it.
  async function loadBeside() {
    const id = split.beside;
    const pid = state().activeProject;
    if (!SP || !id || !pid) return;
    const gen = split.gen;
    const mine = (split.seq += 1);
    const asked = Date.now();
    let data = null;
    let error = '';
    try {
      data = await MU.api(`/api/threads/chat?project=${encodeURIComponent(pid)}&thread=${encodeURIComponent(id)}`);
    } catch (err) {
      error = err.message;
    }
    if (gen !== split.gen || mine !== split.seq) return;
    if (error) {
      split.loadError = error;           // a closed thread answers 404; the next state turns split view off
    } else {
      const saved = Array.isArray(data?.messages) ? data.messages : [];
      const idle = !T.isRunning(id);
      split.unsaved = split.unsaved.filter(u => !saved.some(m => m.role === 'user' && m.content === u.text && (m.ts ?? 0) >= u.ts - 2000) && !(idle && asked - u.ts > 5000));
      split.messages = saved;
      split.loadError = '';
    }
    drawBeside();
  }

  // A line in the right transcript: loading (with a spinner), empty, or could not be read (tone bad).
  function stateLine(text, tone = '', spin = false) {
    const p = make('p', 'ext-thread-pane-state');
    if (tone) p.dataset.tone = tone;
    if (spin) p.append(make('span', 'spinner'));
    p.append(text);
    return p;
  }

  // Draws the right transcript: the saved chat, or the line that says it loads or could not be read. setBeside, loadBeside and a message
  // sent from the right pane call it; a render never does, so a redraw never rebuilds the transcript.
  function drawBeside({ bottom = false } = {}) {
    const id = split.beside;
    const info = infoOf(id);
    if (!SP || !id || !info) return;
    const near = rightChat.scrollHeight - rightChat.scrollTop - rightChat.clientHeight < 180;
    const top = rightChat.scrollTop;
    let stream;
    if (Array.isArray(split.messages)) {
      const shown = [...split.messages, ...split.unsaved.map(u => ({ role: 'user', kind: 'chat', content: u.text, ts: u.ts }))];
      stream = SP.stream(id, shown);
      if (!stream.childElementCount) stream.append(stateLine(`No messages in ${info.name} yet. Type below to start.`));
    } else if (split.loadError) {
      stream = make('div', 'stream');
      const line = stateLine(`The chat of ${info.name} could not be read: ${split.loadError}`, 'bad');
      const again = make('button', 'ghost small', 'Try again');
      again.type = 'button';
      again.addEventListener('click', () => loadBeside());
      line.append(again);
      stream.append(line);
    } else {
      stream = make('div', 'stream');
      stream.append(stateLine(LOADING, '', true));
    }
    rightChat.replaceChildren(stream);
    besideStream = stream;
    rightChat.scrollTo({ top: bottom || near ? rightChat.scrollHeight : top, behavior: 'instant' });
  }

  // One queued message of the right pane: its first words (the whole text in the title), Edit and Remove. The same shape as app.js's row.
  function queueRowEl(item, i) {
    const row = make('li', 'queue-item');
    const flat = item.text.replace(/\s+/g, ' ');
    const label = make('span', 'q-text', flat.length > 80 ? `${flat.slice(0, 80)}…` : flat);
    label.title = item.text;
    const edit = make('button', 'ghost small', 'Edit');
    edit.type = 'button';
    edit.setAttribute('aria-label', `Edit queued message ${i + 1}`);
    edit.addEventListener('click', () => editQueuedBeside(item));
    const remove = make('button', 'ghost small', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove queued message ${i + 1}`);
    remove.addEventListener('click', () => removeQueuedBeside(item));
    row.append(label, edit, remove);
    return row;
  }

  function editQueuedBeside(item) {
    if (rightInput.value.trim()) {
      MU.toast(EDIT_FULL, 'bad');
      return;
    }
    if (!SP.unqueue(item)) return;
    rightInput.value = item.text;
    paint();
    rightInput.focus({ preventScroll: true });
  }

  function removeQueuedBeside(item) {
    if (!SP.unqueue(item)) return;
    MU.toast('Removed 1 queued message');
    paint();
  }

  // Sends the right box's text to the right thread. A command is not sent (it runs in the left box). A spend-cap refusal gives the text back.
  function sendBeside() {
    const id = split.beside;
    const text = rightInput.value.trim();
    if (!id || !text) return;
    if (text.startsWith('/')) {
      MU.toast(COMMANDS_LEFT, 'bad');
      return;
    }
    rightInput.value = '';
    drafts.delete(id);
    SP.send(id, text)
      .then(refused => {
        if (!refused || split.beside !== id) return;
        // A refused send never reached the chat: its message leaves the transcript, and a spend-cap refusal gives the text back.
        split.unsaved = split.unsaved.filter(u => u.text !== text);
        if (refused === 'policy' && !rightInput.value) rightInput.value = text;
        drawBeside();
      })
      .catch(err => MU.toast(err.message, 'bad'));
    paint();
  }

  // Enter while the right thread runs: the text joins its queue (at most five, as the left one).
  function queueBeside() {
    const id = split.beside;
    const text = rightInput.value.trim();
    if (!id || !text) return;
    if (text.startsWith('/')) {
      MU.toast(COMMANDS_LEFT, 'bad');
      return;
    }
    const why = SP.queue(id, text);
    if (why) {
      MU.toast(why, 'bad');
      return;
    }
    rightInput.value = '';
    drafts.delete(id);
    paint();
  }

  // The right pane's read-only line: the words and the two buttons, rebuilt only when what they say has changed.
  function paintReadOnly(t) {
    const writer = writerOf();
    const sig = `${t.id}|${t.writer}|${multiWriter()}|${writer?.name}|${state().projectBusy}`;
    if (sig !== readOnlySig) {
      readOnlySig = sig;
      rightReadOnlyLine.replaceChildren(...readOnlyParts(t));
    }
    rightReadOnly.hidden = rightReadOnlyLine.childElementCount === 0;
  }

  // The right composer: the send/stop button, the hint, the model and Plan pills, and the box's labels.
  function paintRightComposer(t) {
    const running = T.isRunning(t.id);
    rightSend.classList.toggle('stop', running);
    rightSend.title = running ? 'Stop' : 'Send';
    setAttr(rightSend, 'aria-label', running ? `Stop ${t.name}` : `Send to ${t.name}`);
    setText(rightHint, running ? BUSY_HINT : IDLE_HINT);
    setAttr(rightInput, 'aria-label', `Message to ${t.name}`);
    setAttr(rightInput, 'placeholder', `Ask ${t.name} for a change, a review or a plan`);
    const model = modelOf(t);
    const provider = providerOfRef(model);
    if (provider) rightModelSw.dataset.p = provider;
    else delete rightModelSw.dataset.p;
    setText(rightModelName, MU.modelName(model));
    rightModel.title = MODEL_TITLE;
    rightPlan.hidden = !planOn(t);
    rightPlan.title = PLAN_TITLE;
  }

  // The right queue line: its count, and the rows when the queue itself has changed.
  function paintRightQueue(t) {
    const items = SP.queuedItems(t.id);
    rightQueue.hidden = items.length === 0;
    if (items.length) setText(rightQueueText, items.length === 1 ? QUEUE_ONE : `${items.length} messages queued. They start one at a time, in order.`);
    const same = items.length === besideQueueDrawn.length && items.every((item, i) => item === besideQueueDrawn[i]);
    if (same) return;
    besideQueueDrawn = [...items];
    rightQueueList.replaceChildren(...items.map(queueRowEl));
  }

  // A pane that is not the current one says, in its head's line, that its thread starts to wait or that a run in it has ended.
  function announce(head, t, before, now, current) {
    if (current || before === now) return;
    let text = '';
    if (now === 'waiting') text = `${t.name} is waiting for your approval.`;
    else if (before === 'running') text = `Reply finished in ${t.name}.`;
    if (!text) return;
    const line = (head === leftHead ? primaryEl : besideEl).hidden ? (head === leftHead ? rightHead : leftHead).status : head.status;
    line.textContent = '';
    setTimeout(() => {
      line.textContent = text;
    }, 50);
  }

  // One pane's head: its thread's swatch, name, marks, the Show button (folded only) and, for the right pane, Swap sides.
  function fillHead(head, t, other, side, fold) {
    head.el.hidden = false;
    const provider = providerOfRef(modelOf(t));
    if (provider) head.sw.dataset.p = provider;
    else delete head.sw.dataset.p;
    setText(head.name, t.name);
    const status = statusOf(t);
    const shielded = t.writer === false && !multiWriter();
    const key = `${status}|${shielded}`;
    if (head.key !== key) {
      head.key = key;
      const marks = [];
      if (status === 'waiting' || status === 'running') marks.push(dot(status));
      if (shielded) marks.push(shieldEl(t));
      head.marks.replaceChildren(...marks);
    }
    setText(head.show, `Show ${other.name}`);
    head.show.hidden = !fold;
    if (side === 'primary') {
      head.show.disabled = driving();
      head.show.title = driving() ? DRIVE_KEEP : foldReason();
    } else {
      head.show.title = foldReason();
      head.swap.title = `Show ${t.name} on the left, with the full message box`;
    }
    setAttr(head.close, 'aria-label', `Close the ${t.name} pane`);
    head.close.title = `Close this pane. ${t.name} stays open as a tab.`;
  }

  // The divider's values and the ratio the panes take (the data-ratio steps of the CSS).
  function paintDivider() {
    const left = infoOf(activeId());
    const right = infoOf(split.beside);
    setAttr(dividerEl, 'aria-valuenow', split.ratio);
    setAttr(dividerEl, 'aria-valuetext', `${left?.name ?? ''} ${split.ratio}%, ${right?.name ?? ''} ${100 - split.ratio}%`);
  }

  function setRatio(n, save = true) {
    split.ratio = n;
    splitEl.dataset.ratio = String(n);
    paintDivider();
    if (save) remember();
  }

  // The layout of split view while it is on: which panes show, the heads, the right composer, the marks and the screen-reader regions.
  function applyOn() {
    const left = infoOf(activeId());
    const right = infoOf(split.beside);
    if (!left || !right) return;
    const had = document.activeElement;
    const wasLeft = primaryEl.contains(had);
    const wasRight = besideEl.contains(had);
    splitEl.dataset.on = '';
    splitEl.dataset.ratio = String(split.ratio);
    const fold = folded();
    const shown = fold ? (driving() ? 'primary' : split.focus) : null;
    if (shown) split.focus = shown;   // folded, the pane in view is the current one (a drive keeps the left pane in view)
    splitEl.dataset.focus = split.focus;
    if (shown) splitEl.dataset.fold = shown;
    else delete splitEl.dataset.fold;
    primaryEl.hidden = shown === 'beside';
    besideEl.hidden = shown === 'primary';
    dividerEl.hidden = fold;
    // A focus in a pane that just went away moves to the other pane's message box.
    if (wasLeft && primaryEl.hidden) rightInput.focus({ preventScroll: true });
    else if (wasRight && besideEl.hidden) MU.el.input.focus({ preventScroll: true });
    setAttr(primaryEl, 'role', 'region');
    setAttr(primaryEl, 'aria-label', `${left.name}, left pane`);
    setAttr(besideEl, 'role', 'region');
    setAttr(besideEl, 'aria-label', `${right.name}, right pane`);
    setAttr(rightChat, 'aria-label', `Messages in ${right.name}`);
    fillHead(leftHead, left, right, 'primary', fold);
    fillHead(rightHead, right, left, 'beside', fold);
    paintReadOnly(right);
    paintRightComposer(right);
    paintRightQueue(right);
    // A run of the right thread that started after its transcript was drawn: its box goes in now (runStream made it, off screen).
    const box = SP.box(right.id);
    if (box && !box.isConnected && besideStream) besideStream.append(box);
    // A run of the right thread that ended: its saved chat is read again.
    const busy = T.isRunning(right.id);
    if (split.wasBusy && !busy) loadBeside();
    split.wasBusy = busy;
    const leftNow = statusOf(left);
    const rightNow = statusOf(right);
    announce(leftHead, left, split.lastLeft, leftNow, split.focus === 'primary');
    announce(rightHead, right, split.lastRight, rightNow, split.focus === 'beside');
    split.lastLeft = leftNow;
    split.lastRight = rightNow;
    // Only the pane that has the focus is read out as it changes.
    setAttr(MU.el.chat, 'aria-live', split.focus === 'primary' ? 'polite' : 'off');
    setAttr(rightChat, 'aria-live', split.focus === 'beside' ? 'polite' : 'off');
    paintDivider();
    // The Settings page covers the panes: the right pane, the divider and the left head leave the reading and tab order.
    const covered = appEl?.hasAttribute('data-settings-open') === true;
    besideEl.inert = covered;
    dividerEl.inert = covered;
    leftHead.el.inert = covered;
  }

  // Split view off: the left pane is the whole column, as it was before split view.
  function applyOff() {
    const had = besideEl.contains(document.activeElement);
    for (const name of ['on', 'fold', 'focus', 'ratio']) delete splitEl.dataset[name];
    primaryEl.hidden = false;
    besideEl.hidden = true;
    dividerEl.hidden = true;
    leftHead.el.hidden = true;
    rightHead.el.hidden = true;
    primaryEl.removeAttribute('role');
    primaryEl.removeAttribute('aria-label');
    besideEl.removeAttribute('role');
    besideEl.removeAttribute('aria-label');
    setAttr(MU.el.chat, 'aria-live', 'polite');
    setAttr(rightChat, 'aria-live', 'off');
    besideEl.inert = false;
    dividerEl.inert = false;
    leftHead.el.inert = false;
    if (had) MU.el.input.focus({ preventScroll: true });
  }

  // Runs on every render (paint is the render hook): the project switch, the swap rule, the checks that close split view, then the layout.
  function paintSplit() {
    if (!SP) return;
    const pid = state().activeProject ?? null;
    if (pid !== split.project) {
      split.project = pid;
      split.lastActive = null;
      split.focus = 'primary';
      setBeside(pid ? remembered.beside[pid] ?? null : null);
    }
    const ids = new Set(threadList().map(t => t.id));
    // The swap rule: when the right thread becomes the active one, the thread that was on the left goes to the right.
    if (split.beside && split.beside === activeId()) {
      const back = split.lastActive && split.lastActive !== activeId() && ids.has(split.lastActive) ? split.lastActive : null;
      setBeside(back);
    }
    if (split.beside && (!ids.has(split.beside) || !canSplit())) setBeside(null);
    split.lastActive = activeId();
    if (!split.beside) {
      if (wrapped) applyOff();
      return;
    }
    if (!ensureWrapped()) {
      setBeside(null);
      return;
    }
    applyOn();
  }

  // The focus says which pane is current. It follows a focus inside a pane and a press in one.
  function noteFocus(target) {
    const side = primaryEl.contains(target) ? 'primary' : besideEl.contains(target) ? 'beside' : '';
    if (!side || side === split.focus || !split.beside) return;
    split.focus = side;
    paint();
  }

  // ---- the right pane's own events ----

  rightForm.addEventListener('submit', e => {
    e.preventDefault();
    const id = split.beside;
    if (!id) return;
    if (T.isRunning(id)) SP.stop(id);
    else sendBeside();
  });
  rightInput.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    const id = split.beside;
    if (!id) return;
    if (e.key === 'Escape') {
      // A drawer or a dialog takes Escape first; else Escape stops the right thread's run.
      if (MU.dialogOpen?.() || !MU.el.drawer.hidden) return;
      if (T.isRunning(id)) {
        e.preventDefault();
        SP.stop(id);
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (T.isRunning(id)) queueBeside();
      else sendBeside();
    }
  });
  rightQueueClear.addEventListener('click', () => {
    const id = split.beside;
    if (!id) return;
    const n = SP.queuedItems(id).length;
    T.dropQueued(id);
    MU.toast(n ? `Dropped ${n} queued ${n === 1 ? 'message' : 'messages'}` : 'The queue was already empty');
    paint();
  });
  // Copy on a code block of the right transcript, as the left one does.
  rightChat.addEventListener('click', async e => {
    const copy = e.target.closest('.copy');
    if (!copy) return;
    const code = copy.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
    if (!(await MU.copyText(code))) {
      MU.toast('The code could not be copied.', 'bad');
      return;
    }
    copy.textContent = 'Copied';
    setTimeout(() => {
      copy.textContent = 'Copy';
    }, 1400);
  });
  // The transcript sticks to its bottom while it is near it, as the left one does.
  new MutationObserver(() => {
    if (rightChat.scrollHeight - rightChat.scrollTop - rightChat.clientHeight < 180) rightChat.scrollTop = rightChat.scrollHeight;
  }).observe(rightChat, { childList: true, subtree: true, characterData: true });

  // A message sent from the right pane (app.js sendMessage announces it) shows at once, in its transcript.
  window.addEventListener('plenum:thread-sent', e => {
    const d = e.detail;
    if (!d || d.scope !== split.beside) return;
    split.unsaved.push({ text: String(d.text ?? ''), ts: Date.now() });
    if (Array.isArray(split.messages)) drawBeside({ bottom: true });
  });

  // The focus and the presses that say which pane is current.
  splitEl.addEventListener('focusin', e => noteFocus(e.target));
  splitEl.addEventListener('pointerdown', e => noteFocus(e.target));

  // The divider: a drag, a double-click for the even split, and Left, Right, Home and End.
  const snap = x => Math.min(65, Math.max(35, Math.round(x / 5) * 5));
  dividerEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    dividerDrag = true;
    try {
      dividerEl.setPointerCapture(e.pointerId);
    } catch {
      // The drag works without the capture too.
    }
  });
  dividerEl.addEventListener('pointermove', e => {
    if (!dividerDrag) return;
    const r = splitEl.getBoundingClientRect();
    if (r.width > 0) setRatio(snap(((e.clientX - r.left) / r.width) * 100), false);
  });
  const endDrag = e => {
    if (!dividerDrag) return;
    dividerDrag = false;
    try {
      dividerEl.releasePointerCapture(e.pointerId);
    } catch {
      // Nothing to release.
    }
    remember();
  };
  dividerEl.addEventListener('pointerup', endDrag);
  dividerEl.addEventListener('pointercancel', endDrag);
  dividerEl.addEventListener('dblclick', () => setRatio(50));
  dividerEl.addEventListener('keydown', e => {
    let next = null;
    if (e.key === 'ArrowLeft') next = split.ratio - 5;
    else if (e.key === 'ArrowRight') next = split.ratio + 5;
    else if (e.key === 'Home') next = 35;
    else if (e.key === 'End') next = 65;
    if (next === null) return;
    e.preventDefault();
    setRatio(snap(next));
  });

  // Ctrl+Shift+\ turns split view on or off (desktop and browser). Ctrl+1 and Ctrl+2 (desktop app, split view on) go to the two message boxes.
  // Not while a dialog, the drawer or the Settings page is open.
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.altKey || e.isComposing || !(e.ctrlKey || e.metaKey)) return;
    if (MU.dialogOpen?.() || !MU.el.drawer.hidden || appEl?.hasAttribute('data-settings-open')) return;
    if (e.shiftKey && e.code === 'Backslash') {
      e.preventDefault();
      toggleSplit();
      return;
    }
    if (!IS_DESKTOP || e.shiftKey || !split.beside) return;
    if (e.code === 'Digit1') {
      e.preventDefault();
      showPane('primary');
    } else if (e.code === 'Digit2') {
      e.preventDefault();
      showPane('beside');
    }
  });

  // The window's width and the side pane or the Settings page change the layout: the page is drawn again.
  WIDE?.addEventListener?.('change', () => paint());
  if (appEl) new MutationObserver(() => paint()).observe(appEl, { attributes: true, attributeFilter: ['data-pane-open', 'data-settings-open'] });
  // F6 reaches the right pane's transcript and message box while it shows (app.js shellRegions).
  if (SP) SP.regions = () => (split.beside && wrapped ? [rightChat, rightInput] : []);

  // ---------- wiring ----------

  Object.assign(T, {
    header: headerExtra,       // the thread header row's slot for other panels (pro-02's branch chip): add a node, and call T.repaint()
    repaint: () => { drawnSignature = ''; paint(); },
    openNew: openNewDialog,
    open,
    focusTab: id => bar.querySelector(`.ext-thread-btn[data-thread="${CSS.escape(String(id))}"]`)?.focus({ preventScroll: true }),
    unread: id => { const t = threadList().find(x => x.id === id); return Boolean(t) && unread(t); },
    status: id => { const t = threadList().find(x => x.id === id); return t ? statusOf(t) : ''; },
    splitView: {               // split view, for the other panels and the tests (T.split is app.js's hook: not overwritten here)
      open: openBeside, close: closeSplit, swap, show: showPane, beside: () => split.beside, ratio: () => split.ratio,
      folded: () => Boolean(split.beside) && folded(),
    },
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
