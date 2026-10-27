// ext-legal. The agreement card that comes before anything else in Plenum, and the Legal page in Settings.
//
// (1) The agreement card. The server sets html data-legal='pending' while the terms are not accepted or have changed since
//     they were accepted. A card then covers the window and asks for an explicit tick and "I agree". MuseUI.legalReady resolves
//     once the terms are accepted, and ext-setup waits for it before it looks for a first run. Until then the server refuses
//     every provider route with terms: true, and this card is the only way forward or out.
// (2) The Legal page. A section of Settings (MuseUI.settings, id 'legal', last in the list). Its tabs show the accepted
//     agreement, the privacy and third-party notices, the open-source licences and the safety notices. MuseUI.openLegal(tab,
//     noticeId) opens it: /legal calls it with no arguments, and the More link of a notice calls it with 'notices' and the id when
//     MuseUI.openSettings is missing. The same notices are also a section of Settings > Safety, where that link lands first.
//
// Text is set with textContent. The documents go through md(), which escapes every character it reads, the same as the chat.
// There is no inline script and no style attribute: the look comes from ext-legal.css and the hidden attribute.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PENDING = 'pending';
  const TERMS_EVENT = 'plenum:terms-required';
  const SECTION_ID = 'legal';
  // Last in the Settings list: UI-ARCH section 5 puts Legal after Updates.
  const SECTION_ORDER = 100;
  // The safety notices as a section of Settings > Safety (the 'safety' group of app.js), after the approval settings.
  const SAFETY_SECTION_ID = 'safety-notices';
  const SAFETY_SECTION_ORDER = 90;
  // How long the card takes to fade after I agree (LEGAL: 150 ms).
  const FADE_MS = 160;
  const CONFLICT = 'The terms changed while this screen was open. Read the new version.';

  // The Legal page's tabs, in order. Their ids are the keys openLegal accepts.
  const TABS = [
    { id: 'agreement', label: 'Agreement' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'third-party', label: 'Third parties' },
    { id: 'open-source', label: 'Open source' },
    { id: 'notices', label: 'Safety notices' },
  ];
  // The agreement card's tabs. Each id is the document's name on GET /api/legal/doc.
  const GATE_TABS = [
    { id: 'eula', label: 'License Agreement' },
    { id: 'privacy', label: 'Privacy Notice' },
    { id: 'third-party', label: 'Third-party services' },
  ];
  // The five points under "The short version" (LEGAL ui_design, with UI-ARCH's wording: "the model", not "the AI").
  const SHORT_VERSION = [
    'Plenum is free and comes as is, with no warranty.',
    'Plenum has no model of its own. The models belong to other companies; you use them with your own accounts and keys, under their terms, and you pay their charges.',
    'A model can make mistakes. Check what it writes before you rely on it.',
    'You decide what agents may do on your computer, and you are responsible for what you allow, including Auto-approve, Approve all, browser control and computer use.',
    'Plenum sends nothing to its developer: no telemetry, no account, no Plenum servers. Your messages go only to the providers you choose.',
  ];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------- talking to the server ----------

  // A refusal carries the server's message and its status, so a caller can tell a changed document (409) from the rest.
  async function readJson(res) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // MuseUI.request adds the Plenum token, which exists only after MuseUI.ready, so every call waits for that first.
  async function getJson(path) {
    await MuseUI.ready;
    return readJson(await MuseUI.request(path));
  }

  async function postJson(path, body) {
    await MuseUI.ready;
    return readJson(await MuseUI.request(path, { method: 'POST', body: body ?? {} }));
  }

  // The documents, read once per view. name is eula, privacy, third-party or open-source. A failed read is not kept.
  const docCache = new Map();
  function doc(name) {
    if (!docCache.has(name)) {
      const read = getJson(`/api/legal/doc?name=${encodeURIComponent(name)}`);
      docCache.set(name, read);
      read.catch(() => docCache.delete(name));
    }
    return docCache.get(name);
  }

  // ---------- the terms ----------

  const termsVersion = data => Number(data?.terms?.version) || 0;
  const acceptedVersion = data => Number(data?.accepted?.version) || 0;
  // Round w119-legal: the server's own answer (required, which lib/legal.mjs termsAccepted gives: the version AND both hashes). A reply
  // without that field is read by version alone. Without this a changed text with the same version unlocked the page and then refused.
  const needsAccept = data => (typeof data?.required === 'boolean' ? data.required : acceptedVersion(data) < termsVersion(data));

  const linesOf = value => {
    if (Array.isArray(value)) return value.map(line => String(line));
    return typeof value === 'string' ? [value] : [];
  };

  // The changes newer than the accepted version, oldest first, as { version, lines }. The server may send them as a list of
  // { version, lines } or as a map from version to lines, so both shapes are read.
  function changesFor(data) {
    const raw = data?.changes;
    const items = [];
    if (Array.isArray(raw)) {
      for (const c of raw) {
        if (c && typeof c === 'object') items.push({ version: Number(c.version), lines: linesOf(c.lines ?? c.changes ?? c.text) });
      }
    } else if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) items.push({ version: Number(key), lines: linesOf(value) });
    }
    return items
      .filter(c => Number.isFinite(c.version) && c.version > acceptedVersion(data) && c.lines.length > 0)
      .sort((a, b) => a.version - b.version);
  }

  // Dates as the UI writes them: 14 Oct 2026.
  function dateText(value) {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) return 'an unknown date';
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  // ---------- small DOM helpers ----------

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const para = (text, cls) => make('p', cls, text);

  function button(cls, text, onClick) {
    const b = make('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // The brand mark from the sprite in index.html.
  function markSvg() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'legal-mark');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#mark');
    svg.append(use);
    return svg;
  }

  // A document as HTML. md() escapes what it reads and makes its links open in the system browser (https only).
  function docNode(text) {
    const div = make('div', 'legal-doc');
    const source = String(text ?? '');
    if (typeof md === 'function') {
      div.innerHTML = md(source);
    } else {
      div.append(make('pre', 'legal-pre', source));
    }
    return div;
  }

  // The text a caller can read when it fails: what failed, the server's message, and Try again.
  function errorBlock(err, retry) {
    const box = make('div', 'legal-error');
    box.setAttribute('role', 'alert');
    box.append(para(`Plenum could not load this: ${err?.message ?? err}. Check that Plenum is running, then try again.`));
    box.append(button('ghost small', 'Try again', retry));
    return box;
  }

  function changeBox(change) {
    const box = make('section', 'legal-changed');
    box.append(make('h3', 'legal-h', `What changed in version ${change.version}`));
    const list = make('ul', 'legal-list');
    for (const line of change.lines) list.append(make('li', '', line));
    box.append(list);
    return box;
  }

  // A tab row and the panel under it. fill(id) returns the panel's nodes, or a promise of them. Choosing a tab moves the
  // selection and fills the panel again. The arrow keys, Home and End move between the tabs.
  function mountTabs(container, items, start, prefix, fill, onChoose) {
    const row = make('div', 'legal-tabs');
    row.setAttribute('role', 'tablist');
    const panel = make('div', 'legal-read');
    panel.setAttribute('role', 'tabpanel');
    panel.id = `${prefix}-panel`;
    panel.tabIndex = 0;
    let current = start;
    let seq = 0;

    const tabEls = items.map((item, index) => {
      const b = make('button', 'legal-tab', item.label);
      b.type = 'button';
      b.id = `${prefix}-tab-${item.id}`;
      b.dataset.tab = item.id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', panel.id);
      b.addEventListener('click', () => choose(item.id, false));
      b.addEventListener('keydown', e => {
        let next = null;
        if (e.key === 'ArrowRight') next = (index + 1) % items.length;
        else if (e.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        if (next === null) return;
        e.preventDefault();
        choose(items[next].id, true);
      });
      row.append(b);
      return b;
    });

    function paint() {
      for (const b of tabEls) {
        const on = b.dataset.tab === current;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      const selected = tabEls.find(b => b.dataset.tab === current) ?? tabEls[0];
      panel.setAttribute('aria-labelledby', selected.id);
      const mine = ++seq;
      panel.replaceChildren(para('Loading.', 'legal-loading'));
      Promise.resolve()
        .then(() => fill(current))
        .then(
          nodes => { if (mine === seq) panel.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes])); },
          err => { if (mine === seq) panel.replaceChildren(errorBlock(err, paint)); },
        );
    }

    function choose(id, focus) {
      current = id;
      onChoose?.(id);
      paint();
      if (focus) tabEls.find(b => b.dataset.tab === id)?.focus();
    }

    container.append(row, panel);
    paint();
    return { choose };
  }

  // ---------- the agreement card ----------

  let gate = null;        // the overlay while it is on screen
  let gateLoading = false; // a read of GET /api/legal for the card is in flight
  let saving = false;     // an accept or a decline is in flight
  let readyDone = null;   // resolves MuseUI.legalReady

  const isPending = () => document.documentElement.getAttribute('data-legal') === PENDING;
  const startsPending = isPending();

  // Resolved already unless the page loads pending. ext-setup waits for it before it looks for a first run.
  MuseUI.legalReady = startsPending ? new Promise(resolve => { readyDone = resolve; }) : Promise.resolve();

  // Takes the card away and lets the page run. fade keeps the card for FADE_MS so it can fade out.
  function unlock(fade) {
    const done = gate;
    gate = null;
    const wasPending = isPending();
    document.documentElement.removeAttribute('data-legal');
    if (readyDone) {
      readyDone();
      readyDone = null;
    }
    if (done) {
      if (fade) {
        done.classList.add('out');
        setTimeout(() => done.remove(), FADE_MS);
      } else {
        done.remove();
      }
    }
    if (wasPending) {
      try {
        Promise.resolve(MuseUI.refresh?.()).catch(() => {});
      } catch {
        // The page redraws on its next change; nothing else depends on this.
      }
    }
  }

  // Shows the card. data is GET /api/legal, or null when that read failed (then error is shown). message is a line for the
  // status row, such as the changed-terms refusal.
  function showGate(data, error, message) {
    document.documentElement.setAttribute('data-legal', PENDING);
    if (!gate) {
      gate = make('div', 'legal-gate');
      gate.id = 'legalGate';
      document.body.append(gate);
    }
    const card = make('section', 'legal-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'legalGateTitle');
    if (error) {
      const title = make('h2', 'legal-title', 'Plenum could not load its terms');
      title.id = 'legalGateTitle';
      title.tabIndex = -1;
      card.append(title, errorBlockFor(error));
    } else {
      buildAgreement(card, data, message);
    }
    gate.replaceChildren(card);
    card.querySelector('#legalGateTitle')?.focus();
  }

  function errorBlockFor(err) {
    const box = make('div', 'legal-error');
    box.setAttribute('role', 'alert');
    box.append(para(`${err?.message ?? err}. Check that Plenum is running, then press Try again.`));
    box.append(button('primary small', 'Try again', () => openGate()));
    return box;
  }

  function buildAgreement(card, data, message) {
    const terms = data.terms ?? {};
    const first = !data.accepted;

    const title = make('h2', 'legal-title', first ? 'Welcome to Plenum' : "Plenum's terms have changed");
    title.id = 'legalGateTitle';
    title.tabIndex = -1;
    const head = make('div', 'legal-head');
    head.append(markSvg(), title);
    card.append(
      head,
      para('Plenum runs AI tools and models from other companies on your computer. Please read the License Agreement and the Privacy Notice, then agree to continue.', 'legal-lead'),
    );
    if (!first) for (const change of changesFor(data)) card.append(changeBox(change));

    card.append(make('h3', 'legal-h', 'The short version'));
    const short = make('ul', 'legal-list');
    for (const line of SHORT_VERSION) short.append(make('li', '', line));
    card.append(short);

    mountTabs(card, GATE_TABS, 'eula', 'legal-gate', id => doc(id).then(d => [docNode(d.text)]));

    const agree = make('input');
    agree.type = 'checkbox';
    agree.id = 'legalAgree';
    const agreeLabel = make('label', 'legal-check');
    agreeLabel.htmlFor = 'legalAgree';
    agreeLabel.append(agree, make('span', '', 'I have read and agree to the Plenum License Agreement, and I have read the Privacy Notice.'));

    const status = make('p', message ? 'legal-status bad' : 'legal-status', message || '');
    status.setAttribute('role', 'status');

    const accept = button('primary', 'I agree');
    accept.disabled = true;
    const decline = button('ghost', 'Decline and quit');
    const actions = make('div', 'legal-actions');
    actions.append(accept, decline);

    card.append(
      agreeLabel,
      status,
      actions,
      para(`Version ${terms.version ?? ''}, effective ${terms.effective ?? ''}. You can read these any time under Legal in Settings.`, 'legal-foot'),
    );

    const ui = { card, data, agree, accept, decline, status };
    agree.addEventListener('change', () => { accept.disabled = !agree.checked; });
    accept.addEventListener('click', () => saveAgreement(ui));
    decline.addEventListener('click', () => declineTerms(ui));
  }

  function setBusy(ui, on) {
    ui.accept.textContent = on ? 'Saving…' : 'I agree';
    ui.accept.disabled = on || !ui.agree.checked;
    ui.agree.disabled = on;
    ui.decline.disabled = on;
  }

  // POST /api/legal/accept with the version and the two document hashes the card showed. A 409 means the terms changed while
  // the card was open, so the card reads them again.
  async function saveAgreement(ui) {
    if (!ui.agree.checked || saving) return;
    saving = true;
    setBusy(ui, true);
    const hashes = ui.data.hashes ?? {};
    try {
      await postJson('/api/legal/accept', { version: termsVersion(ui.data), eula: hashes.eula, privacy: hashes.privacy });
    } catch (err) {
      saving = false;
      if (err.status === 409) {
        await reloadGate(CONFLICT);
        return;
      }
      setBusy(ui, false);
      ui.status.textContent = `Plenum could not save your choice: ${err.message}. Press I agree to try again.`;
      ui.status.classList.add('bad');
      return;
    }
    saving = false;
    unlock(true);
    MuseUI.toast('Thanks. The terms are under Legal in Settings.');
  }

  // Reads the terms again and draws the card with the new text. If they are now accepted, the page opens.
  async function reloadGate(message) {
    docCache.clear();
    try {
      const data = await getJson('/api/legal');
      if (!needsAccept(data)) {
        unlock(false);
        return;
      }
      showGate(data, null, message);
    } catch (err) {
      showGate(null, err);
    }
  }

  // Quit asks first, through the shared confirm dialog. A confirmed quit asks the server to stop; the desktop app then closes.
  async function declineTerms(ui) {
    if (saving) return;
    const yes = await MuseUI.confirm({
      title: 'Quit Plenum?',
      body: 'You can open it again and accept later.',
      action: 'Quit Plenum',
      focusCancel: true,
    });
    if (!yes) return;
    saving = true;
    setBusy(ui, true);
    try {
      await postJson('/api/legal/decline', {});
      ui.card.replaceChildren(para('Plenum has stopped. You can close this window.', 'legal-lead'));
    } catch (err) {
      saving = false;
      setBusy(ui, false);
      ui.status.textContent = `Plenum could not quit: ${err.message}.`;
      ui.status.classList.add('bad');
    }
  }

  // Reads GET /api/legal and shows the card when the terms need accepting. It runs at start for a pending page, and again when a
  // request is refused with terms: true. Without a pending page, a read that says the terms are accepted changes nothing.
  async function openGate() {
    if (gateLoading) return;
    gateLoading = true;
    docCache.clear();
    try {
      let data;
      try {
        data = await getJson('/api/legal');
      } catch (err) {
        // A pending page keeps the card up and says what failed. Any other page keeps working and asks again later.
        if (isPending()) showGate(null, err);
        return;
      }
      if (!needsAccept(data)) {
        if (isPending()) unlock(false);
        return;
      }
      showGate(data, null, '');
    } finally {
      gateLoading = false;
    }
  }

  // While the card is up it owns the keyboard: Escape does nothing and Tab stays inside the card. A confirm dialog opened from
  // the card keeps its own keys.
  function onKey(e) {
    if (!gate || MuseUI.dialogOpen?.()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key !== 'Tab') return;
    const card = gate.querySelector('.legal-card');
    if (!card) return;
    // Links are in the list too (a link inside the agreement is a stop), so focus on one is inside the card and Tab moves on from it.
    const items = [...card.querySelectorAll('button, input, a[href], [tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const at = items.indexOf(document.activeElement);
    if (e.shiftKey) {
      if (at <= 0) {
        e.preventDefault();
        items[items.length - 1].focus();
      }
    } else if (at === -1 || at === items.length - 1) {
      e.preventDefault();
      items[0].focus();
    }
  }
  window.addEventListener('keydown', onKey, true);

  // A request refused for the terms opens the card, unless it is already up. openGate checks the server first.
  window.addEventListener(TERMS_EVENT, () => {
    if (!gate) openGate();
  });

  if (startsPending) openGate();

  // ---------- the Legal page (a Settings section) ----------

  let lastTab = 'agreement';   // the tab the page shows; kept while the page is open
  let nextNotice = null;       // a notice to open in Safety notices, once that tab draws

  async function agreementNodes(data) {
    const accepted = data.accepted;
    const nodes = [
      para(
        accepted
          ? `You accepted version ${accepted.version} on ${dateText(accepted.at)} (Plenum ${accepted.app}).`
          : 'You have not accepted the License Agreement yet. It opens when Plenum starts.',
        'legal-status-line',
      ),
    ];
    for (const change of changesFor(data)) nodes.push(changeBox(change));
    const d = await doc('eula');
    nodes.push(docNode(d.text));
    return nodes;
  }

  async function openSourceNodes(data) {
    const nodes = [];
    if (data.desktop === true) {
      const row = make('div', 'legal-actions start');
      row.append(
        button('ghost small', 'Open Chromium licences', () => openFile('chromium')),
        button('ghost small', 'Open Electron licence', () => openFile('electron')),
      );
      nodes.push(row);
    } else {
      nodes.push(para('In the desktop app these buttons open the Chromium and Electron licence files. With node server.mjs they are in node_modules/electron/dist/.', 'legal-note'));
    }
    const d = await doc('open-source');
    nodes.push(make('pre', 'legal-pre', String(d.text ?? '')));
    return nodes;
  }

  // The desktop app opens one of its own licence files. The name is one of the four the server allows; no path comes from here.
  async function openFile(name) {
    try {
      await postJson('/api/legal/open-file', { name });
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    }
  }

  // One pill per notice. A raised rev ("Updated") and a hidden notice are the states a person must see, so they come before
  // the planned label; a planned notice that is neither says so.
  function noticePill(n) {
    if (n.updated) return { text: 'Updated', kind: 'updated' };
    if (n.hidden) return { text: n.hiddenAt ? `Hidden ${dateText(n.hiddenAt)}` : 'Hidden', kind: 'hidden' };
    if (n.status === 'planned') return { text: 'Planned feature', kind: 'planned' };
    return { text: 'Shows', kind: 'shows' };
  }

  // The notices list. openId is expanded and scrolled into view when it draws. A change draws the list again.
  async function paintNotices(wrap, openId) {
    wrap.replaceChildren(para('Loading the safety notices.', 'legal-loading'));
    let list;
    try {
      const answer = await getJson('/api/notices');
      list = Array.isArray(answer?.notices) ? answer.notices : [];
    } catch (err) {
      wrap.replaceChildren(errorBlock(err, () => paintNotices(wrap, openId)));
      return;
    }
    const hiddenCount = list.filter(n => n.hidden).length;
    const head = make('div', 'legal-notices-head');
    head.append(para('These appear once where a risk starts. Hiding one never turns off a safety check.', 'legal-intro'));
    const showAll = button('ghost small', 'Show all again', () => changeNotice('/api/notices/show-all', {}, 'Hidden notices are shown again.', wrap, openId));
    showAll.disabled = hiddenCount === 0;
    head.append(showAll);

    const items = list.map(n => {
      const det = make('details', 'legal-notice');
      det.dataset.notice = String(n.id ?? '');
      det.open = n.id === openId;
      const pill = noticePill(n);
      const sum = make('summary');
      sum.append(make('span', 'legal-notice-title', n.title ?? ''), make('span', 'legal-pill', pill.text), make('span', 'legal-notice-where', n.where ?? ''));
      sum.querySelector('.legal-pill').dataset.kind = pill.kind;
      const body = make('div', 'legal-notice-body');
      for (const part of String(n.text ?? '').split(/\n{2,}/)) {
        if (part.trim()) body.append(para(part));
      }
      if (n.hidden) {
        body.append(button('ghost small', 'Show again', () => changeNotice('/api/notices/show', { id: n.id }, 'The notice is shown again.', wrap, n.id)));
      }
      det.append(sum, body);
      return det;
    });

    wrap.replaceChildren(head, ...items);
    if (openId) {
      wrap.querySelector(`[data-notice="${CSS.escape(openId)}"]`)?.scrollIntoView?.({ block: 'nearest' });
    }
  }

  async function changeNotice(path, body, okText, wrap, openId) {
    try {
      await postJson(path, body);
      MuseUI.toast(okText);
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    }
    // ext-notices keeps its own copy of the list; reading it again lets a notice that was shown again appear where its risk starts.
    try {
      await MuseUI.notices?.refresh?.();
    } catch {
      // The strips read the server's list again on the next launch.
    }
    await paintNotices(wrap, openId);
  }

  async function noticesNodes() {
    const openId = nextNotice;
    nextNotice = null;
    const wrap = make('div', 'legal-notices');
    paintNotices(wrap, openId);
    return [wrap];
  }

  function fillTab(id, data) {
    switch (id) {
      case 'agreement': return agreementNodes(data);
      case 'privacy': return doc('privacy').then(d => [docNode(d.text)]);
      case 'third-party': return doc('third-party').then(d => [docNode(d.text)]);
      case 'open-source': return openSourceNodes(data);
      default: return noticesNodes();
    }
  }

  // The Legal section's body. It reads GET /api/legal and then draws the tabs.
  async function paintView(view) {
    view.replaceChildren(para('Loading the Legal page.', 'legal-loading'));
    let data;
    try {
      data = await getJson('/api/legal');
    } catch (err) {
      view.replaceChildren(errorBlock(err, () => paintView(view)));
      return;
    }
    view.replaceChildren();
    mountTabs(view, TABS, lastTab, 'legal-page', id => fillTab(id, data), id => { lastTab = id; });
    view.append(para(`Questions: ${data.terms?.contact ?? ''}`, 'legal-foot'));
  }

  function renderSection(body) {
    const view = make('div', 'legal-view');
    body.replaceChildren(view);
    paintView(view);
  }

  if (MuseUI.settings && typeof MuseUI.settings.register === 'function') {
    MuseUI.settings.register({ id: SECTION_ID, scope: 'app', title: 'Legal', order: SECTION_ORDER, render: renderSection });
  }

  // The same notices sit in Settings > Safety (UI-ARCH 5 item 7), where a notice's More link lands: MuseUI.openSettings('safety', id)
  // hands the id to this section as ctx.item, and that notice opens and scrolls into view. The Legal page keeps its Safety notices tab.
  function renderSafety(body, ctx) {
    const wrap = make('div', 'legal-notices');
    body.replaceChildren(wrap);
    paintNotices(wrap, typeof ctx?.item === 'string' && ctx.item ? ctx.item : null);
  }

  if (MuseUI.settings && typeof MuseUI.settings.register === 'function') {
    MuseUI.settings.register({ id: SAFETY_SECTION_ID, scope: 'app', title: 'Safety notices', order: SAFETY_SECTION_ORDER, group: 'safety', render: renderSafety });
  }

  // Opens Settings at the Legal section. tab is one of TABS' ids and noticeId an entry of the notices list; both are optional.
  // Called as /legal with no arguments it opens the page where it was left. The page is opened at the Legal group by name, so a narrow
  // window (480 px and below), which shows one group at a time, lands on it as a wide one scrolls to it.
  MuseUI.openLegal = (tab, noticeId) => {
    if (TABS.some(t => t.id === tab)) lastTab = tab;
    nextNotice = typeof noticeId === 'string' && noticeId ? noticeId : null;
    if (MuseUI.settings && typeof MuseUI.settings.open === 'function') MuseUI.settings.open('app', SECTION_ID);
  };
})();
