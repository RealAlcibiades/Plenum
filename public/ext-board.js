// ext-board: the Agents board's data and the Running now list in the sidebar (UI-ARCH sections 2, 4 and 11). The board itself is the
// Agents tab of the side pane, drawn by public/ext-agents.js from the store below.
//
// The store holds what lib/activity.mjs holds: every run in progress, the last ended runs and every approval card waiting, in every
// project. It is filled from GET /api/activity and kept current from the 'activity' events on the events channel (plenum:event).
// A snapshot carries the seq of the last change it includes; events that arrived while it was read are applied after it, so nothing
// is lost and nothing is applied twice. A reconnect (the 'hello' event) reads the snapshot again.
//
// Unread: a finished run shows a dot until its project is opened (or the run ends while its project is on screen). That is kept in
// this window's localStorage ('plenum.board.seen': { [scope]: endedAt }), read and written in try/catch.
//
// Text from the server (project and thread names, models, steps, approval summaries) is set with textContent only.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI || typeof MuseUI.api !== 'function') return;

  const SEEN_KEY = 'plenum.board.seen';
  const SIDE_MAX = 5;
  const RECENT_MAX = 30;
  const TICK_MS = 5000;
  const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
  const MOD = MAC ? 'Cmd' : 'Ctrl';

  // The status words of a run (lib/activity.mjs status values).
  const ENDED_WORDS = { done: 'Done', error: 'Error', stopped: 'Stopped', 'cut-off': 'Cut off', 'timed-out': 'Timed out' };

  // ---------- the store ----------

  const runs = new Map();      // scope -> the run in progress
  const recent = [];           // the ended runs, newest first
  const approvals = new Map(); // approval id -> the card waiting
  let seq = 0;                 // the last change applied
  let loaded = false;          // a snapshot has been read at least once
  let gen = 0;                 // which snapshot read is the newest
  let buffer = null;           // the events that arrived while the newest read is on its way
  let seen = readSeen();

  function readSeen() {
    try {
      const value = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter(([, at]) => Number.isFinite(at)));
    } catch {
      return {};
    }
  }

  function writeSeen() {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch {
      // The marks are kept for this page only.
    }
  }

  const isSeen = run => Number.isFinite(seen[run.scope]) && seen[run.scope] >= (run.endedAt ?? 0);

  // Marks the finished runs of a project as seen. Called when the project is opened, and when one of its runs ends while it is open.
  function markSeen(scope) {
    let changed = false;
    for (const run of recent) {
      if (run.scope !== scope || isSeen(run)) continue;
      seen[scope] = Math.max(seen[scope] ?? 0, run.endedAt ?? 0);
      changed = true;
    }
    if (changed) {
      writeSeen();
      notify();
    }
  }

  function trimRecent() {
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
  }

  // One change in the order the server made it. Each change carries the whole run or card, so applying it twice changes nothing.
  function apply(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (Number.isFinite(ev.seq) && ev.seq > seq) seq = ev.seq;
    switch (ev.op) {
      case 'run-start':
      case 'run-step':
        if (ev.run && typeof ev.run.scope === 'string') runs.set(ev.run.scope, ev.run);
        return;
      case 'run-end':
        if (!ev.run || typeof ev.run.scope !== 'string') return;
        runs.delete(ev.run.scope);
        recent.unshift(ev.run);
        trimRecent();
        // A run that ends while its project is on screen has been seen.
        if (ev.run.scope === MuseUI.state.activeProject) seen[ev.run.scope] = Math.max(seen[ev.run.scope] ?? 0, ev.run.endedAt ?? 0);
        return;
      case 'approval-add':
        if (ev.card && typeof ev.card.approvalId === 'string') approvals.set(ev.card.approvalId, ev.card);
        return;
      case 'approval-done':
        approvals.delete(String(ev.approvalId));
        return;
      default:
    }
  }

  // Replaces the store with a snapshot.
  function load(snap) {
    runs.clear();
    for (const run of Array.isArray(snap?.runs) ? snap.runs : []) if (run && typeof run.scope === 'string') runs.set(run.scope, run);
    recent.length = 0;
    for (const run of Array.isArray(snap?.recent) ? snap.recent : []) if (run) recent.push(run);
    trimRecent();
    approvals.clear();
    for (const card of Array.isArray(snap?.approvals) ? snap.approvals : []) if (card && typeof card.approvalId === 'string') approvals.set(card.approvalId, card);
    seq = Number.isFinite(snap?.seq) ? snap.seq : 0;
    loaded = true;
  }

  // Reads the snapshot. A read that a newer one has overtaken is dropped. The events that came in while it was on its way and
  // are newer than it are applied after it.
  async function sync() {
    const mine = ++gen;
    const meanwhile = [];
    buffer = meanwhile;
    try {
      const snap = await MuseUI.api('/api/activity');
      if (mine !== gen) return;
      load(snap);
      for (const ev of meanwhile) if ((ev.seq ?? 0) > seq) apply(ev);
      notify();
    } catch {
      // The board keeps what it has. The next reconnect or change reads it again.
    } finally {
      if (mine === gen) buffer = null;
    }
  }

  function onActivity(ev) {
    apply(ev);
    if (buffer) buffer.push(ev);
    if (ev.op === 'run-end' && ev.run && ev.run.scope === MuseUI.state.activeProject) markSeen(ev.run.scope);
    notify();
  }

  // ---------- the rows of the sidebar ----------

  const clock = ms => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const stepText = run => (run.step ? `${run.step.name} ${run.step.summary}`.trim().slice(0, 60) : '');

  // Waiting cards first (oldest first), then the runs in progress, then the finished runs nobody has opened, newest first.
  // A run that waits on a card is listed once, as waiting.
  function sideRows() {
    const waiting = [...approvals.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const waitingScopes = new Set(waiting.map(c => c.scope));
    const rows = [];
    for (const c of waiting) {
      rows.push({ key: `w:${c.approvalId}`, scope: c.scope, kind: 'wait', tone: 'amber', status: 'Waiting for you', projectName: c.projectName, threadName: c.threadName, model: c.modelLabel, step: '', clock: clock(Date.now() - (c.at ?? Date.now())), unseen: false });
    }
    for (const r of [...runs.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
      if (waitingScopes.has(r.scope)) continue;
      rows.push({ key: `r:${r.scope}`, scope: r.scope, kind: 'run', tone: '', status: `Running ${Math.floor(Math.max(0, Date.now() - (r.startedAt ?? Date.now())) / 60000)}m`, projectName: r.projectName, threadName: r.threadName, model: r.modelLabel, step: stepText(r), clock: clock(Date.now() - (r.startedAt ?? Date.now())), unseen: false, via: r.via ?? '' });
    }
    for (const r of recent) {
      if (isSeen(r)) continue;
      rows.push({ key: `d:${r.scope}:${r.endedAt}`, scope: r.scope, kind: 'done', tone: r.status === 'error' ? 'red' : '', status: ENDED_WORDS[r.status] ?? 'Done', projectName: r.projectName, threadName: r.threadName, model: r.modelLabel, step: stepText(r), clock: clock((r.endedAt ?? 0) - (r.startedAt ?? 0)), unseen: true, via: r.via ?? '' });
    }
    return rows;
  }

  // ---------- the sidebar section ----------

  let side = null;
  let sideHead = null;
  let sideBadge = null;
  let sideCount = null;
  let sideWord = null;
  let sideList = null;
  let sideMore = null;
  let sideSig = '';

  const el = (tag, cls = '', text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };

  // Switches to the row's project the way a click on it does (the project list's own button), and marks its runs seen.
  function openScope(scope) {
    const index = (MuseUI.state.projects ?? []).findIndex(p => p.id === scope);
    if (index >= 0) {
      const items = [...document.querySelectorAll('#projects .proj-item')];
      items[index]?.click();
    }
    markSeen(scope);
  }

  function openBoard() {
    if (typeof MuseUI.openAgentsLive === 'function') MuseUI.openAgentsLive();
    return true;
  }

  function rowEl(row) {
    const b = el('button', row.kind === 'wait' ? 'ext-board-row is-wait' : 'ext-board-row');
    b.type = 'button';
    const top = el('span', 'ext-board-row-top');
    top.append(el('span', row.tone ? `pill ext-board-pill ${row.tone}` : 'pill ext-board-pill', row.status));
    if (row.unseen) top.append(el('span', 'ext-board-dot'));
    b.append(top, el('span', 'ext-board-row-name', `${row.projectName || 'Project'} · ${row.threadName || 'Main'}`));
    // A run that a phone acted in says so: via <device> (DECISIONS 68). The name comes from the phone list, never the id.
    const meta = [row.model, row.step, row.clock].filter(Boolean).join(' · ');
    if (meta) b.append(el('span', 'ext-board-row-meta', meta));
    const via = row.via ? `via ${MuseUI.phoneName?.(row.via) || 'a phone'}` : '';
    if (via) b.append(el('span', 'ext-board-row-meta', via));
    b.setAttribute('aria-label', `${row.status}: ${row.projectName || 'Project'} · ${row.threadName || 'Main'}${via ? `, ${via}` : ''}`);
    b.addEventListener('click', () => openScope(row.scope));
    return b;
  }

  function buildSide() {
    const anchor = document.getElementById('projects');
    if (!anchor || side) return;
    side = el('section', 'ext-board-side');
    side.setAttribute('aria-label', 'Running now');
    side.hidden = true;
    // The head is a button that opens the Agents pane. On the icon strip (56 px) it is the only part that shows: the badge's number.
    sideHead = el('button', 'ext-board-side-head');
    sideHead.type = 'button';
    sideHead.title = 'Open the Agents pane';
    sideHead.append(el('span', 'kicker', 'Running now'));
    sideBadge = el('span', 'badge');
    sideBadge.hidden = true;
    sideCount = el('span', 'ext-board-count-num');
    sideWord = el('span', 'ext-board-count-word');
    sideBadge.append(sideCount, sideWord);
    sideHead.append(sideBadge);
    sideHead.addEventListener('click', openBoard);
    sideList = el('div', 'ext-board-side-list');
    sideMore = el('button', 'ghost small ext-board-side-more', `Show all (${MOD}+Shift+B)`);
    sideMore.type = 'button';
    sideMore.addEventListener('click', openBoard);
    side.append(sideHead, sideList, sideMore);
    anchor.after(side);
  }

  function renderSide() {
    if (!side) buildSide();
    if (!side) return;
    const rows = sideRows();
    const waiting = approvals.size;
    const running = runs.size;
    const sig = JSON.stringify([rows.map(r => [r.key, r.status, r.projectName, r.threadName, r.model, r.step, r.clock, r.via, r.via ? MuseUI.phoneName?.(r.via) ?? '' : '']), waiting]);
    side.hidden = rows.length === 0;
    // The badge shows the cards waiting (amber) when there are any, else the runs in progress.
    sideBadge.hidden = waiting === 0 && running === 0;
    if (waiting > 0) sideBadge.dataset.tone = 'amber';
    else delete sideBadge.dataset.tone;
    sideCount.textContent = String(waiting > 0 ? waiting : running);
    sideWord.textContent = waiting > 0 ? ' waiting' : ' running';
    sideHead.setAttribute('aria-label', waiting > 0 ? `Running now: ${waiting} waiting for you. Open the Agents pane` : `Running now: ${running} running. Open the Agents pane`);
    sideMore.hidden = rows.length === 0;
    // The list is redrawn only when its text changed, so a row that has focus keeps it.
    if (sig === sideSig) return;
    sideSig = sig;
    sideList.replaceChildren(...rows.slice(0, SIDE_MAX).map(rowEl));
  }

  // Every change: the sidebar is drawn and the board (ext-agents.js) is told. The board reads the store through MuseUI.board.
  function notify() {
    renderSide();
    window.dispatchEvent(new CustomEvent('plenum:board'));
  }

  // ---------- events, keys and the entry points ----------

  window.addEventListener('plenum:event', e => {
    const ev = e.detail;
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'activity') {
      onActivity(ev);
    } else if (ev.type === 'hello') {
      // A (re)connected window reads the whole board again.
      sync();
    } else if (ev.type === 'state') {
      // A project that is on screen has its finished runs seen.
      if (MuseUI.state.activeProject) markSeen(MuseUI.state.activeProject);
    }
  });

  // Ctrl+Shift+B is handled once, by the shell's key handler in public/app.js: it toggles the Agents pane, and it works from the message
  // box but not from other text fields (B-6). This file only lists the shortcut; a second handler here would re-open the pane that
  // the shell had just hidden.
  window.MuseShortcutRows = window.MuseShortcutRows || [];
  window.MuseShortcutRows.push({ keys: [MOD, 'Shift', 'B'], action: 'Open the Agents board.' });

  // What the Agents pane draws from. view() is a copy, so the pane never changes the store.
  MuseUI.board = {
    view: () => ({
      loaded,
      runs: [...runs.values()].map(r => ({ ...r })).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
      recent: recent.map(r => ({ ...r })),
      approvals: [...approvals.values()].map(c => ({ ...c })).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
      isSeen: run => isSeen(run),
    }),
    openScope,
    markSeen,
    reload: sync,
  };

  buildSide();
  // The first read waits for the token (MuseUI.ready); the events channel's hello event reads it again on every connection.
  Promise.resolve(MuseUI.ready).then(() => sync());
  // The clocks and the minutes of the rows move while a run goes; the sidebar is redrawn every few seconds.
  setInterval(renderSide, TICK_MS);
})();
