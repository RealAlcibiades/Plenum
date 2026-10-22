// The run controller: everything between a model's "click here" and the mouse actually moving. One computer run exists for one chat
// message. The person starts it (Start in the Computer panel is the consent; a run the model starts itself shows a start card first),
// and from then on every action passes this file. The adapters (Claude, OpenAI, Gemini) only translate their provider's calls into
// canonical actions and hand them to run.step(); the checks, the cards, the limits, the log and the step rows are all here, so a run
// behaves the same whichever model drives it.
//
//   createComputerRun({ project, settings, task, ref, modelName, bridge, approve, closeApproval, emit, out, signal,
//                       budget: { project, log, ref }, mode, covers, consent })
//     project, settings   the project record and the result of policy.normalizeRunSettings
//     approve(card, handle) -> Promise<boolean>   the server's approval requester; handle receives { approvalId }
//     closeApproval(approvalId, reason)           answers a waiting card as denied and tells the page to remove it
//     emit(event)         the turn's stream; out  the turn's { tools: [] }, where each act step is recorded
//     mode, covers        the project's approval mode and { computer, browser } (Approve all coverage)
//     consent             'drawer' when the person pressed Start in the Computer panel (no start card), 'card' otherwise
//   -> the run handle:
//     run.tools            { toolset: true } for Claude; run.systemText the text added to the system prompt
//     run.maxRequests      the most model requests a provider loop may make; run.over the reason the run is over, or null
//     await run.preflight()          throws a 400/409 when a run cannot start now, before anything is stored or shown
//     await run.start()              -> { ok: true } | { ok: false, declined?, message }
//     await run.step(canonical)      -> { ok, output, blocks?, over? }
//     await run.confirm({ action, why, from, code, category })   -> { ok, approved, summary, output }
//     await run.handOver({ reason })                              -> { ok, summary, output }
//     run.budgetCheck(reports)       -> null, or { over: true, reason: 'budget', text }
//     await run.finish(reason)       -> the summary the stored message keeps
//     run.frame, run.drive, run.allow, run.settings, run.id, run.summary()
//
// The order of a step, and why (the numbers match the design in COMPUTERUSE.json computer-gate):
//   1 wait at the drive's checkpoint (a pause holds the call; Stop rejects it) and let the mouse come to rest after a resume;
//   2 a run past its action or time limit answers the limit text for every later call;
//   3 pacing, so actions are at least paceMs apart;
//   4 looking (screenshot, zoom, cursor, wait) never needs a card;
//   5 an action needs a screenshot taken after the latest resume, or the screen may have changed under it;
//   6 the program in front (and the program under each point) must be allowed: Plenum, elevated windows and BUILTIN_DENY never are;
//   7 the person using the mouse or keyboard pauses the run and nothing is injected;
//   8 typed text is checked for card, bank and id numbers, and a password field is never typed into;
//   9 "ask before every action" shows a card per action;
//  10 after a card the mouse must rest and the window that was in front is brought back, or the action is refused;
//  11 the point is converted from the model's pixels to the screen's and injected;
//  12 the step is counted, logged and shown as one step row.
import { DriveStopped, canStart, hotkeyReady, startDrive } from '../drive.mjs';
import { summarizeUsage } from '../pricing.mjs';
import { budgetOf } from '../projects.mjs';
import { spendOf } from '../budget.mjs';
import { cleanReason, coveredByApproveAll } from '../tools.mjs';
import { stopAccelerator, stopKeyLabel } from '../platform/computer.mjs';
import * as store from '../store.mjs';
import * as defaultLogs from './log.mjs';
import {
  COMPUTER_SYSTEM, STEP_LABELS, actionName, appAllowed, appName, capAction, categoryOfSafety, checkTyped, describeAction, exeKey, limitText,
  pointsOfAction, retentionOf, sentSizeOf, startCardDetail, stopWord, zoomRegion,
} from './policy.mjs';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));

// What the model reads when a step is refused. They are written to the model, in the order a person would give the instruction.
export const TEXT = Object.freeze({
  noFrame: 'Take a screenshot first.',
  stale: 'Take a screenshot before acting: the run was paused, so the screen may have changed.',
  pausedByInput: 'The user paused the run by using the mouse or keyboard. When it resumes, take a screenshot before acting.',
  elevated: 'The window in front belongs to an elevated program, which Plenum cannot control. Ask the user to do this step.',
  notFront: 'The allowed window is not in front and could not be brought to the front. Ask the user to click it.',
  notAllowed: 'That app is not allowed. Stay inside the allowed apps or ask the user.',
  neverAllowed: 'That program is a password manager or a system prompt, which the model never uses. Ask the user to do this step.',
  ownWindow: 'That spot belongs to Plenum itself, which the model cannot use. Take a screenshot and choose another spot.',
  changed: 'The window changed while the card waited. Take a screenshot and try again.',
  secure: 'The focused field is a password field. Never type credentials; call hand_over so the user does it.',
  stopped: 'The run was stopped by the user.',
  idle: 'The run was stopped because it stayed paused too long.',
  outside: 'That point is outside the screenshot. Choose a point inside the picture you were given.',
  notAction: 'That is not a computer action.',
  notStarted: 'Computer use has not started.',
  confirmed: 'Confirmed by the user. Take a screenshot, then do exactly this once.',
  notConfirmed: 'The user did not confirm. Do not do it. Ask what they want instead.',
  resumed: 'The user pressed Resume. Take a screenshot before acting.',
  budget: 'Spend cap reached during the run.',
});

