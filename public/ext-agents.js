// The Agents tab of the side pane (UI-ARCH sections 4 and 10). It lists the agents that run now in the project on screen as a tree by the
// model that asked for them (a nested agent sits under its parent), with Stop for one and Stop all, and the last 30 finished agents of
// this window with how each one ended. The list is read from GET /api/agents/live (lib/routes/agents-live.mjs) and kept current from the
// events channel ('agent' events, lib/agent-run.mjs) and from this window's run stream ('muse:stream'). The pane button carries the
// count: the agents waiting on you in amber, else the agents that have not ended, else the finished ones the tab has not shown yet.
// Nothing is kept in the browser. Text from the server (titles, model names, errors) is set with textContent only.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without the side pane there is nothing to attach to.
  if (!MuseUI || !MuseUI.pane || typeof MuseUI.api !== 'function') return;

  const TAB = 'agents';
  const TITLE = 'Agents';
  const FINISHED_MAX = 30;
  const TICK_MS = 1000;
  // The list is read again every second tick (2 s) while a run is going, the tab is on screen, or agents are known to be running.
  const POLL_EVERY = 2;
  // A Stop whose agent has not ended after this long is shown as it was (the server keeps running it, if it cannot stop).
  const STOP_WAIT_MS = 15000;

  // The words for how a finished agent ended (lib/agent-run.mjs stopped values).
  const STOP_WORDS = {
    timeout: 'Stopped at its time limit',
    idle: 'Stopped at its idle limit',
    steps: 'Stopped at its tool step limit',
    user: 'Stopped by you',
    parent: 'Stopped with the run',
    denied: 'Not started: you said no',
  };

  // The project the lists are for. rows: the agents that have not ended (id -> entry). finished: the ended ones, newest first.
  // unseen: how many ended since the tab was last on screen, the project changed, or Clear was pressed.
  let project = null;
  let rows = new Map();
  let finished = [];
  let unseen = 0;
  let loaded = false;
  let loadError = '';
  const stopping = new Set();
  let root = null;             // the element the sections are drawn in, while the tab's view exists
  let refs = new Map();        // id -> { word, rest, stop, r } for the running rows, so a tick changes only their text
  let headRefs = {};           // the header count and Stop all, patched in place
  let paintSig = '';
  let reqSeq = 0;
  let pollTick = 0;
  let refreshTimer = 0;

  const activeId = () => MuseUI.state.activeProject ?? null;
  const shown = () => Boolean(MuseUI.el?.pane) && !MuseUI.el.pane.hidden && MuseUI.pane.active() === TAB;

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  // m:ss, as the build card shows its clock.
  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // The money rule of ext-cost.js: 4 decimals under a cent, 3 under a dollar, else 2.
  function money(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    if (v === 0) return '$0.00';
    if (v < 0.01) return `$${v.toFixed(4)}`;
    if (v < 1) return `$${v.toFixed(3)}`;
    return `$${v.toFixed(2)}`;
  }

  const steps = n => `${n} ${n === 1 ? 'step' : 'steps'}`;

  // A running entry, from the server's list or the events channel. learnedAt is when this window heard of it (0 for the server's list).
  function entryOf(e, learnedAt) {
    return {
      id: String(e.id),
      parentId: e.parentId ?? null,
      parentLabel: e.parentLabel ?? '',
      role: e.role ?? '',
      callerLabel: e.callerLabel ?? '',
      seat: e.seat ?? null,
      taskId: e.taskId ?? null,
      agent: e.agent ?? '',
      label: e.label || e.agent || 'Agent',
      kind: e.kind === 'edit' ? 'edit' : 'read',
      model: e.model ?? '',
      modelLabel: e.modelLabel ?? '',
      title: e.title || 'Agent',
      startedAt: Number.isFinite(Number(e.startedAt)) ? Number(e.startedAt) : Date.now(),
      turns: Number(e.turns) || 0,
      state: e.state || 'queued',
      why: e.why ?? null,
      inside: e.inside || 'plenum',
      stoppable: e.stoppable !== false,
      learnedAt,
    };
  }

  // A running entry from this window's run stream (agent-start). The stream does not name the parent reliably, so the list
  // (or the channel's entry) gives the tree; this is only the first look until the next answer.
  function startOf(ev) {
    return entryOf({
      id: ev.id,
      role: ev.role,
      callerLabel: ev.caller?.label ?? '',
      seat: ev.caller?.seat ?? null,
      agent: ev.agent,
      label: ev.label,
      kind: ev.kind,
      model: ev.model,
      modelLabel: ev.modelLabel,
      title: ev.title,
      startedAt: ev.startedAt,
      state: ev.state || 'running',
      inside: ev.inside,
      stoppable: ev.inside !== 'claude-cli',
    }, Date.now());
  }

  // An agent that ended: the done event's fields (ok, error, stopped, elapsedMs, turns, cost) on top of what the row knew.
  function endedOf(e, prev) {
    const r = entryOf({ ...(prev ?? {}), ...e }, 0);
    return {
      ...r,
      ok: e.ok !== false,
      error: typeof e.error === 'string' ? e.error : '',
      stopped: typeof e.stopped === 'string' ? e.stopped : '',
      elapsedMs: Number.isFinite(Number(e.elapsedMs)) ? Number(e.elapsedMs) : Math.max(0, Date.now() - r.startedAt),
      turns: Number(e.turns ?? prev?.turns) || 0,
      cost: typeof e.cost === 'number' && Number.isFinite(e.cost) ? e.cost : null,
    };
  }

  // Who asked for the agent, in words. A nested agent names its parent.
  function callerText(r) {
    if (r.parentId && r.parentLabel) return r.parentLabel;
    switch (r.role) {
      case 'chat':
        return `Chat (${r.callerLabel || 'the model'})`;
      case 'build':
        return r.taskId ? `Build task ${r.taskId}` : 'Build';
      case 'council':
        return `Council seat ${r.callerLabel || r.seat || ''}`.trim();
      case 'moderator':
        return 'Moderator';
      case 'relay':
        return `Relay hop ${r.callerLabel || ''}`.trim();
      case 'compare':
        return `Quick compare column ${r.seat ?? r.callerLabel ?? ''}`.trim();
      case 'pipeline':
        return `Pipeline step ${r.seat ?? r.callerLabel ?? ''}`.trim();
      default:
        return r.callerLabel || 'a model';
    }
  }

  function stateWord(r) {
    if (r.state === 'approval') return 'Waiting for your approval';
    if (r.state === 'queued') return r.why === 'scope' ? 'Waiting: another agent is editing the same files' : 'Waiting for a free slot';
    if (r.inside === 'claude-cli') return 'Running inside Claude Code';
    return 'Running';
  }

  // The part of a running row's meta line after its state word: model, m:ss and steps.
  const restOf = r => ` · ${[r.modelLabel, clock(Date.now() - r.startedAt), steps(r.turns)].filter(Boolean).join(' · ')}`;

  const pillOf = r => make('span', r.kind === 'edit' ? 'pill warn' : 'pill', r.label);

  function countText(live) {
    if (!live.length) return 'No agents running';
    const running = live.filter(r => r.state === 'running').length;
    const waiting = live.length - running;
    return waiting ? `${running} running · ${waiting} waiting` : `${running} running`;
  }

  // ---------- the lists ----------

  function sortedRows() {
    return [...rows.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  function upsert(r) {
    // An event that arrives after the agent ended changes nothing.
    if (finished.some(f => f.id === r.id)) return;
    rows.set(r.id, { ...(rows.get(r.id) ?? {}), ...r, learnedAt: Date.now() });
  }

  function finish(r) {
    rows.delete(r.id);
    stopping.delete(r.id);
    const again = finished.some(f => f.id === r.id);
    finished = [r, ...finished.filter(f => f.id !== r.id)].slice(0, FINISHED_MAX);
    if (!again) unseen = shown() ? 0 : unseen + 1;
  }

  // Replaces the running rows with the server's answer, keeping the ones this window heard of after the question was asked.
  function applyList(list, asked) {
    const next = new Map();
    for (const e of list) {
      if (!e || e.id == null) continue;
      const r = entryOf(e, 0);
      if (finished.some(f => f.id === r.id)) continue;
      next.set(r.id, r);
    }
    for (const [id, r] of rows) {
      if (!next.has(id) && r.learnedAt > asked && !finished.some(f => f.id === id)) next.set(id, r);
    }
    rows = next;
    for (const id of [...stopping]) if (!rows.has(id)) stopping.delete(id);
  }

  // The events channel: every change to an agent of the project on screen, with the whole entry.
  function onChannel(ev) {
    if (ev.project !== activeId()) return;
    checkProject();
    if (!ev.agent || ev.agent.id == null) return;
    const id = String(ev.agent.id);
    if (ev.action === 'done') finish(endedOf(ev.agent, rows.get(id)));
    else upsert(entryOf(ev.agent, Date.now()));
    changed();
  }

  // This window's run stream (the muse:stream event app.js sends for every event of a run it reads).
  function onStream(ev) {
    if (!ev || typeof ev.type !== 'string' || ev.type.indexOf('agent-') !== 0) return;
    checkProject();
    const id = String(ev.id ?? '');
    if (!id) return;
    if (ev.type === 'agent-start') {
      if (!rows.has(id) && !finished.some(f => f.id === id)) upsert(startOf(ev));
      scheduleRefresh();
    } else if (ev.type === 'agent-state') {
      const r = rows.get(id);
      if (r) {
        r.state = ev.state || r.state;
        r.why = ev.why ?? null;
        r.turns = Number(ev.turns) || r.turns;
      } else {
        scheduleRefresh();
      }
    } else if (ev.type === 'agent-done') {
      const prev = rows.get(id);
      if (prev) finish(endedOf(ev, prev));
      // A start the user said no to never reaches the channel, so its end is shown from the stream alone.
      else if (ev.stopped === 'denied' && !finished.some(f => f.id === id)) finish(endedOf(ev, null));
    }
    changed();
  }

  // ---------- reading the list ----------

  async function refresh() {
    const id = project;
    if (!id) {
      loaded = true;
      changed();
      return;
    }
    const seq = ++reqSeq;
    const asked = Date.now();
    try {
      const data = await MuseUI.api(`/api/agents/live?project=${encodeURIComponent(id)}`);
      if (seq !== reqSeq || id !== project) return;
      applyList(Array.isArray(data?.agents) ? data.agents : [], asked);
      loaded = true;
      loadError = '';
    } catch (err) {
      if (seq !== reqSeq || id !== project) return;
      loadError = err?.message || 'The server did not answer.';
    }
    changed();
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      refresh();
    }, 150);
  }

  // The project on screen changed: everything shown for the old one is dropped and the new one is read.
  function switchTo(id) {
    project = id;
    rows = new Map();
    finished = [];
    unseen = 0;
    loaded = false;
    loadError = '';
    stopping.clear();
    refs = new Map();
    paintSig = '';
    changed();
    if (id) refresh();
  }

  function checkProject() {
    const id = activeId();
    if (id !== project) switchTo(id);
  }

  // ---------- drawing ----------

  // The pane's title bar button: amber for agents waiting on you, else the agents that have not ended, else the unseen finished ones.
  function paintCount() {
    const live = [...rows.values()];
    const waiting = live.filter(r => r.state === 'approval').length;
    if (waiting) return MuseUI.pane.count(TAB, waiting, 'amber');
    const n = live.length || (!loaded ? Number(MuseUI.state.agentsRunning) || 0 : 0);
    if (n) return MuseUI.pane.count(TAB, n, '');
    if (unseen) return MuseUI.pane.count(TAB, unseen, '');
    return MuseUI.pane.count(TAB, null);
  }

  function changed() {
    paintCount();
    if (shown()) paintBody();
  }

  function section(title, nodes, action) {
    const sec = make('section', 'ext-agl-sec');
    const head = make('div', 'ext-agl-sechead');
    head.append(make('span', 'kicker', title));
    if (action) head.append(action);
    sec.append(head, ...nodes);
    return sec;
  }

  // Stop, or Stopping… while the stop is on its way; disabled for an agent that runs inside Claude Code.
  function fillStop(r, btn) {
    const busy = stopping.has(r.id);
    btn.textContent = busy ? 'Stopping…' : 'Stop';
    btn.disabled = busy || !r.stoppable;
    btn.title = r.stoppable ? '' : 'Runs inside Claude Code. Stop the whole reply with Esc.';
    btn.setAttribute('aria-label', `Stop ${r.title}`);
  }

  function runningRow(r, depth) {
    const row = make('div', depth > 0 ? 'ext-agl-row ext-agl-nested' : 'ext-agl-row');
    const line = make('div', 'ext-agl-line');
    const stop = make('button', 'ghost small ext-agl-stop');
    stop.type = 'button';
    stop.addEventListener('click', () => stopOne(r.id));
    const word = make('span', r.state === 'approval' ? 'ext-agl-state warn' : 'ext-agl-state', stateWord(r));
    const rest = make('span', 'ext-agl-rest', restOf(r));
    const meta = make('div', 'ext-agl-meta');
    meta.append(word, rest);
    line.append(pillOf(r), make('strong', 'ext-agl-title', r.title), stop);
    row.append(line, meta, make('div', 'ext-agl-from', `from ${callerText(r)}`));
    refs.set(r.id, { word, rest, stop, r });
    fillStop(r, stop);
    return row;
  }

  // The running agents as a tree: each agent right after the one that started it, indented once per level.
  function treeRows(list) {
    const ids = new Set(list.map(r => r.id));
    const kids = new Map();
    const tops = [];
    for (const r of list) {
      if (r.parentId && r.parentId !== r.id && ids.has(r.parentId)) {
        if (!kids.has(r.parentId)) kids.set(r.parentId, []);
        kids.get(r.parentId).push(r);
      } else {
        tops.push(r);
      }
    }
    const out = [];
    const seen = new Set();
    const walk = (r, depth) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      out.push(runningRow(r, depth));
      for (const k of kids.get(r.id) ?? []) walk(k, depth + 1);
    };
    for (const r of tops) walk(r, 0);
    return out;
  }

  function finishedRow(f) {
    const row = make('div', 'ext-agl-row ext-agl-done');
    const line = make('div', 'ext-agl-line');
    line.append(pillOf(f), make('strong', 'ext-agl-title', f.title));
    const outcome = f.stopped ? (STOP_WORDS[f.stopped] || 'Stopped') : f.ok ? 'Done' : 'Failed';
    const tone = f.stopped ? '' : f.ok ? ' ok' : ' bad';
    const parts = [clock(f.elapsedMs), steps(f.turns)];
    if (f.cost != null) parts.push(money(f.cost));
    const meta = make('div', 'ext-agl-meta');
    meta.append(make('span', `ext-agl-state${tone}`, outcome), make('span', 'ext-agl-rest', ` · ${parts.join(' · ')}`));
    row.append(line, meta);
    if (!f.ok && !f.stopped && f.error) row.append(make('div', 'ext-agl-error-line', f.error));
    return row;
  }

  function sections() {
    const out = [];
    const live = sortedRows();
    const head = make('div', 'ext-agl-head');
    const count = make('span', 'ext-agl-count', countText(live));
    const all = make('button', 'ghost small ext-agl-stop-all', 'Stop all');
    all.type = 'button';
    all.disabled = live.length === 0;
    all.addEventListener('click', stopAll);
    head.append(count, all);
    headRefs = { count, all };
    out.push(head);

    if (loadError) {
      const err = make('div', 'ext-agl-error');
      err.append(make('span', '', `Could not read the running agents: ${loadError}`));
      const again = make('button', 'ghost small', 'Try again');
      again.type = 'button';
      again.addEventListener('click', () => {
        loadError = '';
        refresh();
      });
      err.append(again);
      out.push(err);
    } else if (!loaded) {
      const wait = make('p', 'ext-agl-wait');
      wait.append(make('span', 'spinner'), 'Reading the running agents…');
      out.push(wait);
    }

    if (live.length) out.push(section('Running', treeRows(live)));

    if (finished.length) {
      const clear = make('button', 'ghost small ext-agl-clear', 'Clear');
      clear.type = 'button';
      clear.addEventListener('click', clearFinished);
      out.push(section('Finished', finished.map(finishedRow), clear));
    }

    if (loaded && !loadError && !live.length && !finished.length) {
      const empty = make('div', 'ext-agl-empty');
      empty.append(make('p', 'ext-agl-text', 'No agents are running. A model starts one with its delegate tool, and /build starts one per task.'));
      const settings = make('button', 'ghost small', 'Agent settings');
      settings.type = 'button';
      settings.addEventListener('click', () => MuseUI.openAgents?.());
      empty.append(settings);
      out.push(empty);
    }
    return out;
  }

  // The shape of the body: which rows there are, in what order and under whom, and the finished ones. The words that move while an
  // agent runs (its state, steps and clock) are patched in place by patchRows, so a step does not rebuild the list under a focused Stop.
  function signature() {
    return JSON.stringify([
      sortedRows().map(r => [r.id, r.parentId, r.title, r.label, r.kind, r.role, r.callerLabel, r.taskId, r.parentLabel, r.stoppable, r.seat]),
      finished.map(f => [f.id, f.ok, f.stopped, f.error, f.turns, f.elapsedMs, f.cost]),
      loaded,
      loadError,
      project,
    ]);
  }

  function paintBody() {
    if (!root || !root.isConnected) return;
    const sig = signature();
    if (sig === paintSig) {
      patchRows();
      return;
    }
    paintSig = sig;
    refs = new Map();
    root.replaceChildren(...sections());
    patchRows();
  }

  // Changes the text that moves while an agent runs: the count, each row's state word, steps and clock, and its Stop button.
  function patchRows() {
    if (headRefs.count) headRefs.count.textContent = countText(sortedRows());
    if (headRefs.all) headRefs.all.disabled = rows.size === 0;
    for (const [id, ref] of refs) {
      const r = rows.get(id);
      if (!r) continue;
      ref.word.textContent = stopping.has(id) ? 'Stopping…' : stateWord(r);
      ref.word.className = r.state === 'approval' && !stopping.has(id) ? 'ext-agl-state warn' : 'ext-agl-state';
      ref.rest.textContent = restOf(r);
      fillStop(r, ref.stop);
    }
  }

  // ---------- actions ----------

  async function stopOne(id) {
    const pid = project;
    if (!pid || stopping.has(id)) return;
    stopping.add(id);
    patchRows();
    try {
      await MuseUI.api('/api/agents/stop', { project: pid, id });
    } catch (err) {
      stopping.delete(id);
      MuseUI.toast(err?.message || 'The agent could not be stopped.', 'bad');
      patchRows();
      refresh();
      return;
    }
    // The row leaves the list when its agent-done arrives on the channel. A stop that never ends is shown as it was.
    setTimeout(() => {
      if (stopping.delete(id)) {
        patchRows();
        refresh();
      }
    }, STOP_WAIT_MS);
  }

  async function stopAll() {
    const pid = project;
    if (!pid || !rows.size) return;
    const yes = await MuseUI.confirm({
      title: 'Stop all agents?',
      body: 'Stop every running agent in this project? The models that asked are told each one was stopped.',
      action: 'Stop all',
      tone: 'danger',
      focusCancel: true,
    });
    if (!yes) return;
    try {
      const data = await MuseUI.api('/api/agents/stop', { project: pid, id: 'all' });
      const n = Number(data?.stopped) || 0;
      MuseUI.toast(n ? `Stopped ${n} ${n === 1 ? 'agent' : 'agents'}.` : 'Nothing was stopped. An agent inside Claude Code stops with Esc.');
    } catch (err) {
      MuseUI.toast(err?.message || 'The agents could not be stopped.', 'bad');
    }
    refresh();
  }

  function clearFinished() {
    finished = [];
    unseen = 0;
    changed();
  }

  // ---------- wiring ----------

  MuseUI.pane.register({
    id: TAB,
    title: TITLE,
    icon: 'sparkle',
    order: 40,
    titleButton: true,
    render: body => {
      root = make('div', 'ext-agl');
      body.replaceChildren(root);
      paintSig = '';
      paintBody();
    },
    onShow: () => {
      // Opening the tab marks the finished agents as seen.
      unseen = 0;
      paintCount();
      paintBody();
      refresh();
    },
    onClose: () => {
      root = null;
      refs = new Map();
      paintSig = '';
    },
  });

  // The stream and the channel. The state event carries the server's count for the project (publicState.agentsRunning); when it
  // differs from what this window holds, the list is read again.
  window.addEventListener('muse:stream', e => onStream(e.detail));
  window.addEventListener('plenum:event', e => {
    const ev = e.detail;
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'agent') {
      onChannel(ev);
    } else if (ev.type === 'state' || ev.type === 'hello') {
      checkProject();
      const n = Number(MuseUI.state.agentsRunning);
      if (project && Number.isFinite(n) && n !== rows.size) scheduleRefresh();
      changed();
    }
  });

  // Every second: the clocks and Stop buttons of the rows on screen, and every second poll the list while it matters.
  setInterval(() => {
    if (root && root.isConnected && shown()) patchRows();
    pollTick += 1;
    if (pollTick % POLL_EVERY === 0 && (MuseUI.state.running || rows.size > 0 || shown())) refresh();
  }, TICK_MS);

  // The entry points: /agents running opens the tab; the /agents command can stop everything in the project.
  MuseUI.openAgentsLive = () => MuseUI.pane.open(TAB);
  MuseUI.stopAgents = async () => {
    const pid = activeId();
    if (!pid) return 0;
    const data = await MuseUI.api('/api/agents/stop', { project: pid, id: 'all' });
    refresh();
    return Number(data?.stopped) || 0;
  };

  checkProject();
  paintCount();
})();
