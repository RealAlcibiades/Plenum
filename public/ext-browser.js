// The Browser tab of the side pane (brw-02). Pages open in the desktop app, in their own sandboxed views with their own cookie store
// (desktop/browser.cjs); this file draws the toolbar, the tabs, the questions a page raises and the settings, and tells the desktop
// where to put the page view: the view is drawn by Electron above this page, over the grey placeholder below the tabs. Under plain
// `node server.mjs` there is no desktop app and the pane says so. Loaded by ext.js and adds itself through window.MuseUI.
// Everything a page or a site can influence (a tab's title and address, a file name, a site's name) is placed with textContent.
// There is no inline style and no style attribute: the look is in ext-browser.css.
//
// The native view hides while anything is open over the pane (the drawer, a dialog, a menu, Settings): the pane finds out by asking
// the browser what is on top at points across the placeholder, so any layer counts, and then shows the page's last picture in its place.
//
// For the model's browser control (brw-03) this file offers window.MuseBrowser: state(), onState(fn), headerSlot (an element in the
// pane's header, which holds the switch "Let the model use this browser") and stripSlot (an element above the page, which holds the
// drive strip). The pane shows a "Model is driving: <last action>" badge whenever the server says the model drives, so the indicator
// is there from the start.
//
// brw-03 in this file (UI-ARCH 4 and 10.6): the header switch, the drive strip with Pause or Resume and Stop (the same controls as the
// drive bar: /api/drive/pause, /resume, /stop), the "Type it for me" box while the run waits for a password or code, the Approve all line
// with "Ask me anyway this run", and under the page: Actions (what the model did), Sites the model may open without asking, Any site
// without asking, Checks (the six categories that always ask) and the size of a page snapshot. Every switch saves at once through
// POST /api/browser/settings and says "Saved" or the server's reason beside it.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TAB = 'browser';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const POLL_MS = 2500;
  const SYNC_MS = 150;
  const NOTICE_FRESH_MS = 60_000;
  const FLASH_MS = 2600;
  const CLEAR_ARM_MS = 5000;
  const COVER_POINTS = 6;
  // While the view is shown its place is sent again this often, so a view the desktop took off the window by itself (the window hid
  // to the tray, a crashed page) comes back without waiting for a change here.
  const HEARTBEAT_MS = 2000;
  const TEXT = {
    plain: 'The browser works in the desktop app. Under node server.mjs there is nothing to show here.',
    empty: 'No tab is open. Type an address above, or open a new tab.',
    signIn: 'Sign-ins made here stay in this browser only; Plenum never reads them. Some providers refuse to sign in inside an app window (Google does).',
    downloadNotice: 'A downloaded file is untrusted until you have looked at it. Plenum saves it and never opens or runs it; open it yourself when you are sure.',
    permissionNotice: 'This site asks for a permission. Allow it only for sites you trust; a model driving the browser never gets it.',
    risky: 'This kind of file can run programs. Open it only if you trust where it came from.',
    inChat: 'The model’s browser wants to save a file. Answer in the chat.',
    driving: 'Model is driving',
    // brw-03
    agent: 'Let the model use this browser',
    reach: 'Browser tools reach Claude (API key) and the API models with tools on. CLI agents keep their own tools.',
    planMode: 'Plan mode is on for this project, so the model cannot drive the browser.',
    agentNotice: 'A model can use this browser for you: open pages, click, type and send forms as you, on any site you are signed in to here. It asks before new sites and before anything that buys, sends, signs in or deletes. Watch the pane while it drives.',
    anySiteNotice: 'Any site: the model opens pages without asking, as you, on every site you are signed in to here. Keep this off unless you are watching the pane.',
    checkNotice: 'Without this check the model will do this on the page by itself when it thinks the task needs it. Every action is still listed under Actions, and Stop ends the run.',
    shotNotice: 'Screenshots of this browser go to the model’s provider. Close tabs it should not see.',
    approveAll: 'Approve all is on: this run’s cards will be answered for you.',
    secretNote: 'This is typed straight into the field. The model never sees it, and Plenum does not keep it.',
    noActions: 'Nothing yet. What the model does in the browser is listed here.',
  };
  const DOWNLOAD_NOTICE = 'browser-download';
  const PERMISSION_NOTICE = 'browser-permission';
  const AGENT_NOTICE = 'browser-agent';
  const ANY_SITE_NOTICE = 'browser-any-site';
  const CHECK_NOTICE = 'browser-check-off';
  const SHOT_NOTICE = 'browser-screenshot';
  const LOG_SHOWN = 60;
  // The six checks, in the order and the words the pane shows (the server's ids, lib/browser-tools.mjs BROWSER_CATEGORIES).
  const CHECKS = [
    ['send', 'Sending, posting or publishing'],
    ['buy', 'Buying, paying or checkout'],
    ['signin', 'Signing in'],
    ['delete', 'Deleting or removing'],
    ['agree', 'Agreeing, accepting or confirming'],
    ['personal', 'Entering personal details'],
  ];
  const HOST_RE = /^(\*\.)?[a-z0-9.-]{1,253}$/i;

  // ---------- small helpers ----------

  const mk = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const clamp = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const inputOf = (tag, cls, attrs = {}) => {
    const node = mk(tag, cls);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  function fmtSize(n) {
    if (!(n > 0)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
  }

  function folderName(dir) {
    if (!dir) return 'Downloads';
    const parts = dir.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || dir;
  }

  // The icons this pane needs that the shared sprite does not have: added once, under the same naming (#i-name).
  const ICONS = {
    globe: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.4 2.5 3.7 5.5 3.7 9s-1.3 6.5-3.7 9c-2.4-2.5-3.7-5.5-3.7-9S9.6 5.5 12 3z'],
    'arrow-left': ['M19 12H5', 'M11 6l-6 6 6 6'],
    'arrow-right': ['M5 12h14', 'M13 6l6 6-6 6'],
    reload: ['M19.5 12a7.5 7.5 0 1 1-2.4-5.5', 'M19.5 4.5v4.5H15'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  };
  function installIcons() {
    if (document.getElementById('ext-brw-sprite')) return;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = 'ext-brw-sprite';
    svg.setAttribute('class', 'sprite');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const [name, paths] of Object.entries(ICONS)) {
      if (document.getElementById(`i-${name}`)) continue;
      const symbol = document.createElementNS(SVG_NS, 'symbol');
      symbol.id = `i-${name}`;
      symbol.setAttribute('viewBox', '0 0 24 24');
      for (const d of paths) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        symbol.append(path);
      }
      svg.append(symbol);
    }
    document.body.append(svg);
  }
  installIcons();

  const iconBtn = (name, label, cls = '') => {
    const b = mk('button', `icon-btn ext-brw-btn ${cls}`.trim());
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(MuseUI.icon(name));
    return b;
  };

  // ---------- notices ----------

  // MuseUI.notice draws the registered notice when the notices module is loaded. When it draws nothing this file draws the strip with
  // the same words: OK closes it, Don't show again keeps it closed on this computer, More opens Settings.
  const hiddenKey = id => `plenum-notice-hidden:${id}`;
  function noticeHidden(id) {
    try {
      return localStorage.getItem(hiddenKey(id)) === '1';
    } catch {
      return false;
    }
  }
  function forgetNotice(id) {
    try {
      localStorage.setItem(hiddenKey(id), '1');
    } catch {
      // Without storage the strip shows again next time, which is the safe side.
    }
  }
  // extra is an optional third button { label, run } (the browser-agent notice has one that turns the switch off).
  function noticeStrip(id, text, anchor, extra = null) {
    try {
      if (typeof MuseUI.notice === 'function' && MuseUI.notice(id, { after: anchor })) return null;
    } catch (err) {
      console.error(err); // the shared notice failed; the strip below says the same thing
    }
    if (noticeHidden(id)) return null;
    const strip = mk('div', 'ext-brw-notice');
    strip.setAttribute('role', 'note');
    const actions = mk('div', 'ext-brw-notice-actions');
    const ok = MuseUI.button('ghost small', 'OK');
    const never = MuseUI.button('ghost small', 'Don’t show again');
    ok.addEventListener('click', () => strip.remove());
    never.addEventListener('click', () => {
      forgetNotice(id);
      strip.remove();
    });
    actions.append(ok);
    if (extra) {
      const more = MuseUI.button('ghost small', extra.label);
      more.addEventListener('click', () => {
        strip.remove();
        extra.run();
      });
      actions.append(more);
    }
    actions.append(never);
    strip.append(mk('p', 'ext-brw-notice-text', text), actions);
    return strip;
  }

  // A notice strip of this feature, placed in a host element, replacing any strip of the same id there (a switch turned on twice shows
  // it once). Whether it was dismissed with "Don't show again" is kept by the server (hiddenNotices), not in the page's storage. The shared
  // notice (MuseUI.notice) draws it instead when the notices module knows the id; the strip below says the same thing.
  function showNotice(host, id, text, extra = null) {
    for (const old of host.querySelectorAll(`[data-notice="${id}"]`)) old.remove();
    if (S.control.hiddenNotices && S.control.hiddenNotices.includes(id)) return;
    const holder = mk('div', 'ext-brw-notice-slot');
    holder.dataset.notice = id;
    host.append(holder);
    try {
      if (typeof MuseUI.notice === 'function' && MuseUI.notice(id, { after: holder })) return;
    } catch (err) {
      console.error(err); // the shared notice failed; the strip below says the same thing
    }
    const strip = mk('div', 'ext-brw-notice');
    strip.setAttribute('role', 'note');
    const actions = mk('div', 'ext-brw-notice-actions');
    const ok = MuseUI.button('ghost small', 'OK');
    const never = MuseUI.button('ghost small', 'Don’t show again');
    ok.addEventListener('click', () => holder.remove());
    never.addEventListener('click', () => {
      holder.remove();
      hideNotice(id);
    });
    actions.append(ok);
    if (extra) {
      const more = MuseUI.button('ghost small', extra.label);
      more.addEventListener('click', () => {
        holder.remove();
        extra.run();
      });
      actions.append(more);
    }
    actions.append(never);
    strip.append(mk('p', 'ext-brw-notice-text', text), actions);
    holder.append(strip);
  }

  // Remembers a dismissed notice on the server. A failure is not shown: the notice then comes back next time, which is the safe side.
  async function hideNotice(id) {
    try {
      const data = await MuseUI.api('/api/browser/settings', { hideNotice: id });
      if (data && data.control) S.control = data.control;
    } catch {
      // The notice shows again next time.
    }
  }

  // ---------- state ----------

  const S = {
    available: null,
    tabs: [],
    activeTab: null,
    events: [],
    downloads: [],
    permissions: [],
    remembered: 0,
    settings: { blockDownloads: false, downloadDir: null },
    agentDriving: false,
    takeover: false,
    agent: true,
    maxTabs: 16,
    // brw-03: the switches the server keeps, "Ask me anyway this run", and the field that waits for the person ({ project, host, name }).
    control: { agent: true, allow: [], anySite: false, checks: {}, snapshotElements: 600, snapshotChars: 12000, hiddenNotices: [] },
    askAnyway: false,
    secret: null,
  };
  // The model's browser drives by id (the server's summaries, the same ones the drive bar shows) and the Actions log by project id.
  const drives = new Map();
  const logs = new Map();
  const listeners = new Set();
  let ui = null; // the open pane's elements and api, or null
  let polling = null;
  let lastEventAt = 0;
  let actionError = '';
  let actionErrorAt = 0;

  const activeTab = () => S.tabs.find(t => t.id === S.activeTab) ?? null;

  function apply(state) {
    if (!state || typeof state !== 'object') return;
    lastEventAt = Date.now();
    if (state.available === false) {
      S.available = false;
      S.tabs = [];
      S.activeTab = null;
      S.events = [];
      S.downloads = [];
      S.permissions = [];
    } else {
      S.available = true;
      if (Array.isArray(state.tabs)) S.tabs = state.tabs;
      S.activeTab = typeof state.activeTab === 'string' ? state.activeTab : null;
      if (Array.isArray(state.events)) S.events = state.events;
      if (Array.isArray(state.downloads)) S.downloads = state.downloads;
      if (Array.isArray(state.permissions)) S.permissions = state.permissions;
      if (Number.isFinite(state.remembered)) S.remembered = state.remembered;
      if (state.settings && typeof state.settings === 'object') {
        S.settings = { blockDownloads: state.settings.blockDownloads === true, downloadDir: typeof state.settings.downloadDir === 'string' ? state.settings.downloadDir : null };
      }
      S.agentDriving = state.agentDriving === true;
      S.takeover = state.takeover === true;
      S.agent = state.agent !== false;
      if (Number.isFinite(state.maxTabs)) S.maxTabs = state.maxTabs;
      if (state.control && typeof state.control === 'object') S.control = { ...S.control, ...state.control };
      S.askAnyway = state.askAnyway === true;
      S.secret = state.secret && typeof state.secret === 'object' ? state.secret : null;
    }
    updateCount();
    draw();
    for (const fn of [...listeners]) {
      try {
        fn(S);
      } catch (err) {
        console.error(err);
      }
    }
  }

  async function load() {
    try {
      await (MuseUI.ready ?? Promise.resolve());
      apply(await MuseUI.api('/api/browser/state'));
    } catch {
      // The server did not answer; the next poll or event fills the state in.
    }
  }

  // A request the person made. A refusal is shown on the status line, in red, until the next change.
  async function act(path, body = {}) {
    try {
      const data = await MuseUI.api(path, body);
      actionError = '';
      return data;
    } catch (err) {
      actionError = err?.message || 'The browser could not do that.';
      actionErrorAt = Date.now();
      drawStatus();
      return null;
    }
  }

  // ---------- the pane ----------

  function build(body, api) {
    const root = mk('div', 'ext-brw');
    root.setAttribute('aria-label', 'Browser');

    // Toolbar: Back, Forward, Reload, the address, Open outside.
    const bar = mk('div', 'ext-brw-bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Browser');
    const back = iconBtn('arrow-left', 'Back');
    const forward = iconBtn('arrow-right', 'Forward');
    const reload = iconBtn('reload', 'Reload');
    const url = inputOf('input', 'ext-brw-url', { type: 'url', 'aria-label': 'Address', placeholder: 'Enter a web address', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', enterkeyhint: 'go' });
    const outside = mk('a', 'ext-brw-out');
    outside.target = '_blank';
    outside.rel = 'noopener noreferrer';
    outside.title = 'Open this page in your system browser';
    outside.setAttribute('aria-label', 'Open outside');
    outside.append(MuseUI.icon('external'), mk('span', 'ext-brw-out-text', 'Open outside'));
    bar.append(back, forward, reload, url, outside);

    // The tabs.
    const tabsRow = mk('div', 'ext-brw-tabsrow');
    const tabs = mk('div', 'ext-brw-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Browser tabs');
    const plus = iconBtn('plus', 'New tab', 'ext-brw-plus');
    const driving = mk('span', 'ext-brw-driving', TEXT.driving);
    driving.hidden = true;
    driving.setAttribute('role', 'status');
    tabsRow.append(tabs, plus, driving);

    // The model's browser control (brw-03): the switch in the header row and the drive strip above the page. Both are also reachable
    // as window.MuseBrowser.headerSlot and stripSlot.
    const header = mk('div', 'ext-brw-headslot');
    const strip = mk('div', 'ext-brw-strip');
    const head = buildHeader();
    const driveStrip = buildStrip();
    slots.header.replaceChildren(head.el);
    slots.strip.replaceChildren(driveStrip.el);
    header.append(slots.header);
    strip.append(slots.strip);

    // Questions from pages: a download to save, a permission to allow.
    const asks = mk('div', 'ext-brw-asks');
    asks.setAttribute('role', 'region');
    asks.setAttribute('aria-label', 'Questions from the page');
    asks.setAttribute('aria-live', 'polite');

    // The placeholder the native view covers, with the picture shown while something covers the view.
    const viewEl = mk('div', 'ext-brw-view');
    const shot = mk('img', 'ext-brw-shot');
    shot.alt = '';
    shot.hidden = true;
    const plain = mk('p', 'ext-brw-plain', TEXT.plain);
    plain.hidden = true;
    const empty = mk('div', 'ext-brw-empty');
    const emptyText = mk('p', 'ext-brw-empty-text', TEXT.empty);
    const emptyBtn = MuseUI.button('primary small', 'New tab');
    empty.append(emptyText, emptyBtn);
    empty.hidden = true;
    viewEl.append(shot, plain, empty);

    const status = mk('p', 'ext-brw-status');
    status.setAttribute('role', 'status');

    const actionsBox = buildActions();
    const control = buildControl();
    const more = buildSettings();
    const foot = mk('p', 'ext-brw-foot', TEXT.signIn);

    root.append(bar, tabsRow, header, strip, asks, viewEl, status, actionsBox.el, control.el, more.el, foot);
    body.replaceChildren(root);

    ui = {
      api, root, back, forward, reload, url, outside, tabs, plus, driving, asks, viewEl, shot, plain, empty, emptyBtn, status, more,
      head, strip: driveStrip, actions: actionsBox, control, sigTabs: '', sigAsks: '',
    };
    wireToolbar();
    watch(viewEl);
    draw();
    loadLog();
  }

  function wireToolbar() {
    const { back, forward, reload, url, plus, emptyBtn, shot } = ui;
    const tab = () => activeTab();
    back.addEventListener('click', async () => {
      if (tab()) await act('/api/browser/back', { tab: tab().id });
    });
    forward.addEventListener('click', async () => {
      if (tab()) await act('/api/browser/forward', { tab: tab().id });
    });
    reload.addEventListener('click', async () => {
      if (tab()) await act('/api/browser/reload', { tab: tab().id });
    });
    const newTab = async () => {
      const data = await act('/api/browser/tabs', { action: 'new' });
      if (data) {
        await load();
        url.focus();
      }
    };
    plus.addEventListener('click', newTab);
    emptyBtn.addEventListener('click', newTab);
    url.addEventListener('focus', () => url.select());
    url.addEventListener('keydown', async e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = url.value.trim();
        if (!text) return;
        const current = tab();
        const data = current ? await act('/api/browser/navigate', { tab: current.id, url: text }) : await act('/api/browser/open', { url: text });
        if (data) {
          await load();
          url.blur();
        } else {
          drawStatus();
        }
      } else if (e.key === 'Escape') {
        // Escape puts the address back; it must not close the pane, so the pane's own Escape handler is told this one is handled.
        e.preventDefault();
        url.value = shownAddress();
        url.blur();
      }
    });
    shot.addEventListener('error', () => {
      shot.hidden = true;
    });
  }

  // ---------- drawing ----------

  const shownAddress = () => {
    const t = activeTab();
    return t && t.url && t.url !== 'about:blank' ? t.url : '';
  };

  function tabLabel(t) {
    return t.title || hostOf(t.url) || 'New tab';
  }

  function draw() {
    if (!ui) return;
    const t = activeTab();
    const ok = S.available === true;
    ui.back.disabled = !ok || !t || !t.canGoBack;
    ui.forward.disabled = !ok || !t || !t.canGoForward;
    ui.reload.disabled = !ok || !t;
    ui.url.disabled = !ok;
    ui.plus.disabled = !ok || S.tabs.length >= S.maxTabs;
    if (document.activeElement !== ui.url) ui.url.value = shownAddress();
    // Open outside: the current page when it is an https address (the desktop app hands it to the system browser).
    const https = t && /^https:\/\//.test(t.url);
    if (https) {
      ui.outside.href = t.url;
      ui.outside.removeAttribute('aria-disabled');
    } else {
      ui.outside.removeAttribute('href');
      ui.outside.setAttribute('aria-disabled', 'true');
    }
    ui.driving.hidden = !S.agentDriving;
    ui.root.dataset.driving = S.agentDriving ? 'on' : 'off';
    ui.plain.hidden = S.available !== false;
    ui.empty.hidden = !(ok && S.tabs.length === 0);
    drawTabs();
    drawAsks();
    drawStatus();
    drawSettings();
    drawHeader();
    drawStrip();
    drawControl();
    drawActions();
    syncSoon();
  }

  // The count on the pane's title bar button is what waits on the person (a download to save, a permission to allow), in amber.
  function updateCount() {
    const waiting = S.downloads.filter(d => !d.driving).length + S.permissions.length;
    MuseUI.pane.count(TAB, waiting > 0 ? waiting : null, 'amber');
  }

  function drawTabs() {
    const sig = JSON.stringify([S.available, S.activeTab, S.tabs.map(t => [t.id, tabLabel(t), t.loading, t.crashed === true])]);
    if (sig === ui.sigTabs) return;
    ui.sigTabs = sig;
    const parts = [];
    for (const t of S.tabs) {
      // A button cannot hold another button, so the tab is a wrapper with two buttons: the tab itself and its close button.
      const wrap = mk('div', 'ext-brw-tabwrap');
      wrap.dataset.tab = t.id;
      const select = mk('button', 'ext-brw-tab');
      select.type = 'button';
      select.setAttribute('aria-pressed', String(t.id === S.activeTab));
      select.title = t.url && t.url !== 'about:blank' ? `${tabLabel(t)}\n${t.url}` : tabLabel(t);
      if (t.loading) wrap.dataset.loading = '';
      select.append(mk('span', 'ext-brw-tab-text', clamp(tabLabel(t), 40)));
      if (t.crashed) select.dataset.crashed = '';
      select.addEventListener('click', async () => {
        if (await act('/api/browser/tabs', { action: 'select', tab: t.id })) await load();
      });
      const close = mk('button', 'ext-brw-tab-x');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close tab');
      close.title = 'Close tab';
      close.append(MuseUI.icon('x'));
      close.addEventListener('click', async () => {
        if (await act('/api/browser/tabs', { action: 'close', tab: t.id })) await load();
      });
      wrap.append(select, close);
      parts.push(wrap);
    }
    ui.tabs.replaceChildren(...parts);
  }

  // Questions from the page, one card each. A card is drawn again only when the set of questions changes, so a button never changes
  // under the pointer.
  function drawAsks() {
    const items = [...S.downloads.map(d => ({ key: `d:${d.id}:${d.driving ? 'm' : 'p'}`, kind: 'download', d })), ...S.permissions.map(p => ({ key: `p:${p.id}`, kind: 'permission', p }))];
    const sig = `${items.map(i => i.key).join('|')}#${S.settings.downloadDir ?? ''}`;
    if (sig === ui.sigAsks) return;
    ui.sigAsks = sig;
    ui.asks.replaceChildren(...items.map(i => (i.kind === 'download' ? downloadCard(i.d) : permissionCard(i.p))));
  }

  function downloadCard(d) {
    const card = mk('div', 'ext-brw-ask');
    card.dataset.kind = 'download';
    card.dataset.id = d.id;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Download');
    if (d.driving) {
      card.append(mk('p', 'ext-brw-ask-text', `The model’s browser wants to save ${d.filename}. Answer in the chat.`));
      return card;
    }
    const size = fmtSize(d.size);
    const folder = S.settings.downloadDir ? folderName(S.settings.downloadDir) : 'Downloads';
    const text = mk('p', 'ext-brw-ask-text', `Save ${d.filename}${size ? ` (${size})` : ''} to ${folder}?`);
    card.append(text);
    if (d.host) card.append(mk('p', 'ext-brw-ask-meta', `From ${d.host}.`));
    if (d.risky) card.append(mk('p', 'ext-brw-ask-warn', TEXT.risky));
    const actions = mk('div', 'ext-brw-ask-actions');
    const save = MuseUI.button('primary small', 'Save');
    const cancel = MuseUI.button('ghost small', 'Cancel');
    const answer = async allow => {
      save.disabled = true;
      cancel.disabled = true;
      const data = await act('/api/browser/download', { id: d.id, allow });
      if (!data) {
        save.disabled = false;
        cancel.disabled = false;
        await load();
        return;
      }
      await load();
    };
    save.addEventListener('click', () => answer(true));
    cancel.addEventListener('click', () => answer(false));
    actions.append(save, cancel);
    card.append(actions);
    const strip = noticeStrip(DOWNLOAD_NOTICE, TEXT.downloadNotice, text);
    if (strip) card.append(strip);
    return card;
  }

  function permissionCard(p) {
    const card = mk('div', 'ext-brw-ask');
    card.dataset.kind = 'permission';
    card.dataset.id = p.id;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Permission');
    const who = hostOf(p.origin) || p.origin || 'A site';
    const text = mk('p', 'ext-brw-ask-text', `${who} wants to ${p.label || 'use a permission'}${p.embedded ? ' from inside another page' : ''}.`);
    card.append(text);
    const actions = mk('div', 'ext-brw-ask-actions');
    const allow = MuseUI.button('primary small', 'Allow');
    const deny = MuseUI.button('ghost small', 'Deny');
    const answer = async yes => {
      allow.disabled = true;
      deny.disabled = true;
      await act('/api/browser/permission', { id: p.id, allow: yes });
      await load();
    };
    allow.addEventListener('click', () => answer(true));
    deny.addEventListener('click', () => answer(false));
    actions.append(allow, deny);
    card.append(actions);
    const strip = noticeStrip(PERMISSION_NOTICE, TEXT.permissionNotice, text);
    if (strip) card.append(strip);
    return card;
  }

  // The status line: a refusal first, then the page's own trouble, then Loading…, then the latest notice that is still fresh.
  function drawStatus() {
    if (!ui) return;
    const t = activeTab();
    let text = '';
    let bad = false;
    if (actionError && Date.now() - actionErrorAt < 8000) {
      text = actionError;
      bad = true;
    } else if (S.available === false) {
      text = '';
    } else if (t && t.crashed) {
      text = 'This page stopped working. Reload it to try again.';
      bad = true;
    } else if (t && t.error) {
      text = `This page did not load: ${t.error}`;
      bad = true;
    } else if (t && t.loading) {
      text = 'Loading…';
    } else {
      const fresh = [...S.events].reverse().find(e => Date.now() - (e.at ?? 0) < NOTICE_FRESH_MS);
      if (fresh) {
        const [message, isBad] = noticeText(fresh);
        text = message;
        bad = isBad;
      }
    }
    ui.status.textContent = text;
    ui.status.dataset.tone = bad ? 'bad' : '';
  }

  function noticeText(e) {
    switch (e.kind) {
      case 'popup-blocked':
        return [e.reason === 'tab-limit' ? `Pop-up blocked: ${clamp(e.url || '', 80)}. The tab limit is ${S.maxTabs}; close a tab first.` : `Pop-up blocked: ${clamp(e.url || '', 80)}. Only http and https addresses open.`, false];
      case 'download-blocked':
        return [`Download blocked: ${e.filename}. Use Open outside to save it, or turn off Block all downloads below.`, false];
      case 'download-saved':
        return [`Saved ${e.filename} to ${e.folder || 'Downloads'}. Plenum does not open it.`, false];
      case 'download-failed':
        return [`${e.filename || 'The file'} was not saved. ${e.reason || ''}`.trim(), true];
      default:
        return ['', false];
    }
  }

  // ---------- brw-03: the switch, the drive strip, Actions, sites and checks ----------

  const activeProjectId = () => MuseUI.state?.activeProject ?? null;
  const activeProject = () => (MuseUI.state?.projects ?? []).find(p => p.id === activeProjectId()) ?? null;
  let driveBusy = false;

  function takeDrive(s) {
    if (!s || typeof s.id !== 'string' || s.kind !== 'browser') return;
    if (s.state === 'stopped') drives.delete(s.id);
    else drives.set(s.id, s);
  }

  function replaceDrives(list) {
    drives.clear();
    for (const s of Array.isArray(list) ? list : []) takeDrive(s);
  }

  // This project's browser drive, else any other (a drive of another project still uses the one browser).
  function browserDrive() {
    const list = [...drives.values()];
    return list.find(d => d.projectId === activeProjectId()) ?? list[0] ?? null;
  }

  const lastAction = projectId => (logs.get(projectId) ?? []).at(-1) ?? null;

  function pushLog(projectId, entry) {
    if (typeof projectId !== 'string' || !entry || typeof entry !== 'object') return;
    const list = logs.get(projectId) ?? [];
    list.push(entry);
    if (list.length > 200) list.splice(0, list.length - 200);
    logs.set(projectId, list);
  }

  async function loadLog() {
    const id = activeProjectId();
    if (!id) return;
    try {
      const data = await MuseUI.api(`/api/browser/log?project=${encodeURIComponent(id)}`);
      if (data && Array.isArray(data.entries)) logs.set(id, data.entries.slice(-200));
      drawActions();
      drawStrip();
    } catch {
      // The log is read again with the next change.
    }
  }

  // Saves one or more of the pane's switches. Resolves true after the server has stored them; otherwise the reason is shown beside the
  // control (a refusal, or the line for plain node) and false comes back, so the caller puts the control back.
  async function saveSetting(body, statusEl) {
    const data = await act('/api/browser/settings', body);
    if (data && data.control) {
      S.control = data.control;
      S.agent = data.control.agent !== false;
      flash(statusEl, 'Saved');
      return true;
    }
    flash(statusEl, data && data.available === false ? 'The browser works in the desktop app only.' : actionError || 'Not saved', true);
    return false;
  }

  const hostName = u => {
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return '';
    }
  };

  function hostListed(host, list) {
    for (const raw of Array.isArray(list) ? list : []) {
      const p = String(raw).toLowerCase();
      if (p === '*' || p === host) return true;
      if (p.startsWith('*.') && host.length > p.length - 1 && host.endsWith(p.slice(1))) return true;
    }
    return false;
  }

  // The header: the switch "Let the model use this browser", what it reaches, the Plan mode line, and the Approve all line.
  function buildHeader() {
    const el = mk('div', 'ext-brw-agent');
    const row = mk('div', 'ext-brw-row');
    const label = mk('label', 'switch');
    const input = inputOf('input', '', { type: 'checkbox' });
    label.append(input, mk('span', 'switch-track'), mk('span', 'ext-brw-switch-text', TEXT.agent));
    const flashEl = mk('span', 'ext-brw-flash');
    flashEl.setAttribute('role', 'status');
    row.append(label, flashEl);
    const reach = mk('p', 'ext-brw-note', TEXT.reach);
    const plan = mk('p', 'ext-brw-note ext-brw-plan', TEXT.planMode);
    plan.hidden = true;
    const notices = mk('div', 'ext-brw-notices');

    const approve = mk('div', 'ext-brw-approve');
    approve.hidden = true;
    approve.append(mk('p', 'ext-brw-note', TEXT.approveAll));
    const anyRow = mk('div', 'ext-brw-row');
    const anyLabel = mk('label', 'switch');
    const anyInput = inputOf('input', '', { type: 'checkbox' });
    anyLabel.append(anyInput, mk('span', 'switch-track'), mk('span', 'ext-brw-switch-text', 'Ask me anyway this run'));
    const anyFlash = mk('span', 'ext-brw-flash');
    anyFlash.setAttribute('role', 'status');
    anyRow.append(anyLabel, anyFlash);
    approve.append(anyRow);

    el.append(row, reach, plan, notices, approve);

    input.addEventListener('change', async () => {
      const want = input.checked;
      input.disabled = true;
      const ok = await saveSetting({ agent: want }, flashEl);
      input.disabled = false;
      if (!ok) input.checked = S.agent;
      draw();
    });
    anyInput.addEventListener('change', async () => {
      const want = anyInput.checked;
      anyInput.disabled = true;
      const data = await act('/api/browser/ask-anyway', { on: want });
      anyInput.disabled = false;
      if (data && typeof data.askAnyway === 'boolean') {
        S.askAnyway = data.askAnyway;
        flash(anyFlash, 'Saved');
      } else {
        anyInput.checked = S.askAnyway;
        flash(anyFlash, actionError || 'Not saved', true);
      }
    });
    return { el, input, flashEl, plan, notices, approve, anyInput };
  }

  // The drive strip above the page: what the model is doing and the same controls as the drive bar, the "Type it for me" box while the
  // run waits for a secret, and nothing at all when no model drives.
  function buildStrip() {
    const el = mk('div', 'ext-brw-drive');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Model control');
    el.hidden = true;
    const dot = mk('span', 'ext-brw-drive-dot');
    dot.setAttribute('aria-hidden', 'true');
    const text = mk('span', 'ext-brw-drive-text');
    text.setAttribute('role', 'status');
    const actions = mk('span', 'ext-brw-drive-actions');
    const toggle = MuseUI.button('ghost small', 'Pause');
    const stop = MuseUI.button('ghost small ext-brw-danger', 'Stop');
    actions.append(toggle, stop);
    const top = mk('div', 'ext-brw-drive-top');
    top.append(dot, text, actions);

    const secret = mk('div', 'ext-brw-secret');
    secret.hidden = true;
    const secretRow = mk('div', 'ext-brw-row');
    const secretInput = inputOf('input', 'ext-brw-secret-input', { type: 'password', 'aria-label': 'Type it for me', placeholder: 'Type it for me', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const secretBtn = MuseUI.button('primary small', 'Type it');
    const secretFlash = mk('span', 'ext-brw-flash');
    secretFlash.setAttribute('role', 'status');
    secretRow.append(secretInput, secretBtn, secretFlash);
    secret.append(secretRow, mk('p', 'ext-brw-note', TEXT.secretNote));
    el.append(top, secret);

    const typeIt = async () => {
      const value = secretInput.value;
      if (!value) return;
      // The box is emptied before the request goes, so the secret is not left on the page whatever happens next.
      secretInput.value = '';
      secretBtn.disabled = true;
      try {
        await MuseUI.api('/api/browser/type-secret', { value, project: activeProjectId() ?? undefined });
        flash(secretFlash, 'Typed. Press Resume when you are done.');
      } catch (err) {
        flash(secretFlash, err?.message || 'Not typed. Try again.', true);
      } finally {
        secretBtn.disabled = false;
      }
    };
    secretBtn.addEventListener('click', typeIt);
    secretInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        typeIt();
      }
    });
    toggle.addEventListener('click', () => {
      const d = browserDrive();
      if (d) driveAct(d.state === 'paused' ? '/api/drive/resume' : '/api/drive/pause');
    });
    stop.addEventListener('click', () => driveAct('/api/drive/stop'));
    return { el, dot, text, toggle, stop, secret, secretInput, secretBtn };
  }

  // Pause, Resume or Stop for the browser drive, through the drive routes (lib/routes/drive.mjs). A refusal is shown on the status line.
  async function driveAct(route) {
    const d = browserDrive();
    if (!d || driveBusy) return;
    driveBusy = true;
    drawStrip();
    try {
      const data = await MuseUI.api(route, { id: d.id });
      if (data && data.drive) takeDrive(data.drive);
    } catch (err) {
      actionError = err?.message || 'The browser could not do that.';
      actionErrorAt = Date.now();
    } finally {
      driveBusy = false;
      drawStrip();
      drawStatus();
    }
  }

  function driveWords(d) {
    const last = lastAction(d.projectId);
    const mine = d.projectId === activeProjectId();
    const where = !mine ? ' · in another project' : '';
    if (d.state === 'paused') {
      if (d.pausedBy === 'model') return `Your turn${d.note ? ` · the model asks: "${d.note}"` : ''} · Resume when done${where}`;
      if (d.pausedBy === 'card') return `Waiting for your answer on the card in the chat${where}`;
      return `Paused${last ? ` · ${last.summary}` : ''}${where}`;
    }
    return `${TEXT.driving}${last ? `: ${last.summary}` : ''}${where}`;
  }

  function drawStrip() {
    if (!ui) return;
    const d = browserDrive();
    const s = ui.strip;
    s.el.hidden = !d;
    if (!d) {
      ui.driving.hidden = !S.agentDriving;
      ui.driving.textContent = TEXT.driving;
      return;
    }
    const paused = d.state === 'paused';
    s.el.dataset.state = paused ? (d.pausedBy === 'card' ? 'card' : d.pausedBy === 'model' ? 'turn' : 'paused') : 'running';
    s.text.textContent = clamp(driveWords(d), 220);
    s.toggle.textContent = paused ? 'Resume' : 'Pause';
    // A card that waits is answered first, so Resume waits; Stop always works.
    s.toggle.disabled = driveBusy || (paused && d.pausedBy === 'card');
    s.toggle.title = paused && d.pausedBy === 'card' ? 'Answer the card in the chat first. Stop ends the run.' : paused ? 'Let the model carry on' : 'Hold the model’s next step';
    s.stop.disabled = driveBusy;
    s.stop.title = 'Stop the model’s control of the browser now';
    const waiting = paused && d.pausedBy === 'model' && S.secret !== null && (!S.secret.project || S.secret.project === d.projectId);
    s.secret.hidden = !waiting;
    // The badge on the tab row says what the model last did.
    const last = lastAction(d.projectId);
    ui.driving.hidden = false;
    ui.driving.textContent = clamp(last ? `${TEXT.driving}: ${last.summary}` : TEXT.driving, 70);
  }

  let agentNoticeTried = false;

  function drawHeader() {
    if (!ui) return;
    const h = ui.head;
    // The first-time notice waits for the first state the server sends, so it knows whether it was dismissed before.
    if (!agentNoticeTried && S.available === true) {
      agentNoticeTried = true;
      showAgentNoticeOnce();
    }
    if (document.activeElement !== h.input) h.input.checked = S.agent;
    const project = activeProject();
    h.plan.hidden = !(project && project.chatMode === 'plan');
    const allOn = Boolean(project) && project.approvals === 'all' && !(project.approveAllCovers && project.approveAllCovers.browser === false);
    h.approve.hidden = !allOn;
    if (document.activeElement !== h.anyInput) h.anyInput.checked = S.askAnyway;
  }

  // "Sites and checks": the sites that open without asking, Any site, the six Checks, and the size of a snapshot.
  function buildControl() {
    const el = mk('details', 'ext-brw-box ext-brw-control');
    el.append(mk('summary', 'ext-brw-box-title', 'Sites, checks and page size'));
    const inner = mk('div', 'ext-brw-box-body');

    const anyRow = mk('div', 'ext-brw-row');
    const anyLabel = mk('label', 'switch');
    const anyInput = inputOf('input', '', { type: 'checkbox' });
    anyLabel.append(anyInput, mk('span', 'switch-track'), mk('span', 'ext-brw-switch-text', 'Any site without asking'));
    const anyFlash = mk('span', 'ext-brw-flash');
    anyFlash.setAttribute('role', 'status');
    anyRow.append(anyLabel, anyFlash);
    const notices = mk('div', 'ext-brw-notices');

    const sitesRow = mk('div', 'ext-brw-row ext-brw-folder');
    const sitesLabel = mk('label', 'ext-brw-label', 'Sites the model may open without asking');
    const sites = inputOf('textarea', 'ext-brw-sites', { rows: '4', 'aria-label': 'Sites the model may open without asking, one host to a line', placeholder: 'example.com\n*.example.org', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' });
    sitesLabel.append(sites);
    const sitesActions = mk('div', 'ext-brw-actions');
    const sitesSave = MuseUI.button('ghost small', 'Save sites');
    sitesActions.append(sitesSave);
    const sitesFlash = mk('span', 'ext-brw-flash');
    sitesFlash.setAttribute('role', 'status');
    const sitesNote = mk('p', 'ext-brw-note', 'One host to a line. *.example.com covers its subdomains; add example.com as well for the bare address. Any other site asks you first, once for each run, in every approval mode except Approve all.');
    sitesRow.append(sitesLabel, sitesActions, sitesFlash, sitesNote);

    const checksTitle = mk('p', 'ext-brw-subtitle', 'Checks');
    const checksNote = mk('p', 'ext-brw-note', 'These always ask first, in every approval mode. Turn one off and the model does that on the page by itself.');
    const checks = {};
    const checkRows = mk('div', 'ext-brw-checks');
    for (const [id, text] of CHECKS) {
      const row = mk('div', 'ext-brw-row');
      const label = mk('label', 'switch');
      const input = inputOf('input', '', { type: 'checkbox' });
      label.append(input, mk('span', 'switch-track'), mk('span', 'ext-brw-switch-text', text));
      const fl = mk('span', 'ext-brw-flash');
      fl.setAttribute('role', 'status');
      row.append(label, fl);
      checkRows.append(row);
      checks[id] = { input, fl };
      input.addEventListener('change', async () => {
        const want = input.checked;
        input.disabled = true;
        const ok = await saveSetting({ checks: { [id]: want } }, fl);
        input.disabled = false;
        if (!ok) input.checked = S.control.checks[id] !== false;
        else if (!want) showNotice(notices, CHECK_NOTICE, TEXT.checkNotice);
        draw();
      });
    }

    const sizeTitle = mk('p', 'ext-brw-subtitle', 'Page size');
    const sizeRow = mk('div', 'ext-brw-row');
    const elementsLabel = mk('label', 'ext-brw-label', 'Controls listed');
    const elements = inputOf('input', 'ext-brw-number', { type: 'number', min: '1', max: '2000', step: '1', 'aria-label': 'Controls listed in a snapshot' });
    elementsLabel.append(elements);
    const charsLabel = mk('label', 'ext-brw-label', 'Text characters');
    const chars = inputOf('input', 'ext-brw-number', { type: 'number', min: '1000', max: '60000', step: '1000', 'aria-label': 'Text characters in a snapshot' });
    charsLabel.append(chars);
    const sizeFlash = mk('span', 'ext-brw-flash');
    sizeFlash.setAttribute('role', 'status');
    sizeRow.append(elementsLabel, charsLabel, sizeFlash);
    const sizeNote = mk('p', 'ext-brw-note', 'How much of a page the model reads at once: up to 2,000 controls and 60,000 characters. A longer page is cut and the model is told.');
    const shotNote = mk('p', 'ext-brw-note', TEXT.shotNotice);

    inner.append(anyRow, notices, sitesRow, checksTitle, checksNote, checkRows, sizeTitle, sizeRow, sizeNote, shotNote);
    el.append(inner);

    anyInput.addEventListener('change', async () => {
      const want = anyInput.checked;
      anyInput.disabled = true;
      const ok = await saveSetting({ anySite: want }, anyFlash);
      anyInput.disabled = false;
      if (!ok) anyInput.checked = S.control.anySite === true;
      else if (want) showNotice(notices, ANY_SITE_NOTICE, TEXT.anySiteNotice);
      draw();
    });

    const saveSites = async () => {
      const lines = sites.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const bad = lines.find(l => !HOST_RE.test(l));
      if (bad) {
        flash(sitesFlash, `"${clamp(bad, 40)}" is not a site. Use a host such as example.com.`, true);
        return;
      }
      sitesSave.disabled = true;
      const ok = await saveSetting({ allow: lines }, sitesFlash);
      sitesSave.disabled = false;
      if (ok) sites.value = S.control.allow.filter(h => h !== '*').join('\n');
      draw();
    };
    sitesSave.addEventListener('click', saveSites);

    const saveSize = async (key, input, flashEl) => {
      const n = Number(input.value);
      const range = key === 'snapshotElements' ? [1, 2000] : [1000, 60000];
      if (!Number.isInteger(n) || n < range[0] || n > range[1]) {
        flash(flashEl, `Use a whole number from ${range[0].toLocaleString('en-US')} to ${range[1].toLocaleString('en-US')}.`, true);
        input.value = String(S.control[key]);
        return;
      }
      const ok = await saveSetting({ [key]: n }, flashEl);
      if (!ok) input.value = String(S.control[key]);
      draw();
    };
    elements.addEventListener('change', () => saveSize('snapshotElements', elements, sizeFlash));
    chars.addEventListener('change', () => saveSize('snapshotChars', chars, sizeFlash));

    return { el, anyInput, notices, sites, checks, elements, chars };
  }

  function drawControl() {
    if (!ui) return;
    const c = ui.control;
    const control = S.control;
    if (document.activeElement !== c.anyInput) c.anyInput.checked = control.anySite === true;
    if (document.activeElement !== c.sites) c.sites.value = (control.allow ?? []).filter(h => h !== '*').join('\n');
    for (const [id, part] of Object.entries(c.checks)) if (document.activeElement !== part.input) part.input.checked = control.checks?.[id] !== false;
    if (document.activeElement !== c.elements) c.elements.value = String(control.snapshotElements);
    if (document.activeElement !== c.chars) c.chars.value = String(control.snapshotChars);
  }

  // "Actions": what the model did in this project, newest first. Typed text and anything secret are never in it (the server writes only a
  // control's name). A site the model opened that is not on the list has an "Always allow" button.
  function buildActions() {
    const el = mk('details', 'ext-brw-box ext-brw-actions-box');
    el.append(mk('summary', 'ext-brw-box-title', 'Actions'));
    const inner = mk('div', 'ext-brw-box-body');
    const list = mk('ol', 'ext-brw-log');
    list.setAttribute('aria-label', 'What the model did in the browser');
    const empty = mk('p', 'ext-brw-note', TEXT.noActions);
    const flashEl = mk('span', 'ext-brw-flash');
    flashEl.setAttribute('role', 'status');
    inner.append(list, empty, flashEl);
    el.append(inner);
    return { el, list, empty, flashEl, sig: '' };
  }

  function drawActions() {
    if (!ui) return;
    const a = ui.actions;
    const entries = (logs.get(activeProjectId()) ?? []).slice(-LOG_SHOWN).reverse();
    const sig = JSON.stringify([entries.map(e => [e.at, e.summary, e.ok]), S.control.allow]);
    if (sig === a.sig) return;
    a.sig = sig;
    a.empty.hidden = entries.length > 0;
    const items = entries.map(e => {
      const li = mk('li', 'ext-brw-log-item');
      if (e.ok === false) li.dataset.tone = 'bad';
      const when = new Date(e.at);
      li.append(mk('time', 'ext-brw-log-time', Number.isFinite(when.getTime()) ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''));
      li.append(mk('span', 'ext-brw-log-text', clamp(e.summary || e.tool || '', 120)));
      const host = hostName(e.url);
      if (host && e.tool !== 'browser_navigate') li.append(mk('span', 'ext-brw-log-host', host));
      if (e.note) li.append(mk('span', 'ext-brw-log-note', e.note));
      if (e.tool === 'browser_navigate' && host && e.ok !== false && !hostListed(host, S.control.allow)) {
        const always = MuseUI.button('ghost small', `Always allow ${clamp(host, 30)}`);
        always.addEventListener('click', async () => {
          always.disabled = true;
          const data = await act('/api/browser/allow', { host });
          if (data && data.control) {
            S.control = data.control;
            flash(a.flashEl, `${host} added to the list`);
          } else {
            flash(a.flashEl, actionError || 'Not saved', true);
            always.disabled = false;
          }
          draw();
        });
        li.append(always);
      } else if (host && e.tool === 'browser_navigate') {
        li.append(mk('span', 'ext-brw-log-host', host));
      }
      return li;
    });
    a.list.replaceChildren(...items);
  }

  // The first time the pane opens with the switch on: what a model can do here, with a way to turn it off.
  function showAgentNoticeOnce() {
    if (!ui || !S.agent || S.available !== true || (S.control.hiddenNotices && S.control.hiddenNotices.includes(AGENT_NOTICE))) return;
    showNotice(ui.head.notices, AGENT_NOTICE, TEXT.agentNotice, {
      label: 'Turn it off',
      run: async () => {
        const ok = await saveSetting({ agent: false }, ui.head.flashEl);
        if (!ok) ui.head.input.checked = S.agent;
        draw();
      },
    });
    // Seen once is enough: it does not come back, whichever button is pressed.
    hideNotice(AGENT_NOTICE);
  }

  // ---------- the settings under the page ----------

  function buildSettings() {
    const el = mk('details', 'ext-brw-more');
    const summary = mk('summary', 'ext-brw-more-title', 'Downloads and site permissions');
    const inner = mk('div', 'ext-brw-more-body');

    // Block all downloads.
    const blockRow = mk('div', 'ext-brw-row');
    const blockLabel = mk('label', 'switch');
    const block = inputOf('input', '', { type: 'checkbox' });
    blockLabel.append(block, mk('span', 'switch-track'), mk('span', 'ext-brw-switch-text', 'Block all downloads'));
    const blockStatus = mk('span', 'ext-brw-flash');
    blockStatus.setAttribute('role', 'status');
    blockRow.append(blockLabel, blockStatus);
    block.addEventListener('change', async () => {
      const want = block.checked;
      block.disabled = true;
      const data = await act('/api/browser/downloads', { block: want });
      block.disabled = false;
      if (data && data.settings) {
        S.settings = data.settings;
        flash(blockStatus, 'Saved');
      } else {
        block.checked = S.settings.blockDownloads;
        flash(blockStatus, actionError || 'Not saved', true);
      }
      draw();
    });

    // Where saved files go.
    const folderRow = mk('div', 'ext-brw-row ext-brw-folder');
    const folderLabel = mk('label', 'ext-brw-label', 'Save downloads to');
    const folder = inputOf('input', 'ext-brw-path', { type: 'text', 'aria-label': 'Download folder', placeholder: 'The system Downloads folder', spellcheck: 'false', autocomplete: 'off' });
    folderLabel.append(folder);
    const folderActions = mk('div', 'ext-brw-actions');
    const choose = MuseUI.button('ghost small', 'Choose…');
    const saveFolder = MuseUI.button('ghost small', 'Use this folder');
    const reset = MuseUI.button('ghost small', 'Use Downloads');
    folderActions.append(choose, saveFolder, reset);
    const folderStatus = mk('span', 'ext-brw-flash');
    folderStatus.setAttribute('role', 'status');
    const folderNote = mk('p', 'ext-brw-note', 'Files are saved in the Downloads folder unless you choose another. A credential, system or Plenum folder is refused. Plenum never opens or runs a saved file.');
    folderRow.append(folderLabel, folderActions, folderStatus, folderNote);
    const saveTo = async path => {
      const data = await act('/api/browser/downloads', { folder: path });
      if (data && data.settings) {
        S.settings = data.settings;
        folder.value = data.settings.downloadDir ?? '';
        flash(folderStatus, 'Saved');
      } else {
        flash(folderStatus, actionError || 'Not saved', true);
      }
      draw();
    };
    saveFolder.addEventListener('click', () => {
      const text = folder.value.trim();
      saveTo(text || null);
    });
    folder.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveTo(folder.value.trim() || null);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        folder.value = S.settings.downloadDir ?? '';
        folder.blur();
      }
    });
    reset.addEventListener('click', () => saveTo(null));
    choose.addEventListener('click', async () => {
      try {
        const data = await MuseUI.api('/api/pick-folder', {});
        if (data && data.path) {
          folder.value = data.path;
          await saveTo(data.path);
        }
      } catch (err) {
        flash(folderStatus, err?.message || 'The folder picker could not open.', true);
      }
    });

    // Site permissions and browsing data.
    const permRow = mk('div', 'ext-brw-row');
    const forget = MuseUI.button('ghost small', 'Forget site permissions');
    const remembered = mk('span', 'ext-brw-note-inline');
    const permStatus = mk('span', 'ext-brw-flash');
    permStatus.setAttribute('role', 'status');
    permRow.append(forget, remembered, permStatus);
    forget.addEventListener('click', async () => {
      const data = await act('/api/browser/permission-reset', {});
      if (data) {
        flash(permStatus, 'Forgotten');
        await load();
      } else {
        flash(permStatus, actionError || 'Not done', true);
      }
    });

    const clearRow = mk('div', 'ext-brw-row');
    const clear = MuseUI.button('ghost small ext-brw-danger', 'Clear browsing data…');
    const clearNote = mk('p', 'ext-brw-note', 'Signs you out of every site in this browser and removes its cookies, stored data and cache. Tabs stay open.');
    const clearStatus = mk('span', 'ext-brw-flash');
    clearStatus.setAttribute('role', 'status');
    let armed = null;
    clear.addEventListener('click', async () => {
      if (!armed) {
        clear.textContent = 'Click again to clear';
        armed = setTimeout(() => {
          armed = null;
          clear.textContent = 'Clear browsing data…';
        }, CLEAR_ARM_MS);
        return;
      }
      clearTimeout(armed);
      armed = null;
      clear.textContent = 'Clear browsing data…';
      const data = await act('/api/browser/clear', {});
      flash(clearStatus, data ? 'Cleared' : actionError || 'Not cleared', !data);
    });
    clearRow.append(clear, clearStatus, clearNote);

    inner.append(blockRow, folderRow, permRow, clearRow);
    el.append(summary, inner);
    return { el, block, folder, remembered, forget };
  }

  // "Saved" or a refusal beside the control that changed, for a moment.
  const flashTimers = new WeakMap();
  function flash(node, text, bad = false) {
    node.textContent = text;
    node.dataset.tone = bad ? 'bad' : 'ok';
    clearTimeout(flashTimers.get(node));
    flashTimers.set(node, setTimeout(() => {
      node.textContent = '';
      node.dataset.tone = '';
    }, FLASH_MS));
  }

  function drawSettings() {
    const { more } = ui;
    more.block.checked = S.settings.blockDownloads === true;
    if (document.activeElement !== more.folder) more.folder.value = S.settings.downloadDir ?? '';
    more.remembered.textContent = S.remembered > 0 ? `${S.remembered} remembered for this session` : 'None remembered';
    more.forget.disabled = S.remembered === 0;
  }

  // ---------- where the page view goes ----------

  let sending = false;
  let again = false;
  let lastKey = 'h';
  let lastSentAt = 0;
  let syncTimer = null;
  let shotUrl = '';

  // The part of the placeholder that is on screen: its box cut to the pane's body (which scrolls) and to the window. null when none.
  function visibleBox(viewEl) {
    const r = viewEl.getBoundingClientRect();
    const body = (MuseUI.el.paneBody ?? document.getElementById('paneBody'))?.getBoundingClientRect();
    const left = Math.max(r.left, body ? body.left : 0, 0);
    const top = Math.max(r.top, body ? body.top : 0, 0);
    const right = Math.min(r.right, body ? body.right : Infinity, window.innerWidth);
    const bottom = Math.min(r.bottom, body ? body.bottom : Infinity, window.innerHeight);
    if (right - left < 2 || bottom - top < 2) return null;
    return { left, top, width: right - left, height: bottom - top };
  }

  // True when anything but the placeholder is on top at one of a grid of points across it: a drawer, a dialog, a menu, Settings, a
  // command list. The native view is drawn above the page, so it must give way to each of them.
  function covered(viewEl, box) {
    // The grid stays clear of the placeholder's rounded corners (4 px): a point at a corner's very edge belongs to the box behind it, and
    // whether it does depends on the sub-pixel position the layout above happens to give the placeholder.
    const inset = Math.max(1, Math.min(6, box.width / 4, box.height / 4));
    for (let i = 0; i < COVER_POINTS; i += 1) {
      for (let j = 0; j < COVER_POINTS; j += 1) {
        const x = box.left + inset + (box.width - 2 * inset) * (i / (COVER_POINTS - 1));
        const y = box.top + inset + (box.height - 2 * inset) * (j / (COVER_POINTS - 1));
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === viewEl || viewEl.contains(hit))) return true;
      }
    }
    return false;
  }

  function wanted() {
    if (!ui || ui.api.isActive?.() !== true || S.available !== true || S.tabs.length === 0) return { mode: 'hidden' };
    if (MuseUI.el.pane.hidden || document.visibilityState !== 'visible') return { mode: 'hidden' };
    const box = visibleBox(ui.viewEl);
    if (!box) return { mode: 'hidden' };
    if (covered(ui.viewEl, box)) return { mode: 'covered' };
    return { mode: 'shown', box };
  }

  function showShot(dataUrl) {
    if (!ui) return;
    shotUrl = dataUrl;
    ui.shot.src = dataUrl;
    ui.shot.hidden = false;
    ui.viewEl.dataset.covered = '';
  }

  function hideShot() {
    if (!ui) return;
    ui.shot.hidden = true;
    delete ui.viewEl.dataset.covered;
    ui.shot.removeAttribute('src');
    shotUrl = '';
  }

  async function sync() {
    const want = wanted();
    const key = want.mode === 'shown' ? `s:${Math.round(want.box.left)},${Math.round(want.box.top)},${Math.round(want.box.width)},${Math.round(want.box.height)}` : want.mode === 'covered' ? 'c' : 'h';
    if (key === lastKey && !(want.mode === 'shown' && Date.now() - lastSentAt > HEARTBEAT_MS)) return;
    if (sending) {
      again = true;
      return;
    }
    sending = true;
    const previous = lastKey;
    lastKey = key;
    try {
      if (want.mode === 'shown') {
        const b = want.box;
        await MuseUI.api('/api/browser/bounds', { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height), visible: true });
        lastSentAt = Date.now();
        hideShot();
      } else if (want.mode === 'covered') {
        const data = await MuseUI.api('/api/browser/bounds', { visible: false, snapshot: true });
        if (data && typeof data.image === 'string' && data.image.startsWith('data:image/jpeg;base64,')) showShot(data.image);
      } else if (previous !== 'h') {
        await MuseUI.api('/api/browser/bounds', { visible: false });
      }
    } catch {
      // The desktop did not answer. The next check sends it again.
      lastKey = '';
    } finally {
      sending = false;
      if (again) {
        again = false;
        sync();
      }
    }
  }

  function syncSoon(ms = 0) {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      sync();
    }, ms);
  }

  let observers = [];
  let ticker = null;

  // Starts watching what moves or covers the placeholder. The interval catches what no event reports (a pane that slides, a width that
  // changes with the sidebar); the observers make the common cases immediate.
  function watch(viewEl) {
    unwatch();
    const ro = new ResizeObserver(() => syncSoon());
    ro.observe(viewEl);
    ro.observe(MuseUI.el.pane);
    // Anything opening, closing or moving anywhere in the page may cover the placeholder. Checks are spaced, because the chat changes
    // on every streamed word.
    const mo = new MutationObserver(() => syncSoon(60));
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'open', 'aria-hidden', 'aria-expanded', 'data-open'] });
    observers = [ro, mo];
    ticker = setInterval(() => {
      if (ui && ui.api.isActive?.() === true) syncSoon();
    }, SYNC_MS);
  }

  function unwatch() {
    for (const o of observers) o.disconnect();
    observers = [];
    clearInterval(ticker);
    ticker = null;
  }

  window.addEventListener('resize', () => syncSoon());
  window.addEventListener('scroll', () => syncSoon(), true);
  window.addEventListener('plenum:pane', () => syncSoon());
  document.addEventListener('visibilitychange', () => syncSoon());

  // The page is no longer showing the pane: the native view comes off the window.
  async function hideNative() {
    lastKey = 'h';
    syncTimer = null;
    try {
      await MuseUI.api('/api/browser/hide', {});
    } catch {
      // Nothing to hide, or the desktop is not there.
    }
  }

  // ---------- polling and events ----------

  function startPolling() {
    if (polling) return;
    polling = setInterval(() => {
      // The events channel carries every change, so the read is a fallback: it runs only when nothing arrived for a while.
      if (Date.now() - lastEventAt > POLL_MS) load();
      else drawStatus();
    }, POLL_MS);
  }

  function stopPolling() {
    clearInterval(polling);
    polling = null;
  }

  MuseUI.events.on('browser', ev => {
    if (ev.kind === 'state' && ev.state) apply(ev.state);
    else if (ev.kind === 'key' && ev.key) handleKey(ev.key);
    else if (ev.kind === 'log' && ev.entry) {
      pushLog(ev.project, ev.entry);
      // A screenshot goes to the model's provider: say so where it starts.
      if (ui && ev.entry.tool === 'browser_screenshot') showNotice(ui.head.notices, SHOT_NOTICE, TEXT.shotNotice);
      drawActions();
      drawStrip();
    }
  });
  // The model's browser drives are the ones the drive bar shows: every change of a drive, and the page state that carries them.
  MuseUI.events.on('drive', ev => {
    takeDrive(ev?.drive);
    draw();
  });
  const drivesFromState = ev => {
    if (ev?.state && Array.isArray(ev.state.drives)) {
      replaceDrives(ev.state.drives);
      draw();
    }
  };
  MuseUI.events.on('hello', drivesFromState);
  MuseUI.events.on('state', drivesFromState);
  window.addEventListener('plenum:connection', e => {
    if (e.detail?.connected) load();
  });

  // A shortcut pressed while the page had the focus (the desktop app passes F6 and Ctrl+L on, because the page swallows keys).
  function handleKey(k) {
    if (k.key === 'F6') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', code: 'F6', bubbles: true, cancelable: true, ctrlKey: k.ctrl, shiftKey: k.shift, altKey: k.alt, metaKey: k.meta }));
    } else if (String(k.key).toLowerCase() === 'l' && (k.ctrl || k.meta)) {
      focusAddress();
    }
  }

  function paneIsOurs() {
    return Boolean(ui) && !MuseUI.el.pane.hidden && MuseUI.pane.active() === TAB;
  }

  function focusAddress() {
    if (!paneIsOurs()) MuseUI.pane.open(TAB);
    ui?.url.focus();
  }

  // Ctrl+L goes to the address while this tab is on screen. Ctrl+T opens a browser tab (not a new thread) while the focus is in the pane.
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.isComposing || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
    const key = String(e.key).toLowerCase();
    if (!paneIsOurs()) return;
    if (key === 'l') {
      e.preventDefault();
      ui.url.focus();
    } else if (key === 't' && MuseUI.el.pane.contains(document.activeElement)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ui.plus.click();
    }
  }, true);

  // ---------- registration ----------

  const slots = { header: mk('div', 'ext-brw-slot-header'), strip: mk('div', 'ext-brw-slot-strip') };

  MuseUI.pane.register({
    id: TAB,
    title: 'Browser',
    icon: 'globe',
    order: 20,
    titleButton: true,
    render: (body, api) => build(body, api),
    onShow: () => {
      load();
      startPolling();
      syncSoon();
    },
    onHide: () => {
      stopPolling();
      hideNative();
    },
    onClose: () => {
      stopPolling();
      unwatch();
      ui = null;
      hideNative();
    },
  });

  // The + menu's "Open the browser" (UI-ARCH section 2). The shell reads the slot's items: label, icon and run.
  MuseUI.slots.add('plusMenu', 'browser', { label: 'Open the browser', icon: 'globe', run: () => MuseUI.pane.open(TAB) }, 40);

  window.MuseBrowser = Object.freeze({
    // Opens the Browser tab, and an address in it when one is given. Resolves the server's answer, or null.
    async open(address) {
      MuseUI.pane.open(TAB);
      if (typeof address !== 'string' || !address.trim()) return null;
      const data = await act('/api/browser/open', { url: address });
      await load();
      return data;
    },
    state: () => JSON.parse(JSON.stringify(S)),
    onState(fn) {
      if (typeof fn !== 'function') throw new TypeError('onState needs a function.');
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Elements for brw-03: the switch row goes in headerSlot, the drive strip in stripSlot.
    headerSlot: slots.header,
    stripSlot: slots.strip,
    refresh: load,
  });

  // The count on the pane's title bar button (a question waits) is right from the start, so the first read does not wait for the pane.
  load();
  (MuseUI.ready ?? Promise.resolve()).then(() => {
    replaceDrives(MuseUI.state?.drives);
    draw();
  });
})();