const SETTLE = Object.freeze({ restMs: 1000, pollMs: 100, maxMs: 10_000, tolerance: 3 });
const CARD_WAIT_NOTE = 'The run was stopped.';
const OUT_TOOLS_MAX = 400;
const NOT_COUNTED = new Set(['screenshot', 'zoom', 'cursor', 'wait', 'move']);

const clip = (text, n) => {
  const s = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const inRect = (p, r) => Boolean(r) && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
const imageBlock = png => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') } });
const mmss = ms => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;
const isPasteChord = keys => {
  const set = new Set((keys ?? []).map(k => String(k).toLowerCase()));
  return (set.has('v') && (set.has('ctrl') || set.has('super'))) || (set.has('insert') && set.has('shift'));
};
// The key names (besides a single character) that the desktop reads as a character: the space bar and the X keysym names of ASCII
// punctuation (desktop/computer/actions.cjs, KEYSYM_CHARS). A key or hold of one of these types a character as a letter does.
const CHARACTER_KEY_NAMES = new Set([
  'space', 'spacebar', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'apostrophe', 'parenleft', 'parenright',
  'asterisk', 'plus', 'comma', 'minus', 'period', 'slash', 'colon', 'semicolon', 'less', 'equal', 'greater', 'question', 'at',
  'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore', 'grave', 'braceleft', 'bar', 'braceright', 'asciitilde',
]);
const printableKey = keys => (keys ?? []).some(k => [...String(k)].length === 1 || CHARACTER_KEY_NAMES.has(String(k).trim().toLowerCase()));

export function createComputerRun(options = {}) {
  const {
    project, settings, task = '', ref = '', bridge, approve, closeApproval, emit = () => {}, out = null, signal, budget = null,
    mode = 'ask', covers = {}, consent = 'card', platform = process.platform, logs = defaultLogs,
  } = options;
  if (!project || !settings || !bridge || typeof approve !== 'function') throw new TypeError('A computer run needs a project, settings, a bridge and a way to ask the person.');
  const modelName = options.modelName || ref || 'The model';
  const sleep = options.sleep ?? sleepFor;
  const settle = { ...SETTLE, ...(options.settle ?? {}) };
  const windowScope = settings.scope === 'window';
  const allow = settings.allow.map(a => ({ ...a }));
  const view = { allow, unknownApps: settings.unknownApps };
  const label = windowScope ? appName(settings.targetWindow.exe) : `display ${settings.display}`;
  const sentSize = sentSizeOf(settings.size, settings.maxEdge);

  let drive = null;
  let log = null;
  let frame = null;
  let started = false;
  let finished = false;
  let declined = false;
  let over = null;
  let lastInjectAt = 0;
  let stepSeq = 0;
  let logSeq = 0;
  let acted = 0;
  let overlayShown = false;
  let lastOverlay = null;
  let pausedAt = 0;
  let lastState = 'running';
  let lastFg = null;
  let result = null;
  const cards = new Set();
  const ownExes = new Set();
  let chain = Promise.resolve();
  const serial = fn => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  // ---------- small helpers ----------

  // Writes an event to the run log. Events from before the log exists (the start card) are kept and written when it opens.
  const early = [];
  const record = event => {
    if (log) log.event(event);
    else early.push({ ...event, at: Date.now() });
  };

  const notice = text => {
    try {
      emit({ type: 'notice', kind: 'computer', text });
    } catch {
      // A stream that is gone changes nothing for the run.
    }
    record({ kind: 'notice', text });
  };

  const covered = () => !settings.askAnyway && coveredByApproveAll({ mode, covers }, 'computer');
  const stepsOf = () => (settings.steps === null ? 'no limit' : String(settings.steps));
  const stepWords = () => `step ${(drive?.steps ?? 0) + 1}${settings.steps === null ? '' : ` of ${settings.steps}`}`;
  const appLine = fg => (fg ? `${appName(fg.exe)}${fg.title ? ` — ${clip(fg.title, 60)}` : ''}` : '');
  const stoppedResult = () => ({
    ok: false,
    over: true,
    output: drive?.stopReason === 'idle' ? TEXT.idle : TEXT.stopped,
  });

  const overlayArgs = state => ({
    show: true,
    displayId: settings.display,
    rect: windowScope ? settings.rect : null,
    state,
    model: modelName,
    label,
  });

  // Keeps the on-screen bar in step with the drive: running or paused. A stopped drive hides it in finish().
  function showOverlay(state) {
    if (!overlayShown || state === lastOverlay) return;
    lastOverlay = state;
    bridge.overlay(overlayArgs(state)).catch(() => {});
  }

  // Called by the drive on every change, including the first one, before startDrive has returned.
  function onDriveChange(s) {
    try {
      emit({ type: 'drive', drive: s });
    } catch {
      // The stream is gone; the run is still stoppable from the bar.
    }
    if (s.state === lastState) return;
    const was = lastState;
    lastState = s.state;
    if (s.state === 'stopped') {
      // Stop is terminal and immediate: the cards close, the keys are let go and the bar leaves the screen now, not when the model
      // has finished writing its report.
      closeWaitingCards(CARD_WAIT_NOTE);
      void quiesce(s.stopReason);
      return;
    }
    showOverlay(s.state === 'running' ? 'running' : 'paused');
    if (s.state === 'paused' && s.pausedBy !== 'card') {
      pausedAt = Date.now();
      record({ kind: 'pause', text: s.pausedBy === 'model' ? `Your turn: "${s.note}"` : s.pausedBy === 'input' ? 'Paused: you used the mouse or keyboard' : 'Paused by you', by: s.pausedBy });
    } else if (s.state === 'running' && was === 'paused' && pausedAt) {
      record({ kind: 'resume', text: `Resumed after ${mmss(Date.now() - pausedAt)}`, by: 'user' });
      pausedAt = 0;
    }
  }

  // Lets go of every key and button, hides the on-screen bar and, for any end but done, says in the chat why the model can no longer
  // act. Runs once; later calls get the same promise.
  let quiescing = null;
  function quiesce(reason) {
    if (!quiescing) {
      const tasks = [Promise.resolve().then(() => bridge.release()).catch(() => {})];
      if (overlayShown) {
        overlayShown = false;
        tasks.push(Promise.resolve().then(() => bridge.overlay({ show: false })).catch(() => {}));
      }
      quiescing = Promise.all(tasks);
      if (reason && String(reason).split(':')[0] !== 'done') {
        notice(`Computer use stopped: ${stopWord(reason)}. The model can no longer act; it reports what it did.`);
      }
    }
    return quiescing;
  }

  function closeWaitingCards(reason) {
    for (const id of [...cards]) {
      cards.delete(id);
      try {
        closeApproval?.(id, reason);
      } catch {
        // The card is already gone.
      }
    }
  }

  // Waits until the run is running and the mouse has come to rest after a resume. Rejects with DriveStopped.
  async function waitUntilRunning() {
    let settled = true;
    for (;;) {
      if (drive.state !== 'running') settled = false;
      await drive.checkpoint();
      if (!settled) {
        settled = true;
        await settleMouse();
        continue;
      }
      return;
    }
  }

  // After the person's hand comes off the mouse (Resume, Approve, a hand-over): poll the pointer every 100 ms until it has moved no
  // more than 3 px for a second, then read and discard the input flags so that click is not taken as a new pause. A pointer that
  // keeps moving for ten seconds pauses the run again.
  async function settleMouse() {
    const begin = Date.now();
    let anchor = await bridge.cursor();
    let restSince = Date.now();
    for (;;) {
      await sleep(settle.pollMs);
      if (drive.state === 'stopped') return;
      const now = await bridge.cursor();
      if (Math.abs(now.x - anchor.x) > settle.tolerance || Math.abs(now.y - anchor.y) > settle.tolerance) {
        anchor = now;
        restSince = Date.now();
      }
      if (Date.now() - restSince >= settle.restMs) break;
      if (Date.now() - begin >= settle.maxMs) {
        pauseForInput();
        return;
      }
    }
    await bridge.userInput();
  }

  function pauseForInput() {
    try {
      if (drive.state === 'running') drive.pause('input');
    } catch {
      // The run changed state at the same moment (stopped, or paused by the person); either way it is not running.
    }
  }

  // One approval card of this run. The drive is paused for its duration (so the time limit does not run down), Approve all answers it
  // at once when it covers computer cards and `always` is not set, and a stop closes it. -> { approved, reason, auto }
  async function showCard({ summary, detail, marker = null, always = false }) {
    if (!always && covered()) {
      record({ kind: 'card', text: summary, answer: 'approved', by: 'Approve all' });
      notice(`Approve all answered: ${clip(summary, 160)}`);
      return { approved: true, reason: '', auto: true };
    }
    // The drive is paused for the card. If the person paused it at the same moment, wait for their Resume and try again, so a card
    // is never shown over a run that is running.
    let paused = false;
    while (drive && !paused) {
      await waitUntilRunning();
      try {
        drive.pause('card');
        paused = true;
      } catch {
        if (drive.state === 'stopped') throw new DriveStopped(drive.stopReason);
      }
    }
    const card = { summary, detail, kind: 'computer' };
    if (frame && log) card.frame = { run: log.id, n: frame.n, w: frame.width, h: frame.height, ...(marker ? { marker } : {}) };
    const handle = {};
    let allowed = false;
    try {
      const pending = approve(card, handle);
      if (handle.approvalId) cards.add(handle.approvalId);
      try {
        allowed = (await pending) === true;
      } finally {
        if (handle.approvalId) cards.delete(handle.approvalId);
      }
    } catch {
      allowed = false;
    }
    const stopped = drive?.state === 'stopped';
    if (paused && drive.state === 'paused' && drive.pausedBy === 'card') {
      try {
        drive.resume('card');
      } catch {
        // Stopped at the same moment.
      }
    }
    const reason = cleanReason(card.reason);
    record({ kind: 'card', text: summary, answer: allowed ? 'approved' : 'denied', by: stopped ? 'stop' : 'you', ...(reason ? { text: `${summary} (${reason})` } : {}) });
    return { approved: allowed && !stopped, reason, auto: false, stopped };
  }

  // The mouse rests, the window that was in front before the card is brought back and must be in front again. -> { ok, output? }
  async function afterCard(prev) {
    await settleMouse();
    if (drive.state === 'stopped') throw new DriveStopped(drive.stopReason);
    if (drive.state !== 'running') return { ok: false, output: TEXT.pausedByInput };
    if (prev?.id !== undefined && !prev.own) await bridge.focus(prev.id).catch(() => {});
    if (!prev) return { ok: true };
    const now = await bridge.foreground();
    if (!now || String(now.id) !== String(prev.id)) return { ok: false, output: TEXT.changed };
    return { ok: true };
  }

  function logAction({ action, summary, ok, reason, point, fg }) {
    log?.action({ n: ++logSeq, action, summary, ok, reason, frame: frame?.n ?? null, point, app: appLine(fg ?? lastFg) });
  }

  // ---------- starting ----------

  async function preflight() {
    if (!bridge.available) throw httpError(400, 'Computer use needs the desktop app.');
    const probe = await bridge.probe();
    if (!probe?.supported) throw httpError(400, probe?.reason || 'Computer use is not available on this computer.');
    const refusal = canStart('computer', project.id);
    if (refusal) throw httpError(409, refusal);
    return probe;
  }

  async function start() {
    if (started) return { ok: true };
    started = true;
    try {
      await preflight();
    } catch (err) {
      finished = true;
      return { ok: false, message: err.message, status: err.status };
    }
    if (consent !== 'drawer') {
      const answer = await showCard({
        summary: `Start computer use: ${clip(task, 200)}`,
        detail: startCardDetail({ settings, modelName, keyLabel: stopKeyLabel(platform, stopAccelerator(platform, store.get()?.driveStopKey ?? null)), platform }),
      });
      if (!answer.approved) {
        declined = true;
        finished = true;
        notice('Computer use was not started.');
        return { ok: false, declined: true, message: 'Computer use was not started.' };
      }
    }
    try {
      drive = startDrive({
        kind: 'computer',
        projectId: project.id,
        label,
        limits: { steps: settings.steps, activeMs: settings.minutes * 60_000 },
        signal,
        onChange: onDriveChange,
      });
    } catch (err) {
      finished = true;
      return { ok: false, message: err.message, status: err.status };
    }
    try {
      await logs.prune(retentionOf(store.get()));
    } catch {
      // A log folder that cannot be cleaned does not stop the run.
    }
    try {
      log = await logs.openRunLog({ projectId: project.id, settings, model: modelName, task, maxFrameBytes: retentionOf(store.get()).maxBytes });
    } catch (err) {
      try {
        drive.stop('error');
      } catch {
        // Stopped at the same moment.
      }
      finished = true;
      return { ok: false, message: `The run log could not be created (${err?.code ?? 'error'}), so the run did not start.` };
    }
    for (const event of early.splice(0)) log.event(event);
    if (!settings.numberGuard) record({ kind: 'notice', text: 'Number guard off: card, bank and id numbers can be typed in this run.' });
    for (const c of Object.entries(settings.confirm).filter(([, on]) => !on)) record({ kind: 'notice', text: `Check off: ${c[0]}` });
    if (settings.askAnyway) record({ kind: 'notice', text: 'Approve all does not answer this run\'s cards.' });
    try {
      const list = await bridge.windows();
      for (const w of list) if (w.own) ownExes.add(exeKey(w.exe));
      // The person has just clicked Start in Plenum, so Plenum is in front: bring the window the run is about to use forward.
      if (windowScope) await bridge.focus(settings.targetWindow.id);
      else if (allow.length) {
        const first = list.find(w => !w.own && exeKey(w.exe) === exeKey(allow[0].exe));
        if (first) await bridge.focus(first.id);
      }
    } catch {
      // The first look at the screen shows whether the window is there.
    }
    try {
      const shown = await bridge.overlay(overlayArgs('running'));
      overlayShown = true;
      lastOverlay = 'running';
      if (shown?.ok === false) notice('The bar on the screen could not be shown. Use Stop in Plenum, or the stop key.');
    } catch {
      overlayShown = true;
      lastOverlay = 'running';
      notice('The bar on the screen could not be shown. Use Stop in Plenum, or the stop key.');
    }
    const hot = await hotkeyReady();
    if (!hot.ok && hot.reason !== 'no desktop app') {
      notice(`The stop key ${stopKeyLabel(platform, hot.accelerator ?? stopAccelerator(platform, null))} is taken by another program. Use Stop on the bar or the overlay.`);
    }
    return { ok: true };
  }

  // ---------- looking ----------

  // The window of a window-scope run must be the app in front when the model looks; a minimised window is restored.
  async function ensureTargetFront() {
    const fg = await bridge.foreground();
    if (!fg || exeKey(fg.exe) !== exeKey(settings.targetWindow.exe)) await bridge.focus(settings.targetWindow.id).catch(() => {});
  }

  async function lookScreenshot() {
    if (windowScope) await ensureTargetFront();
    const cap = await bridge.capture({ scope: settings.scope, target: settings.target, maxEdge: settings.maxEdge });
    if (cap.ok === false) {
      logAction({ action: 'screenshot', summary: '', ok: false, reason: cap.message });
      return { ok: false, output: cap.message };
    }
    const n = await log.frame(cap.png, { width: cap.width, height: cap.height });
    const physical = cap.physical && Number.isFinite(cap.physical.x) ? cap.physical : { x: 0, y: 0, width: cap.width, height: cap.height };
    const scale = cap.scale && cap.scale.x > 0 && cap.scale.y > 0 ? cap.scale : { x: physical.width / cap.width, y: physical.height / cap.height };
    frame = { n, width: cap.width, height: cap.height, scale, physical, resumes: drive.resumes };
    logAction({ action: 'screenshot', summary: `${cap.width}x${cap.height}`, ok: true });
    return { ok: true, output: 'OK', blocks: [imageBlock(cap.png)], frame: { n, width: cap.width, height: cap.height } };
  }

  async function lookZoom(action) {
    if (!frame) return { ok: false, output: TEXT.noFrame };
    const region = zoomRegion(action);
    if (!region) return { ok: false, output: 'A zoom needs a region: x0, y0, x1, y1 in the pixels of the last screenshot.' };
    if (windowScope) await ensureTargetFront();
    const zoomed = await bridge.zoom({ scope: settings.scope, target: settings.target, maxEdge: settings.maxEdge, frame, region });
    if (zoomed.ok === false) {
      logAction({ action: 'zoom', summary: describeAction(action, { platform }), ok: false, reason: zoomed.message });
      return { ok: false, output: zoomed.message };
    }
    logAction({ action: 'zoom', summary: describeAction(action, { platform }), ok: true });
    return { ok: true, output: 'OK', blocks: [imageBlock(zoomed.png)] };
  }

  async function lookCursor() {
    const at = await bridge.cursor();
    logAction({ action: 'cursor', summary: '', ok: true });
    if (!frame) return { ok: true, output: 'The pointer is on the screen. Take a screenshot to see where.' };
    const x = Math.round((at.x - frame.physical.x) / (frame.scale?.x || 1));
    const y = Math.round((at.y - frame.physical.y) / (frame.scale?.y || 1));
    const inside = x >= 0 && y >= 0 && x < frame.width && y < frame.height;
    return { ok: true, output: inside ? `The pointer is at ${x}, ${y}.` : 'The pointer is outside the picture you were given.' };
  }

  async function lookWait(action) {
    const end = Date.now() + action.ms;
    while (Date.now() < end && drive.state === 'running') await sleep(Math.min(200, Math.max(1, end - Date.now())));
    logAction({ action: 'wait', summary: describeAction(action, { platform }), ok: true });
    return { ok: true, output: 'OK' };
  }

  // ---------- acting ----------

  function toPhysical(point) {
    const sx = frame.scale?.x ?? 1;
    const sy = frame.scale?.y ?? 1;
    return { x: Math.round(frame.physical.x + point.x * sx), y: Math.round(frame.physical.y + point.y * sy) };
  }

  function convert(action) {
    const out = { ...action };
    if (Number.isFinite(action.x) && Number.isFinite(action.y)) Object.assign(out, toPhysical(action));
    if (action.kind === 'drag') {
      out.from = toPhysical(action.from);
      out.to = toPhysical(action.to);
    }
    return out;
  }

  // The card for a program that is not in the run's list. Approve adds it for this run only. -> { ok, output? }
  async function askAboutApp(info, marker, fg) {
    // Plenum itself is never a program a card can add.
    if (ownExes.has(exeKey(info.exe))) return { ok: false, output: TEXT.ownWindow };
    const exeName = String(info.exe ?? '').split(/[\\/]/).pop();
    const answer = await showCard({
      summary: `Allow ${appName(info.exe)} for this run?`,
      detail: `The model wants to act in "${clip(info.title || exeName, 80)}" (${exeName}), which is ${windowScope ? 'not the window you chose' : 'not in your list'}. Approve adds ${appName(info.exe)} for this run only.${windowScope ? ` The model sees only ${label}, so what it clicks may not be what it expects.` : ''}`,
      marker,
    });
    if (answer.stopped) throw new DriveStopped(drive.stopReason);
    if (!answer.approved) return { ok: false, output: TEXT.notAllowed + (answer.reason ? ` The user said: ${answer.reason}` : '') };
    allow.push({ id: String(info.id ?? ''), exe: String(info.exe ?? ''), title: String(info.title ?? '') });
    record({ kind: 'notice', text: `${appName(info.exe)} allowed for this run` });
    const after = await afterCard(fg);
    return after.ok ? { ok: true } : after;
  }

  // Judges the program in front, and then the program under each point of the action. -> { ok, output? }
  async function gateApps(action, sentPoints) {
    const marker = sentPoints[0] ? { x: Math.round(sentPoints[0].x), y: Math.round(sentPoints[0].y) } : null;
    let fg = await bridge.foreground();
    lastFg = fg;
    let verdict = appAllowed(fg, view);
    if (!verdict.ok && (verdict.why === 'no window is in front' || verdict.why === 'Plenum itself' || (verdict.why === 'not allowed' && windowScope && settings.unknownApps === 'refuse'))) {
      // Plenum in front (the person answered a card there), nothing in front, or another app in front in a run that refuses other apps:
      // bring the run's own window back once and look again.
      let bring = null;
      if (windowScope) bring = settings.targetWindow.id;
      else if (allow.length) {
        const list = await bridge.windows();
        bring = list.find(w => !w.own && exeKey(w.exe) === exeKey(allow[0].exe))?.id ?? null;
      }
      if (bring !== null) await bridge.focus(bring).catch(() => {});
      fg = await bridge.foreground();
      lastFg = fg;
      verdict = appAllowed(fg, view);
      if (!verdict.ok && verdict.why !== 'elevated' && verdict.why !== 'never allowed') return { ok: false, output: TEXT.notFront };
    }
    if (!verdict.ok) {
      if (verdict.why === 'elevated') {
        notice('The window in front belongs to an elevated program, which Plenum cannot control. Do that step yourself.');
        return { ok: false, output: TEXT.elevated };
      }
      if (verdict.why === 'never allowed') return { ok: false, output: TEXT.neverAllowed };
      if (verdict.why === 'not allowed') {
        if (settings.unknownApps === 'refuse') return { ok: false, output: TEXT.notAllowed };
        const asked = await askAboutApp(fg, marker, fg);
        if (!asked.ok) return asked;
      } else {
        return { ok: false, output: TEXT.notFront };
      }
    }
    // The program under each point (the stacking order is not known on every platform; then only the program in front is judged).
    if (sentPoints.length) {
      let stack = null;
      try {
        stack = await bridge.windows({ all: true });
      } catch {
        stack = null;
      }
      if (Array.isArray(stack)) {
        const seen = new Set([exeKey(fg?.exe)]);
        let listed = null;
        for (const sent of sentPoints) {
          const p = toPhysical(sent);
          const top = stack.find(w => inRect(p, w.bounds));
          if (!top) continue;
          const key = exeKey(top.exe);
          if (seen.has(key)) continue;
          seen.add(key);
          // The stacking order does not say which windows are Plenum's; the window list does.
          if (!ownExes.has(key)) {
            listed ??= await bridge.windows().catch(() => []);
            for (const w of listed) if (w.own) ownExes.add(exeKey(w.exe));
          }
          const judged = appAllowed({ exe: top.exe, own: ownExes.has(key), elevated: false }, view);
          if (judged.ok) continue;
          if (judged.why === 'Plenum itself') return { ok: false, output: TEXT.ownWindow };
          if (judged.why === 'never allowed') return { ok: false, output: TEXT.neverAllowed };
          if (settings.unknownApps === 'refuse') return { ok: false, output: TEXT.notAllowed };
          // The stacking order carries no titles; the window list does, and the card is easier to answer with one.
          const named = (listed ?? []).find(x => String(x.id) === String(top.id));
          const asked = await askAboutApp({ id: top.id, exe: top.exe, title: named?.title ?? '' }, marker, fg);
          if (!asked.ok) return asked;
        }
      }
    }
    return { ok: true, fg };
  }

  // The text checks and the password-field guard. -> { ok, output? }
  async function gateTyping(action) {
    if (action.kind === 'type') {
      const why = checkTyped(action.text, { numbers: settings.numberGuard });
      if (why) {
        const long = why.startsWith('is longer');
        return {
          ok: false,
          output: long ? `Not typed: the text ${why}. Type it in smaller parts.` : `Not typed: the text ${why}. Never type card or bank details; call hand_over so the user does it.`,
        };
      }
    }
    // A hold takes the same key names as a key and the operating system repeats a held character, so it types like a key does.
    const typesInto = action.kind === 'type' || ((action.kind === 'key' || action.kind === 'hold') && (printableKey(action.keys) || isPasteChord(action.keys)));
    if (typesInto && (await bridge.isSecureField()) === true) return { ok: false, output: TEXT.secure };
    return { ok: true };
  }

  async function userMoved() {
    const input = await bridge.userInput();
    if (!input.mouse && !input.keys) return false;
    pauseForInput();
    return true;
  }

  async function doAct(action, name) {
    const quiet = NOT_COUNTED.has(name);
    const summary = describeAction(action, { platform });
    const sentPoints = pointsOfAction(action);
    // 5: a screenshot taken after the latest resume (a pointer move only needs a screenshot to have been taken at all).
    if (!frame) return { ok: false, output: TEXT.noFrame };
    if (!quiet && frame.resumes !== drive.resumes) return { ok: false, output: TEXT.stale };
    for (const p of sentPoints) {
      if (!(p.x >= 0 && p.y >= 0 && p.x < frame.width && p.y < frame.height)) return { ok: false, output: TEXT.outside };
    }
    // 3: pacing.
    if (lastInjectAt) {
      const wait = settings.paceMs - (Date.now() - lastInjectAt);
      if (wait > 0) await sleep(wait);
    }
    // 7 (first look): the person's hand on the mouse or keyboard pauses the run before any card is shown.
    if (await userMoved()) {
      record({ kind: 'notice', text: 'The model\'s action was not sent: you were using the mouse or keyboard.' });
      return { ok: false, output: TEXT.pausedByInput };
    }
    const id = `cu-${++stepSeq}`;
    const rowName = `computer.${name}`;
    if (!quiet) emit({ type: 'tool', id, name: rowName, summary });
    const finishRow = res => {
      if (quiet) return res;
      emit({ type: 'tool_result', id, ok: res.ok, summary: res.ok ? 'OK' : clip(res.output, 300) });
      if (out?.tools && out.tools.length < OUT_TOOLS_MAX) out.tools.push({ name: rowName, summary, ok: res.ok, result: res.ok ? 'OK' : clip(res.output, 300) });
      return res;
    };
    const refuse = (output, extra = {}) => finishRow({ ok: false, output, ...extra });
    const note = (ok, reason) => logAction({ action: name, summary, ok, reason, point: sentPoints[0] ?? null });

    // 6.
    const gate = await gateApps(action, sentPoints);
    if (!gate.ok) {
      note(false, gate.output);
      return refuse(gate.output);
    }
    // 8.
    const typed = await gateTyping(action);
    if (!typed.ok) {
      note(false, typed.output);
      return refuse(typed.output);
    }
    // 9: ask before every action.
    if (settings.confirmEvery && !quiet) {
      const prev = gate.fg ?? (await bridge.foreground());
      const answer = await showCard({
        summary: `Allow this step: ${STEP_LABELS[name]} ${summary}`.trim(),
        detail: `In: ${prev ? appName(prev.exe) : 'an unknown app'} · ${stepWords()}`,
        marker: sentPoints[0] ? { x: Math.round(sentPoints[0].x), y: Math.round(sentPoints[0].y) } : null,
        always: true,
      });
      if (answer.stopped) throw new DriveStopped(drive.stopReason);
      if (!answer.approved) {
        const text = `The user did not allow this step. Do not repeat it. Ask what they want instead.${answer.reason ? ` The user said: ${answer.reason}` : ''}`;
        note(false, 'denied by user');
        return refuse(text);
      }
      const after = await afterCard(prev);
      if (!after.ok) {
        note(false, after.output);
        return refuse(after.output);
      }
    }
    // 7 (last look), then 11: convert and inject.
    if (await userMoved()) {
      record({ kind: 'notice', text: 'The model\'s action was not sent: you were using the mouse or keyboard.' });
      note(false, 'paused by user input');
      return refuse(TEXT.pausedByInput);
    }
    const sent = await bridge.input(convert(action));
    lastInjectAt = Date.now();
    if (sent.ok === false) {
      if (sent.reason === 'elevated') notice('The window in front belongs to an elevated program, which Plenum cannot control. Do that step yourself.');
      note(false, sent.message);
      return refuse(sent.message);
    }
    // 12.
    if (!quiet) {
      drive.tick();
      acted += 1;
    }
    note(true);
    return finishRow({ ok: true, output: 'OK' });
  }

  async function runStep(raw) {
    if (!started || !drive) return { ok: false, output: TEXT.notStarted };
    if (finished) return stoppedResult();
    const first = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    const name = actionName(first);
    if (!name) return { ok: false, output: TEXT.notAction };
    const action = capAction(first, frame);
    try {
      await waitUntilRunning();
      if (over) return { ok: false, over: true, output: over.text };
      if (drive.limitReached()) {
        over = { reason: 'limit', text: limitText(settings) };
        record({ kind: 'notice', text: over.text });
        return { ok: false, over: true, output: over.text };
      }
      switch (name) {
        case 'screenshot': return await lookScreenshot();
        case 'zoom': return await lookZoom(action);
        case 'cursor': return await lookCursor();
        case 'wait': return await lookWait(action);
        default: return await doAct(action, name);
      }
    } catch (err) {
      if (err instanceof DriveStopped) return stoppedResult();
      // The desktop did not answer, or refused in a way the backend does not describe. The model is told plainly and the log keeps it.
      const text = err?.status === 503 || err?.status === 504 ? 'The desktop app did not answer. Take a screenshot and try again.' : 'The computer step failed. Take a screenshot and try again.';
      record({ kind: 'notice', text: `A step failed: ${clip(err?.message, 160)}` });
      return { ok: false, output: text };
    }
  }

  // ---------- asking the person ----------

  async function confirm({ action = '', why = '', from = 'model', code, category } = {}) {
    return serial(async () => {
      if (!started || !drive) return { ok: false, approved: false, output: TEXT.notStarted };
      try {
        await waitUntilRunning();
        const source = from === 'openai' ? 'OpenAI says: ' : from === 'google' ? 'Google says: ' : 'The model says: ';
        const summary = `Confirm: ${clip(action, 200)}`;
        // A provider's own check whose kind the person switched off is acknowledged without a card; a confirm the model makes itself
        // is always honoured.
        if (from !== 'model') {
          const id = categoryOfSafety({ code, category, text: `${action} ${why}` });
          if (id && settings.confirm[id] === false) {
            record({ kind: 'card', text: summary, answer: 'acknowledged', by: 'your setting' });
            return { ok: true, approved: true, auto: true, summary: 'Acknowledged by your setting', output: 'Acknowledged by your setting.' };
          }
        }
        const prev = await bridge.foreground();
        const answer = await showCard({
          summary,
          detail: `${why ? `${source}${clip(why, 600)}\n` : ''}In: ${prev ? appName(prev.exe) : 'an unknown app'} · ${stepWords()}`,
        });
        if (answer.stopped) return { ...stoppedResult(), approved: false };
        if (!answer.auto) {
          await settleMouse();
          if (prev?.id !== undefined && !prev.own) await bridge.focus(prev.id).catch(() => {});
        }
        if (answer.approved) return { ok: true, approved: true, summary: answer.auto ? 'Approved by Approve all' : 'Confirmed by you', output: TEXT.confirmed };
        const tail = answer.reason ? ` The user said: ${answer.reason}` : '';
        return { ok: false, approved: false, denied: true, summary: answer.reason ? `Denied by user: ${answer.reason}` : 'Denied by user', output: TEXT.notConfirmed + tail };
      } catch (err) {
        if (err instanceof DriveStopped) return { ...stoppedResult(), approved: false };
        throw err;
      }
    });
  }

  async function handOver({ reason = '' } = {}) {
    return serial(async () => {
      if (!started || !drive) return { ok: false, output: TEXT.notStarted };
      try {
        await waitUntilRunning();
        const said = clip(reason, 120);
        try {
          drive.pause('model', said);
        } catch (err) {
          if (drive.state === 'stopped') throw new DriveStopped(drive.stopReason);
          throw err;
        }
        notice(`Your turn. The model asks: "${said}". Press Resume on the bar when you are done.`);
        record({ kind: 'handover', text: said, by: 'model' });
        await drive.checkpoint();
        await settleMouse();
        return { ok: true, summary: 'Your turn', output: TEXT.resumed };
      } catch (err) {
        if (err instanceof DriveStopped) return stoppedResult();
        throw err;
      }
    });
  }

  // ---------- the end ----------

  // Every five model requests the adapter passes the usage records so far. A project's spend cap ends the run when the run's cost
  // so far, added to what the project had already spent, reaches it.
  function budgetCheck(reports) {
    if (over) return over.reason === 'budget' ? { over: true, ...over } : null;
    const cap = budget?.project ? budgetOf(budget.project).capUsd : null;
    if (!cap) return null;
    const used = summarizeUsage(budget.ref ?? ref, reports, { billing: 'api' })?.cost?.dollars ?? 0;
    const before = spendOf(budget.project, budget.log ?? []).usd;
    if (before + used < cap) return null;
    over = { reason: 'budget', text: TEXT.budget };
    notice(TEXT.budget);
    return { over: true, ...over };
  }

  let finishing = null;
  const finish = reason => {
    finishing ??= endRun(reason ?? 'done');
    return finishing;
  };

  async function endRun(reason) {
    const wasStarted = Boolean(drive);
    finished = true;
    const stopReason = drive?.stopReason ?? (declined ? 'declined' : over?.reason ?? reason);
    if (wasStarted) {
      closeWaitingCards(CARD_WAIT_NOTE);
      // Stopping the drive lets go of the keys and hides the bar (quiesce, by way of onDriveChange) and says why for any end but done.
      if (drive.state !== 'stopped') {
        try {
          drive.stop(stopReason);
        } catch {
          // Stopped at the same moment.
        }
      }
      await quiesce(null);
      await log?.finish({ stopReason, actions: acted });
    }
    result = summary(stopReason);
    return result;
  }

  function summary(stopReason = drive?.stopReason ?? null) {
    return {
      id: log?.id ?? null,
      actions: acted,
      frames: frame?.n ?? 0,
      apps: windowScope ? [appName(settings.targetWindow.exe)] : allow.map(a => appName(a.exe)),
      scope: settings.scope,
      stopReason,
      model: modelName,
    };
  }

  return {
    tools: { toolset: true },
    get systemText() {
      return COMPUTER_SYSTEM({ settings, size: sentSize, platform });
    },
    maxRequests: settings.steps === null ? 10_000 : settings.steps + 20,
    get over() {
      return over ? over.reason : null;
    },
    get id() {
      return log?.id ?? null;
    },
    get frame() {
      return frame;
    },
    get drive() {
      return drive;
    },
    get allow() {
      return allow;
    },
    get settings() {
      return settings;
    },
    get declined() {
      return declined;
    },
    get started() {
      return Boolean(drive);
    },
    consent,
    preflight,
    start,
    step: raw => serial(() => runStep(raw)),
    confirm,
    handOver,
    budgetCheck,
    finish,
    summary,
    // For the provider adapters: which kind a provider's own safety check is, and whether the person switched that kind off for this
    // run ({ id, off }; id is null for a check that fits none of the six). Google's override of a blocked decision uses switchedOff().
    safety: info => {
      const id = categoryOfSafety(info);
      return { id, off: id !== null && settings.confirm[id] === false };
    },
    switchedOff: () => Object.entries(settings.confirm).filter(([, on]) => !on).map(([id]) => id),
    // For the tests: how many acts were counted, and the label shown for the run.
    _label: label,
    _stepsText: stepsOf,
  };
}

