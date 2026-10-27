// The demo replay (mob-10, wave 107; MOBILE-UI 6.18). The shell's demo mode (?demo=1) replays demo/session.json offline: runs, a waiting
// approval, a computer run with frames, a diff and an artifact picture. The Stop answers from the replay with the same ack shape the
// Bridge sends, and the approval card is answered in the replay. Nothing here reaches a computer, a channel or the store.
//
//   const replay = createReplay(sessionJson);
//   replay.view()                 plain data for the demo screens (no functions)
//   replay.decide(id, 'approve' | 'deny')   -> { ok, reason }
//   replay.stop()                 -> { ok, ack: { id, cancelled, drivesStopped, agentsStopped, cardsDenied } }
//   replay.reset()                the recorded session again

import { stopResultText } from '../stop.js';

const RUN_STATES = Object.freeze(['running', 'finished', 'failed', 'stopped']);

function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

// A picture from the session's own SVG text, as a data URI (img-src allows data:). Only the SVG is kept, never script.
export function pictureSrc(svg) {
  const text = String(svg ?? '');
  if (!/^\s*<svg[\s>]/.test(text) || /<script/i.test(text)) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}

export function createReplay(session) {
  const original = cloneDeep(session) ?? {};
  let state = cloneDeep(original);
  if (!Array.isArray(state.runs)) state.runs = [];
  if (!Array.isArray(state.approvals)) state.approvals = [];
  if (!Array.isArray(state.agents)) state.agents = [];
  if (!Array.isArray(state.artifacts)) state.artifacts = [];
  let stoppedCount = 0;

  const view = () => ({
    computer: { name: String(state.computer?.name ?? 'Demo computer'), desktopVersion: String(state.computer?.desktopVersion ?? '') },
    projects: cloneDeep(state.projects ?? []),
    runs: state.runs.map(r => ({ ...r, state: RUN_STATES.includes(r.state) ? r.state : 'finished' })),
    approvals: state.approvals.map(a => ({ ...a })),
    agents: state.agents.map(a => ({ ...a })),
    drive: state.computerRun ? { ...state.computerRun, frames: (state.computerRun.frames ?? []).map(f => ({ caption: String(f.caption ?? ''), src: pictureSrc(f.svg) })) } : null,
    diff: state.diff ? cloneDeep(state.diff) : null,
    artifacts: state.artifacts.map(a => ({ id: a.id, name: a.name, caption: a.caption ?? '', src: pictureSrc(a.svg) })),
    stoppedCount,
  });

  // The waiting approval a person answers. Approve lets its run go on; Deny ends the card (the run stays, as on the computer).
  function decide(id, decision) {
    const card = state.approvals.find(a => a.id === id);
    if (!card) return { ok: false, reason: 'unknown' };
    if (card.state !== 'waiting') return { ok: false, reason: 'not-waiting' };
    if (decision !== 'approve' && decision !== 'deny') return { ok: false, reason: 'decision' };
    card.state = decision === 'approve' ? 'approved' : 'denied';
    const run = state.runs.find(r => r.id === card.runId);
    if (run && run.waitingFor === 'approval') {
      delete run.waitingFor;
      if (decision === 'deny') run.state = 'finished';
    }
    return { ok: true, reason: null };
  }

  // Stop: every running run, the computer run, the agents and the waiting cards stop, and the counts are the answer.
  function stop() {
    const runs = state.runs.filter(r => r.state === 'running').length;
    const drives = state.computerRun && state.computerRun.state === 'driving' ? 1 : 0;
    const agents = state.agents.filter(a => a.state === 'running').length;
    const cards = state.approvals.filter(a => a.state === 'waiting').length;
    for (const r of state.runs) if (r.state === 'running') { r.state = 'stopped'; delete r.waitingFor; }
    for (const a of state.agents) if (a.state === 'running') a.state = 'stopped';
    if (state.computerRun && state.computerRun.state === 'driving') state.computerRun.state = 'stopped';
    for (const a of state.approvals) if (a.state === 'waiting') a.state = 'denied';
    stoppedCount += 1;
    const ack = { id: `demo-stop-${stoppedCount}`, cancelled: runs, drivesStopped: drives, agentsStopped: agents, cardsDenied: cards };
    return { ok: true, ack, text: stopResultText(ack, String(state.computer?.name ?? 'Demo computer')) };
  }

  function reset() {
    state = cloneDeep(original);
    if (!Array.isArray(state.runs)) state.runs = [];
    if (!Array.isArray(state.approvals)) state.approvals = [];
    if (!Array.isArray(state.agents)) state.agents = [];
    if (!Array.isArray(state.artifacts)) state.artifacts = [];
    stoppedCount = 0;
    return view();
  }

  return { view, decide, stop, reset };
}
