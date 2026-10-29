// ext-phone.js (mob-11, phone layer parts 1 and 2; MOBILE-UI sections 0, 3, 4, 8.1 to 8.14, 9, 10, 12, 16.2). A panel discovered from the
// public folder. It is active only when <html data-surface="phone"> (the phone's copy of this page); on the desktop it adds nothing
// and changes nothing. It turns the desktop UI into the phone's frame:
//   - the title bar: back, the title, the connection chip and a visible "⋯" that opens the More sheet;
//   - the bottom bar: Projects, Chat, Agents, Review and an empty Stop dock. ext-phone draws no Stop. The shell's #plenum-stop sits over
//     .ph-stop-dock, and this panel publishes the dock's geometry as --ph-stop-left/top/w/h on <html>, with data-ph-stop="cell" or "float";
//   - the Projects tab (the sidebar as a full screen), the Chat tab (transcript and composer), and the Agents and Review tabs (side pane);
//   - sheets that end at the bar's top edge, and the model and role sheet, which lists every #modelSel option in its order;
//   - composer row 2: [+] [model chip] [Mode] [Send]; the keyboard through visualViewport (with the iOS 26 re-measure); text zoom;
//   - long-press and a visible "⋯" on project rows and replies; one back stack (sheet, settings, drawer, pane, Chat, Projects);
//   - window.plenumPhoneDebug, only with ?debug=1, ?demo or ?selftest: safeArea, keyboard, textZoom, tab, back, connection.
//   - track B (wave 121, MOBILE-UI 8.10 and 8.11): taps, drags, typing and keys on the Browser picture, and Take over from phone on a computer
//     run, only where the connection says this computer allows them (the remote section below).
// Every desktop control is driven through its original element (click, or set the value and dispatch one change). No app logic is copied.
// Text reaches the page only through textContent. No inline script, no style attribute, no colour literal (ext-phone.css holds the look).
(function () {
  'use strict';

  const root = document.documentElement;
  if (!root || root.dataset.surface !== 'phone') return;
  const MuseUI = window.MuseUI;
  if (!MuseUI || !MuseUI.slots || !MuseUI.pane || !MuseUI.ui) return;
  if (document.getElementById('ph-bar')) return; // loaded twice

  const NS = 'http://www.w3.org/2000/svg';
  const DEBUG_ON = /[?&](debug|demo|selftest)(=|&|$)/.test(String(location.search || ''));
  const shell = window.plenumShell && typeof window.plenumShell === 'object' ? window.plenumShell : null;

  const $ = id => document.getElementById(id);
  const q = (sel, scope = document) => scope.querySelector(sel);
  const qa = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));
  const txt = node => (node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const mk = (tag, cls = '', text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  // What the shell offers this page. In a debug page (?debug=1) plenumPhoneDebug.shell() can add to it, so the checks can give the phone layer a
  // list of computers, a contact address or a dictation service without the native shell; a production page never has the hook.
  const debugShell = {};
  const shellProp = name => (Object.prototype.hasOwnProperty.call(debugShell, name) ? debugShell[name] : (shell ? shell[name] : undefined));
  const shellCall = (name, ...args) => {
    try {
      const fn = shellProp(name);
      return typeof fn === 'function' ? fn.apply(shell, args) : undefined;
    } catch {
      return undefined;
    }
  };
  const shellHas = name => typeof shellProp(name) === 'function';

  // Sprite icons (index.html carries the symbols). The class list matches the desktop's .ic, so the strokes match too.
  function icon(name, cls = 'ph-ic') {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', `ic ${cls}`);
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    const u = document.createElementNS(NS, 'use');
    u.setAttribute('href', `#i-${name}`);
    s.append(u);
    return s;
  }
  function dotsIcon() {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', 'ph-ic ph-dots');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    for (const cx of [5, 12, 19]) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', '12');
      c.setAttribute('r', '1.9');
      c.setAttribute('fill', 'currentColor');
      c.setAttribute('stroke', 'none');
      s.append(c);
    }
    return s;
  }

  const TABS = [
    { id: 'projects', label: 'Projects', icon: 'folder' },
    { id: 'chat', label: 'Chat', icon: 'sparkle' },
    { id: 'agents', label: 'Agents', icon: 'layers' },
    { id: 'review', label: 'Review', icon: 'list' },
  ];
  const TAB_LABEL = { projects: 'Projects', chat: 'Chat', agents: 'Agents', review: 'Review' };
  const PANE_TITLE = { artifacts: 'Artifacts', browser: 'Browser', agents: 'Agents', review: 'Review' };
  const CARRIER_WORD = { lan: 'LAN', tailscale: 'Tailnet', relay: 'Relay' };
  const CARRIER_LONG = { lan: 'the same network', tailscale: 'Tailscale', relay: 'your relay' };
  const CONN_WORD = { reconnecting: 'Reconnecting', offline: 'Offline', asleep: 'Asleep' };
  const CONN_TONE = { connected: 'ok', reconnecting: 'warn', asleep: 'muted', offline: 'bad' };

  const refs = {
    app: $('app'),
    topbar: $('titlebar'),
    main: null,
    sidebar: q('.sidebar'),
    projName: $('projName'),
    chat: $('chat'),
    composer: $('composer'),
    composerWrap: $('composerWrap'),
    input: $('input'),
    projects: $('projects'),
    pane: $('pane'),
    paneButtons: $('paneButtons'),
    modelSel: $('modelSel'),
    effortSel: $('effortSel'),
    modeWrap: $('modeWrap'),
    boardSeats: $('boardSeats'),
    boardSummary: $('boardSummary'),
    relayOpenBtn: $('relayOpenBtn'),
    settingsPage: $('settingsPage'),
    settingsClose: $('settingsClose'),
    drawer: $('drawer'),
    drawerClose: $('drawerClose'),
    send: $('send'),
    dock: null,
    bar: null,
    title: null,
    connChip: null,
    connDot: null,
    connWord: null,
    moreBtn: null,
    plus: null,
    chip: null,
    chipDot: null,
    chipText: null,
  };
  refs.main = refs.topbar ? refs.topbar.parentElement : null;

  // One state for the frame. It holds facts about this page only; nothing is stored, and nothing is sent anywhere.
  const state = {
    tab: 'projects',
    paneId: null,
    chatScroll: 0,
    zoom: 1,
    walkF: 1,
    kbOpen: false,
    forcedKb: null,
    layoutBase: 0,
    lastW: 0,
    online: true,
    connOverride: null,
    phones: [],
    chatTimer: null,
  };

  // ---------- connection and the computer's name ----------

  function connView() {
    if (state.connOverride) return state.connOverride;
    const c = shell ? shellCall('connection') : null;
    if (c && typeof c === 'object') return c;
    return { state: state.online ? 'connected' : 'offline', carrier: '', desktopName: '' };
  }

  function computerName() {
    const name = connView().desktopName;
    return name ? String(name) : 'Projects';
  }

  function projectName() {
    return txt(refs.projName) || 'No project';
  }

  function modeNow() {
    const on = q('.mode-seg .seg-btn[aria-pressed="true"]');
    return on && on.dataset.mode === 'council' ? 'council' : 'chat';
  }

  // ---------- painting: the title, the chip, the bar, the connection chip, the Stop dock ----------

  function paintTitle() {
    if (!refs.title) return;
    const text = state.tab === 'projects' ? computerName() : projectName();
    if (refs.title.textContent !== text) refs.title.textContent = text;
    refs.title.title = text;
  }

  function paintConn() {
    if (!refs.connChip) return;
    const c = connView();
    const st = c.state || 'connected';
    const name = c.desktopName || 'your computer';
    const word = st === 'connected' ? (CARRIER_WORD[c.carrier] || '') : (CONN_WORD[st] || 'Offline');
    const sentence = st === 'connected'
      ? `Connected to ${name}${c.carrier ? ` over ${CARRIER_LONG[c.carrier] || c.carrier}` : ''}. Connection details`
      : st === 'reconnecting' ? `Reconnecting to ${name}. Connection details`
        : st === 'asleep' ? `${name} is asleep or Plenum is closed. Connection details`
          : `Can't reach ${name}. Connection details`;
    refs.connChip.dataset.state = st;
    refs.connChip.setAttribute('aria-label', sentence);
    refs.connChip.title = sentence;
    refs.connDot.dataset.tone = CONN_TONE[st] || 'bad';
    refs.connWord.textContent = word;
  }

  function paintChip() {
    if (!refs.chip) return;
    const sel = refs.modelSel;
    const eff = refs.effortSel;
    let label;
    let full;
    let provider = '';
    if (modeNow() === 'council') {
      const seats = refs.boardSeats ? refs.boardSeats.children.length : 0;
      label = seats ? `Council · ${seats} seat${seats === 1 ? '' : 's'}` : 'Council';
      full = seats ? `Council, ${seats} seats` : 'Council';
    } else {
      const opt = sel && sel.selectedOptions ? sel.selectedOptions[0] : null;
      const name = opt ? txt(opt.querySelector('.o-name') || opt) : '';
      const effOpt = eff && eff.selectedOptions ? eff.selectedOptions[0] : null;
      const effName = effOpt ? txt(effOpt.querySelector('.o-name') || effOpt) : '';
      provider = (opt && opt.querySelector('.o-dot') && opt.querySelector('.o-dot').dataset.p) || '';
      label = name ? (effName ? `${name} · ${effName}` : name) : 'Choose a model';
      full = name ? `Model ${name}${effName ? `, effort ${effName}` : ''}` : 'Choose a model';
    }
    refs.chipText.textContent = label;
    refs.chip.title = full;
    refs.chip.setAttribute('aria-label', `${full}. Change model and role`);
    if (provider) refs.chipDot.dataset.p = provider;
    else delete refs.chipDot.dataset.p;
    refs.chip.disabled = Boolean(sel && sel.disabled);
  }

  function paintBar() {
    if (!refs.bar) return;
    for (const b of qa('.ph-bar-item', refs.bar)) {
      const id = b.dataset.tab;
      if (id === state.tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
      let name = TAB_LABEL[id] || id;
      if (id === 'chat') name = `Chat, ${projectName()}`;
      const badge = b.querySelector('.ph-bar-badge');
      if (id === 'agents' || id === 'review') {
        const pb = q(`#paneButtons [data-pane="${id}"] .badge`);
        const count = pb && !pb.hidden ? txt(pb) : '';
        if (count) {
          const tone = pb.dataset.tone || '';
          badge.hidden = false;
          badge.textContent = count;
          badge.dataset.tone = tone;
          name += tone === 'amber' ? `, ${count} waiting` : `, ${count}`;
        } else {
          badge.hidden = true;
          badge.textContent = '';
          delete badge.dataset.tone;
        }
      }
      b.setAttribute('aria-label', name);
    }
  }

  // The Stop dock is the cell the shell's Stop covers. In the cell, the shell draws Stop there. While the keyboard is open the dock
  // floats above the composer's top-right corner (8.1), so the publish says which mode applies.
  function publishDock() {
    if (!refs.dock) return;
    let mode = 'cell';
    let left;
    let top;
    let w;
    let h;
    if (state.kbOpen) {
      mode = 'float';
      w = 56;
      h = 48;
      const comp = refs.composer ? refs.composer.getBoundingClientRect() : null;
      const compTop = comp && comp.height > 0 ? comp.top : innerHeight - 200;
      // The right safe area (a notch in landscape) stays clear of the floating Stop, as the shell's own Stop does (16.1).
      const saRight = parseFloat(getComputedStyle(root).getPropertyValue('--sa-right')) || 0;
      left = innerWidth - saRight - 16 - w;
      top = compTop - 8 - h;
    } else {
      const r = refs.dock.getBoundingClientRect();
      left = r.left;
      top = r.top;
      w = r.width;
      h = r.height;
    }
    root.style.setProperty('--ph-stop-left', `${Math.round(left)}px`);
    root.style.setProperty('--ph-stop-top', `${Math.round(top)}px`);
    root.style.setProperty('--ph-stop-w', `${Math.round(w)}px`);
    root.style.setProperty('--ph-stop-h', `${Math.round(h)}px`);
    root.dataset.phStop = mode;
  }

  function publishComposerTop() {
    if (!refs.composer) return;
    const vh = state.forcedKb !== null ? innerHeight - state.forcedKb : (window.visualViewport ? window.visualViewport.height : innerHeight);
    const top = refs.composer.getBoundingClientRect().top;
    root.style.setProperty('--composer-top', `${Math.max(0, Math.round(vh - top))}px`);
  }

  function refreshChrome() {
    paintTitle();
    paintConn();
    paintChip();
    paintBar();
    publishComposerTop();
    publishDock();
  }

  // ---------- the back stack: sheets, settings, drawer, mode menu, pane, Chat, Projects ----------

  const layers = [];
  let swallowPops = 0;
  let selfOverride = '';
  // Leaving Projects for another tab pushes one history entry, so the browser's Back (and the edge swipe) goes back to Projects instead of
  // out of the app; going back to Projects by the bar takes that entry off again. tabPushPending: the entry waits while a layer's own
  // history.back() is still on its way, because a pushState before that pop lands would be undone by it.
  let tabEntry = false;
  let tabPushPending = false;

  function pushTabEntryNow() {
    try {
      history.pushState({ ph: 0, tab: true }, '');
    } catch {
      // Without history the Back key still reaches Projects through the page's own handler.
    }
  }

  function pushTabEntry() {
    if (tabEntry) return;
    tabEntry = true;
    if (swallowPops > 0) tabPushPending = true;
    else pushTabEntryNow();
  }

  function dropTabEntry() {
    if (!tabEntry) return;
    tabEntry = false;
    if (tabPushPending) {
      tabPushPending = false;
      return;
    }
    try {
      if (history.state && history.state.tab === true) {
        swallowPops += 1;
        history.back();
      }
    } catch {
      // No history to pop.
    }
  }

  function pushEntry(kind, opts = {}) {
    const entry = {
      kind,
      dom: opts.dom || null,
      teardown: opts.teardown || null,
      opener: opts.opener || null,
      el: opts.el || null,
      closed: false,
    };
    layers.push(entry);
    try {
      history.pushState({ ph: layers.length }, '');
    } catch {
      // Without history the Back key still closes the top layer through the page's own handler.
    }
    return entry;
  }

  // Closes one layer. dom: also run the desktop control that closes it. back: pop the history state this layer pushed.
  function closeEntry(entry, { dom = true, back = true } = {}) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    const at = layers.indexOf(entry);
    if (at >= 0) layers.splice(at, 1);
    if (back && at >= 0 && at === layers.length) {
      try {
        if (history.state && history.state.ph === at + 1) {
          swallowPops += 1;
          history.back();
        }
      } catch {
        // No history to pop.
      }
    }
    if (dom && entry.dom) {
      try {
        entry.dom();
      } catch {
        // The desktop control is gone; the layer is closed anyway.
      }
    }
    if (entry.teardown) {
      try {
        entry.teardown();
      } catch {
        // Already removed.
      }
    }
    if (entry.opener && entry.opener.isConnected && typeof entry.opener.focus === 'function') {
      try {
        entry.opener.focus({ preventScroll: true });
      } catch {
        // Not focusable any more.
      }
    }
  }

  function closeLayers(filter) {
    for (const entry of layers.slice().reverse()) {
      if (!entry.closed && filter(entry)) closeEntry(entry);
    }
  }

  // Pops the top layer, else Chat goes to Projects. Returns false at Projects, where Android back leaves the app.
  // popped: the history state is already gone (the browser's Back, or the shell's own Back).
  function handleBack(popped = true) {
    if (swallowPops > 0) {
      swallowPops -= 1;
      if (swallowPops === 0 && tabPushPending) {
        tabPushPending = false;
        pushTabEntryNow();
      }
      return true;
    }
    const top = layers[layers.length - 1];
    if (top) {
      closeEntry(top, { dom: true, back: !popped });
      return true;
    }
    if (state.tab !== 'projects') {
      // popped: the browser already took the entry the tab pushed. Otherwise setTab('projects') takes it off.
      if (popped) {
        tabEntry = false;
        tabPushPending = false;
      }
      setTab('projects');
      return true;
    }
    return false;
  }

  // Watches a desktop panel's hidden flag, so its open state takes a place in the stack.
  function watchShown(el, kind, closeDom) {
    if (!el || el.dataset.phWatched === '1') return;
    el.dataset.phWatched = '1';
    let entry = null;
    const sync = () => {
      if (!el.hidden) {
        if (!entry) {
          entry = pushEntry(kind, { dom: () => closeDom() });
          if (kind === 'settings') {
            if (state.tab === 'projects') applyTab('chat');
            MuseUI.pane.hide();
          }
        }
      } else if (entry) {
        const done = entry;
        entry = null;
        closeEntry(done, { dom: false });
      }
    };
    new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  }

  function attachModeWatch() {
    const menu = $('modeMenu');
    if (!menu || menu.dataset.phWatched === '1') return;
    watchShown(menu, 'mode', () => {
      const btn = $('modeBtn');
      if (btn) btn.click();
    });
  }

  // A sheet: a scrim and a section over the page. Its bottom edge is the bar's top, so the bar and the Stop dock stay live under it.
  let focusTrapBound = false;
  function openSheet({ title, note = '', className = '', fill, opener }) {
    const seq = ++sheetSeq;
    const titleId = `ph-sheet-title-${seq}`;
    const scrim = mk('div', 'ph-scrim');
    scrim.setAttribute('aria-hidden', 'true');
    const sheet = mk('section', `ph-sheet${className ? ` ${className}` : ''}`);
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', titleId);
    const handle = mk('div', 'ph-handle');
    handle.setAttribute('aria-hidden', 'true');
    const head = mk('header', 'ph-sheet-head');
    const heading = mk('h2', 'ph-sheet-title', title);
    heading.id = titleId;
    heading.tabIndex = -1;
    const closeBtn = mk('button', 'ph-icon-btn ph-sheet-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.title = 'Close';
    closeBtn.append(icon('x'));
    head.append(heading, closeBtn);
    const bodyEl = mk('div', 'ph-sheet-body');
    sheet.append(handle, head, bodyEl);
    if (note) bodyEl.append(mk('p', 'ph-sheet-note', note));
    const entry = pushEntry('sheet', {
      opener: opener || document.activeElement,
      el: sheet,
      teardown: () => {
        scrim.remove();
        sheet.remove();
      },
    });
    closeBtn.addEventListener('click', () => closeEntry(entry));
    scrim.addEventListener('click', () => closeEntry(entry));
    document.body.append(scrim, sheet);
    const api = { el: sheet, body: bodyEl, close: () => closeEntry(entry) };
    if (typeof fill === 'function') fill(bodyEl, api);
    try {
      heading.focus({ preventScroll: true });
    } catch {
      // Focus is a courtesy here.
    }
    return api;
  }
  let sheetSeq = 0;

  function sheetRow({ label, note = '', iconName = '', danger = false, disabled = false, check = false, onPick }) {
    const b = mk('button', `ph-row${danger ? ' ph-row-danger' : ''}`);
    b.type = 'button';
    if (iconName) b.append(icon(iconName));
    const text = mk('span', 'ph-row-text');
    text.append(mk('span', 'ph-row-label', label));
    if (note) text.append(mk('span', 'ph-row-note', note));
    b.append(text);
    if (check) b.append(icon('check', 'ph-check'));
    if (disabled) b.setAttribute('aria-disabled', 'true');
    b.addEventListener('click', () => {
      if (disabled) {
        MuseUI.toast(note || 'Not available right now.', 'bad');
        return;
      }
      if (typeof onPick === 'function') onPick(b);
    });
    return b;
  }

  function sectionHead(text) {
    return mk('h2', 'ph-group-head', text);
  }

  function focusables(scope) {
    return qa('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]', scope)
      .filter(el => el.getClientRects().length > 0);
  }

  // ---------- tabs: Projects, Chat, Agents, Review ----------

  function applyTab(next) {
    if (state.tab === 'chat' && next !== 'chat' && refs.chat) state.chatScroll = refs.chat.scrollTop;
    if (state.tab === 'projects' && next !== 'projects') pushTabEntry();
    else if (state.tab !== 'projects' && next === 'projects') dropTabEntry();
    state.tab = next;
    root.dataset.phTab = next;
    refreshChrome();
    if (next === 'chat' && refs.chat) {
      const at = state.chatScroll;
      requestAnimationFrame(() => {
        refs.chat.scrollTop = at;
      });
    }
  }

  // A tab tap closes any sheet first, then switches. Tapping the tab you are on pops its nested view to the root.
  function setTab(name) {
    const next = name === 'projects' || name === 'agents' || name === 'review' ? name : 'chat';
    if (next === 'agents' || next === 'review') {
      if (!MuseUI.pane.list().includes(next)) {
        MuseUI.toast(`${TAB_LABEL[next]} is not in this Plenum build yet.`, 'bad');
        return;
      }
    }
    closeLayers(entry => entry.kind !== 'pane');
    if (next === 'chat' && state.tab === 'chat' && !state.paneId) {
      if (refs.chat) refs.chat.scrollTo({ top: refs.chat.scrollHeight, behavior: 'smooth' });
      return;
    }
    if (next === 'projects' || next === 'chat') {
      MuseUI.pane.hide();
    } else {
      try {
        MuseUI.pane.open(next);
      } catch {
        MuseUI.toast(`${TAB_LABEL[next]} could not open.`, 'bad');
        return;
      }
    }
    applyTab(next);
  }

  function onPaneEvent(ev) {
    const d = ev && ev.detail ? ev.detail : {};
    if (d.action === 'show' || d.action === 'open' || d.action === 'select') {
      const id = typeof d.id === 'string' ? d.id : null;
      state.paneId = id;
      const want = id === 'agents' || id === 'review' ? id : (state.tab === 'projects' ? 'chat' : state.tab);
      if (want !== state.tab) applyTab(want);
      if (!layers.some(entry => entry.kind === 'pane')) {
        pushEntry('pane', { dom: () => MuseUI.pane.hide() });
      }
    } else if (d.action === 'hide' || (d.action === 'close' && !MuseUI.pane.active())) {
      state.paneId = null;
      closeLayers(entry => entry.kind === 'pane');
      if (state.tab === 'agents' || state.tab === 'review') applyTab('chat');
    }
  }

  // ---------- the bottom bar and the title bar ----------

  function buildBar() {
    const bar = mk('nav', 'ph-bar');
    bar.id = 'ph-bar';
    bar.setAttribute('aria-label', 'Plenum');
    for (const t of TABS) {
      const b = mk('button', 'ph-bar-item');
      b.type = 'button';
      b.dataset.tab = t.id;
      b.append(icon(t.icon, 'ph-ic ph-bar-ic'), mk('span', 'ph-bar-label', t.label));
      const badge = mk('span', 'ph-bar-badge');
      badge.hidden = true;
      b.append(badge);
      bar.append(b);
    }
    const dock = mk('span', 'ph-stop-dock');
    dock.setAttribute('role', 'presentation');
    dock.setAttribute('aria-hidden', 'true');
    bar.append(dock);
    bar.addEventListener('click', e => {
      const b = e.target instanceof Element ? e.target.closest('.ph-bar-item') : null;
      if (b) setTab(b.dataset.tab);
    });
    document.body.append(bar);
    refs.bar = bar;
    refs.dock = dock;
  }

  function buildTitle() {
    const top = refs.topbar;
    if (!top) return;
    const back = mk('button', 'ph-icon-btn ph-back');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back');
    back.title = 'Back';
    back.append(icon('chevron', 'ph-ic ph-back-ic'));
    back.addEventListener('click', () => handleBack(false));
    top.prepend(back);

    const projTitle = q('.proj-title', top);
    const title = mk('span', 'ph-title');
    if (projTitle) projTitle.append(title);
    else top.prepend(title);
    refs.title = title;

    const conn = mk('button', 'ph-chip-conn');
    conn.type = 'button';
    const dot = mk('span', 'ph-dot');
    dot.setAttribute('aria-hidden', 'true');
    const word = mk('span', 'ph-chip-word');
    conn.append(dot, word);
    conn.addEventListener('click', () => openConnSheet(conn));
    refs.connChip = conn;
    refs.connDot = dot;
    refs.connWord = word;

    const more = mk('button', 'ph-icon-btn ph-more');
    more.type = 'button';
    more.setAttribute('aria-label', 'More');
    more.title = 'More';
    more.append(dotsIcon());
    more.addEventListener('click', () => openMoreSheet(more));
    refs.moreBtn = more;
    top.append(conn, more);
  }

  function buildComposer() {
    const bar = refs.composer ? q('.composer-bar', refs.composer) : null;
    if (!bar) return;
    const plus = mk('button', 'ph-plus');
    plus.type = 'button';
    plus.setAttribute('aria-label', 'Add');
    plus.title = 'Add';
    plus.append(icon('plus'));
    plus.addEventListener('click', () => openPlusSheet(plus));
    const chip = mk('button', 'ph-model-chip');
    chip.type = 'button';
    const chipDot = mk('span', 'ph-dot');
    chipDot.setAttribute('aria-hidden', 'true');
    const chipText = mk('span', 'ph-chip-text');
    chip.append(chipDot, chipText);
    chip.addEventListener('click', () => openModelSheet(chip));
    bar.prepend(plus);
    bar.insertBefore(chip, plus.nextSibling);
    refs.plus = plus;
    refs.chip = chip;
    refs.chipDot = chipDot;
    refs.chipText = chipText;
    if (refs.input) refs.input.placeholder = 'Message, or / for commands';
  }

  // ---------- Projects: each row gets a visible "⋯"; a long-press opens the same sheet ----------

  function decorateProjects() {
    if (!refs.projects) return;
    for (const row of qa('.proj-item', refs.projects)) {
      if (row.querySelector(':scope > .ph-row-more')) continue;
      const name = txt(row.querySelector('.pn')) || 'project';
      const b = mk('button', 'ph-row-more');
      b.type = 'button';
      b.setAttribute('aria-label', `More for ${name}`);
      b.title = `More for ${name}`;
      b.append(dotsIcon());
      b.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        openProjectSheet(row, b);
      });
      row.append(b);
    }
  }

  function openProjectSheet(row, opener) {
    const name = txt(row.querySelector('.pn')) || 'Project';
    const path = row.title || '';
    openSheet({
      title: name,
      note: path,
      opener,
      fill: (body, api) => {
        body.append(sheetRow({
          label: 'Open',
          iconName: 'folder',
          onPick: () => {
            api.close();
            row.click();
          },
        }));
        body.append(sheetRow({
          label: 'Copy path',
          iconName: 'file',
          onPick: () => {
            api.close();
            MuseUI.copyText(path);
          },
        }));
        const forget = row.querySelector('.forget');
        if (forget) {
          body.append(sheetRow({
            label: 'Forget this project',
            note: 'The files are kept.',
            iconName: 'x',
            danger: true,
            onPick: () => {
              api.close();
              forget.click();
            },
          }));
        }
      },
    });
  }

  function setupProjectLongPress() {
    const list = refs.projects;
    if (!list) return;
    let press = null;
    let fired = false;
    let suppressUntil = 0;
    const clear = () => {
      if (press && press.timer) clearTimeout(press.timer);
      press = null;
    };
    list.addEventListener('pointerdown', e => {
      fired = false;
      suppressUntil = 0;
      const row = e.target instanceof Element ? e.target.closest('.proj-item') : null;
      if (!row || e.target.closest('.ph-row-more, .forget')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      clear();
      press = { row, x: e.clientX, y: e.clientY, timer: null };
      press.timer = setTimeout(() => {
        const current = press;
        press = null;
        if (!current) return;
        fired = true;
        shellCall('haptic', 'light');
        openProjectSheet(current.row, current.row);
      }, 500);
    });
    list.addEventListener('pointermove', e => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) clear();
    });
    // The release of a long-press is followed by a click on the row. That click is swallowed, and only that one: the window is short.
    list.addEventListener('pointerup', () => {
      clear();
      if (fired) suppressUntil = performance.now() + 50;
      fired = false;
    });
    list.addEventListener('pointercancel', () => {
      clear();
      fired = false;
    });
    list.addEventListener('contextmenu', e => {
      const row = e.target instanceof Element ? e.target.closest('.proj-item') : null;
      if (!row) return;
      e.preventDefault();
      clear();
      openProjectSheet(row, row);
    });
    // A click that ends a long-press does not switch the project.
    list.addEventListener('click', e => {
      if (performance.now() < suppressUntil) {
        suppressUntil = 0;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const row = e.target instanceof Element ? e.target.closest('.proj-item') : null;
      if (row && !e.target.closest('.ph-row-more, .forget')) setTimeout(() => applyTab('chat'), 0);
    }, true);
  }

  // ---------- Chat: each reply gets a visible "⋯" and an accessible name ----------

  function decorateTurns() {
    if (!refs.chat) return;
    for (const turn of qa('.turn', refs.chat)) {
      const head = turn.querySelector(':scope > .turn-head');
      if (!head) continue;
      const who = txt(head.querySelector('.who'));
      const when = txt(head.querySelector('.when'));
      turn.setAttribute('aria-label', [who, when].filter(Boolean).join(', '));
      if (turn.classList.contains('user') || head.querySelector('.ph-turn-more')) continue;
      const b = mk('button', 'ph-turn-more');
      b.type = 'button';
      b.setAttribute('aria-label', `More for this reply${who ? ` from ${who}` : ''}`);
      b.title = 'More for this reply';
      b.append(dotsIcon());
      b.addEventListener('click', e => {
        e.preventDefault();
        openTurnSheet(turn, b);
      });
      head.append(b);
    }
  }

  function openTurnSheet(turn, opener) {
    const who = txt(turn.querySelector('.turn-head .who')) || 'Reply';
    const when = txt(turn.querySelector('.turn-head .when'));
    openSheet({
      title: who,
      note: when,
      opener,
      fill: (body, api) => {
        body.append(sheetRow({
          label: 'Copy reply',
          iconName: 'file',
          onPick: () => {
            const text = String((turn.querySelector('.turn-body') || turn).textContent || '').trim();
            api.close();
            MuseUI.copyText(text);
          },
        }));
        // The turnExtras slot (mob-11 part 2 adds Report this reply): each item is { label, icon, run(turn, opener) }.
        const extras = MuseUI.slots.list('turnExtras').slice().sort((a, b) => a.order - b.order);
        for (const it of extras) {
          const v = it.value;
          if (!v || typeof v.run !== 'function') continue;
          body.append(sheetRow({
            label: String(v.label ?? it.id),
            iconName: typeof v.icon === 'string' ? v.icon : '',
            onPick: () => {
              api.close();
              v.run(turn, opener);
            },
          }));
        }
      },
    });
  }

  // ---------- the title bar's "⋯" sheet (8.14) ----------

  // The chips that other panels place after the project name (git, spend, and so on). The title bar hides them on the phone (ext-phone.css),
  // and the More sheet lists them, so each stays one tap away.
  function titleExtras() {
    if (!refs.topbar) return [];
    const out = [];
    for (const el of Array.from(refs.topbar.querySelectorAll('.proj-title > *'))) {
      if (el.matches('#projName, #projPath, .ph-title')) continue;
      const buttons = el.tagName === 'BUTTON' ? [el] : Array.from(el.querySelectorAll('button'));
      if (buttons.length) out.push(...buttons);
      else out.push(el);
    }
    return out;
  }

  function openMoreSheet(opener) {
    openSheet({
      title: 'More',
      opener,
      className: 'ph-sheet-more',
      fill: (body, api) => {
        const panes = MuseUI.pane.list().filter(id => id !== 'agents' && id !== 'review');
        if (panes.length) {
          body.append(sectionHead('Panes'));
          for (const id of panes) {
            body.append(sheetRow({
              label: PANE_TITLE[id] || id,
              iconName: 'layers',
              onPick: () => {
                api.close();
                MuseUI.pane.open(id);
              },
            }));
          }
        }
        const chips = [
          ...MuseUI.slots.list('titlebar').filter(it => it.id !== 'phones' && it.value instanceof Element).map(it => it.value),
          ...titleExtras(),
        ];
        if (chips.length) {
          body.append(sectionHead('This project'));
          for (const chip of chips) {
            const label = txt(chip) || chip.getAttribute('aria-label') || 'Action';
            body.append(sheetRow({
              label,
              note: chip.title && chip.title !== label ? chip.title : '',
              disabled: chip.disabled === true,
              onPick: () => {
                api.close();
                chip.click();
              },
            }));
          }
        }
        const links = qa('.side-foot .side-link').filter(b => !b.hidden);
        if (links.length) {
          body.append(sectionHead('App'));
          for (const b of links) {
            body.append(sheetRow({
              label: txt(b),
              disabled: b.disabled === true,
              onPick: () => {
                api.close();
                b.click();
              },
            }));
          }
        }
        body.append(sectionHead('Phone'));
        const phones = state.phones;
        const selfId = selfOverride || (shell && shell.device && typeof shell.device.id === 'string' ? shell.device.id : '');
        const names = phones.map(p => (selfId && p.id === selfId ? `${p.name} (this phone)` : p.name));
        body.append(sheetRow({
          label: phones.length ? `Phones connected (${phones.length})` : 'Phones connected',
          note: phones.length ? names.join(', ') : 'No other phone is connected.',
          onPick: () => {
            api.close();
            MuseUI.openSettings('phones');
          },
        }));
        if (shellHas('openSettings')) {
          body.append(sheetRow({
            label: 'Phone settings',
            onPick: () => {
              api.close();
              shellCall('openSettings');
            },
          }));
        }
        const lockMode = connView().lockMode;
        if (shellHas('lock') && typeof lockMode === 'string' && lockMode !== 'off') {
          body.append(sheetRow({
            label: 'Lock now',
            onPick: () => {
              api.close();
              shellCall('lock');
            },
          }));
        }
        if (shellHas('switchComputer')) {
          body.append(sheetRow({
            label: 'Switch computer',
            onPick: () => {
              api.close();
              shellCall('switchComputer');
            },
          }));
        }
      },
    });
  }

  function openConnSheet(opener) {
    const c = connView();
    const name = c.desktopName || 'your computer';
    const st = c.state || 'connected';
    const sentence = st === 'connected'
      ? `Connected to ${name}${c.carrier ? ` over ${CARRIER_LONG[c.carrier] || c.carrier}` : ''}.`
      : st === 'reconnecting' ? `Reconnecting to ${name}.` : st === 'asleep' ? `${name} is asleep or Plenum is closed.` : `Can't reach ${name}.`;
    openSheet({
      title: 'Connection',
      note: sentence,
      opener,
      fill: (body, api) => {
        body.append(sheetRow({
          label: 'Phones and ways to reach this computer',
          onPick: () => {
            api.close();
            MuseUI.openSettings('phones');
          },
        }));
      },
    });
  }

  // ---------- the "+" sheet (8.5.4, the plusMenu slot and the attach button) ----------

  function openPlusSheet(opener) {
    openSheet({
      title: 'Add',
      opener,
      fill: (body, api) => {
        const items = MuseUI.slots.list('plusMenu').slice().sort((a, b) => a.order - b.order);
        for (const it of items) {
          const v = it.value;
          if (!v || typeof v.run !== 'function') continue;
          body.append(sheetRow({
            label: String(v.label ?? it.id),
            iconName: typeof v.icon === 'string' ? v.icon : '',
            onPick: () => {
              api.close();
              v.run();
            },
          }));
        }
        const attach = q('.attach-btn');
        if (attach) {
          body.append(sheetRow({
            label: 'Files',
            iconName: 'file-plus',
            onPick: () => {
              api.close();
              attach.click();
            },
          }));
        }
        if (!body.querySelector('.ph-row')) body.append(mk('p', 'ph-sheet-note', 'Nothing to add here yet.'));
      },
    });
  }

  // ---------- the model and role sheet (8.5.2): every #modelSel option, in order, with its disabled state ----------

  function isOpt(node) {
    return node && node.tagName === 'OPTION';
  }

  function optionRow(opt, busy, api) {
    const name = txt(opt.querySelector('.o-name') || opt) || opt.value;
    const noteEl = opt.querySelector('.o-note');
    const note = noteEl ? txt(noteEl) : '';
    const disabled = opt.disabled === true || busy;
    const reason = busy && !opt.disabled ? 'A reply is running. Change the model when it ends.' : (opt.disabled ? (opt.title || note || 'Not available here.') : note);
    const row = mk('button', 'ph-row ph-opt');
    row.type = 'button';
    row.setAttribute('role', 'radio');
    const checked = opt.value === refs.modelSel.value;
    row.setAttribute('aria-checked', String(checked));
    if (disabled) row.setAttribute('aria-disabled', 'true');
    const dot = mk('span', 'ph-dot');
    dot.setAttribute('aria-hidden', 'true');
    const provider = opt.querySelector('.o-dot') ? opt.querySelector('.o-dot').dataset.p : '';
    if (provider) dot.dataset.p = provider;
    const text = mk('span', 'ph-row-text');
    text.append(mk('span', 'ph-row-label', name));
    if (reason) text.append(mk('span', 'ph-row-note', reason));
    row.append(dot, text);
    if (checked) row.append(icon('check', 'ph-check'));
    row.dataset.search = `${name} ${reason}`.toLowerCase();
    row.addEventListener('click', () => {
      if (disabled) {
        MuseUI.toast(reason || 'Not available right now.', 'bad');
        return;
      }
      const sel = refs.modelSel;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      api.close();
    });
    return row;
  }

  function openModelSheet(opener) {
    openSheet({
      title: 'Model and role',
      opener,
      className: 'ph-sheet-model',
      fill: (body, api) => {
        const sel = refs.modelSel;
        const eff = refs.effortSel;
        body.append(sectionHead('Send to'));
        const seg = mk('div', 'ph-seg');
        seg.setAttribute('role', 'radiogroup');
        seg.setAttribute('aria-label', 'Send to');
        const now = modeNow();
        for (const [mode, label] of [['chat', 'Chat'], ['council', 'Council']]) {
          const b = mk('button', 'ph-seg-btn', label);
          b.type = 'button';
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', String(now === mode));
          b.addEventListener('click', () => {
            if (modeNow() !== mode) {
              const src = q(`.mode-seg .seg-btn[data-mode="${mode}"]`);
              if (src) src.click();
            }
            api.close();
          });
          seg.append(b);
        }
        body.append(seg);
        if (now === 'council') {
          body.append(sheetRow({
            label: 'Edit seats…',
            note: txt(refs.boardSummary),
            onPick: () => {
              api.close();
              if (refs.boardSummary) refs.boardSummary.click();
            },
          }));
        }

        body.append(sectionHead('Models'));
        const search = mk('input', 'ph-search');
        search.type = 'search';
        search.placeholder = 'Search models';
        search.setAttribute('aria-label', 'Search models');
        search.autocomplete = 'off';
        body.append(search);
        const busy = Boolean(sel && sel.disabled);
        const groups = [];
        const loose = [];
        const addGroup = (label, options) => {
          if (!options.length) return;
          const g = mk('div', 'ph-group');
          if (label) g.append(mk('h2', 'ph-group-head', label));
          const radios = mk('div', 'ph-radios');
          radios.setAttribute('role', 'radiogroup');
          radios.setAttribute('aria-label', label || 'Models');
          for (const opt of options) radios.append(optionRow(opt, busy, api));
          g.append(radios);
          body.append(g);
          groups.push(g);
        };
        for (const node of Array.from(sel ? sel.children : [])) {
          if (node.tagName === 'OPTGROUP') addGroup(node.label, Array.from(node.children).filter(isOpt));
          else if (isOpt(node)) loose.push(node);
        }
        addGroup('', loose);
        search.addEventListener('input', () => {
          const needle = search.value.trim().toLowerCase();
          for (const g of groups) {
            let any = false;
            for (const row of qa('.ph-opt', g)) {
              const show = !needle || row.dataset.search.includes(needle);
              row.hidden = !show;
              if (show) any = true;
            }
            g.hidden = !any;
          }
        });

        if (eff && eff.options.length) {
          body.append(sectionHead('Effort'));
          const grid = mk('div', 'ph-effort');
          grid.setAttribute('role', 'radiogroup');
          grid.setAttribute('aria-label', 'Effort');
          for (const o of Array.from(eff.options)) {
            const label = txt(o.querySelector('.o-name') || o);
            const b = mk('button', 'ph-seg-btn', label);
            b.type = 'button';
            b.setAttribute('role', 'radio');
            const on = o.value === eff.value;
            b.setAttribute('aria-checked', String(on));
            if (busy) {
              b.setAttribute('aria-disabled', 'true');
            }
            b.addEventListener('click', () => {
              if (busy) {
                MuseUI.toast('A reply is running. Change the effort when it ends.', 'bad');
                return;
              }
              eff.value = o.value;
              eff.dispatchEvent(new Event('change', { bubbles: true }));
              api.close();
            });
            grid.append(b);
          }
          body.append(grid);
        }

        const more = [];
        if (refs.relayOpenBtn) {
          more.push(sheetRow({
            label: 'Relay…',
            note: 'Pass a finished reply from one seat to another',
            onPick: () => {
              api.close();
              refs.relayOpenBtn.click();
            },
          }));
        }
        for (const [re, label] of [[/^compare/i, 'Compare…'], [/^pipelines/i, 'Pipelines…']]) {
          const found = qa('.sidebar button, .side-foot button').find(b => re.test(txt(b)) && !b.hidden);
          if (found) {
            more.push(sheetRow({
              label,
              onPick: () => {
                api.close();
                found.click();
              },
            }));
          }
        }
        if (more.length) {
          body.append(sectionHead('More ways to send'));
          for (const row of more) body.append(row);
        }
      },
    });
  }

  // ---------- the composer's Mode menu, the drawers and Settings join the back stack ----------

  function wireLayers() {
    watchShown(refs.settingsPage, 'settings', () => {
      if (refs.settingsClose) refs.settingsClose.click();
    });
    watchShown(refs.drawer, 'drawer', () => {
      if (refs.drawerClose) refs.drawerClose.click();
    });
    attachModeWatch();
    if (refs.modeWrap) {
      new MutationObserver(attachModeWatch).observe(refs.modeWrap, { childList: true });
    }
  }

  // ---------- the keyboard: visualViewport, the iOS 26 re-measure, the Stop float ----------

  function textFocused() {
    const a = document.activeElement;
    if (!a) return false;
    if (a.tagName === 'TEXTAREA') return true;
    if (a.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'file', 'range', 'color', 'reset'].includes(a.type);
    return a.isContentEditable === true;
  }

  function setKb(kb) {
    const vv = window.visualViewport;
    const vh = state.forcedKb !== null ? innerHeight - state.forcedKb : (vv ? vv.height : innerHeight);
    const px = Math.max(0, Math.round(kb));
    root.style.setProperty('--kb', `${px}px`);
    root.style.setProperty('--vvh', `${Math.round(vh)}px`);
    state.kbOpen = px > 120;
    root.toggleAttribute('data-phone-kb', state.kbOpen);
    refreshChrome();
  }

  function measure() {
    if (state.forcedKb !== null) {
      setKb(state.forcedKb);
      return;
    }
    const vv = window.visualViewport;
    const vh = vv ? vv.height : innerHeight;
    const off = vv ? vv.offsetTop : 0;
    const focus = textFocused();
    if (innerWidth !== state.lastW) {
      state.lastW = innerWidth;
      state.layoutBase = innerHeight;
    }
    // With no text field focused, the full height is the layout base. With one focused, the keyboard is what is missing from it.
    if (!focus) state.layoutBase = Math.max(innerHeight, Math.round(vh));
    const kb = focus ? Math.max(0, Math.round((state.layoutBase || innerHeight) - vh - off)) : 0;
    setKb(kb);
  }

  // iOS 26 leaves visualViewport.offsetTop stale after the keyboard closes (WebKit 300523), so the value is taken again at 0, 100, 300 and 600 ms.
  function remeasureAfterBlur() {
    for (const ms of [0, 100, 300, 600]) setTimeout(measure, ms);
  }

  // ---------- text zoom: the platform's factor (--tz, data-tz) and the debug walk over the page's own text ----------

  const walked = new WeakMap();

  function scaleOne(el, f) {
    if (!(el instanceof HTMLElement)) return;
    let base = walked.get(el);
    if (base === undefined) {
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (!(px > 0)) return;
      const parent = el.parentElement;
      const inherits = parent && getComputedStyle(parent).fontSize === getComputedStyle(el).fontSize && state.walkF !== 1;
      base = inherits ? px / state.walkF : px;
      walked.set(el, base);
    }
    el.style.fontSize = f === 1 ? '' : `${(base * f).toFixed(2)}px`;
  }

  function setZoom(f) {
    const value = Number.isFinite(f) && f > 0 ? f : 1;
    state.zoom = value;
    root.style.setProperty('--tz', String(value));
    root.dataset.tz = value < 1.3 ? '1' : value < 1.6 ? '2' : '3';
  }

  let zoomObserver = null;
  function walkZoom(f) {
    if (!document.body) return;
    if (state.walkF === 1 && f !== 1) {
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        if (walked.has(el)) continue;
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (px > 0) walked.set(el, px);
      }
    }
    for (const el of Array.from(document.body.querySelectorAll('*'))) scaleOne(el, f);
    state.walkF = f;
    if (f !== 1 && !zoomObserver) {
      zoomObserver = new MutationObserver(records => {
        for (const rec of records) {
          for (const node of Array.from(rec.addedNodes)) {
            if (node instanceof HTMLElement) {
              scaleOne(node, state.walkF);
              for (const el of Array.from(node.querySelectorAll('*'))) scaleOne(el, state.walkF);
            }
          }
        }
      });
      zoomObserver.observe(document.body, { childList: true, subtree: true });
    }
    if (f === 1 && zoomObserver) {
      zoomObserver.disconnect();
      zoomObserver = null;
    }
  }

  // ---------- presence: the phones connected now (the "⋯" sheet's Phones connected row, 8.14) ----------

  function setPhones(list) {
    state.phones = (Array.isArray(list) ? list : [])
      .filter(p => p && typeof p.id === 'string')
      .map(p => ({ id: p.id, name: typeof p.name === 'string' && p.name ? p.name : 'Phone' }));
  }

  async function readPhones() {
    try {
      await (MuseUI.ready ?? Promise.resolve());
      const res = await MuseUI.request('/api/phones');
      if (!res || !res.ok) return;
      const data = await res.json();
      const devices = Array.isArray(data.devices) ? data.devices : [];
      setPhones(devices.filter(d => d && d.connected === true).map(d => ({ id: d.id, name: d.name })));
    } catch {
      // No phone support in this build, or the server did not answer; the row says none is connected.
    }
  }

  // ---------- part 2 (mob-11, wave 107): approvals, the waiting bar, hand-over, the strips, the adapters, Settings > This phone ----------
  // MOBILE-UI 8.4.3, 8.4.5, 8.6, 8.8, 8.9, 8.10, 8.11, 8.12, 9, 10, 12, 13 and the checks P-12, P-25 to P-34, P-36. The desktop
  // cards, panes and notices are driven and restyled, never rebuilt: an answer still goes through the card's own button.

  const ARM_MS = 400;     // 8.6 rule 2: a card is armed this long after it renders, scrolls into view or gets new detail
  const QUIET_MS = 250;   // a pointer tap this soon after a scroll ends is ignored (keyboard and assistive activation are exempt)
  const AGAIN_MS = 1500;  // the "Tap again" label stays this long
  const MOVE_MAX = 10;    // a pointer that moved this far between down and up on the button is a drag, not a tap
  const STRIP_STATES = ['reconnecting', 'offline', 'asleep', 'phone-offline'];
  const STRIP_TONE = { reconnecting: 'warn', offline: 'bad', asleep: 'muted', 'phone-offline': 'muted' };
  const CONN_LONG = { connected: 'Connected', reconnecting: 'Reconnecting', offline: 'Offline', asleep: 'Asleep', 'phone-offline': 'This phone is offline' };
  const TIER_WORD = { full: 'Full control', approve: 'Approve and watch', read: 'Read only' };
  const TIER_NOTE = {
    approve: 'This phone can approve, deny and stop. Starting runs needs Full control, which you set at the computer under Settings › Phones.',
    read: 'This phone can watch and stop. Change it at the computer under Settings › Phones.',
  };
  const p2 = {
    scrolling: false,
    scrollEnd: -1e9,
    scrollTimer: 0,
    press: null,               // { el, x, y, moved } for the last pointer down on a card's answer button
    armedById: new Map(),      // approval id -> { at, detail }: when the card was armed and the detail it showed (kept across rebuilds)
    armedByEl: new WeakMap(),  // a card without an id -> { at, detail }
    shownIds: new Set(),       // approval ids whose answer row was brought into view once (a rebuild does not scroll again)
    again: new WeakMap(),      // button -> the timer that restores its label
    offlineOff: new WeakSet(), // buttons this module disabled for the connection (and only those)
    fake: [],                  // debug approvals for another project (plenumPhoneDebug.approval)
    fakeSeq: 0,
    tierOverride: null,
    announced: new Set(),      // approval ids already announced as waiting off screen
    waitTarget: null,
    pictureTold: false,
    signBypass: null,
    barTimer: 0,
    barFired: false,
    newerHold: false,          // the Newer pill was tapped: it stays hidden until the end is in view
  };

  const hhmm = value => {
    const d = value instanceof Date ? value : new Date(value);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const firstLine = text => String(text ?? '').split('\n')[0].trim().slice(0, 160);

  // A line for the screen reader. The same words twice are announced again, because the text is cleared first.
  function announce(text, assertive = false) {
    const node = assertive ? refs.alert : refs.live;
    if (!node) return;
    node.textContent = '';
    setTimeout(() => {
      node.textContent = String(text);
    }, 40);
  }

  function buildLive() {
    const polite = mk('div', 'ph-sr');
    polite.id = 'ph-live';
    polite.setAttribute('role', 'status');
    polite.setAttribute('aria-live', 'polite');
    const urgent = mk('div', 'ph-sr');
    urgent.id = 'ph-alert';
    urgent.setAttribute('role', 'alert');
    document.body.append(polite, urgent);
    refs.live = polite;
    refs.alert = urgent;
  }

  // ---------- the tier and the connection (9): the composer is replaced by a note; the strip shows the four states ----------

  function phoneTier() {
    if (p2.tierOverride) return p2.tierOverride;
    const c = connView();
    const t = c && typeof c.tier === 'string' ? c.tier : (shell && typeof shell.tier === 'string' ? shell.tier : 'full');
    return t === 'approve' || t === 'read' ? t : 'full';
  }

  function paintTier() {
    const t = phoneTier();
    const limited = t !== 'full';
    if (refs.composer) refs.composer.hidden = limited;
    let note = $('ph-tier-note');
    if (!note && refs.composerWrap) {
      note = mk('p', 'ph-tier-note');
      note.id = 'ph-tier-note';
      refs.composerWrap.insertBefore(note, refs.composer || null);
    }
    if (note) {
      note.hidden = !limited;
      const copy = TIER_NOTE[t] || '';
      if (note.textContent !== copy) note.textContent = copy;
    }
  }

  function connNow() {
    const st = connView().state || 'connected';
    if (st === 'connected' && navigator.onLine === false && !state.connOverride) return 'phone-offline';
    return st;
  }

  function lastSeenText() {
    const c = connView();
    if (!c || !c.lastSeen) return '';
    const t = typeof c.lastSeen === 'number' || c.lastSeen instanceof Date ? c.lastSeen : Date.parse(String(c.lastSeen));
    return Number.isFinite(Number(t)) && Number(t) > 0 ? ` Last seen ${hhmm(t)}.` : '';
  }

  // The computer's name as it reported itself. Until a computer has said its name, the phone says "your computer", never a made-up name.
  function deskName() {
    const n = connView().desktopName;
    return n ? String(n) : 'your computer';
  }

  function deskCap() {
    const n = deskName();
    return n.charAt(0).toUpperCase() + n.slice(1);
  }

  function stripText(st) {
    if (st === 'reconnecting') return `Reconnecting to ${deskName()}…`;
    if (st === 'offline') return `Can't reach ${deskName()}.${lastSeenText()}`;
    if (st === 'asleep') return `${deskCap()} is asleep or Plenum is closed.${lastSeenText()} Plenum reconnects when it wakes.`;
    if (st === 'phone-offline') return 'This phone is offline.';
    return '';
  }

  function openAwakeSheet(opener) {
    openSheet({
      title: `Keep ${deskName()} awake`,
      note: `On ${deskName()}, Settings › Desktop › Keep awake holds it up only while a run is going. For the rest, raise the sleep timer under Windows Settings › Power & battery.`,
      opener,
    });
  }

  function stripButton(label) {
    const b = mk('button', 'ph-strip-btn', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (label === 'Try again') {
        if (shellHas('retry')) shellCall('retry');
        else if (MuseUI.refresh) MuseUI.refresh();
      } else if (label === 'Details') {
        openConnSheet(b);
      } else {
        openAwakeSheet(b);
      }
    });
    return b;
  }

  function buildStrip() {
    const node = mk('div', 'ph-strip');
    node.id = 'ph-strip';
    node.hidden = true;
    node.setAttribute('role', 'status');
    const text = mk('p', 'ph-strip-text');
    const actions = mk('div', 'ph-strip-actions');
    node.append(text, actions);
    refs.strip = { node, text, actions, shown: '', since: 0 };
    MuseUI.slots.add('bannerSlot', 'ph-strip', node, -5);
  }

  // The shell draws its own strip while it is not connected, so this one shows only when the shell's is not on screen.
  function paintStrip() {
    const s = refs.strip;
    if (!s) return;
    const st = connNow();
    if (st !== s.shown) {
      s.shown = st;
      s.since = performance.now();
      s.text.textContent = stripText(st);
      s.node.dataset.tone = STRIP_TONE[st] || '';
      s.actions.replaceChildren();
      const acts = st === 'offline' ? ['Try again', 'Details'] : st === 'asleep' ? ['Try again', 'How to keep it awake'] : [];
      for (const label of acts) s.actions.append(stripButton(label));
      if (STRIP_STATES.includes(st) && st !== 'reconnecting') announce(s.text.textContent, st === 'offline');
    }
    const shellStrip = document.querySelector('#plenum-conn-strip:not([hidden])');
    // Reconnecting shows only after 1.5 s (9), so a quick hop does not flash a strip.
    const waited = st !== 'reconnecting' || performance.now() - s.since >= 1500;
    if (st === 'reconnecting' && !waited) setTimeout(refreshAll, 1600);
    s.node.hidden = !(STRIP_STATES.includes(st) && !shellStrip && waited);
  }

  // Approval buttons are disabled while the computer cannot be reached (9), with the line that says when they come back.
  function paintOffline() {
    const off = STRIP_STATES.includes(connNow());
    for (const card of qa('.approval:not(.typeit)')) {
      const answers = qa('.approval-actions > button, .ph-scope > button', card).filter(b => !b.classList.contains('ph-link-btn'));
      for (const b of answers) {
        if (off && !b.disabled) {
          b.disabled = true;
          p2.offlineOff.add(b);
        } else if (!off && p2.offlineOff.has(b)) {
          b.disabled = false;
          p2.offlineOff.delete(b);
        }
      }
      let line = card.querySelector(':scope > .ph-off-note');
      if (off && !line && answers.length) {
        line = mk('p', 'ph-off-note', `Reconnecting… answer when ${deskName()} is back.`);
        line.setAttribute('role', 'status');
        const actions = card.querySelector(':scope > .approval-actions');
        if (actions) actions.before(line);
      } else if (!off && line) {
        line.remove();
      }
    }
  }

  // ---------- the approval guard (8.6 rules 1 and 2, P-12, P-34) ----------

  function trackScroll() {
    const scrollDone = () => {
      p2.scrolling = false;
      p2.scrollEnd = performance.now();
    };
    document.addEventListener('scroll', () => {
      p2.scrolling = true;
      clearTimeout(p2.scrollTimer);
      p2.scrollTimer = setTimeout(scrollDone, 120);
    }, { capture: true, passive: true });
    document.addEventListener('scrollend', scrollDone, { capture: true, passive: true });
  }

  // The card a button belongs to, when the button answers an approval: its Approve, Deny and scope buttons. Show all, the reason link and
  // the hand-over box are not guarded.
  function guardedCard(el) {
    if (!(el instanceof HTMLButtonElement)) return null;
    if (el.closest('.approval-more, .ph-link-btn, .typeit')) return null;
    const card = el.closest('.approval');
    if (!card || card.classList.contains('typeit')) return null;
    if (!el.closest('.approval-actions') && !el.closest('.ph-scope')) return null;
    return card;
  }

  // The state of a card is kept by its approval id, not by its element: the desktop rebuilds every card on each build event.
  function cardDetail(card) {
    const detail = card.querySelector('.approval-detail');
    return detail ? detail.textContent : '';
  }

  function armedOf(card) {
    const id = card.getAttribute('data-approval-id') || '';
    return id ? (p2.armedById.get(id) ?? null) : (p2.armedByEl.get(card) ?? null);
  }

  // A card is armed for ARM_MS when it first appears and again when its detail changes. A rebuilt card with the same detail stays armed
  // as it was (only the remaining window is kept on the new element), so a tap is not refused again after a build event.
  function armCard(card) {
    const id = card.getAttribute('data-approval-id') || '';
    const detail = cardDetail(card);
    const now = performance.now();
    const prev = armedOf(card);
    if (prev && prev.detail === detail) {
      const left = ARM_MS - (now - prev.at);
      if (left > 0) {
        card.dataset.phArming = '1';
        setTimeout(() => { if (card.isConnected) delete card.dataset.phArming; }, left);
      }
      return;
    }
    const entry = { at: now, detail };
    if (id) p2.armedById.set(id, entry);
    else p2.armedByEl.set(card, entry);
    card.dataset.phArming = '1';
    setTimeout(() => {
      if (card.isConnected) delete card.dataset.phArming;
    }, ARM_MS);
  }

  function blockReason(btn, card, detail, press) {
    const now = performance.now();
    if (now - (armedOf(card)?.at ?? -1e9) < ARM_MS) return 'render';
    // A keyboard, switch or assistive activation has detail 0 and is exempt from the movement and scroll rules (8.6 rule 2).
    if (detail === 0) return '';
    if (p2.scrolling || now - p2.scrollEnd < QUIET_MS) return 'scroll';
    if (press && press.el === btn && press.moved >= MOVE_MAX) return 'move';
    return '';
  }

  function showAgain(btn) {
    const isDeny = btn.classList.contains('ph-deny') || /^Deny/.test(btn.dataset.phLabel || txt(btn));
    if (!btn.dataset.phLabel) btn.dataset.phLabel = btn.textContent;
    btn.textContent = 'Tap again';
    btn.classList.add('ph-again');
    clearTimeout(p2.again.get(btn));
    p2.again.set(btn, setTimeout(() => {
      p2.again.delete(btn);
      btn.classList.remove('ph-again');
      if (btn.dataset.phLabel) btn.textContent = btn.dataset.phLabel;
    }, AGAIN_MS));
    announce(`Ready. Tap again to ${isDeny ? 'deny' : 'approve'}.`);
  }

  // An honoured answer: the haptic, and "Approved on this phone at 14:03" (8.6 rule 4) once the computer has recorded it. The computer
  // sends an approval event with action 'answered' for the id; a refused answer (403, 409 or a lost connection) sends none, so the
  // phone says nothing extra and the shell's own error stands.
  function answered(btn, card) {
    const deny = btn.classList.contains('ph-deny') || /^Deny/.test(btn.dataset.phLabel || txt(btn));
    shellCall('haptic', 'light');
    const verb = deny ? 'Denied' : 'Approved';
    const at = hhmm(new Date());
    const id = card.getAttribute('data-approval-id') || '';
    if (!id) return;
    const onEvent = e => {
      const ev = e.detail;
      if (!ev || ev.type !== 'approval' || ev.action !== 'answered' || String(ev.approvalId ?? '') !== id) return;
      if ((ev.allow === true) === deny) return;   // the computer recorded the other answer
      done();
      MuseUI.toast(`${verb} on this phone at ${at}`);
    };
    const done = () => {
      window.removeEventListener('plenum:event', onEvent);
      clearTimeout(timer);
    };
    const timer = setTimeout(done, 20000);
    window.addEventListener('plenum:event', onEvent);
  }

  // An unarmed or early tap is cancelled in the capture phase, so the card never sees it, and the button says so (never silent).
  document.addEventListener('click', e => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn) return;
    const card = guardedCard(btn);
    if (!card) return;
    // A card that appeared in this frame is decorated and armed now, so a click in the same frame is still refused.
    if (card.dataset.phCard !== '1') decorateCard(card);
    armCard(card);
    const press = p2.press && p2.press.el === btn ? p2.press : null;
    p2.press = null;
    if (blockReason(btn, card, e.detail, press)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showAgain(btn);
      return;
    }
    answered(btn, card);
  }, true);

  function trackPress() {
    document.addEventListener('pointerdown', e => {
      const btn = e.target instanceof Element ? e.target.closest('button') : null;
      p2.press = btn && guardedCard(btn) ? { el: btn, x: e.clientX, y: e.clientY, moved: 0 } : null;
    }, true);
    const measureMove = e => {
      if (!p2.press) return;
      p2.press.moved = Math.max(p2.press.moved, Math.hypot(e.clientX - p2.press.x, e.clientY - p2.press.y));
    };
    document.addEventListener('pointermove', measureMove, true);
    document.addEventListener('pointerup', measureMove, true);
  }

  // The card's controls: Approve and Deny in fixed places (Deny left), scope buttons in a row above, the reason behind a link.
  function decorateCard(card) {
    if (card.dataset.phCard === '1') return;
    card.dataset.phCard = '1';
    if (card.classList.contains('typeit')) {
      decorateHandOver(card);
      return;
    }
    const actions = card.querySelector(':scope > .approval-actions');
    if (!actions) return;
    // A card taller than the screen (a command notice sits above its buttons) would leave Approve and Deny below the fold. The answer
    // row is brought into view once per approval, after the desktop's own scroll to the card has run (that runs in the frame before
    // this one). A rebuild of the same card does not move the transcript again.
    const id = card.getAttribute('data-approval-id') || '';
    const first = !id || !p2.shownIds.has(id);
    if (id) p2.shownIds.add(id);
    if (first) {
      requestAnimationFrame(() => {
        if (actions.isConnected) actions.scrollIntoView({ block: 'nearest' });
      });
    }
    const answers = Array.from(actions.children).filter(el => el.tagName === 'BUTTON');
    const yes = answers.find(b => txt(b) === 'Approve');
    const no = answers.find(b => txt(b) === 'Deny');
    if (yes) yes.classList.add('ph-approve');
    if (no) no.classList.add('ph-deny');
    const extra = answers.filter(b => b !== yes && b !== no);
    if (extra.length) {
      const row = mk('div', 'ph-scope');
      for (const b of extra) {
        b.classList.add('ph-scope-btn');
        row.append(b);
      }
      actions.before(row);
    }
    const reason = card.querySelector(':scope > .approval-reason');
    if (reason && !card.querySelector(':scope > .ph-link-btn')) {
      reason.hidden = true;
      const link = mk('button', 'ph-link-btn', 'Deny with a reason…');
      link.type = 'button';
      link.addEventListener('click', () => {
        const open = reason.hidden;
        reason.hidden = !open;
        link.textContent = open ? 'Hide reason' : 'Deny with a reason…';
        if (open) reason.focus({ preventScroll: true });
      });
      actions.after(link);
    }
  }

  // The hand-over box (8.10, P-32): a password is type=password with autocomplete off; a code is numeric with one-time-code, so the
  // keyboard offers the code that just arrived on this phone. The model never sees either: the person types it here.
  function decorateHandOver(card) {
    const box = card.querySelector(':scope > .approval-reason');
    if (!box) return;
    const ask = txt(card.querySelector('.approval-summary'));
    const code = /\b(code|otp|2fa|two-factor|verification|passcode|one-time)\b/i.test(ask);
    box.classList.add('ph-secret');
    if (code) {
      box.type = 'text';
      box.inputMode = 'numeric';
      box.autocomplete = 'one-time-code';
    } else {
      box.type = 'password';
      box.autocomplete = 'off';
    }
    if (typeof MuseUI.notice === 'function') MuseUI.notice('phone-type-secret', { before: box });
  }

  // Each render: new cards are decorated and armed, a card whose detail changed is armed again, the offline state is applied.
  function sweep() {
    const present = new Set();
    for (const card of qa('.approval')) {
      const id = card.getAttribute('data-approval-id') || '';
      if (id) present.add(id);
      decorateCard(card);
      armCard(card);
    }
    // Forget the approvals that left the page, so the maps stay the size of the waiting list.
    for (const id of Array.from(p2.armedById.keys())) if (!present.has(id)) p2.armedById.delete(id);
    for (const id of Array.from(p2.shownIds)) if (!present.has(id)) p2.shownIds.delete(id);
    paintOffline();
    paintReview();
    paintAgents();
    hideAddPhone();
    paintSettingsNotes();
    paintControl();
  }

  // ---------- the waiting bar (8.6, P-31): shown while an approval or a hand-over waits and its card is not on screen ----------

  function buildWait() {
    const node = mk('div', 'ph-wait');
    node.id = 'ph-wait';
    node.setAttribute('role', 'region');
    node.setAttribute('aria-label', 'Waiting for you');
    node.hidden = true;
    const text = mk('span', 'ph-wait-text');
    const count = mk('span', 'ph-wait-count');
    const view = mk('button', 'ph-wait-view', 'View');
    view.type = 'button';
    view.addEventListener('click', () => {
      if (p2.waitTarget) viewWaiting(p2.waitTarget);
    });
    node.append(text, count, view);
    refs.wait = { node, text, count, view };
    MuseUI.slots.add('bannerSlot', 'ph-waiting', node, 1);
  }

  // The waiting items: the board's approvals (every project), the debug ones, and the hand-over boxes in the page.
  function waitingItems() {
    const out = [];
    let view = null;
    try {
      view = MuseUI.board && typeof MuseUI.board.view === 'function' ? MuseUI.board.view() : null;
    } catch {
      view = null;
    }
    for (const c of view && Array.isArray(view.approvals) ? view.approvals : []) {
      out.push({ kind: 'approval', id: String(c.approvalId ?? ''), project: String(c.projectName || 'Project'), projectId: c.projectId ?? null, summary: firstLine(c.summary), at: Number(c.at) || 0 });
    }
    for (const f of p2.fake) out.push(f);
    for (const node of qa('.approval.typeit')) {
      out.push({ kind: 'handover', id: '', project: projectName(), projectId: MuseUI.state.activeProject ?? null, summary: 'the model needs you to do a step.', node });
    }
    return out;
  }

  // A card is on screen when it sits between the title and the bar and nothing (a sheet or the pane) covers its middle.
  function visibleInView(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const top = refs.topbar ? refs.topbar.getBoundingClientRect().bottom : 0;
    const bottom = refs.bar ? refs.bar.getBoundingClientRect().top : innerHeight;
    const y0 = Math.max(r.top, top + 1);
    const y1 = Math.min(r.bottom, bottom - 1);
    if (y1 <= y0) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, (y0 + y1) / 2);
    return Boolean(hit && (el === hit || el.contains(hit)));
  }

  function itemOnScreen(item) {
    if (item.kind === 'handover') return visibleInView(item.node);
    const card = item.id ? document.querySelector(`[data-approval-id="${CSS.escape(item.id)}"]`) : null;
    return visibleInView(card);
  }

  function refreshWait() {
    const w = refs.wait;
    if (!w) return;
    const items = waitingItems();
    const off = items.filter(item => !itemOnScreen(item));
    for (const item of off) {
      if (item.id && !p2.announced.has(item.id)) {
        p2.announced.add(item.id);
        announce(`Approval needed in ${item.project}`);
        if (document.visibilityState === 'visible') shellCall('haptic', 'warn');
      }
    }
    for (const id of Array.from(p2.announced)) {
      if (!items.some(item => item.id === id)) p2.announced.delete(id);
    }
    p2.waitTarget = off[0] ?? null;
    w.node.hidden = off.length === 0;
    if (!off.length) return;
    const it = off[0];
    const line = it.kind === 'handover' ? `${it.project}: the model needs you to do a step.` : `${it.project}: ${it.summary}`;
    if (w.text.textContent !== line) w.text.textContent = line;
    const count = off.length > 1 ? `1 of ${off.length}` : '';
    if (w.count.textContent !== count) w.count.textContent = count;
  }

  // View: a card of this project scrolls into view and takes the focus, and its arming applies again. Another project opens Agents
  // with the card expanded, and does not change the active project (8.6, P-31).
  function viewWaiting(item) {
    const current = item.kind === 'handover' || (item.projectId && item.projectId === MuseUI.state.activeProject) || (!item.projectId && item.project === projectName());
    if (current) {
      const card = item.kind === 'handover' ? item.node : (item.id ? document.querySelector(`[data-approval-id="${CSS.escape(item.id)}"]`) : null);
      if (card && card.isConnected) {
        if (state.tab === 'agents' || state.tab === 'review') setTab('chat');
        armCard(card);
        card.scrollIntoView({ block: 'center' });
        card.focus({ preventScroll: true });
        return;
      }
    }
    setTab('agents');
    setTimeout(() => expandWaiting(item), 60);
  }

  function expandWaiting(item) {
    const want = firstLine(item.summary).slice(0, 40);
    const hit = want ? qa('.ext-agl *').find(el => el.children.length === 0 && txt(el).startsWith(want)) : null;
    const toggler = hit ? hit.closest('button, [role="button"], summary') || hit : null;
    if (toggler) {
      toggler.click();
      toggler.scrollIntoView({ block: 'center' });
    } else {
      announce(`Open ${item.project} to answer.`);
    }
  }

  // ---------- a notification named a place (H7): #waiting, #handover, #chat, #settings=limit, #home ----------

  // Calls fn until it answers something (the board and the project list may not be loaded when the app opens from a notification).
  function soon(fn, tries = 15, every = 200) {
    const attempt = left => {
      if (fn() || left <= 0) return;
      setTimeout(() => attempt(left - 1), every);
    };
    attempt(tries);
  }

  function goWaiting(id) {
    soon(() => {
      const items = waitingItems();
      const item = id ? items.find(i => i.id === id) : items[0];
      if (!item) return false;
      viewWaiting(item);
      return true;
    }, 10);
    // The card is gone (answered at the computer, or by another phone): Agents opens so the person sees what is left.
    setTimeout(() => {
      if (id && !waitingItems().some(i => i.id === id)) {
        setTab('agents');
        MuseUI.toast('That approval is no longer waiting.');
      } else if (!id && !waitingItems().length) {
        setTab('agents');
      }
    }, 2200);
  }

  function goHandover() {
    soon(() => {
      const item = waitingItems().find(i => i.kind === 'handover');
      if (!item) return false;
      viewWaiting(item);
      return true;
    }, 10);
  }

  function goChat(project) {
    setTab('chat');
    if (!project) return;
    soon(() => {
      const projects = MuseUI.state && Array.isArray(MuseUI.state.projects) ? MuseUI.state.projects : [];
      const at = projects.findIndex(p => p && p.id === project);
      if (at < 0) return false;
      if (MuseUI.state.activeProject !== project) {
        const row = qa('.proj-item', refs.projects)[at];
        if (row) row.click();
      }
      return true;
    }, 10);
  }

  // The spend limit is a chip of the project's title bar (ext-budget), which sits in the "⋯" sheet on the phone. Its own drawer is the place to
  // raise the limit; without the chip the Settings page opens.
  function goLimit() {
    const chip = q('.ext-budget-chip');
    if (chip && !chip.hidden) {
      chip.click();
      return;
    }
    try {
      MuseUI.openSettings('');
    } catch {
      MuseUI.toast('Open Settings to see your limits.');
    }
  }

  function handleRoute(link) {
    if (!link || typeof link !== 'object') return;
    if (link.kind === 'waiting') goWaiting(typeof link.id === 'string' ? link.id : '');
    else if (link.kind === 'handover') goHandover();
    else if (link.kind === 'chat') goChat(typeof link.project === 'string' ? link.project : '');
    else if (link.kind === 'settings' && link.section === 'limit') goLimit();
    else if (link.kind === 'home') setTab('projects');
  }

  function wireRoutes() {
    if (shell && typeof shell.onRoute === 'function') shell.onRoute(handleRoute);
    else window.addEventListener('plenum:route', e => handleRoute(e.detail));
    const first = shellCall('takeRoute');
    if (first) handleRoute(first);
  }

  // ---------- the composer's mic (L18, P-24): only when the shell says this phone can listen ----------

  const MIC_ERRORS = {
    'permission-denied': 'Allow the microphone for Plenum in the phone\'s Settings.',
    'on-device-unavailable': 'This phone cannot listen on its own. The speech service can be allowed in Phone settings › Dictation.',
    busy: 'Dictation is busy. Try again in a moment.',
    network: 'The speech service could not be reached.',
    'no-speech': 'Nothing was heard.',
  };
  const mic = { button: null, listening: false, off: [] };

  function micIcon() {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ic ph-ic');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v3']) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.8');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.append(p);
    }
    return svg;
  }

  function setListening(on) {
    mic.listening = on;
    if (!mic.button) return;
    mic.button.setAttribute('aria-pressed', String(on));
    mic.button.setAttribute('aria-label', on ? 'Stop dictation' : 'Dictate a message');
    mic.button.title = on ? 'Stop dictation' : 'Dictate a message';
  }

  function insertDictated(text) {
    const input = refs.input;
    const add = String(text || '').trim();
    if (!input || !add) return;
    const now = input.value;
    input.value = now ? `${now}${/\s$/.test(now) ? '' : ' '}${add}` : add;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function toggleMic() {
    const dictation = shellProp('dictation');
    if (!dictation) return;
    shellCall('haptic', 'light');
    if (mic.listening) {
      setListening(false);
      try {
        await dictation.stop();
      } catch {
        // Already stopped.
      }
      return;
    }
    try {
      setListening(true);
      await dictation.start();
    } catch (err) {
      setListening(false);
      MuseUI.toast(MIC_ERRORS[String(err && err.code)] || 'Dictation did not start.', 'bad');
    }
  }

  function paintMic() {
    const bar = refs.composer ? q('.composer-bar', refs.composer) : null;
    const caps = shellProp('caps');
    const dictation = shellProp('dictation');
    const can = Boolean(Array.isArray(caps) && caps.includes('dictation') && dictation && typeof dictation.start === 'function');
    if (!bar) return;
    if (can && !mic.button) {
      const b = mk('button', 'ph-mic');
      b.type = 'button';
      b.append(micIcon());
      b.addEventListener('click', toggleMic);
      mic.button = b;
      bar.insertBefore(b, refs.send && refs.send.parentElement === bar ? refs.send : null);
      setListening(false);
      const on = (name, fn) => {
        const off = dictation.on && dictation.on(name, fn);
        if (typeof off === 'function') mic.off.push(off);
      };
      on('final', e => insertDictated(e && e.text));
      on('end', () => setListening(false));
      on('error', e => {
        setListening(false);
        MuseUI.toast(MIC_ERRORS[String(e && e.code)] || 'Dictation stopped.', 'bad');
      });
    } else if (!can && mic.button) {
      for (const off of mic.off.splice(0)) off();
      mic.button.remove();
      mic.button = null;
      mic.listening = false;
    }
  }

  // ---------- the Newer pill (8.13, P-36) and the bar's long-press (8.13) ----------

  function buildNewer() {
    const b = mk('button', 'ph-newer', '↓ Newer');
    b.type = 'button';
    b.hidden = true;
    b.setAttribute('aria-label', 'Newer messages. Go to the end.');
    b.addEventListener('click', () => {
      // Hidden until the end is in view again, so the smooth scroll's own events do not bring it back.
      p2.newerHold = true;
      if (refs.chat) refs.chat.scrollTo({ top: refs.chat.scrollHeight, behavior: 'smooth' });
      b.hidden = true;
    });
    document.body.append(b);
    refs.newer = b;
    if (refs.chat) refs.chat.addEventListener('scroll', paintNewer, { passive: true });
  }

  // The pill shows while a reply streams and the transcript sits more than 180 px from its end (app.js stickBottom).
  function paintNewer() {
    if (!refs.newer || !refs.chat) return;
    const far = refs.chat.scrollHeight - refs.chat.scrollTop - refs.chat.clientHeight > 180;
    if (!far) p2.newerHold = false;
    refs.newer.hidden = !(state.tab === 'chat' && !state.paneId && MuseUI.state.running === true && far && !p2.newerHold);
  }

  function openThreadSheet(opener) {
    openSheet({
      title: `Threads in ${projectName()}`,
      opener,
      fill: (body, api) => {
        body.append(sheetRow({ label: 'Main', note: 'The thread you are in', check: true, onPick: () => { api.close(); setTab('chat'); } }));
        body.append(mk('p', 'ph-sheet-note', 'Only the main thread so far.'));
      },
    });
  }

  // The computers this phone is paired with (the shell's list), the one in use checked. A different one is connected from here; the UI that
  // computer sends replaces this page's once, the way a newer UI does. Pairing another computer, and the full list, are the shell's screens.
  function openComputersSheet(opener) {
    const c = connView();
    const list = shellHas('computers') ? shellCall('computers') : null;
    const rows = Array.isArray(list) && list.length ? list : [{ id: '', name: c.desktopName || 'your computer', active: true }];
    openSheet({
      title: 'Computers',
      opener,
      fill: (body, api) => {
        for (const comp of rows) {
          const note = comp.active
            ? (connNow() === 'connected' ? `Connected${c.carrier && CARRIER_LONG[c.carrier] ? ` over ${CARRIER_LONG[c.carrier]}` : ''}` : (CONN_WORD[connNow()] || 'Not connected'))
            : 'Tap to connect';
          body.append(sheetRow({
            label: String(comp.name || 'Computer'),
            note,
            check: comp.active === true,
            onPick: () => {
              api.close();
              if (comp.active || !comp.id || !shellHas('connectComputer')) return;
              MuseUI.toast(`Connecting to ${comp.name}…`);
              shellCall('connectComputer', comp.id);
            },
          }));
        }
        if (shellHas('switchComputer')) {
          body.append(sheetRow({ label: rows.length > 1 ? 'All computers' : 'Switch computer', note: rows.length > 1 ? '' : 'Pair another computer or change which one this phone uses.', onPick: () => { api.close(); shellCall('switchComputer'); } }));
        } else {
          body.append(sheetRow({ label: 'Switch computer', note: 'Only one computer is paired to this phone.', disabled: true }));
        }
      },
    });
  }

  // A 500 ms hold on Chat opens the thread sheet and on Projects the computers sheet. The click that ends the hold is swallowed.
  function wireBarPress() {
    const bar = refs.bar;
    if (!bar) return;
    let sx = 0;
    let sy = 0;
    const cancel = () => {
      clearTimeout(p2.barTimer);
      p2.barTimer = 0;
    };
    bar.addEventListener('pointerdown', e => {
      cancel();
      p2.barFired = false;
      const item = e.target instanceof Element ? e.target.closest('.ph-bar-item') : null;
      if (!item) return;
      sx = e.clientX;
      sy = e.clientY;
      p2.barTimer = setTimeout(() => {
        p2.barTimer = 0;
        p2.barFired = true;
        shellCall('haptic', 'light');
        if (item.dataset.tab === 'chat') openThreadSheet(item);
        else if (item.dataset.tab === 'projects') openComputersSheet(item);
      }, 500);
    });
    bar.addEventListener('pointermove', e => {
      if (p2.barTimer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel();
    });
    bar.addEventListener('pointerup', cancel);
    bar.addEventListener('pointercancel', cancel);
    bar.addEventListener('click', e => {
      if (!p2.barFired) return;
      p2.barFired = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  // ---------- the turn sheet's Report (8.4.5): a local report, Save report, Open an issue, and Send by email once a contact address is set ----------

  const REPORT_REASONS = ['Harmful or unsafe', 'Wrong or misleading', 'Something else'];
  // The contact address comes from the build (plenumShell.contactEmail: scripts/build-mobile.mjs reads package.json bugs.email, which is filled
  // before any store submission, MOBILE.json [CONTACT EMAIL]). While it is not set the email row says so instead of inventing an address; once
  // it is set the row is a button that opens the person's mail app with the report subject. Read when the sheet opens, never cached.
  function contactEmail() {
    const raw = shellProp('contactEmail');
    const value = typeof raw === 'string' ? raw.trim() : '';
    return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value) ? value : '';
  }
  const ISSUES_URL = 'https://github.com/RealAlcibiades/Plenum/issues/new';

  function openReportSheet(turn, opener) {
    const who = txt(turn.querySelector('.turn-head .who')) || 'the model';
    const when = txt(turn.querySelector('.turn-head .when'));
    const reply = String((turn.querySelector('.turn-body') || turn).textContent || '').trim();
    let reason = '';
    let note = '';
    openSheet({
      title: 'Report this reply',
      opener,
      className: 'ph-sheet-report',
      fill: (body, api) => {
        body.append(sectionHead('What is wrong with it?'));
        const radios = mk('div', 'ph-radios');
        radios.setAttribute('role', 'radiogroup');
        radios.setAttribute('aria-label', 'What is wrong with it?');
        for (const label of REPORT_REASONS) {
          const row = mk('button', 'ph-row ph-opt');
          row.type = 'button';
          row.setAttribute('role', 'radio');
          row.setAttribute('aria-checked', 'false');
          row.append(mk('span', 'ph-row-text', label));
          row.addEventListener('click', () => {
            reason = label;
            for (const other of qa('.ph-opt', radios)) other.setAttribute('aria-checked', String(other === row));
          });
          radios.append(row);
        }
        body.append(radios);
        const field = mk('textarea', 'ph-note-field');
        field.placeholder = 'Add a note (optional)';
        field.setAttribute('aria-label', 'Add a note (optional)');
        field.maxLength = 500;
        field.addEventListener('input', () => {
          note = field.value.slice(0, 500);
        });
        body.append(field);
        body.append(mk('p', 'ph-sheet-note', 'The report stays on this phone until you send it. It holds the reply and the model\'s name, not your files.'));
        const save = mk('button', 'ph-report-btn ph-report-primary', 'Save report');
        save.type = 'button';
        save.addEventListener('click', async () => {
          const lines = ['Plenum report', `Model: ${who}`, `Time: ${when}`, `Reason: ${reason || 'not chosen'}`, `Note: ${note || '(none)'}`, '', 'Reply:', reply];
          const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
          const ok = shellHas('save') ? await shellCall('save', { name: 'report.txt', blob }) : false;
          if (ok) {
            api.close();
            MuseUI.toast('Saved.');
          } else {
            MuseUI.toast('Could not save report.txt. Try again or use Share.', 'bad');
          }
        });
        body.append(save);
        const issue = mk('button', 'ph-report-btn', 'Open an issue');
        issue.type = 'button';
        issue.addEventListener('click', () => {
          const url = `${ISSUES_URL}?title=${encodeURIComponent(`Report: ${reason || 'a reply'}`)}`;
          if (shellHas('openExternal')) openOut(url);
          else MuseUI.toast('Open the Plenum issues page on a computer.', 'bad');
        });
        body.append(issue);
        const address = contactEmail();
        if (address) {
          const mail = mk('button', 'ph-report-btn', 'Send by email');
          mail.type = 'button';
          mail.addEventListener('click', () => {
            const url = `mailto:${address}?subject=${encodeURIComponent(`Report: ${reason || 'a reply'}`)}&body=${encodeURIComponent(`${note ? `${note}\n\n` : ''}Reply from ${who}:\n${reply.slice(0, 1500)}`)}`;
            const a = document.createElement('a');
            a.href = url;
            document.body.append(a);
            a.click();
            a.remove();
          });
          body.append(mail);
        } else {
          body.append(sheetRow({ label: 'Send by email', note: 'No contact address is set in this build. Save the report and send it yourself.', disabled: true }));
        }
      },
    });
  }

  // ---------- the adapters: window.open and https links go to the system browser, downloads go to save (8.4.3) ----------

  function openOut(href) {
    const r = shellCall('openExternal', href);
    if (r && typeof r.then === 'function') {
      r.then(ok => {
        if (ok === false) MuseUI.toast('Could not open that link.', 'bad');
      }, () => MuseUI.toast('Could not open that link.', 'bad'));
    }
    return r;
  }

  async function saveFrom(href, name) {
    const file = String(name || 'download');
    if (!shellHas('save')) {
      const a = document.createElement('a');
      a.href = href;
      a.download = file;
      document.body.append(a);
      a.click();
      a.remove();
      return;
    }
    try {
      const res = await fetch(href);
      if (!res.ok) throw new Error('download failed');
      const blob = await res.blob();
      const ok = await shellCall('save', { name: file, blob });
      if (ok) MuseUI.toast(shell.platform === 'web' ? 'Saved.' : 'Shared.');
      else MuseUI.toast(`Could not save ${file}. Try again or use Share.`, 'bad');
    } catch {
      MuseUI.toast(`Could not save ${file}. Try again or use Share.`, 'bad');
    }
  }

  // Accounts › "Sign in to …" on the phone opens a sheet: the sign-in opens a window on the computer, so it is finished there.
  function openSignInSheet(btn, label) {
    const provider = label.replace(/^Sign in (to|again)\s*/, '').trim() || 'your account';
    openSheet({
      title: 'Finish this sign-in on your computer',
      note: `Signing in to ${provider} opens a browser window on ${deskName()}. Plenum starts it now; finish it at the computer.`,
      opener: btn,
      fill: (body, api) => {
        body.append(sheetRow({
          label: 'Start on the computer',
          iconName: 'check',
          onPick: () => {
            api.close();
            p2.signBypass = btn;
            try {
              btn.click();
            } finally {
              p2.signBypass = null;
            }
          },
        }));
        body.append(sheetRow({ label: 'Cancel', onPick: () => api.close() }));
      },
    });
  }

  function installAdapters() {
    const nativeOpen = window.open;
    window.open = function (url, target, features) {
      const href = url === null || url === undefined ? '' : String(url);
      if (/^https:\/\//i.test(href) && shellHas('openExternal')) {
        openOut(href);
        return null;
      }
      return typeof nativeOpen === 'function' ? nativeOpen.call(window, url, target, features) : null;
    };
    document.addEventListener('click', e => {
      if (e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      // The picture of the browser (8.11): a tap is not input in v1, so it says so once. With the remote controls on (track B, below) the
      // picture's own pointer handler sends the tap, and this click only stops here.
      if (target.closest('.ext-brw-shot')) {
        e.preventDefault();
        e.stopPropagation();
        if (controlOn('browser')) return;
        if (!p2.pictureTold) {
          p2.pictureTold = true;
          MuseUI.toast(`This is a picture of the page on ${deskName()}. Use the address bar and the buttons here to steer it.`);
        }
        return;
      }
      const btn = target.closest('button');
      if (btn && btn !== p2.signBypass && !btn.closest('.ph-sheet, .ph-scrim')) {
        const label = txt(btn);
        if (/^Sign in (to|again)\b/.test(label)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          openSignInSheet(btn, label);
          return;
        }
      }
      const a = target.closest('a[href]');
      if (!a) return;
      if (a.hasAttribute('download')) {
        e.preventDefault();
        saveFrom(a.href, a.getAttribute('download'));
        return;
      }
      let url = null;
      try {
        url = new URL(a.href, location.href);
      } catch {
        url = null;
      }
      if (url && url.protocol === 'https:' && url.origin !== location.origin && shellHas('openExternal')) {
        e.preventDefault();
        openOut(url.href);
      }
    }, true);
  }

  // ---------- the panes on the phone: Review's diff (8.8, P-29), Agents' rows and Stop labels (8.7, P-30), Artifacts and the run view ----------

  // Wrap is on by default; a phone-only toggle turns it off, and then only the diff's own lines scroll sideways. The choice stays while the
  // person moves from file to file (the pane draws each diff again), and is forgotten with the page.
  let reviewWrap = true;

  // The files of the Review list in the order the pane draws them, the selected one marked by the pane itself (aria-pressed).
  function reviewPicks(root) {
    return qa('.ext-review-files .ext-review-pick', root);
  }

  // [‹ Previous] [Viewed ✓] [Next ›] under the diff (MOBILE-UI 8.8). The three act through the pane's own list: Previous and Next press the
  // neighbour's file button, Viewed flips the selected row's tick. The bar is the phone's, so the pane's own redraws leave it alone.
  function buildReviewNav(root) {
    const nav = mk('div', 'ph-review-nav');
    nav.setAttribute('role', 'group');
    nav.setAttribute('aria-label', 'Files in this review');
    const prev = mk('button', 'ph-review-prev', '‹ Previous');
    const viewed = mk('button', 'ph-review-viewed', 'Viewed');
    const next = mk('button', 'ph-review-next', 'Next ›');
    const where = mk('span', 'ph-review-where');
    where.setAttribute('role', 'status');
    for (const b of [prev, viewed, next]) b.type = 'button';
    const step = delta => {
      const picks = reviewPicks(root);
      const at = picks.findIndex(p => p.getAttribute('aria-pressed') === 'true');
      const to = picks[at < 0 ? (delta > 0 ? 0 : picks.length - 1) : at + delta];
      if (!to) return;
      to.click();
      const diff = q('.ext-review-diff', root);
      if (diff) diff.scrollTop = 0;
      const row = reviewPicks(root).find(p => p.getAttribute('aria-pressed') === 'true');
      if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
      paintReviewNav(root);
    };
    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    viewed.addEventListener('click', () => {
      const pick = reviewPicks(root).find(p => p.getAttribute('aria-pressed') === 'true');
      const box = pick && pick.closest('.ext-review-row') ? pick.closest('.ext-review-row').querySelector('input[type="checkbox"]') : null;
      if (!box) return;
      box.checked = !box.checked;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      paintReviewNav(root);
    });
    nav.append(prev, viewed, next, where);
    const foot = q(':scope > .ext-review-foot', root);
    if (foot) root.insertBefore(nav, foot);
    else root.append(nav);
    return nav;
  }

  function paintReviewNav(root) {
    const picks = reviewPicks(root);
    let nav = q(':scope > .ph-review-nav', root);
    if (!picks.length) {
      if (nav) nav.hidden = true;
      return;
    }
    if (!nav) nav = buildReviewNav(root);
    nav.hidden = false;
    const at = picks.findIndex(p => p.getAttribute('aria-pressed') === 'true');
    const prev = q('.ph-review-prev', nav);
    const next = q('.ph-review-next', nav);
    const viewed = q('.ph-review-viewed', nav);
    const where = q('.ph-review-where', nav);
    const here = at < 0 ? null : picks[at];
    prev.disabled = at <= 0;
    next.disabled = at < 0 ? picks.length < 1 : at >= picks.length - 1;
    const row = here ? here.closest('.ext-review-row') : null;
    const done = Boolean(row && row.classList.contains('is-viewed'));
    viewed.disabled = !row;
    viewed.setAttribute('aria-pressed', String(done));
    const label = done ? 'Viewed ✓' : 'Viewed';
    if (viewed.textContent !== label) viewed.textContent = label;
    const words = at < 0 ? `${picks.length} ${picks.length === 1 ? 'file' : 'files'}` : `${at + 1} of ${picks.length}`;
    if (where.textContent !== words) where.textContent = words;
  }

  function paintReview() {
    for (const lines of qa('.ext-review-lines')) {
      lines.classList.toggle('ph-nowrap', !reviewWrap);
      const before = lines.previousElementSibling;
      if (before && before.classList.contains('ph-wrap')) {
        before.setAttribute('aria-pressed', String(reviewWrap));
        continue;
      }
      const b = mk('button', 'ph-wrap', 'Wrap');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(reviewWrap));
      b.addEventListener('click', () => {
        reviewWrap = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(reviewWrap));
        lines.classList.toggle('ph-nowrap', !reviewWrap);
      });
      lines.before(b);
    }
    for (const root of qa('.ext-review')) paintReviewNav(root);
  }

  // The project of an agent row is the last run above it in the same section ("my-app · Main" gives "my-app").
  function projectOfRow(row) {
    const sec = row.closest('.ext-agl-sec');
    if (!sec) return '';
    const runs = qa('.ext-board-run-title', sec).filter(r => r.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
    const last = runs[runs.length - 1];
    return last ? txt(last).split(' · ')[0] : '';
  }

  function paintAgents() {
    for (const b of qa('.ext-agl .ext-agl-stop')) {
      const row = b.closest('.ext-agl-row');
      const title = txt(row && row.querySelector('.ext-agl-title'));
      const project = row ? projectOfRow(row) : '';
      const label = project && title ? `Stop ${title} in ${project}` : (title ? `Stop ${title}` : 'Stop');
      if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
    }
    for (const t of qa('.ext-agl-empty .ext-agl-text')) {
      const copy = 'No runs yet. Runs and their agents show here while they work.';
      if (t.textContent !== copy) t.textContent = copy;
    }
  }

  // ---------- Settings: This phone is the first section; Add phone is hidden on the phone (8.12, P-28) ----------

  function registerThisPhone() {
    if (!MuseUI.settings || typeof MuseUI.settings.register !== 'function') return;
    try {
      MuseUI.settings.register({
        id: 'this-phone',
        scope: 'app',
        title: 'This phone',
        order: -100,
        render: body => {
          body.append(mk('p', 'ph-note-line', `Notifications, app lock, appearance and ways to reach ${deskName()} are set on the phone.`));
          const c = connView();
          const name = shell && shell.device && shell.device.name ? String(shell.device.name) : 'This phone';
          const st = connNow();
          const link = st === 'connected'
            ? (c.carrier && CARRIER_LONG[c.carrier] ? `connected over ${CARRIER_LONG[c.carrier]}` : 'connected')
            : (CONN_LONG[st] || 'not connected').toLowerCase();
          body.append(mk('p', 'ph-note-line', `Phone: ${name} · ${TIER_WORD[phoneTier()]} · ${link}`));
          const open = mk('button', 'ph-report-btn', 'Open phone settings');
          open.type = 'button';
          open.addEventListener('click', () => shellCall('openSettings'));
          body.append(open);
        },
      });
    } catch {
      // The settings page is not ready in this build; the desktop sections still show.
    }
  }

  // The notes MOBILE-UI 8.12 puts in the desktop's own Settings sections on the phone. A note is added once per section and follows the
  // computer's name; the section itself is the desktop's and is not changed.
  const SETTINGS_NOTES = {
    appearance: () => `This sets the theme on ${deskName()}. The phone follows Phone settings › Appearance.`,
    'api-keys': () => `Sent encrypted to ${deskName()} and kept in its key store.`,
    music: () => 'Music plays on the screen that turned it on.',
  };

  function paintSettingsNotes() {
    for (const card of qa('#settingsPage .settings-card[data-section]')) {
      const id = card.dataset.section;
      const make = SETTINGS_NOTES[id];
      if (!make) continue;
      const copy = make();
      let note = card.querySelector(':scope .ph-settings-note');
      if (!note) {
        note = mk('p', 'ph-settings-note', copy);
        note.dataset.phNote = id;
        const body = card.querySelector(':scope > .card-body') || card;
        // The API key line sits right under the key fields; the others close their section.
        const fields = id === 'api-keys' ? qa('input[type="password"]', card) : [];
        const last = fields[fields.length - 1];
        const holder = last ? (last.closest('.setting, .field, label, .key-row') || last.parentElement) : null;
        if (holder && holder.parentElement) holder.after(note);
        else body.append(note);
      } else if (note.textContent !== copy) {
        note.textContent = copy;
      }
    }
  }

  function hideAddPhone() {
    for (const b of qa('#settingsPage button')) {
      if (txt(b) === 'Add phone' && !b.hidden) b.hidden = true;
    }
  }

  // ---------- the debug hooks (?debug=1, demo or selftest): approval, tier, stopState, connection ----------

  function installDebug2() {
    if (!DEBUG_ON || !window.plenumPhoneDebug) return;
    const dbg = window.plenumPhoneDebug;
    dbg.approval = opts => {
      const o = opts && typeof opts === 'object' ? opts : {};
      const id = String(o.id || `dbg-${++p2.fakeSeq}`);
      const project = o.project === undefined ? projectName() : String(o.project);
      const summary = String(o.summary ?? 'Run: npm test -- --watch=false');
      if (project === projectName() && refs.chat) {
        const card = MuseUI.approvalEl({ approvalId: id, summary, detail: String(o.detail ?? ''), defaultDeny: o.defaultDeny === true });
        refs.chat.append(card);
      } else {
        p2.fake.push({ kind: 'approval', id, project, projectId: null, summary: firstLine(summary), at: Date.now() });
      }
      refreshAll();
      return id;
    };
    dbg.tier = t => {
      p2.tierOverride = t === 'full' || t === 'approve' || t === 'read' ? t : null;
      refreshAll();
    };
    dbg.stopState = s => {
      const stop = $('plenum-stop');
      if (!stop) return;
      if (s === 'driving') {
        stop.dataset.driving = 'computer';
        stop.setAttribute('aria-description', 'A model is driving: Notepad, step 12 of 80');
      } else {
        delete stop.dataset.driving;
        stop.removeAttribute('aria-description');
      }
    };
    // The name is the computer's name in every line the phone shows. Tests pass another name to check that the phone uses it.
    // extra: { tier, lockMode, caps, carrier } go through connection() like the shell's own, so the tier, the Lock now row and the remote controls
    // (caps: the computer's capabilities, carrier: the way the phone reaches it) follow the production path.
    dbg.connection = (s, name = 'Studio PC', extra = {}) => {
      const st = String(s);
      const known = ['connected', 'reconnecting', 'offline', 'asleep', 'phone-offline'];
      const word = known.includes(st) ? st : 'offline';
      state.connOverride = { state: word, carrier: word === 'connected' ? 'lan' : '', desktopName: String(name), lastSeen: Date.now() - 120000 };
      if (extra && typeof extra.tier === 'string') state.connOverride.tier = extra.tier;
      if (extra && typeof extra.lockMode === 'string') state.connOverride.lockMode = extra.lockMode;
      if (extra && Array.isArray(extra.caps)) state.connOverride.caps = extra.caps.map(String);
      if (extra && typeof extra.carrier === 'string') state.connOverride.carrier = extra.carrier;
      refreshAll();
    };
    dbg.route = link => handleRoute(link);
    // Gives this page a shell property it does not have (computers, connectComputer, contactEmail, caps, dictation); undefined takes it away again.
    dbg.shell = patch => {
      for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
        if (value === undefined) delete debugShell[key];
        else debugShell[key] = value;
      }
      refreshAll();
    };
  }

  // ---------- wiring part 2 ----------

  function refreshAll() {
    refreshChrome();
    paintMic();
    paintStrip();
    paintOffline();
    paintTier();
    refreshWait();
    paintNewer();
    paintControl();
  }

  function observeAll() {
    let frame = 0;
    const later = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sweep();
        refreshWait();
        paintNewer();
      });
    };
    // The names of the agent Stops are put back at once, in the same turn as the redraw that replaced them, so a screen reader never lands on a
    // Stop that is only called "Stop <agent>" for a frame; everything else waits for the next frame.
    new MutationObserver(() => {
      paintAgents();
      later();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('plenum:board', refreshWait);
    window.addEventListener('plenum:event', e => {
      const ev = e.detail;
      if (ev && (ev.type === 'approval' || ev.type === 'activity' || ev.type === 'drive')) refreshWait();
    });
    window.addEventListener('plenum:connection', refreshAll);
    window.addEventListener('online', refreshAll);
    window.addEventListener('offline', refreshAll);
    setInterval(refreshAll, 1000);
  }

  // ---------- track B (MOBILE-UI 8.10 and 8.11, wave 121): the phone as the person ----------
  // A tap, a drag, typing and a key on the Browser picture, and Take over from phone on a computer run, are sent the way the person would send
  // them at the computer. The desktop and the Bridge check each one again (Full tier, the control capability, a run this phone holds). The
  // controls show only when the connection says this computer lets the phone act, the Full tier, a connected carrier, and on the iOS app only over
  // the LAN (lib/remote/tiers.mjs controlRefusal). Typed text is cleared once it is sent and kept nowhere else.
  const REMOTE_NOTICE = 'phone-remote-control';
  const TAKE_LABEL = 'Take over from phone';
  const RESUME_LABEL = 'Resume';
  const TYPE_LABEL = 'Type it for me';
  const KEY_NAMES = ['Enter', 'Tab', 'Backspace', 'Escape'];
  const TYPE_MAX = 1000;
  const TAP_PX = 10;
  const DRIVE_MS = 2000;
  const FRAME_NEXT_MIN = 250;
  const FRAME_NEXT_MAX = 2000;
  const FRAME_IDLE_MS = 2000;
  const FRAME_FAIL_MS = 4000;
  const LIVE_FAIL_MS = 1000;
  const NO_ANSWER = 'Plenum on this computer did not answer.';
  const CONTROL_CAP = { browser: 'browser-control', computer: 'computer-control' };
  // Pictures keep the size the desktop reported: a point is sent in that picture's pixels.
  const pictureSize = new WeakMap();
  const remote = {
    frame: { timer: 0, busy: false, fails: 0 },
    drive: { at: 0, busy: false },
    run: { held: false, drive: null, timer: 0, busy: false, dom: null, warned: false },
  };

  const setHidden = (node, flag) => {
    if (node && node.hidden !== flag) node.hidden = flag;
  };
  const drawerOpen = () => {
    const d = $('drawer');
    return Boolean(d) && !d.hidden;
  };
  const paneOpen = () => {
    const p = $('pane');
    return Boolean(p) && !p.hidden && MuseUI.pane.active() === 'browser';
  };
  const browserShot = () => {
    const root = q('.ext-brw');
    const view = root ? q('.ext-brw-view', root) : null;
    return view ? q('.ext-brw-shot', view) : null;
  };
  const briefDrive = d => ({ id: String(d.id), state: String(d.state || ''), pausedBy: String(d.pausedBy || '') });

  // Whether this page may send a kind of input: the computer's capability is in the connection (caps), the tier is Full, the phone is
  // connected, and the iOS app reaches the computer only over the LAN. Without caps in the connection the controls stay off.
  function controlOn(kind) {
    const c = connView();
    if (phoneTier() !== 'full' || connNow() !== 'connected') return false;
    if (!Array.isArray(c.caps) || !c.caps.includes(CONTROL_CAP[kind])) return false;
    const caps = shellProp('caps');
    const ios = shellProp('app') === 'ios' || (Array.isArray(caps) && caps.includes('lan-control') && shellProp('platform') !== 'android');
    return !ios || c.carrier === 'lan';
  }

  // POST to a route as the person. A refusal keeps its status and the server's own sentence; a dropped request says the computer did not answer.
  async function callPhone(path, body) {
    try {
      const res = await MuseUI.request(path, { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data, error: res.ok ? '' : String(data.error || `Request failed (${res.status})`) };
    } catch {
      return { ok: false, status: 0, data: {}, error: NO_ANSWER };
    }
  }

  async function readPhone(path) {
    const res = await MuseUI.request(path);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }

  // The strip the notice draws at the top of its place, once per launch (the notices registry decides; a hidden notice is not drawn).
  function noticeOnce(container) {
    if (!container || q(`[data-notice="${REMOTE_NOTICE}"]`, container) || typeof MuseUI.notice !== 'function') return;
    MuseUI.notice(REMOTE_NOTICE, { into: container });
  }

  function showPicture(img, data) {
    pictureSize.set(img, { width: Number(data.width), height: Number(data.height) });
    if (img.getAttribute('src') !== data.image) img.src = data.image;
    img.hidden = false;
  }

  // The point of the picture under a point of the screen. The picture is drawn from the top left at the size its box gives it (contain), so one
  // scale serves both axes. Null when the point is outside the picture.
  function pictureAt(img, cx, cy) {
    const size = pictureSize.get(img) || (img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    const r = img.getBoundingClientRect();
    if (!size || !(size.width > 0) || !(r.width > 0) || !(r.height > 0)) return null;
    const scale = Math.min(r.width / size.width, r.height / size.height);
    const x = (cx - r.left) / scale;
    const y = (cy - r.top) / scale;
    if (x < 0 || y < 0 || x > size.width || y > size.height) return null;
    return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height, scale };
  }

  // A press and release within TAP_PX is a tap; a longer move is a drag. The gesture is judged at release.
  function wirePicture(img, act) {
    let press = null;
    img.addEventListener('pointerdown', e => {
      if (e.button === 0 || e.pointerType !== 'mouse') press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    img.addEventListener('pointercancel', () => {
      press = null;
    });
    img.addEventListener('pointerup', e => {
      const p = press;
      press = null;
      if (!p || p.id !== e.pointerId) return;
      act(img, p.x, p.y, e.clientX - p.x, e.clientY - p.y);
    });
  }

  // A tap or a drag on the picture, as the person's input. The gate and the point are judged now. A drag moves the page the other way: a finger
  // that goes up scrolls the page down, so the sent dy is positive.
  function pictureGesture(kind, img, x, y, dx, dy) {
    if (!controlOn(kind)) return;
    const at = pictureAt(img, x, y);
    if (!at) return;
    if (Math.hypot(dx, dy) < TAP_PX) {
      sendAct(kind, { kind: 'tap', x: at.x, y: at.y, width: at.width, height: at.height });
      return;
    }
    const sx = Math.round(-dx / at.scale);
    const sy = Math.round(-dy / at.scale);
    if (!sx && !sy) return;
    sendAct(kind, { kind: 'scroll', x: at.x, y: at.y, width: at.width, height: at.height, dx: sx, dy: sy });
  }

  // One input as the person: the browser's route, or the computer run's (only while this phone holds the run). A refusal is said once. A
  // 409 from the run means the hold is over, so the view is released.
  async function sendAct(kind, body) {
    let route = '/api/browser/input';
    let payload = body;
    if (kind === 'computer') {
      const d = remote.run.drive;
      if (!remote.run.held || !d) return false;
      route = '/api/computer/input';
      payload = { id: d.id, ...body };
    }
    const r = await callPhone(route, payload);
    if (r.ok) return true;
    if (kind === 'computer' && r.status === 409) releaseRun();
    MuseUI.toast(r.error, 'bad');
    return false;
  }

  // The typing box and the keys, for the browser picture or a computer run. The box is cleared once its text is sent.
  function buildRows(kind) {
    const node = mk('div', 'ph-rc-rows');
    const row = mk('div', 'ph-rc-row');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ph-rc-text';
    input.maxLength = TYPE_MAX;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', kind === 'computer' ? 'Text to type on the computer' : 'Text to type on the page');
    input.placeholder = 'Text to type';
    const send = mk('button', 'ph-rc-btn ph-rc-send', TYPE_LABEL);
    send.type = 'button';
    send.addEventListener('click', async () => {
      const text = input.value;
      if (!text) return;
      if (await sendAct(kind, { kind: 'type', text })) input.value = '';
    });
    row.append(input, send);
    const keys = mk('div', 'ph-rc-keys');
    keys.setAttribute('role', 'group');
    keys.setAttribute('aria-label', kind === 'computer' ? 'Keys for the computer' : 'Keys for the page');
    for (const name of KEY_NAMES) {
      const b = mk('button', 'ph-rc-btn ph-rc-key', name);
      b.type = 'button';
      b.addEventListener('click', () => {
        sendAct(kind, { kind: 'key', key: name });
      });
      keys.append(b);
    }
    node.append(row, keys);
    return { node, input };
  }

  // ----- the Browser pane: the picture takes taps and drags, the typing box and the keys sit under it, and the picture is made again live -----

  function paneWatching() {
    return paneOpen() && controlOn('browser') && Boolean(browserShot());
  }

  function paintBrowserRemote() {
    const root = q('.ext-brw');
    const view = root ? q('.ext-brw-view', root) : null;
    const shot = view ? q('.ext-brw-shot', view) : null;
    if (!root || !view || !shot) return;
    let block = q('.ph-rc-browser', root);
    if (!block) {
      block = mk('div', 'ph-rc ph-rc-browser');
      block.hidden = true;
      block.append(buildRows('browser').node);
      view.after(block);
    }
    if (!shot.dataset.phRc) {
      shot.dataset.phRc = 'picture';
      wirePicture(shot, (img, x, y, dx, dy) => pictureGesture('browser', img, x, y, dx, dy));
    }
    const on = controlOn('browser') && !shot.hidden && Boolean(shot.getAttribute('src'));
    shot.toggleAttribute('data-ph-rc-on', on);
    setHidden(block, !on);
    if (on) noticeOnce(root);
  }

  function ensureBrowserFrames() {
    if (!paneWatching()) {
      if (remote.frame.timer) clearTimeout(remote.frame.timer);
      remote.frame.timer = 0;
      return;
    }
    if (!remote.frame.timer && !remote.frame.busy) remote.frame.timer = setTimeout(pollBrowser, 0);
  }

  // A picture of the page, made again at the rate the desktop asks (nextMs). It stops when the pane is not on screen.
  async function pollBrowser() {
    remote.frame.timer = 0;
    if (!paneWatching() || remote.frame.busy) return;
    remote.frame.busy = true;
    let next = FRAME_IDLE_MS;
    try {
      const r = await callPhone('/api/browser/frame', {});
      const shot = browserShot();
      if (!r.ok) {
        remote.frame.fails += 1;
        next = Math.min(FRAME_FAIL_MS, 500 * remote.frame.fails);
      } else if (shot && typeof r.data.image === 'string' && r.data.image.startsWith('data:image/')) {
        remote.frame.fails = 0;
        showPicture(shot, r.data);
        next = Math.min(FRAME_NEXT_MAX, Math.max(FRAME_NEXT_MIN, Number(r.data.nextMs) || FRAME_NEXT_MIN));
      }
    } finally {
      remote.frame.busy = false;
    }
    if (paneWatching() && !remote.frame.timer) remote.frame.timer = setTimeout(pollBrowser, next);
  }

  // ----- a computer run in the Computer runs panel: Take over from phone, then the run's picture, the typing box, the keys and Resume -----

  // The computer's live drive, read at most every DRIVE_MS. The drive bar reads the same list.
  function refreshDrive() {
    if (remote.drive.busy || Date.now() - remote.drive.at < DRIVE_MS) return;
    remote.drive.busy = true;
    remote.drive.at = Date.now();
    readPhone('/api/drive').then(data => {
      const list = Array.isArray(data.drives) ? data.drives : [];
      const d = list.find(x => x && x.kind === 'computer' && x.state !== 'stopped') || null;
      const next = d ? briefDrive(d) : null;
      if (!next || (remote.run.drive && remote.run.drive.id !== next.id)) releaseRun();
      remote.run.drive = next;
    }).catch(() => {
      // The list could not be read; the view keeps what it has.
    }).finally(() => {
      remote.drive.busy = false;
    });
  }

  function buildRunRemote() {
    const block = mk('div', 'ph-rc ph-rc-run');
    block.hidden = true;
    const take = mk('button', 'ph-rc-btn ph-rc-takeover', TAKE_LABEL);
    take.type = 'button';
    take.addEventListener('click', takeOver);
    const frame = mk('div', 'ph-rc-frame');
    const img = document.createElement('img');
    img.className = 'ph-rc-pic';
    img.alt = '';
    img.hidden = true;
    frame.append(img);
    const rows = buildRows('computer');
    const resume = mk('button', 'ph-rc-btn ph-rc-resume', RESUME_LABEL);
    resume.type = 'button';
    resume.addEventListener('click', resumeRun);
    block.append(take, frame, rows.node, resume);
    wirePicture(img, (el, x, y, dx, dy) => pictureGesture('computer', el, x, y, dx, dy));
    remote.run.dom = { block, take, frame, img, rows: rows.node, resume };
    return block;
  }

  function paintRunRemote() {
    const body = $('drawerBody');
    const facts = body ? q('.cu-facts', body) : null;
    let block = body ? q('.ph-rc-run', body) : null;
    // ext-computer.js sets data-live on the facts line, so a change of its wording does not remove Take over.
    const live = facts?.dataset.live === 'true';
    if (!live || !controlOn('computer')) {
      if (block) block.remove();
      return;
    }
    if (!block) {
      block = buildRunRemote();
      facts.after(block);
    }
    refreshDrive();
    const dom = remote.run.dom;
    const drive = remote.run.drive;
    setHidden(block, !drive);
    if (!drive || !dom) return;
    setHidden(dom.take, remote.run.held);
    setHidden(dom.frame, !remote.run.held);
    setHidden(dom.rows, !remote.run.held);
    setHidden(dom.resume, !remote.run.held);
    if (!remote.run.held && dom.block.contains(document.activeElement) && document.activeElement.closest('[hidden]')) dom.take.focus({ preventScroll: true });
    noticeOnce(block);
  }

  // Pauses the run and gives this phone its screen. The desktop answers only a Full phone that the Bridge brought, and holds the run for it.
  async function takeOver() {
    const d = remote.run.drive;
    if (!d) return;
    const r = await callPhone('/api/computer/takeover', { id: d.id });
    if (!r.ok) {
      MuseUI.toast(r.error, 'bad');
      return;
    }
    remote.run.held = true;
    remote.run.warned = false;
    if (r.data.drive) remote.run.drive = briefDrive(r.data.drive);
    paintRunRemote();
    remote.run.dom?.resume.focus({ preventScroll: true });
    ensureLive();
  }

  async function resumeRun() {
    const d = remote.run.drive;
    if (!d) return;
    const r = await callPhone('/api/drive/resume', { id: d.id });
    if (!r.ok) {
      MuseUI.toast(r.error, 'bad');
      return;
    }
    releaseRun();
    paintRunRemote();
    remote.run.dom?.take.focus({ preventScroll: true });
  }

  // The hold is over here: the picture stops and the view goes back to Take over from phone.
  function releaseRun() {
    remote.run.held = false;
    if (remote.run.timer) clearTimeout(remote.run.timer);
    remote.run.timer = 0;
    const img = remote.run.dom ? remote.run.dom.img : null;
    if (img) {
      img.hidden = true;
      img.removeAttribute('src');
    }
  }

  function ensureLive() {
    const block = remote.run.dom ? remote.run.dom.block : null;
    const on = remote.run.held && Boolean(block) && block.isConnected && !block.hidden && drawerOpen();
    if (!on) {
      if (remote.run.timer) clearTimeout(remote.run.timer);
      remote.run.timer = 0;
      return;
    }
    if (!remote.run.timer && !remote.run.busy) remote.run.timer = setTimeout(pollLive, 0);
  }

  // The run's picture, made again at the rate the desktop asks. A 409 means the hold is over (the run resumed or stopped, or a card waits).
  async function pollLive() {
    remote.run.timer = 0;
    if (!remote.run.held || !remote.run.drive || remote.run.busy || !drawerOpen()) return;
    remote.run.busy = true;
    let next = FRAME_IDLE_MS;
    try {
      const r = await callPhone('/api/computer/live', { id: remote.run.drive.id });
      if (r.status === 409) {
        releaseRun();
        MuseUI.toast(r.error, 'bad');
      } else if (r.ok && remote.run.dom) {
        if (typeof r.data.image === 'string' && r.data.image.startsWith('data:image/')) {
          remote.run.warned = false;
          showPicture(remote.run.dom.img, r.data);
          next = Math.min(FRAME_NEXT_MAX, Math.max(FRAME_NEXT_MIN, Number(r.data.nextMs) || FRAME_NEXT_MIN));
        }
      } else {
        next = LIVE_FAIL_MS;
        if (!remote.run.warned) {
          remote.run.warned = true;
          MuseUI.toast(r.error, 'bad');
        }
      }
    } finally {
      remote.run.busy = false;
    }
    if (remote.run.held && !remote.run.timer) remote.run.timer = setTimeout(pollLive, next);
  }

  // Redraws the remote controls and keeps their polls going. It runs from the sweep and the one-second refresh and changes only what differs.
  function paintControl() {
    paintBrowserRemote();
    paintRunRemote();
    ensureBrowserFrames();
    ensureLive();
  }

  function startPart2() {
    buildLive();
    buildWait();
    buildStrip();
    buildNewer();
    wireBarPress();
    trackScroll();
    trackPress();
    installAdapters();
    registerThisPhone();
    MuseUI.slots.add('turnExtras', 'ph-report', { label: 'Report this reply', run: openReportSheet }, 90);
    installDebug2();
    observeAll();
    sweep();
    refreshAll();
    wireRoutes();
    if (shell && typeof shell.onCaps === 'function') shell.onCaps(() => paintMic());
  }

  // ---------- building the phone's frame ----------

  function decorateAll() {
    decorateProjects();
    decorateTurns();
  }

  function buildFrame() {
    buildBar();
    buildTitle();
    buildComposer();
    wireLayers();
    decorateAll();
    setupProjectLongPress();
  }

  function wireEvents() {
    if (refs.paneButtons) {
      new MutationObserver(() => paintBar()).observe(refs.paneButtons, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    if (refs.projName) new MutationObserver(() => refreshChrome()).observe(refs.projName, { childList: true, characterData: true, subtree: true });
    if (refs.projects) new MutationObserver(decorateProjects).observe(refs.projects, { childList: true });
    if (refs.chat) new MutationObserver(decorateTurns).observe(refs.chat, { childList: true, subtree: true });
    if (refs.modelSel) new MutationObserver(paintChip).observe(refs.modelSel, { childList: true, subtree: true, attributes: true });
    const modeSeg = q('.mode-seg');
    if (modeSeg) new MutationObserver(paintChip).observe(modeSeg, { attributes: true, subtree: true, attributeFilter: ['aria-pressed'] });
    if (refs.effortSel) refs.effortSel.addEventListener('change', refreshChrome);
    if (refs.modelSel) refs.modelSel.addEventListener('change', refreshChrome);
    state.chatTimer = setInterval(() => {
      paintChip();
      paintTitle();
    }, 800);
    if (typeof ResizeObserver === 'function' && refs.composer) {
      new ResizeObserver(() => {
        publishComposerTop();
        publishDock();
      }).observe(refs.composer);
    }

    window.addEventListener('plenum:pane', onPaneEvent);
    window.addEventListener('plenum:event', e => {
      const ev = e.detail;
      if (!ev || ev.type !== 'phone' || ev.kind !== 'presence' || !Array.isArray(ev.connected)) return;
      setPhones(ev.connected);
    });
    window.addEventListener('plenum:connection', e => {
      state.online = !(e.detail && e.detail.connected === false);
      paintConn();
    });
    window.addEventListener('resize', measure);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', measure);
      window.visualViewport.addEventListener('scroll', measure);
    }
    document.addEventListener('focusin', e => {
      if (!textFocused()) return;
      measure();
      if (e.target instanceof Element && e.target.closest('#composer')) {
        try {
          window.scrollTo(0, 0);
        } catch {
          // Not allowed in this page state.
        }
      }
    });
    document.addEventListener('focusout', remeasureAfterBlur);

    // Escape closes the top layer first and stops there. Tab stays inside a sheet while one is open.
    window.addEventListener('keydown', e => {
      const top = layers[layers.length - 1];
      if (!top) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeEntry(top, { dom: true, back: true });
        return;
      }
      if (e.key === 'Tab' && top.kind === 'sheet' && top.el) {
        const items = focusables(top.el);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const at = document.activeElement;
        if (e.shiftKey && (at === first || !top.el.contains(at))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (at === last || !top.el.contains(at))) {
          e.preventDefault();
          first.focus();
        }
      }
    }, true);

    // The page's history is this panel's: the browser's Back, the edge swipe and history.back() from closeEntry arrive as popstate. The
    // native apps' hardware Back does not pop the page, so the shell hands it here (onBack); the answer true means a layer or the tab took it.
    window.addEventListener('popstate', () => handleBack(true));
    if (shell && typeof shell.onBack === 'function') shell.onBack(() => handleBack(false));
    if (shell && typeof shell.onConnection === 'function') shell.onConnection(() => paintConn());
    if (shell && typeof shell.onTextZoom === 'function') shell.onTextZoom(f => setZoom(f));
    const platformZoom = shellCall('textZoom');
    setZoom(typeof platformZoom === 'number' ? platformZoom : 1);
  }

  function installDebug() {
    if (!DEBUG_ON) return;
    const dbg = window.plenumPhoneDebug && typeof window.plenumPhoneDebug === 'object' ? window.plenumPhoneDebug : {};
    dbg.safeArea = (t, r, b, l) => {
      ['top', 'right', 'bottom', 'left'].forEach((side, i) => {
        const v = [t, r, b, l][i];
        root.style.setProperty(`--dbg-sa-${side}`, `${Math.max(0, Number(v) || 0)}px`);
      });
      refreshChrome();
    };
    dbg.keyboard = px => {
      const v = Math.max(0, Number(px) || 0);
      state.forcedKb = v > 0 ? v : null;
      setKb(v);
    };
    dbg.textZoom = f => {
      setZoom(Number(f));
      walkZoom(Number(f));
    };
    dbg.tab = name => setTab(String(name));
    dbg.self = id => {
      selfOverride = String(id || '');
    };
    dbg.back = () => handleBack(false);
    if (typeof dbg.connection !== 'function') {
      dbg.connection = (s, name = 'Studio PC') => {
        const st = String(s);
        state.connOverride = { state: st === 'connected' ? 'connected' : st === 'asleep' ? 'asleep' : st === 'reconnecting' ? 'reconnecting' : 'offline', carrier: st === 'connected' ? 'lan' : '', desktopName: String(name) };
        paintConn();
      };
    }
    window.plenumPhoneDebug = dbg;
  }

  function start() {
    buildFrame();
    applyTab(state.tab);
    wireEvents();
    installDebug();
    measure();
    readPhones();
    refreshChrome();
    startPart2();
  }

  try {
    start();
  } catch (err) {
    console.error(err);
  }
})();
