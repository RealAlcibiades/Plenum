// ext-tools-verify. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// The tool check for xAI (grok-05). It adds one row under the xAI key card in Settings > Accounts > API keys, where Grok answers text
// only until a tool call goes through with your key. The check sends one tiny request to xAI with the saved key; the server
// (lib/tool-verify.mjs) keeps only the result, never the key. This panel never sees a key. It reads GET /api/keys (each provider's
// toolsVerified flag and last check) and posts to POST /api/keys/verify-tools. Text is set with textContent only.
//
// ext-accounts-api.js draws the key cards each time Settings opens, so this panel watches the page and adds the row to each new card.
// It also reads the card's Save state from the pill's ok class, which ext-accounts-api.js sets when a key is saved.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it, or without MutationObserver, there is nothing to attach to.
  if (!MuseUI || typeof MutationObserver !== 'function') return;

  const PROVIDER = 'xai';
  // The key cards: section.card in the list of the API keys section, with the xAI badge in its head.
  const CARD = '.ext-apikeys-list > section.card';
  const BADGE = '.card-head .logo-sm.p-xai';

  const TEXT = {
    loading: 'Checking the tool check…',
    loadFailed: 'The tool check could not be read. Try again.',
    notVerified: 'Tools: not verified. Grok answers text only until Plenum checks a tool call with your key.',
    cost: 'The check sends one tiny request to xAI with your key, and xAI bills it like any other request.',
    needKey: 'Save a key above before checking.',
    checking: 'Checking tool calls. This sends one tiny request with your key.',
    check: 'Check tool calls',
    again: 'Check again',
    forget: 'Clear the tool check',
    tryAgain: 'Try again',
    noReason: 'the check did not say why',
  };

  const seen = new WeakSet();
  const rows = new WeakMap();
  let timer = 0;

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Each write happens only when the value changes. The observer below sees the page's own changes, so a write that repeats
  // the same value would be seen again and again.
  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  function setClass(node, value) {
    if (node.className !== value) node.className = value;
  }

  // Whether a key is saved for the card: ext-accounts-api.js puts the ok class on the card's pill when it is.
  function savedOf(card) {
    return card.querySelector('.card-head .pill')?.classList.contains('ok') === true;
  }

  // The day of a check, written the way the rest of the page writes dates: 20 Oct 2026.
  function dayOf(iso) {
    if (typeof iso !== 'string') return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // The provider's reason as a clause after a colon. The server has already taken the key out of it (lib/tool-verify.mjs).
  function clauseOf(reason) {
    const text = typeof reason === 'string' ? reason.trim().replace(/[.\s]+$/, '') : '';
    if (!text) return TEXT.noReason;
    return text.replace(/^The /, 'the ');
  }

  // A check record as the server sends it: { ok, model, at, reason }, or null when there has been none.
  function checkOf(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      ok: raw.ok === true,
      model: typeof raw.model === 'string' && raw.model ? raw.model : null,
      at: typeof raw.at === 'string' ? raw.at : null,
      reason: typeof raw.reason === 'string' ? raw.reason : null,
    };
  }

  // The page's state after a change (the picker's tool line reads it). A failure to refresh leaves the page as it was.
  function refreshApp() {
    try {
      Promise.resolve(MuseUI.refresh?.()).catch(() => {});
    } catch {
      // The page reads its state again the next time it draws.
    }
  }

  // Builds the row under one xAI card and starts reading its state. Returns { paint } for the observer to call again.
  function buildRow(card) {
    const state = { mode: 'loading', toolsOn: false, check: null, busy: false, message: null };
    const root = make('div', 'tools-verify');
    const text = make('p', 'tools-verify-text', TEXT.loading);
    const note = make('p', 'tools-verify-note');
    const actions = make('div', 'actions tools-verify-actions');
    const check = MuseUI.button('ghost small', TEXT.check);
    const forget = MuseUI.button('ghost small', TEXT.forget);
    const retry = MuseUI.button('ghost small', TEXT.tryAgain);
    actions.append(check, forget, retry);
    const result = make('p', 'tools-verify-result');
    result.setAttribute('role', 'status');
    root.append(text, note, actions, result);
    card.append(root);

    // Every text and state the row shows comes from here, so a change of the card's Save state repaints it the same way.
    function paint() {
      const saved = savedOf(card);
      if (state.mode === 'failed') {
        setText(text, TEXT.loadFailed);
        setText(note, '');
        note.hidden = true;
        check.hidden = true;
        forget.hidden = true;
        retry.hidden = false;
        retry.disabled = state.busy;
      } else {
        const on = state.toolsOn;
        const failed = !on && state.check !== null && state.check.ok === false;
        retry.hidden = true;
        if (state.mode === 'loading') {
          setText(text, TEXT.loading);
        } else if (on) {
          const day = dayOf(state.check?.at);
          const name = state.check?.model ?? 'Grok';
          setText(text, state.check?.ok === true
            ? `Tool calls work with ${name}${day ? ` (checked ${day})` : ''}. Grok now gets the project tools.`
            : 'Tool calls are on for Grok. Grok gets the project tools.');
        } else if (failed) {
          setText(text, `xAI did not complete a tool call on chat completions: ${clauseOf(state.check.reason)}. Grok stays text-only. xAI documents tools on its Responses API, which Plenum does not speak yet.`);
        } else {
          setText(text, TEXT.notVerified);
        }
        const showNote = state.mode === 'ready' && !on;
        setText(note, showNote ? (saved ? TEXT.cost : `${TEXT.cost} ${TEXT.needKey}`) : '');
        note.hidden = !showNote;
        check.hidden = !(state.mode === 'ready' && !on);
        setText(check, failed ? TEXT.again : TEXT.check);
        check.disabled = state.busy || !saved;
        forget.hidden = !(state.mode === 'ready' && on);
        forget.disabled = state.busy;
      }
      // The message line: the work in hand, or the last answer that was an error.
      const shown = state.busy ? { text: TEXT.checking, tone: '' } : state.message;
      setText(result, shown?.text ?? '');
      setClass(result, shown?.tone ? `tools-verify-result ${shown.tone}` : 'tools-verify-result');
      result.hidden = !shown;
    }

    // Reads the flag and the last check for xAI. A provider the list does not name leaves no row at all.
    async function load() {
      state.mode = 'loading';
      state.message = null;
      paint();
      try {
        const data = await MuseUI.api('/api/keys');
        const p = Array.isArray(data?.providers) ? data.providers.find(x => x?.id === PROVIDER) : null;
        if (!p) {
          root.remove();
          rows.delete(card);
          return;
        }
        state.mode = 'ready';
        state.toolsOn = p.toolsVerified === true;
        state.check = checkOf(p.toolCheck);
      } catch {
        state.mode = 'failed';
      }
      paint();
    }

    async function runCheck() {
      if (state.busy) return;
      state.busy = true;
      state.message = null;
      paint();
      try {
        const r = await MuseUI.api('/api/keys/verify-tools', { provider: PROVIDER });
        state.toolsOn = r.toolsVerified === true;
        state.check = checkOf(r);
        if (state.toolsOn) refreshApp();
      } catch (err) {
        state.message = { text: String(err?.message || 'The check did not run. Try again.'), tone: 'bad' };
      } finally {
        state.busy = false;
        paint();
      }
    }

    async function runForget() {
      if (state.busy) return;
      state.busy = true;
      state.message = null;
      paint();
      try {
        const r = await MuseUI.api('/api/keys/verify-tools', { provider: PROVIDER, forget: true });
        state.toolsOn = r.toolsVerified === true;
        state.check = null;
        refreshApp();
      } catch (err) {
        state.message = { text: String(err?.message || 'The check could not be removed. Try again.'), tone: 'bad' };
      } finally {
        state.busy = false;
        paint();
      }
    }

    check.addEventListener('click', runCheck);
    forget.addEventListener('click', runForget);
    retry.addEventListener('click', load);
    load();
    return { paint };
  }

  // Looks for key cards that are new since the last look, and repaints the rows that are there.
  function scan() {
    timer = 0;
    for (const card of document.querySelectorAll(CARD)) {
      const row = rows.get(card);
      if (row) {
        row.paint();
        continue;
      }
      if (seen.has(card)) continue;
      seen.add(card);
      if (!card.querySelector(BADGE)) continue;
      rows.set(card, buildRow(card));
    }
  }

  function schedule() {
    if (!timer) timer = setTimeout(scan, 30);
  }

  // The page changes often (chat replies, pills, drawers), so the scan is queued and runs once for a burst of changes. Only childList
  // and class changes are watched: the row's own changes (text and the hidden and disabled states) do not queue another scan.
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  schedule();
})();
