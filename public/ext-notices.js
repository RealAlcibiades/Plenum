// ext-notices. The danger notices. MuseUI.notice(id, opts) draws a strip where a risk starts, and MuseUI.risk(id, opts) asks
// before a risky switch. Loaded by ext.js and adds itself through window.MuseUI (see the notices surface in app.js).
// The texts, the Don't-show-again state and the rev come from GET /api/notices (lib/notices.mjs). This file draws them with
// textContent and writes no text of its own, except the question a caller passes when the registry cannot be read.
// Two forms (UI-ARCH 7 and 10.7): a strip where the risk starts, which informs and never blocks (the default), and a dialog,
// with Cancel focused, for Approve all and Apply update only. A notice never stands in for a safety control: the caller still
// runs its own checks whatever the person chooses here, and a hidden notice changes no check.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  // The notices that ask. Every other notice is a strip (UI-ARCH 10.7).
  const DIALOG_IDS = new Set(['approve-all', 'self-update']);
  // The action button is red for these: red means Approve all and the actions that take control (UI-ARCH 9).
  const DANGER_IDS = new Set(['approve-all', 'computer-use']);
  // The strip's edge tone: red for the two notices that hand over control, info for the ones that only explain, amber otherwise.
  const RED_IDS = new Set(['approve-all', 'computer-use']);
  const INFO_IDS = new Set(['multi-provider', 'api-finder-prices', 'artifacts']);
  const ID = /^[a-z0-9-]{1,40}$/;
  // The registry is read once. A read that takes longer than this is given up, and the page carries on without it.
  const REGISTRY_WAIT_MS = 5000;
  const HIDDEN_TOAST = 'Hidden. You can show it again under Settings › Safety.';
  const DONT_SHOW = "Don't show again";

  // The registry as the server answered it, or null when it could not be read. Each entry is
  // { id, rev, kind, status, feature, where, title, text, action, hidden, hiddenAt, updated }.
  let registry = null;
  // Ids drawn or asked during this launch (this page session). A notice appears at most once per launch, and a choice made
  // with OK or Cancel lasts until the next launch. Show again clears its id here, so the notice returns once.
  const seen = new Set();
  // The question in flight for an id. A second call for the same id waits for the same answer; it never passes through.
  const asking = new Map();
  let seq = 0;

  // Turns the server's answer into a list of entries. The server may answer an array or an object keyed by id.
  function listOf(notices) {
    let rows = null;
    if (Array.isArray(notices)) rows = notices;
    else if (notices && typeof notices === 'object') rows = Object.entries(notices).map(([id, n]) => ({ ...n, id }));
    if (!rows) throw new Error('The notices list is missing.');
    return rows.filter(row => row && typeof row.id === 'string' && ID.test(row.id)).map(entryOf);
  }

  function entryOf(row) {
    const text = value => (typeof value === 'string' ? value : '');
    return {
      id: row.id,
      rev: Number.isInteger(row.rev) ? row.rev : 1,
      kind: row.kind === 'confirm' ? 'confirm' : 'inline',
      status: row.status === 'planned' ? 'planned' : 'live',
      feature: text(row.feature),
      where: text(row.where),
      title: text(row.title) || row.id,
      text: text(row.text),
      action: text(row.action) || 'Continue',
      hidden: row.hidden === true,
      hiddenAt: typeof row.hiddenAt === 'string' ? row.hiddenAt : null,
      updated: row.updated === true,
    };
  }

  // Reads the registry once. Any failure leaves registry null: strips are then not drawn, and risk() falls back as described below.
  async function load() {
    try {
      await (MuseUI.ready ?? Promise.resolve());
      const data = await MuseUI.api('/api/notices');
      registry = listOf(data?.notices);
    } catch (err) {
      registry = null;
      console.warn('The danger notices could not be read. Questions use the text their caller gives.', err?.message ?? err);
    }
  }

  const loaded = new Promise(resolve => {
    const timer = setTimeout(resolve, REGISTRY_WAIT_MS);
    load().then(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  const find = id => registry?.find(n => n.id === id) ?? null;
  const toneOf = id => (RED_IDS.has(id) ? 'bad' : INFO_IDS.has(id) ? 'info' : 'warn');

  // Text is split into paragraphs on blank lines and set with textContent. A line that only names the buttons is left out: the
  // buttons are drawn from the registry's action, so that line would say the same thing twice.
  function paragraphs(text, cls) {
    return String(text ?? '')
      .split(/\n{2,}/)
      .map(part => part.trim())
      .filter(part => part !== '' && !part.startsWith('Buttons:'))
      .map(part => {
        const p = document.createElement('p');
        p.className = cls;
        p.textContent = part;
        return p;
      });
  }

  // Writes Don't show again (or Show again) and keeps this page in step. The page's copy changes first, so the question or strip
  // that follows already obeys the choice. A failed write puts the old state back and says so.
  async function setHidden(id, hidden) {
    const n = find(id);
    if (!n) return false;
    const was = n.hidden;
    n.hidden = hidden;
    if (!hidden) seen.delete(id);
    try {
      applyServer(await MuseUI.api(hidden ? '/api/notices/hide' : '/api/notices/show', { id }));
      return true;
    } catch (err) {
      const again = find(id);
      if (again) again.hidden = was;
      MuseUI.toast(`The choice was not saved. ${err?.message ?? ''}`.trim(), 'bad');
      return false;
    }
  }

  // The server answers the new list after each write. An answer without a list changes nothing here.
  function applyServer(data) {
    const rows = Array.isArray(data) ? data : data?.notices;
    if (rows === undefined || rows === null) return;
    try {
      registry = listOf(rows);
    } catch {
      // Keep the list in memory; the next read of the page brings the server's copy.
    }
  }

  // Reads the registry again after another panel changed it on the server (the Settings pages list the notices and post Show again
  // themselves). A notice that was hidden and is shown now is drawn again where its risk starts; a read that fails keeps this copy.
  async function refresh() {
    const was = new Map((registry ?? []).map(n => [n.id, n.hidden]));
    const before = registry;
    await load();
    if (registry === null) registry = before;
    for (const n of registry ?? []) if (was.get(n.id) === true && !n.hidden) seen.delete(n.id);
    return true;
  }

  // More: Settings › Safety at that notice (UI-ARCH 7). Falls back to the Legal page's notices tab, then to Settings.
  function openSafety(id) {
    if (typeof MuseUI.openSettings === 'function') return MuseUI.openSettings('safety', id);
    if (typeof MuseUI.openLegal === 'function') return MuseUI.openLegal('notices', id);
    return MuseUI.settings?.open?.('app');
  }

  // ---------- the strip ----------

  // A strip informs where the risk starts. It takes no focus and blocks nothing. OK hides it until the next launch.
  function buildStrip(n) {
    const note = document.createElement('div');
    note.className = 'risk-note';
    note.setAttribute('role', 'note');
    note.dataset.notice = n.id;
    note.dataset.tone = toneOf(n.id);
    const head = document.createElement('div');
    head.className = 'risk-note-head';
    head.append(MuseUI.icon('alert', 'risk-icon'), MuseUI.span('risk-note-title', n.title));
    const row = document.createElement('div');
    row.className = 'risk-note-actions';
    const okBtn = MuseUI.button('ghost small', 'OK');
    const hideBtn = MuseUI.button('ghost small', DONT_SHOW);
    const moreBtn = MuseUI.button('risk-more', 'More');
    const close = () => note.remove();
    okBtn.addEventListener('click', close);
    hideBtn.addEventListener('click', async () => {
      hideBtn.disabled = true;
      if (await setHidden(n.id, true)) {
        close();
        MuseUI.toast(HIDDEN_TOAST, 'ok');
      } else {
        hideBtn.disabled = false;
      }
    });
    moreBtn.addEventListener('click', () => openSafety(n.id));
    // Escape on a focused strip acts as OK. It stops there, so the run underneath is not stopped by the same key.
    note.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    });
    row.append(okBtn, hideBtn, moreBtn);
    note.append(head, ...paragraphs(n.text, 'risk-note-text'), row);
    return note;
  }

  // Draws the strip before or after an element, or as the first child of a container. It returns true only when a strip was drawn.
  function notice(id, opts = {}) {
    const n = find(id);
    if (!n || n.hidden || seen.has(id)) return false;
    const { before, after, into } = opts ?? {};
    const note = buildStrip(n);
    if (before instanceof Element && before.parentNode) before.parentNode.insertBefore(note, before);
    else if (after instanceof Element && after.parentNode) after.parentNode.insertBefore(note, after.nextSibling);
    else if (into instanceof Element) into.prepend(note);
    else return false;
    seen.add(id);
    return true;
  }

  // ---------- the dialog ----------

  // A dialog for Approve all and Apply update. Cancel is focused, so Enter or Escape keeps things as they are. It is shown with
  // show() and a scrim, as the other confirmations are, so the drive pill and its Stop stay pressable over it (UI-ARCH 7).
  // It resolves 'yes', 'no' or 'more'. Don't show again is written for 'yes' and 'no' only.
  function askDialog(n) {
    return new Promise(resolve => {
      const num = ++seq;
      const dlg = document.createElement('dialog');
      dlg.className = 'risk-dialog';
      dlg.setAttribute('role', 'alertdialog');
      dlg.setAttribute('aria-modal', 'true');
      const title = document.createElement('h2');
      title.className = 'risk-dialog-title';
      title.id = `risk-title-${num}`;
      title.textContent = n.title;
      const head = document.createElement('div');
      head.className = 'risk-dialog-head';
      head.append(MuseUI.icon('alert', 'risk-icon'), title);
      const body = document.createElement('div');
      body.className = 'risk-dialog-body';
      body.id = `risk-body-${num}`;
      body.append(...paragraphs(n.text, 'risk-text'));
      dlg.setAttribute('aria-labelledby', title.id);
      dlg.setAttribute('aria-describedby', body.id);
      const check = document.createElement('input');
      check.type = 'checkbox';
      const checkRow = document.createElement('label');
      checkRow.className = 'risk-check';
      checkRow.append(check, MuseUI.span('risk-check-text', DONT_SHOW));
      const moreBtn = MuseUI.button('risk-more', 'More');
      const cancelBtn = MuseUI.button('ghost', 'Cancel');
      const actionBtn = MuseUI.button(DANGER_IDS.has(n.id) ? 'primary danger' : 'primary', n.action);
      const actions = document.createElement('div');
      actions.className = 'risk-dialog-actions';
      actions.append(cancelBtn, actionBtn);
      const foot = document.createElement('div');
      foot.className = 'risk-dialog-foot';
      foot.append(moreBtn, actions);
      dlg.append(head, body, checkRow, foot);
      const scrim = document.createElement('div');
      scrim.className = 'risk-scrim';
      const order = [moreBtn, check, cancelBtn, actionBtn];

      let settled = false;
      const keepFocus = e => {
        if (!dlg.contains(e.target)) cancelBtn.focus();
      };
      const finish = answer => {
        if (settled) return;
        settled = true;
        document.removeEventListener('focusin', keepFocus);
        scrim.remove();
        dlg.remove();
        if (answer !== 'more' && check.checked) setHidden(n.id, true);
        resolve(answer);
      };
      cancelBtn.addEventListener('click', () => finish('no'));
      actionBtn.addEventListener('click', () => finish('yes'));
      moreBtn.addEventListener('click', () => {
        finish('more');
        openSafety(n.id);
      });
      dlg.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          // Esc closes this dialog only: the page's own Escape handlers (the Settings page, the project drawer) must not also act.
          e.preventDefault();
          e.stopPropagation();
          finish('no');
          return;
        }
        if (e.key !== 'Tab') return;
        const at = order.indexOf(document.activeElement);
        if (e.shiftKey && at <= 0) {
          e.preventDefault();
          actionBtn.focus();
        } else if (!e.shiftKey && (at === -1 || at === order.length - 1)) {
          e.preventDefault();
          moreBtn.focus();
        }
      });
      document.addEventListener('focusin', keepFocus);
      document.body.append(scrim, dlg);
      dlg.show();
      cancelBtn.focus();
    });
  }

  // ---------- risk ----------

  // The question for a registry notice, or the caller's own question when the registry has no entry for the id (it could not be
  // read, or the id is new). The caller's question is the one the app passes for Approve all and Apply update; it is asked each time.
  function fallback(opts) {
    if (!(opts.title || opts.body) || typeof MuseUI.confirm !== 'function') return true;
    return MuseUI.confirm({ title: opts.title, body: opts.body, action: opts.action, tone: opts.tone, focusCancel: opts.focusCancel === true });
  }

  async function decide(id, opts) {
    await loaded;
    const n = find(id);
    if (!n) return fallback(opts);
    // A strip informs and does not wait. It is drawn only when the caller names where it goes.
    if (!DIALOG_IDS.has(id)) {
      if (opts.before || opts.after || opts.into) notice(id, opts);
      return true;
    }
    // Don't show again, or a choice already made in this launch, lets the switch go on at once.
    if (n.hidden || seen.has(id)) return true;
    seen.add(id);
    const answer = await askDialog(n);
    if (answer === 'more') {
      // More leaves the switch off and asks again next time, so the person can read the notice first.
      seen.delete(id);
      return false;
    }
    return answer === 'yes';
  }

  // Resolves true when the switch may go on. It never throws: a notice that cannot be shown does not stop the caller, whose own
  // checks still run (LEGAL notices, RULE).
  function risk(id, opts = {}) {
    const o = opts ?? {};
    if (asking.has(id)) return asking.get(id);
    const answer = decide(id, o).catch(() => true).finally(() => asking.delete(id));
    asking.set(id, answer);
    return answer;
  }

  MuseUI.risk = risk;
  MuseUI.notice = notice;
  // The Legal page and the Settings page read and change the notices through this, so they share one copy of the state.
  MuseUI.notices = {
    ready: loaded,
    list: () => (registry ?? []).map(n => ({ ...n })),
    hide: id => setHidden(id, true),
    show: id => setHidden(id, false),
    showAll: async () => {
      seen.clear();
      try {
        applyServer(await MuseUI.api('/api/notices/show-all', {}));
        return true;
      } catch (err) {
        MuseUI.toast(`The choice was not saved. ${err?.message ?? ''}`.trim(), 'bad');
        return false;
      }
    },
    open: openSafety,
    refresh,
  };
})();
