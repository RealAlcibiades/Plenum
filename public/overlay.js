// The bar of the computer-use overlay (public/overlay.html): the words the person reads on their screen while a model has the mouse
// and the keyboard, with Pause (Resume) and Stop. The overlay window (desktop/computer/overlay.cjs) loads this page with
//   ?state=running|paused&label=<what is driven>&model=<the model's name>&theme=light|dark
// and these are shown at once; after that the server is the source of truth: GET /api/drive every second, and the answers to the
// buttons. The page has no preload, no Node and never holds the per-launch token: the overlay's own session adds it to this page's
// requests for /api/ paths (and nothing else), so every request here is a plain same-origin fetch.
//
// Stop is the emergency stop (AMENDMENTS floor): it is never disabled, it reads the server afresh before it acts so a run that began
// a moment ago is stopped too, it stops every computer run, it answers a run that had already ended as done, and when it cannot
// reach Plenum it says so and names the stop key, which does not depend on this page. Everything that arrives (the server's words,
// the model's note, the address) is set with textContent; there is no markup built from strings, no storage, no logging.
(function () {
  'use strict';

  const KIND = 'computer';
  const POLL_MS = 1000;
  const TICK_MS = 1000;
  const CALL_MS = 3000;
  const NOTICE_MS = 6000;
  // Reads that failed in a row before the bar says Plenum is not answering.
  const FAIL_AFTER = 3;

  const byId = id => document.getElementById(id);
  const root = document.documentElement;
  const bar = byId('bar');
  const textEl = byId('text');
  const toggleBtn = byId('toggle');
  const stopBtn = byId('stop');
  const live = byId('live');
  if (!bar || !textEl || !toggleBtn || !stopBtn) return;

  // One printable line, clipped. A cut never leaves half of a surrogate pair.
  function clean(value, max) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim().slice(0, max).replace(/[\ud800-\udbff]$/, '');
  }

  const params = new URLSearchParams(location.search);
  const first = {
    state: params.get('state') === 'paused' ? 'paused' : 'running',
    label: clean(params.get('label'), 80),
    model: clean(params.get('model'), 60),
    theme: params.get('theme') === 'light' ? 'light' : 'dark',
  };
  // The theme the person chose in Plenum is written into this page by the server (the same attribute as in the app); when they follow
  // the system, the address says which one the system is using now.
  const given = root.dataset.theme;
  root.dataset.theme = given === 'light' || given === 'dark' ? given : first.theme;

  // The live computer runs as the server last said (newest first), each { s: summary, at: when it arrived }; null until the first read.
  let drives = null;
  // The stop key as the server reports it: { ok, accelerator, label, reason }.
  let hotkey = null;
  let busy = false;
  let stopping = false;
  let failures = 0;
  let notice = '';
  let noticeUntil = 0;
  let shownKey = '';

  const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const current = () => (drives && drives.length ? drives[0] : null);

  function mmss(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  // "step 12 of 80", and the time left when the run has a time limit (it counts only while the run is running).
  function progress(entry) {
    const s = entry.s;
    const steps = num(s.steps) ?? 0;
    const cap = num(s.limits && s.limits.steps);
    let text = cap === null ? `step ${steps}` : `step ${steps} of ${cap}`;
    const limit = num(s.limits && s.limits.activeMs);
    if (limit !== null) {
      const used = (num(s.activeMs) ?? 0) + (s.state === 'running' ? Math.max(0, Date.now() - entry.at) : 0);
      text += ` · ${mmss(Math.max(0, limit - used))} left`;
    }
    return text;
  }

  // Where the stop key is named in a message: the server's word for it, else the usual key for this system.
  function keyHint() {
    if (hotkey && hotkey.ok === false) return 'Try Stop again, or use Stop in Plenum.';
    if (hotkey && hotkey.ok && hotkey.label) return `Press ${clean(hotkey.label, 30)} to stop.`;
    const mac = typeof navigator === 'object' && navigator && /Mac/i.test(String(navigator.userAgent || ''));
    return `Press ${mac ? 'Control+Option+Esc' : 'Ctrl+Alt+Esc'} to stop.`;
  }

  // The words for the run: { text, tone, said, cardWait, paused }. tone is running (amber), paused (grey) or wait (accent).
  function describe(entry) {
    const who = first.model || 'The model';
    if (!entry) {
      if (drives === null) {
        const where = first.label || 'this computer';
        return first.state === 'paused'
          ? { text: `Paused · ${where}`, tone: 'paused', said: 'Paused.', paused: true }
          : { text: `${who} is using ${where}`, tone: 'running', said: `${who} is using ${where}.` };
      }
      return { text: 'Stopped · no model is controlling this computer', tone: 'paused', said: 'Stopped.' };
    }
    const s = entry.s;
    const where = clean(s.label, 80) || first.label || 'this computer';
    if (s.state === 'running') {
      return { text: `${who} is using ${where} · ${progress(entry)}`, tone: 'running', said: `${who} is using ${where}.` };
    }
    if (s.pausedBy === 'model') {
      // The model's own words are quoted and named; they are never shown as Plenum's.
      const note = clean(s.note, 120);
      return { text: note ? `Your turn · ${who} asks: "${note}"` : `Your turn · ${who} is waiting for you`, tone: 'wait', said: 'Your turn.', paused: true };
    }
    if (s.pausedBy === 'card') {
      return { text: 'Waiting for your answer on the card in Plenum', tone: 'wait', said: 'Waiting for your answer.', paused: true, cardWait: true };
    }
    if (s.pausedBy === 'input') {
      return { text: `Paused: you used the mouse or keyboard · ${where} · ${progress(entry)}`, tone: 'paused', said: 'Paused.', paused: true };
    }
    return { text: `Paused · ${where} · ${progress(entry)}`, tone: 'paused', said: 'Paused.', paused: true };
  }

  // A line that replaces the usual words for a few seconds (a refusal, a failure).
  function say(text) {
    notice = clean(text, 200);
    noticeUntil = Date.now() + NOTICE_MS;
  }

  function paint() {
    const entry = current();
    const d = describe(entry);
    let text = d.text;
    let tone = d.tone;
    if (failures >= FAIL_AFTER) {
      text = `Plenum is not answering. ${keyHint()}`;
      tone = 'wait';
    }
    if (notice && Date.now() < noticeUntil) text = notice;
    else notice = '';

    bar.dataset.tone = tone;
    if (textEl.textContent !== text) textEl.textContent = text;
    textEl.title = text;
    const label = d.paused ? 'Resume' : 'Pause';
    if (toggleBtn.textContent !== label) toggleBtn.textContent = label;
    // A card waiting for the person is answered first; Resume would skip it, so the button waits. Stop is never disabled.
    toggleBtn.disabled = !entry || busy || d.cardWait === true;
    toggleBtn.title = d.cardWait ? 'Answer the card in Plenum first. Stop ends the run.' : (d.paused ? 'Let the model carry on' : 'Pause the model’s control');
    stopBtn.disabled = false;
    stopBtn.title = hotkey && hotkey.ok && hotkey.label ? `Stop the model’s control now (${clean(hotkey.label, 30)})` : 'Stop the model’s control now';

    // The live region says a change of state once, never the clock.
    const key = entry ? `${entry.s.id}|${entry.s.state}|${entry.s.pausedBy || ''}` : (drives === null ? 'first' : 'none');
    if (key !== shownKey && live) {
      shownKey = key;
      live.textContent = d.said;
    }
  }

  // One request to the server's own origin. Rejects when it cannot be made or takes longer than CALL_MS. { ok, status, data }.
  async function call(path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CALL_MS);
    try {
      const init = body === undefined
        ? { cache: 'no-store', signal: ctl.signal }
        : { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal };
      const res = await fetch(path, init);
      let data = null;
      try {
        data = await res.json();
      } catch {
        // Not JSON; the status says enough.
      }
      return { ok: res.ok, status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  // Keeps one summary the server sent. A run that has stopped leaves the list; anything else that is not a computer run is ignored.
  function take(s) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || s.kind !== KIND) return;
    const rest = (drives || []).filter(e => e.s.id !== s.id);
    drives = s.state === 'stopped' ? rest : [{ s, at: Date.now() }, ...rest];
  }

  // Reads GET /api/drive: the live runs and the stop key. Rejects when the answer is not the list.
  async function read() {
    const r = await call('/api/drive');
    const list = r.ok && r.data && Array.isArray(r.data.drives) ? r.data.drives : null;
    if (!list) throw new Error('unreadable');
    const now = Date.now();
    drives = list.filter(s => s && typeof s === 'object' && typeof s.id === 'string' && s.kind === KIND && s.state !== 'stopped').map(s => ({ s, at: now }));
    if (r.data.hotkey && typeof r.data.hotkey === 'object') hotkey = r.data.hotkey;
  }

  const wordsOf = r => (r && r.data && typeof r.data.error === 'string' ? clean(r.data.error, 160) : '');

  // Pause or Resume, whichever the run is waiting for. A refusal (409: a card waits; 404: the run ended) is shown in the server's words.
  async function toggle() {
    const entry = current();
    if (!entry || busy || (entry.s.state === 'paused' && entry.s.pausedBy === 'card')) return;
    busy = true;
    paint();
    try {
      const r = await call(entry.s.state === 'paused' ? '/api/drive/resume' : '/api/drive/pause', { id: entry.s.id });
      if (r.ok && r.data && r.data.drive) take(r.data.drive);
      else say(wordsOf(r) || 'That did not work. Try again, or press Stop.');
    } catch {
      say(`Plenum did not answer. ${keyHint()}`);
    } finally {
      busy = false;
    }
    try {
      await read();
    } catch {
      // The next read tries again.
    }
    paint();
  }

  // The emergency stop. It never waits for a Pause or Resume in flight, and a second press while one is in flight does nothing.
  async function stop() {
    if (stopping) return;
    stopping = true;
    say('Stopping…');
    paint();
    let failed = false;
    try {
      // Read afresh first, so a run that began a moment ago is stopped too. When the read fails the last one stands.
      try {
        await read();
      } catch {
        if (drives === null) failed = true;
      }
      const ids = (drives || []).map(e => e.s.id);
      await Promise.all(ids.map(async id => {
        try {
          const r = await call('/api/drive/stop', { id });
          if (r.ok) take(r.data && r.data.drive ? r.data.drive : { id, kind: KIND, state: 'stopped' });
          // 404: that run had already ended, which is what was asked for.
          else if (r.status === 404) take({ id, kind: KIND, state: 'stopped' });
          else failed = true;
        } catch {
          failed = true;
        }
      }));
    } finally {
      stopping = false;
    }
    if (failed) say(`Stop did not reach Plenum. ${keyHint()}`);
    else notice = '';
    paint();
    try {
      await read();
    } catch {
      // The next read tries again.
    }
    paint();
  }

  stopBtn.addEventListener('click', () => {
    stop().catch(() => {});
  });
  toggleBtn.addEventListener('click', () => {
    toggle().catch(() => {});
  });

  // One read after another, a second apart, never two at once.
  async function poll() {
    try {
      await read();
      failures = 0;
    } catch {
      failures += 1;
    }
    paint();
    setTimeout(() => {
      poll().catch(() => {});
    }, POLL_MS);
  }

  paint();
  poll().catch(() => {});
  setInterval(paint, TICK_MS);
})();
