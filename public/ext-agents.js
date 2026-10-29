// The Agents tab of the side pane (UI-ARCH sections 4 and 10): the Agents board. Three sections:
//   Waiting for you: every approval card waiting in any project, one open at a time (Open card), drawn with the chat's own card
//                    (MuseUI.approvalEl, public/app.js) and answered from here.
//   Running:         every run in progress, in every project, as Project · Thread, its model, its clock and its last step, with the
//                    agents of the project on screen nested under its run. Each run has Stop (POST /api/cancel).
//   Finished:        the last 30 runs (MuseUI.board, public/ext-board.js) and the last 30 finished agents of this window.
// The runs and cards come from MuseUI.board (fed by GET /api/activity and the 'activity' events, lib/activity.mjs). Without that
// store the tab shows the agents only, as it did before the board. The agents list is read from GET /api/agents/live
// (lib/routes/agents-live.mjs) and kept current from the events channel ('agent' events, lib/agent-run.mjs) and from this window's
// run stream ('muse:stream'). The pane button carries the count: the cards waiting on you in amber, else the runs in progress, else
// the finished ones the tab has not shown yet. Nothing is kept in the browser. Text from the server (titles, names, models, errors,
// approval summaries) is set with textContent only.
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

  // The words for how a run ended (lib/activity.mjs status values).
  const RUN_WORDS = { done: 'Done', error: 'Error', stopped: 'Stopped', 'cut-off': 'Cut off', 'timed-out': 'Timed out' };

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
  // The board: scope -> { state, meta, step } for the run rows on screen, patched in place like the agent rows.
  let runRefs = new Map();
  // The one approval card open on the board (its id), and the element built for it. The element is kept while the card waits, so the
  // keys, the countdown and any reason typed into it survive a repaint.
  let expanded = '';
  let cardEl = null;
  let cardId = '';

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

  // The head's words count what the pane lists: the agents, the board's runs and the cards that wait on the person.
  // A run that waits on a card is counted once, as waiting (the sidebar does the same), and a queued agent is listed under Running, so it is
  // counted as running (B-13, B-14). The board's cards already include the agents' own waiting cards, so with a board those are counted there.
  function countText(live, board) {
    const waitingScopes = new Set((board?.approvals ?? []).map(c => c.scope));
    const runsOn = board ? board.runs.filter(r => !waitingScopes.has(r.scope)).length : 0;
    const agentsOn = live.filter(r => r.state !== 'approval').length;
    const asking = live.filter(r => r.state === 'approval').length;
    const running = runsOn + agentsOn;
    const waiting = board ? board.approvals.length : asking;
    if (!running && !waiting) return 'Nothing is running.';
    return waiting ? `${running} running · ${waiting} waiting` : `${running} running`;
  }

  // Stop all is enabled while anything runs or waits, in this project or on the board (every project's runs are stopped by it).
  function anyLive(live, board) {
    return live.length > 0 || (board ? board.runs.length + board.approvals.length : 0) > 0 || Boolean(MuseUI.state.running) || Number(MuseUI.state.agentsRunning) > 0;
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

  // The board's store (public/ext-board.js) as a copy, or null while the board is not there. view() says whether it has been read.
  function boardView() {
    const b = MuseUI.board;
    if (!b || typeof b.view !== 'function') return null;
    try {
      return b.view();
    } catch {
      return null;
    }
  }

  // The pane's title bar button: amber for what waits on you (agents and board cards), else the runs in progress (the agents that have
  // not ended when there is no board), else the unseen finished ones.
  function paintCount() {
    const live = [...rows.values()];
    const board = boardView();
    const waiting = board ? board.approvals.length : live.filter(r => r.state === 'approval').length;
    if (waiting) return MuseUI.pane.count(TAB, waiting, 'amber');
    const n = board ? board.runs.length : (live.length || (!loaded ? Number(MuseUI.state.agentsRunning) || 0 : 0));
    if (n) return MuseUI.pane.count(TAB, n, '');
    const unseenRuns = board ? board.recent.filter(r => !board.isSeen(r)).length : 0;
    if (unseen || unseenRuns) return MuseUI.pane.count(TAB, unseen + unseenRuns, '');
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
    // The Stop names the agent and the project it runs in (the project on screen, which is where its rows are listed; P-30).
    const name = (MuseUI.state.projects ?? []).find(p => p.id === project)?.name ?? '';
    btn.setAttribute('aria-label', name ? `Stop ${r.title} in ${name}` : `Stop ${r.title}`);
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
    const board = boardView();
    // A card that was answered or ended is no longer open.
    if (expanded && !(board?.approvals ?? []).some(c => c.approvalId === expanded)) expanded = '';
    const head = make('div', 'ext-agl-head');
    const count = make('span', 'ext-agl-count', countText(live, board));
    const all = make('button', 'ghost small ext-agl-stop-all', 'Stop all');
    all.type = 'button';
    all.disabled = !anyLive(live, board);
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

    // The board's cards that wait, then the runs of every project with the agents of the project on screen under their run.
    if (board && board.approvals.length) out.push(section(`Waiting for you (${board.approvals.length})`, board.approvals.map(waitingRow)));
    if (board) {
      if (board.runs.length || live.length) out.push(section('Running', runningNodes(board, live)));
    } else if (live.length) {
      out.push(section('Running', treeRows(live)));
    }

    // The last 30 runs of the board, then the finished agents this window has seen (Clear empties the agents' part only).
    const finishedNodes = board ? board.recent.map(runEndedRow) : [];
    finishedNodes.push(...finished.map(finishedRow));
    if (finishedNodes.length) {
      let clear = null;
      if (finished.length) {
        clear = make('button', 'ghost small ext-agl-clear', 'Clear');
        clear.type = 'button';
        clear.addEventListener('click', clearFinished);
      }
      out.push(section('Finished', finishedNodes, clear));
    }

    const boardBusy = Boolean(board && (board.runs.length || board.approvals.length || board.recent.length));
    if (loaded && !loadError && !live.length && !finished.length && !boardBusy) {
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

  // ---------- the board's rows (public/ext-board.js) ----------

  const KEY_DELAY_MS = 400; // the card's keys count only this long after it takes the focus (approvalEl, public/app.js)
  const clockOfDay = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const runClock = run => clock((run.endedAt ?? Date.now()) - (run.startedAt ?? Date.now()));
  const stepLine = run => (run.step ? `Last step: ${run.step.name} ${run.step.summary}`.trim() : 'No step yet');
  const runStateOf = (run, board) => ((board?.approvals ?? []).some(c => c.scope === run.scope) ? 'Waiting for you' : 'Running');
  // The phone that acted in a run says so: via <device> (DECISIONS 68). The name comes from the phone list, never the id.
  const viaOf = run => (run.via ? `via ${MuseUI.phoneName?.(run.via) || 'a phone'}` : '');
  const runMetaText = (run, board) => [runStateOf(run, board), run.modelLabel, runClock(run), viaOf(run)].filter(Boolean).join(' · ');
  const titleOf = r => `${r.projectName || 'Project'} · ${r.threadName || 'Main'}`;

  function openProjectButton(scope) {
    const open = make('button', 'ghost small ext-board-open', 'Open project');
    open.type = 'button';
    open.addEventListener('click', () => MuseUI.board?.openScope?.(scope));
    return open;
  }

  // A run in progress: Project · Thread, then its state, model and clock, its last step, and Open project and Stop.
  function runRow(run, board) {
    const row = make('div', 'ext-board-run');
    const line = make('div', 'ext-board-run-line');
    const stop = make('button', 'ghost small ext-board-stop', 'Stop');
    stop.type = 'button';
    stop.setAttribute('aria-label', `Stop the run in ${titleOf(run)}`);
    stop.addEventListener('click', () => stopRun(run));
    line.append(make('strong', 'ext-board-run-title', titleOf(run)), openProjectButton(run.scope), stop);
    const meta = make('div', 'ext-board-run-meta', runMetaText(run, board));
    const step = make('div', 'ext-board-run-step', stepLine(run));
    row.append(line, meta, step);
    runRefs.set(run.scope, { meta, step });
    return row;
  }

  // The runs in progress of every project. The agents of the project on screen sit in a block under its first run.
  function runningNodes(board, live) {
    const out = [];
    let nested = false;
    const agents = () => {
      const wrap = make('div', 'ext-board-agents');
      wrap.append(...treeRows(live));
      return wrap;
    };
    for (const run of board.runs) {
      out.push(runRow(run, board));
      if (!nested && live.length && run.projectId === project) {
        nested = true;
        out.push(agents());
      }
    }
    if (!nested && live.length) out.push(agents());
    return out;
  }

  // A finished run: Project · Thread, how it ended, its model and clock, and the error when it failed.
  function runEndedRow(run) {
    const row = make('div', 'ext-board-run is-ended');
    const line = make('div', 'ext-board-run-line');
    line.append(make('strong', 'ext-board-run-title', titleOf(run)), openProjectButton(run.scope));
    row.append(line, make('div', 'ext-board-run-meta', [RUN_WORDS[run.status] ?? 'Done', run.modelLabel, runClock(run), viaOf(run)].filter(Boolean).join(' · ')));
    if (run.error) row.append(make('div', 'ext-board-run-error', run.error));
    return row;
  }

  // A card waiting on the user: its project, thread, model and the summary. Open card expands it (one at a time).
  function waitingRow(c) {
    const isOpen = expanded === c.approvalId;
    const row = make('div', isOpen ? 'ext-board-wait is-open' : 'ext-board-wait');
    const line = make('div', 'ext-board-run-line');
    line.append(make('span', 'pill warn', 'Waiting for you'), make('strong', 'ext-board-run-title', titleOf(c)));
    const toggle = make('button', 'ghost small ext-board-open-card', isOpen ? 'Close card' : 'Open card');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    toggle.addEventListener('click', () => toggleCard(c.approvalId));
    row.append(line, make('div', 'ext-board-run-step', String(c.summary ?? '').slice(0, 160)), toggle);
    if (isOpen) {
      // The model is left out when the run has none (a card raised before its model was known), rather than shown as a stand-in word.
      const ctx = make('div', 'ext-board-context', [titleOf(c), c.modelLabel].filter(Boolean).join(' · '));
      ctx.append(make('div', 'ext-board-started', `Started ${clockOfDay(c.at ?? Date.now())}`));
      row.append(ctx, cardFor(c));
    }
    return row;
  }

  // The approval card, built by the chat's own builder (MuseUI.approvalEl). Kept while the same card stays open.
  function cardFor(c) {
    if (cardEl && cardId === c.approvalId) return cardEl;
    cardId = c.approvalId;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    cardEl = typeof MuseUI.approvalEl === 'function'
      ? MuseUI.approvalEl({ ...c, shownAt: c.at, keysFrom: now + KEY_DELAY_MS }, { source: 'board' })
      : make('div', 'ext-board-note', 'The approval card did not load (public/app.js).');
    return cardEl;
  }

  // Opens or closes a card. The open card takes the focus once it is drawn, and its keys count after the usual short delay.
  function toggleCard(id) {
    expanded = expanded === id ? '' : id;
    cardEl = null;
    cardId = '';
    paintSig = '';
    changed();
    const node = cardEl;
    if (expanded && node && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => node.focus?.({ preventScroll: true }));
  }

  // The runs that are not model replies, by kind, and the word the pane uses for them. A restore, a rewind and a merge have no model to stop (B-16).
  const NON_REPLY_WORDS = { restore: 'restore', rewind: 'rewind', 'worktree-merge': 'merge' };

  // Stops the run of a project after a confirmation. The model is stopped and its agents stop with it.
  async function stopRun(run) {
    const word = NON_REPLY_WORDS[run.kind];
    const yes = await MuseUI.confirm({
      title: 'Stop this run?',
      body: word
        ? `Stop this ${word} in ${run.projectName || 'this project'}? It stops, and a card it waits on is denied. Files it has already changed stay as they are.`
        : `Stop the run in ${run.projectName || 'this project'}? The model that is running is stopped, and its agents stop with it. Files it has already changed stay as they are.`,
      action: 'Stop run',
      tone: 'danger',
      focusCancel: true,
    });
    if (!yes) return;
    try {
      // A run of another thread names its scope, so Stop ends that thread's run and not Main's or the active thread's.
      await MuseUI.stopRun(run.projectId ?? run.scope, run.projectId && run.scope && run.scope !== run.projectId ? run.scope : undefined);
    } catch (err) {
      MuseUI.toast(err?.message || 'The run could not be stopped.', 'bad');
    }
  }

  // The shape of the body: which rows there are, in what order and under whom, and the finished ones. The words that move while an
  // agent runs (its state, steps and clock) are patched in place by patchRows, so a step does not rebuild the list under a focused Stop.
  function signature() {
    const board = boardView();
    return JSON.stringify([
      sortedRows().map(r => [r.id, r.parentId, r.title, r.label, r.kind, r.role, r.callerLabel, r.taskId, r.parentLabel, r.stoppable, r.seat]),
      finished.map(f => [f.id, f.ok, f.stopped, f.error, f.turns, f.elapsedMs, f.cost]),
      loaded,
      loadError,
      project,
      // The board's shape: which runs, cards and ended runs there are, and which card is open. Their clocks and steps are patched in place.
      board ? [board.runs.map(r => [r.scope, r.projectId, r.projectName, r.threadName]), board.approvals.map(c => [c.approvalId, c.projectName, c.threadName, c.summary]), board.recent.map(r => [r.scope, r.endedAt, r.status, r.error]), expanded] : null,
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
    runRefs = new Map();
    // Drawing the list again moves the open card out of the page and back, which drops the focus. A control inside the card (the
    // reason box, Approve, Deny) gets the focus back, with its caret; the card itself never does, because its own Y and N would then
    // answer what the person is typing. A card that arrives in another project must not take a key press away either.
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const inCard = Boolean(cardEl && active && active !== cardEl && cardEl.contains?.(active));
    const caret = inCard && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    root.replaceChildren(...sections());
    if (inCard && typeof active.focus === 'function') {
      active.focus({ preventScroll: true });
      if (caret) {
        try { active.setSelectionRange(caret[0], caret[1], caret[2] ?? 'none'); } catch { /* a control without a caret keeps no selection */ }
      }
    }
    patchRows();
  }

  // Changes the text that moves while an agent runs: the count, each row's state word, steps and clock, and its Stop button.
  function patchRows() {
    const board = boardView();
    const live = sortedRows();
    if (headRefs.count) headRefs.count.textContent = countText(live, board);
    if (headRefs.all) headRefs.all.disabled = !anyLive(live, board);
    for (const [id, ref] of refs) {
      const r = rows.get(id);
      if (!r) continue;
      ref.word.textContent = stopping.has(id) ? 'Stopping…' : stateWord(r);
      ref.word.className = r.state === 'approval' && !stopping.has(id) ? 'ext-agl-state warn' : 'ext-agl-state';
      ref.rest.textContent = restOf(r);
      fillStop(r, ref.stop);
    }
    if (runRefs.size) {
      for (const [scope, ref] of runRefs) {
        const run = (board?.runs ?? []).find(r => r.scope === scope);
        if (!run) continue;
        ref.meta.textContent = runMetaText(run, board);
        ref.step.textContent = stepLine(run);
      }
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

  // The same route as the phone's Stop and the desktop's Stop everything (POST /api/stop-all): every reply, agent and computer or browser
  // run in every project, and the cards they wait on are denied.
  async function stopAll() {
    const yes = await MuseUI.confirm({
      title: 'Stop everything?',
      body: 'Every reply, agent and computer or browser run stops, in every project, and the cards they wait on are denied. Files already changed stay as they are.',
      action: 'Stop all',
      tone: 'danger',
      focusCancel: true,
    });
    if (!yes) return;
    // The runs that are not replies are counted before the stop, so the server's count of cancelled runs does not pass them off as replies (B-16).
    const others = (boardView()?.runs ?? []).filter(r => NON_REPLY_WORDS[r.kind]).length;
    try {
      const d = await MuseUI.api('/api/stop-all', {});
      const words = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      const replies = Math.max(0, (Number(d?.cancelled) || 0) - others);
      const drives = Number(d?.drivesStopped) || 0;
      const agents = Number(d?.agentsStopped) || 0;
      const cards = Number(d?.cardsDenied) || 0;
      if (!replies && !drives && !agents && !cards && !others) MuseUI.toast('Nothing was running.');
      else MuseUI.toast(`Stopped. ${words(replies, 'reply', 'replies')}, ${words(drives, 'computer or browser run', 'computer or browser runs')}, ${words(agents, 'agent', 'agents')}${others ? `, ${words(others, 'restore, rewind or merge run', 'restore, rewind or merge runs')}` : ''}. ${words(cards, 'waiting card', 'waiting cards')} denied.`);
    } catch (err) {
      MuseUI.toast(err?.message || 'Stop did not answer.', 'bad');
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
      runRefs = new Map();
      cardEl = null;
      cardId = '';
      paintSig = '';
    },
  });

  // The stream and the channel. The state event carries the server's count for the project (publicState.agentsRunning); when it
  // differs from what this window holds, the list is read again.
  window.addEventListener('muse:stream', e => onStream(e.detail));
  // The board's store changed (public/ext-board.js): runs, cards and finished runs are drawn again.
  window.addEventListener('plenum:board', () => changed());
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
