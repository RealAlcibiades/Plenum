// Plan use (pro-10): the quota ring after the model picker, the Plan use pop-up it opens, and the limit banner with Draft handoff.
// Loaded by ext.js and adds itself through window.MuseUI. It reads GET /api/quota and sends POST /api/quota/refresh and
// POST /api/handoff/draft (lib/quota.mjs, lib/routes/handoff.mjs). A poll never sends a model request, and a refresh can only
// send one the server allows. A handoff is only written into the composer: this file never sends a message.
// Everything here is built with createElement, textContent and setAttribute; no inline style and no innerHTML (strict CSP).
(function () {
  'use strict';
  const MU = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MU || !MU.el) return;

  const el = MU.el;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const POLL_MS = 10 * 60 * 1000;
  const TICK_MS = 750;
  const RING_R = 8;
  const RING_LEN = 2 * Math.PI * RING_R;
  const QUOTA = ['codex', 'muse', 'anthropic', 'gemini'];
  const LABELS = { codex: 'Codex', muse: 'Muse Code', anthropic: 'Claude', gemini: 'Gemini', echo: 'Test', xai: 'Grok', openai: 'OpenAI', deepseek: 'DeepSeek', mistral: 'Mistral', googleai: 'Google AI', openrouter: 'OpenRouter' };
  const MARKS = { codex: ['X', 'codex'], muse: ['M', 'muse'], anthropic: ['C', 'claude'], gemini: ['G', 'gemini'] };
  const PILLS = { ok: 'Within limit', warn: 'Above 80%', high: 'Above 95%', unknown: 'Unknown' };
  const RANK = { ok: 0, warn: 1, unknown: 2, high: 3 };
  // The same words the server's limit errors use. Matched against error turns and notices only, never against replies.
  const LIMIT_RE = /\b(usage|rate|plan|weekly|5-hour|five-hour|hourly|daily|monthly|session)[ -]limit\b|\blimit (reached|exceeded|hit)\b|\bout of (credits|quota)\b|\btoo many requests\b|\b429\b|resource[_ ]exhausted|exceeded your (current )?quota/i;
  // A limit error names the CLI that stopped ("Codex stopped with an error: ..."); that name decides the provider.
  const SPEAKERS = [['Codex', 'codex'], ['Claude', 'anthropic'], ['Muse Code', 'muse'], ['Gemini', 'gemini']];
  const NO_READING = 'Not checked yet.';

  const quota = { providers: null, at: 0 };
  const near = new Set(); // providers whose near-limit banner already showed in this page session
  const seenNodes = new WeakSet();
  // Limit messages this page has handled, by text. A redraw of the chat makes new nodes with the same text, so a message that is
  // already here is not handled again when the chat is drawn once more (B-100). A new arrival is always handled.
  const limitSeen = new Set();
  let popOpen = false;
  let busyRefresh = false;
  let painted = '';
  let banner = null; // { node, handle }
  let infoCache = null;
  let infoAt = 0;

  // ---------- small helpers ----------

  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const providerOf = ref => {
    const text = String(ref ?? '');
    const i = text.indexOf(':');
    return i < 0 ? text : text.slice(0, i);
  };
  const labelOf = provider => LABELS[provider] ?? provider;
  const when = ms => (typeof ms === 'number' && Number.isFinite(ms)
    ? new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'time not reported');
  const asOf = ms => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'not seen yet');

  // The entry the page holds for a provider. Before the first poll every ring is unknown.
  function entryFor(provider) {
    return quota.providers?.[provider] ?? { provider, label: labelOf(provider), state: 'unknown', usedPercent: null, windows: [], observedAt: null, note: NO_READING };
  }

  // The provider whose ring shows for a model: the four subscription CLIs, and Claude only on its CLI route. API models and Echo have none.
  function ringProvider(ref) {
    const provider = providerOf(ref);
    if (provider === 'codex' || provider === 'muse' || provider === 'gemini') return provider;
    if (provider === 'anthropic' && MU.providers?.anthropic?.route === 'cli') return provider;
    return null;
  }

  // ---------- the ring ----------

  const ringWrap = make('span', 'ext-quota');
  ringWrap.hidden = true;
  const ring = make('button', 'ext-quota-ring');
  ring.type = 'button';
  ring.setAttribute('aria-haspopup', 'dialog');
  ring.setAttribute('aria-expanded', 'false');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('class', 'ext-quota-track');
  track.setAttribute('cx', '10');
  track.setAttribute('cy', '10');
  track.setAttribute('r', String(RING_R));
  const arc = document.createElementNS(SVG_NS, 'circle');
  arc.setAttribute('class', 'ext-quota-arc');
  arc.setAttribute('cx', '10');
  arc.setAttribute('cy', '10');
  arc.setAttribute('r', String(RING_R));
  arc.setAttribute('transform', 'rotate(-90 10 10)');
  arc.setAttribute('stroke-dasharray', `0 ${RING_LEN}`);
  const query = document.createElementNS(SVG_NS, 'text');
  query.setAttribute('class', 'ext-quota-q');
  query.setAttribute('x', '10');
  query.setAttribute('y', '10');
  query.setAttribute('text-anchor', 'middle');
  query.setAttribute('dominant-baseline', 'central');
  query.textContent = '?';
  svg.append(track, arc, query);
  ring.append(svg);
  const pop = make('div', 'ext-quota-pop');
  pop.hidden = true;
  pop.tabIndex = -1;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Plan use');
  ringWrap.append(ring, pop);

  // Draws the ring for the selected model: its state, the arc, and the title and label that name each window.
  function describe(entry) {
    if (entry.windows?.length) return `${entry.label}: ${entry.windows.map(w => `${w.name} ${w.usedPercent}% used, resets ${when(w.resetsAt)}`).join(' · ')}`;
    return `${entry.label}: plan use unknown. ${entry.note || ''}`.trim();
  }

  function paintRing() {
    const provider = ringProvider(el.model.value);
    const key = `${el.model.value}|${MU.providers?.anthropic?.route ?? ''}|${quota.at}`;
    if (key === painted) return;
    painted = key;
    if (!provider) {
      ringWrap.hidden = true;
      closePop();
      return;
    }
    const entry = entryFor(provider);
    const state = ['ok', 'warn', 'high'].includes(entry.state) ? entry.state : 'unknown';
    ringWrap.hidden = false;
    ring.className = `ext-quota-ring ${state}`;
    const text = describe(entry);
    ring.title = text;
    ring.setAttribute('aria-label', text);
    arc.setAttribute('stroke-dasharray', state === 'unknown' ? `0 ${RING_LEN}` : `${((entry.usedPercent ?? 0) / 100) * RING_LEN} ${RING_LEN}`);
    if (popOpen) renderPop();
  }

  // The model picker sets its value without an event when the project changes, so the ring is checked on a short tick as well.
  function syncRing() {
    paintRing();
  }

  // ---------- Plan use pop-up ----------

  function openPop() {
    if (ringWrap.hidden) return;
    popOpen = true;
    pop.hidden = false;
    ring.setAttribute('aria-expanded', 'true');
    renderPop();
    pop.focus();
    loadQuota();
  }

  function closePop() {
    if (!popOpen && pop.hidden) return;
    popOpen = false;
    pop.hidden = true;
    ring.setAttribute('aria-expanded', 'false');
  }

  function renderPop() {
    const head = make('div', 'ext-quota-pop-head');
    const title = make('span', 'ext-quota-pop-title', 'Plan use');
    const close = make('button', 'ghost small', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => {
      closePop();
      ring.focus();
    });
    head.append(title, close);
    const cards = make('div', 'ext-quota-cards');
    for (const provider of QUOTA) cards.append(cardFor(provider));
    const foot = make('p', 'ext-quota-foot', 'Refreshing Muse Code or Claude Code can send one very small request.');
    pop.replaceChildren(head, cards, foot);
  }

  function cardFor(provider) {
    const entry = entryFor(provider);
    const [mark, key] = MARKS[provider];
    const state = ['ok', 'warn', 'high'].includes(entry.state) ? entry.state : 'unknown';
    const sub = entry.windows?.length ? 'Plan limits' : 'Plan limits not shown';
    const card = MU.cardShell(mark, key, entry.label ?? labelOf(provider), sub, PILLS[state], state === 'ok');
    const body = make('div', 'card-body ext-quota-card-body');
    for (const w of entry.windows ?? []) {
      const row = make('div', 'ext-quota-win');
      const line = make('div', 'ext-quota-win-line');
      line.append(make('span', 'ext-quota-win-name', w.name), make('span', 'ext-quota-win-pct', `${w.usedPercent}% used`));
      const meter = document.createElement('meter');
      meter.setAttribute('min', '0');
      meter.setAttribute('max', '100');
      meter.setAttribute('low', '80');
      meter.setAttribute('high', '95');
      meter.setAttribute('optimum', '0');
      meter.setAttribute('value', String(w.usedPercent));
      meter.setAttribute('aria-label', `${w.name}, ${w.usedPercent}% used`);
      row.append(line, meter, make('p', 'ext-quota-win-reset', w.resetsAt ? `Resets ${when(w.resetsAt)}` : 'Reset time not reported'));
      body.append(row);
    }
    if (!(entry.windows ?? []).length) body.append(make('p', 'ext-quota-note', entry.note || NO_READING));
    body.append(make('p', 'ext-quota-asof', `As of ${asOf(entry.observedAt)}`));
    if (entry.windows?.length && entry.note) body.append(make('p', 'ext-quota-note', entry.note));
    if (!(provider === 'anthropic' && MU.providers?.anthropic?.route !== 'cli')) {
      const refresh = make('button', 'ghost small ext-quota-refresh', 'Refresh');
      refresh.type = 'button';
      refresh.disabled = busyRefresh;
      refresh.addEventListener('click', () => refreshOne(provider, refresh));
      body.append(refresh);
    }
    card.append(body);
    return card;
  }

  async function refreshOne(provider, button) {
    if (busyRefresh) return;
    busyRefresh = true;
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try {
      const entry = await MU.api('/api/quota/refresh', { provider, reason: 'user' });
      setEntry(provider, entry);
    } catch (err) {
      MU.toast(err.message || 'Plan use could not be refreshed.', 'bad');
    } finally {
      busyRefresh = false;
      if (popOpen) renderPop();
    }
  }

  function setEntry(provider, entry) {
    quota.providers = { ...(quota.providers ?? {}), [provider]: entry };
    quota.at = Date.now();
    paintRing();
    checkNear();
  }

  // ---------- reading the quota ----------

  async function loadQuota() {
    try {
      const res = await MU.request('/api/quota');
      if (!res.ok) return;
      const data = await res.json();
      quota.providers = data.providers ?? null;
      quota.at = typeof data.at === 'number' ? data.at : Date.now();
      paintRing();
      checkNear();
    } catch {
      // Offline or the server is busy: the ring keeps the last reading.
    }
  }

  // The first time a provider's ring turns high in this page session, the banner says how far it has got.
  function checkNear() {
    const provider = ringProvider(el.model.value);
    if (!provider || !quota.providers?.[provider]) return;
    const entry = quota.providers[provider];
    if (entry.state !== 'high' || near.has(provider) || !entry.windows?.length) return;
    near.add(provider);
    const top = entry.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    showBanner({ provider, near: `${labelOf(provider)} has used ${top.usedPercent}% of its ${top.name}.` });
  }

  // ---------- the limit banner and Draft handoff ----------

  // Models the page can hand to: ready ones (GET /api/models/info), other providers first, then by quota state (ok, warn, unknown, high).
  async function targetModels(fromProvider) {
    const now = Date.now();
    if (!infoCache || now - infoAt > 60_000) {
      const res = await MU.request('/api/models/info');
      if (!res.ok) throw new Error('The models could not be read.');
      infoCache = await res.json();
      infoAt = now;
    }
    const ready = infoCache.readiness ?? {};
    const models = (MU.catalog ?? []).filter(c => c.provider !== 'echo' && ready[c.provider]?.ready === true);
    return models
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        const same = (a.c.provider === fromProvider) - (b.c.provider === fromProvider);
        if (same) return same;
        const sa = RANK[entryFor(a.c.provider).state] ?? RANK.unknown;
        const sb = RANK[entryFor(b.c.provider).state] ?? RANK.unknown;
        return sa - sb || a.i - b.i;
      })
      .map(({ c }) => c);
  }

  async function fillTargets(select, fromProvider) {
    select.replaceChildren(make('option', '', 'Loading models…'));
    select.disabled = true;
    try {
      const models = await targetModels(fromProvider);
      select.replaceChildren();
      for (const c of models) {
        const ref = `${c.provider}:${c.id}`;
        const entry = QUOTA.includes(c.provider) ? quota.providers?.[c.provider] : null;
        const text = entry?.usedPercent !== null && entry?.usedPercent !== undefined ? `${c.label} · ${entry.usedPercent}% used` : c.label;
        const option = make('option', '', text);
        option.value = ref;
        select.append(option);
      }
      if (!models.length) {
        select.replaceChildren(make('option', '', 'No other model is ready'));
        select.disabled = true;
        return false;
      }
      select.disabled = false;
      return true;
    } catch {
      select.replaceChildren(make('option', '', 'Models could not be read'));
      select.disabled = true;
      return false;
    }
  }

  // The model that stopped: the selected one when it belongs to that provider, else the first catalog model of the provider.
  function stoppedRef(provider) {
    const selected = el.model.value;
    if (providerOf(selected) === provider) return selected;
    const hit = (MU.catalog ?? []).find(c => c.provider === provider);
    return hit ? `${hit.provider}:${hit.id}` : null;
  }

  // The banner holds one message at a time: a plan limit, a near limit, or the quiet line after a handoff.
  function showBanner({ provider, error = '', near: nearText = '' }) {
    const node = make('div', 'ext-quota-banner');
    node.setAttribute('role', 'status');
    node.dataset.kind = nearText ? 'near' : 'limit';
    const text = make('p', 'ext-quota-banner-text', nearText || `${labelOf(provider)} seems to have hit a plan limit. Hand the task to another agent?`);
    const row = make('div', 'ext-quota-banner-row');
    const pick = make('label', 'ext-quota-pick');
    pick.append(make('span', 'ext-quota-pick-label', 'Hand to'));
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Hand the task to');
    pick.append(select);
    const draft = make('button', 'primary small', 'Draft handoff');
    draft.type = 'button';
    draft.disabled = true;
    const dismiss = make('button', 'ghost small', 'Dismiss');
    dismiss.type = 'button';
    dismiss.addEventListener('click', () => hideBanner(node));
    draft.addEventListener('click', () => draftHandoff({ provider, error, select, draft, pick, text, node }));
    row.append(pick, draft, dismiss);
    node.append(text, row);
    fillTargets(select, provider).then(ok => {
      draft.disabled = !ok;
    });
    setBanner(node);
  }

  function setBanner(node) {
    if (banner) banner.handle.remove();
    banner = { node, handle: MU.slots.add('bannerSlot', 'ext-quota', node, 20) };
  }

  // Removes the banner only when it is the one the button belongs to, so an old Dismiss cannot hide a newer message.
  function hideBanner(node) {
    if (!banner || banner.node !== node) return;
    banner.handle.remove();
    banner = null;
  }

  async function draftHandoff({ provider, error, select, draft, pick, text, node }) {
    if (el.input.value.trim() !== '') {
      MU.toast('The composer has text. Clear it first.', 'bad');
      return;
    }
    const to = select.value;
    const from = stoppedRef(provider);
    const project = MU.state.activeProject;
    if (!to || !from || !project) {
      MU.toast('Choose a model to hand to first.', 'bad');
      return;
    }
    draft.disabled = true;
    try {
      const data = await MU.api('/api/handoff/draft', { project, from, to, error });
      // Only the composer and the model picker change. Nothing is sent: the person edits the note and presses Enter.
      el.input.value = data.text;
      el.input.dispatchEvent(new Event('input', { bubbles: true }));
      el.model.value = to;
      el.model.dispatchEvent(new Event('change'));
      el.input.focus();
      MU.toast('Handoff drafted. Edit it, then press Enter.');
      // The quiet line: the next model starts from the chat so far, not from this session.
      text.textContent = `${data.toLabel} starts from the chat so far. Its own session does not carry over.`;
      node.dataset.kind = 'done';
      pick.remove();
      draft.remove();
    } catch (err) {
      MU.toast(err.message || 'The handoff could not be drafted.', 'bad');
      draft.disabled = false;
    }
  }

  // A limit error or notice: find the provider it names, refresh its reading (within the server's limit), and show the banner.
  function onLimit(node, text) {
    const message = text.trim();
    const named = SPEAKERS.find(([name]) => message.startsWith(name));
    const provider = named ? named[1] : (newestProviderBefore(node) ?? providerOf(el.model.value));
    if (QUOTA.includes(provider)) {
      MU.api('/api/quota/refresh', { provider, reason: 'limit-error' })
        .then(entry => setEntry(provider, entry))
        .catch(() => {});
    }
    showBanner({ provider, error: message });
  }

  // The provider of the newest assistant reply before a node in the chat, or null.
  function newestProviderBefore(node) {
    let found = null;
    for (const turn of el.chat.querySelectorAll('.turn.assistant[data-p]')) {
      if (turn === node || node.contains(turn)) continue;
      if (turn.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) found = turn.dataset.p || null;
    }
    return found;
  }

  function limitText(turn) {
    const body = turn.querySelector('.turn-body');
    return ((body ? body.textContent : turn.textContent) || '').trim();
  }

  // A redraw of the whole chat adds its stream again (renderChat), so the limit messages in it are new nodes; those already handled are
  // skipped by their text. A message that arrives on its own is handled once, as before.
  function scanAdded(root) {
    if (!(root instanceof Element)) return;
    const redraw = root.classList.contains('stream');
    const turns = root.matches('.turn.system') ? [root] : [...root.querySelectorAll('.turn.system')];
    for (const turn of turns) {
      if (seenNodes.has(turn)) continue;
      seenNodes.add(turn);
      const text = limitText(turn);
      if (!LIMIT_RE.test(text) || (redraw && limitSeen.has(text))) continue;
      limitSeen.add(text);
      onLimit(turn, text);
    }
  }

  // ---------- wiring ----------

  // The ring goes right after the model picker's label, inside the composer bar.
  const pickLabel = el.model.closest('label');
  if (pickLabel) pickLabel.after(ringWrap);

  ring.addEventListener('click', () => {
    if (popOpen) closePop();
    else openPop();
  });
  // Escape closes the pop-up from anywhere while it is open (its own buttons re-draw and lose focus), and it is the topmost layer.
  document.addEventListener('keydown', event => {
    if (popOpen && event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      closePop();
      ring.focus();
    }
  }, true);
  document.addEventListener('pointerdown', event => {
    if (popOpen && !ringWrap.contains(event.target)) closePop();
  }, true);

  el.model.addEventListener('change', () => {
    syncRing();
    checkNear();
  });

  // Limit errors arrive as chat turns; only the turns added from now on are read (history was read by the page at load).
  if (el.chat) {
    // The history on the page now is read as seen, so it stays quiet (B-100).
    for (const turn of el.chat.querySelectorAll('.turn.system')) {
      const text = limitText(turn);
      if (LIMIT_RE.test(text)) limitSeen.add(text);
    }
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) scanAdded(node);
      }
    }).observe(el.chat, { childList: true, subtree: true });
  }

  // A poll when a run ends: the send button loses its stop class.
  if (el.send) {
    new MutationObserver(records => {
      for (const record of records) {
        const was = (record.oldValue ?? '').split(/\s+/).includes('stop');
        if (was && !el.send.classList.contains('stop')) loadQuota();
      }
    }).observe(el.send, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  }

  setInterval(() => {
    if (document.visibilityState === 'visible') loadQuota();
  }, POLL_MS);
  setInterval(syncRing, TICK_MS);

  MU.events?.on?.('state', () => syncRing());
  MU.ready.then(() => {
    syncRing();
    loadQuota();
  });
})();
