// The connection banner and Retry for failed sends. Loaded by ext.js and adds itself through window.MuseUI.
// When a call to the local server cannot reach it, one banner says so instead of a line per call, and the page checks the server
// every 5 seconds until it answers again. A failed send gets Retry (it puts the last message back in the composer; it does not
// send it) and Copy error. Only the last "Cannot reach the Plenum server" line stays visible.
// The fetch wrapper only watches same-origin /api/ calls. It never changes a request or a response.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const LINE = 'Cannot reach the Plenum server';
  const EVERY_MS = 5000;
  // Checked while the server is up: a small file from the fixed static list, so an idle page does not run the status check.
  const UP_CHECK = '/mark.svg';
  // Checked while the banner shows: the status endpoint, which answers only once the server is running again.
  const DOWN_CHECK = '/api/status';
  // The original fetch. The checks use it, so they never pass through the wrapper below.
  const real = window.fetch.bind(window);

  let down = false;    // the banner is showing
  let probing = false; // one check at a time, so a tick and a click cannot overlap

  const banner = document.createElement('div');
  banner.className = 'ext-conn-banner';
  banner.setAttribute('role', 'alert');
  banner.hidden = true;
  const note = document.createElement('span');
  note.className = 'ext-conn-text';
  note.textContent = 'Cannot reach the Plenum server. Retrying every 5 seconds.';
  const retryNow = MuseUI.button('ghost small ext-conn-btn', 'Retry now');
  retryNow.addEventListener('click', () => probe());
  banner.append(note, retryNow);
  // Above the transcript, in the same column as the messages.
  MuseUI.el.chat.before(banner);

  // True for a call to this server's own API. Calls to any other address are never watched.
  function isLocalApi(input) {
    try {
      const raw = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input?.url ?? ''));
      const url = new URL(raw, location.href);
      return url.origin === location.origin && url.pathname.startsWith('/api/');
    } catch {
      return false;
    }
  }

  // A reply of any status means the server is up. A network failure on a local call means it is down. The error is passed on
  // unchanged, so the caller handles it as it did before this panel.
  window.fetch = async (input, init) => {
    const local = isLocalApi(input);
    try {
      const res = await real(input, init);
      if (local) markUp();
      return res;
    } catch (err) {
      if (local && err instanceof TypeError) markDown();
      throw err;
    }
  };

  function markDown() {
    if (down) return;
    down = true;
    banner.hidden = false;
  }

  function markUp() {
    if (!down) return;
    down = false;
    banner.hidden = true;
    MuseUI.toast('Connected to the Plenum server again.');
    MuseUI.refresh();
  }

  // One check: every 5 seconds, and at once for Retry now. An ok answer from the status endpoint ends the banner. A network
  // failure starts it (or keeps it up).
  async function probe() {
    if (probing) return;
    probing = true;
    try {
      const res = await real(down ? DOWN_CHECK : UP_CHECK, {
        cache: 'no-store',
        // The status endpoint is behind the Plenum token like every other /api/ route.
        headers: MuseUI.headers ? MuseUI.headers() : {},
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
      });
      res.body?.cancel().catch(() => {});
      if (res.ok) markUp();
    } catch {
      markDown();
    } finally {
      probing = false;
    }
  }

  // The events channel (GET /api/events) is open while the server is up, so its loss is the quickest sign the server is gone:
  // app.js announces it as 'plenum:connection' with detail { connected }.
  window.addEventListener('plenum:connection', e => {
    if (e.detail?.connected) markUp();
    else markDown();
  });

  // Runs for the life of the page. Without it an idle page would not notice a server that stopped.
  setInterval(probe, EVERY_MS);

  // True for a turn whose text is the connection line the app writes when a refresh cannot reach the server.
  function isLine(turn) {
    return (turn.querySelector(':scope > .turn-body')?.textContent ?? '').startsWith(LINE);
  }

  // Keeps only the last connection line visible. The others get a class that the stylesheet hides.
  function dedupe() {
    const lines = [...MuseUI.el.chat.querySelectorAll('.turn.error, .turn.system')].filter(isLine);
    lines.forEach((turn, i) => turn.classList.toggle('ext-conn-dup', i < lines.length - 1));
  }

  // Puts the last message the user sent back in the composer. It is not sent: the user presses Send.
  function retryLast() {
    const input = MuseUI.el.input;
    const last = [...(MuseUI.state.messages ?? [])].reverse().find(m => m.role === 'user' && m.kind === 'chat');
    if (!last) return MuseUI.toast('There is no earlier message to retry.', 'bad');
    // A draft is never overwritten, the same rule app.js follows when it inserts a reply.
    if (input.value.trim()) return MuseUI.toast('The composer already has text. Clear it first, then retry.', 'bad');
    input.value = last.content ?? '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  async function copyError(turn) {
    const text = turn.querySelector(':scope > .turn-body')?.textContent ?? '';
    // MuseUI.copyText falls back to the page's copy command when the clipboard API refuses.
    const copied = MuseUI.copyText ? await MuseUI.copyText(text) : await navigator.clipboard.writeText(text).then(() => true, () => false);
    if (copied) MuseUI.toast('Error copied.');
    else MuseUI.toast('The error could not be copied.', 'bad');
  }

  function bar(turn) {
    const row = document.createElement('div');
    row.className = 'ext-conn-bar';
    const retry = MuseUI.button('ghost small ext-conn-btn', 'Retry');
    retry.addEventListener('click', retryLast);
    const copy = MuseUI.button('ghost small ext-conn-btn', 'Copy error');
    copy.addEventListener('click', () => copyError(turn));
    row.append(retry, copy);
    return row;
  }

  // Retry and Copy error under each failed send. The connection lines get none of their own.
  function addBars() {
    for (const turn of MuseUI.el.chat.querySelectorAll('.turn.error')) {
      if (isLine(turn) || turn.querySelector(':scope > .ext-conn-bar')) continue;
      turn.append(bar(turn));
    }
  }

  function sweep() {
    dedupe();
    // The send button shows Stop while a run is going. Retry waits until the page is idle.
    if (!MuseUI.el.send.classList.contains('stop')) addBars();
  }

  // The page redraws the transcript by replacing its children, so each redraw runs the sweep again. The send button's class
  // changes when a run starts or ends, which also decides whether the Retry bars may be added.
  new MutationObserver(sweep).observe(MuseUI.el.chat, { childList: true, subtree: true });
  new MutationObserver(sweep).observe(MuseUI.el.send, { attributes: true, attributeFilter: ['class'] });
  sweep();
})();
