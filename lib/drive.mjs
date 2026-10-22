// Drives: one model-driven session of something outside the chat. A drive is kind 'computer' (the screen, lib/computer) or
// 'browser' (the in-app browser). This module owns the registry and the controls only. It never takes a screenshot, a click or a
// page, so each feature calls it and nothing here knows what the model is doing.
//
// States and transitions:
//   running -> paused   pause(by)       by: 'user' (Pause on the bar or the overlay), 'input' (the person used the mouse or keyboard),
//                                       'model' (the model asked the person to do a step; the note says what), 'card' (an approval
//                                       card of this run waits)
//   paused  -> running  resume(by)      a 'card' pause resumes only through resume('card'), which the controller calls once the card
//                                       is answered or times out; resume('user') then answers 409
//   any live -> stopped stop(reason)    terminal. Every checkpoint waiting on the run is rejected with DriveStopped.
// Any other transition throws an Error with status 409 that names the state. Every transition and every step calls onChange and
// publishes a 'drive' event on the events channel (lib/events.mjs), so every window's drive bar follows.
//
// Limits: the time limit counts only time spent running (activeMs). A drive that stays paused for its idle limit stops itself with
// reason 'idle'; the limit is driveIdleMinutes in state.json (default 60, 5 to 480), unless the caller passes limits.idleMs.
//
// The stop key: while a drive that wants it is live, the server asks the desktop app to register a global shortcut
// ({ type: 'drive-hotkey', on: true, accelerator }, desktop/handlers/drive.cjs). Pressing it sends { type: 'drive-stop' }, and
// stopAll('hotkey') stops every drive. Under plain `node server.mjs` there is no desktop app, and hotkeyStatus() says so.
//
// Nothing in this file logs. A model's reason for a pause is printable text clipped to 120 characters.
import { randomUUID } from 'node:crypto';
import * as events from './events.mjs';
import * as store from './store.mjs';
import { onShellMessage, shellAvailable, shellRequest } from './shell.mjs';

export const KINDS = Object.freeze(['computer', 'browser']);
export const PAUSE_BY = Object.freeze(['user', 'input', 'model', 'card']);
export const DEFAULT_ACCELERATOR = 'Ctrl+Alt+Escape';
export const DEFAULT_IDLE_MINUTES = 60;
export const MIN_IDLE_MINUTES = 5;
export const MAX_IDLE_MINUTES = 480;
const NOTE_MAX = 120;
const LABEL_MAX = 80;
const HOTKEY_TIMEOUT_MS = 5000;
const LIMIT_MAX = 1_000_000_000;
// The shape of a stop key: one to three modifiers, then a key. The same pattern the desktop handler checks (desktop/handlers/drive.cjs).
// An override must also name at least two different modifiers (validStopKey).
const STOP_KEY_RE = /^((Ctrl|Alt|Shift|Super)\+){1,3}(Escape|F[1-9]|F1[0-2]|[A-Z])$/;

const NO_PROJECT = 'A drive needs a project.';
const BAD_KIND = 'A drive is a computer run or a browser session.';
const PROJECT_BUSY = 'This project already has a run that is driving something. Stop it first.';
const COMPUTER_BUSY = 'Another computer run is in progress. Stop it first.';
const CARD_ONLY = 'Answer the card in Plenum first, or press Stop.';

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Thrown to a caller waiting at checkpoint() when its run stops. The message names the reason.
export class DriveStopped extends Error {
  constructor(reason) {
    super('The run was stopped (' + reason + ').');
    this.name = 'DriveStopped';
    this.reason = reason;
  }
}

// Printable text only, collapsed to one line and clipped. A cut never leaves half of a surrogate pair.
function clip(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).replace(/[\ud800-\udbff]$/, '');
}

// The model's words for a pause, shown quoted in the bar. Clipped to 120 characters.
export const cleanNote = raw => clip(raw, NOTE_MAX);

const modifiersOf = accelerator => accelerator.split('+').slice(0, -1);
const validStopKey = value =>
  typeof value === 'string' && STOP_KEY_RE.test(value) && new Set(modifiersOf(value)).size === modifiersOf(value).length && modifiersOf(value).length >= 2;

// The idle limit in minutes, checked on read: anything outside the range, or not a whole number, is the default.
const idleMinutesOf = value =>
  Number.isInteger(value) && value >= MIN_IDLE_MINUTES && value <= MAX_IDLE_MINUTES ? value : DEFAULT_IDLE_MINUTES;

// The idle limit in milliseconds, from state.json (driveIdleMinutes).
export function driveIdleMs() {
  return idleMinutesOf(store.get()?.driveIdleMinutes) * 60_000;
}

// For the settings route: the value is checked and refused with a plain message when it is not a whole number of minutes in range.
export function normalizeIdleMinutes(value) {
  if (Number.isInteger(value) && value >= MIN_IDLE_MINUTES && value <= MAX_IDLE_MINUTES) return value;
  throw httpError(400, `The pause limit must be a whole number of minutes from ${MIN_IDLE_MINUTES} to ${MAX_IDLE_MINUTES}.`);
}

// For the settings route: '' or null clears the override (the default key is used). Anything else must be a stop key with at
// least two modifiers, for example Ctrl+Alt+Escape.
export function normalizeStopOverride(value) {
  if (value === null || value === undefined || value === '') return null;
  if (validStopKey(value)) return value;
  throw httpError(400, 'The stop key needs at least two of Ctrl, Alt, Shift and Super, then a key, for example Ctrl+Alt+Escape.');
}

// The accelerator the desktop app registers. Electron's Ctrl is the Control key on macOS too, so the default is Control+Option+Esc
// there. An override saved in state.json (driveStopKey) is used only when it is a valid stop key with two or more modifiers.
export function stopAccelerator(platform, override) {
  void platform;
  return validStopKey(override) ? override : DEFAULT_ACCELERATOR;
}

// The text people see for an accelerator: 'Ctrl+Alt+Esc' on Windows and Linux, 'Control+Option+Esc' on macOS.
export function stopKeyLabel(platform, accelerator) {
  const mac = platform === 'darwin';
  const parts = String(accelerator ?? DEFAULT_ACCELERATOR).split('+');
  const key = parts.pop();
  const names = parts.map(name => {
    if (name === 'Ctrl') return mac ? 'Control' : 'Ctrl';
    if (name === 'Alt') return mac ? 'Option' : 'Alt';
    if (name === 'Super') return mac ? 'Command' : platform === 'win32' ? 'Win' : 'Super';
    return name;
  });
  return [...names, key === 'Escape' ? 'Esc' : key].join('+');
}

// The limits a drive is started with. steps and activeMs may be null (no limit). idleMs is positive; it defaults to the setting.
function normalizeLimits(limits) {
  const value = limits && typeof limits === 'object' ? limits : {};
  const count = (v, what) => {
    if (v === null || v === undefined) return null;
    if (Number.isInteger(v) && v > 0 && v <= LIMIT_MAX) return v;
    throw httpError(400, `The ${what} limit must be empty (no limit) or a whole number above 0.`);
  };
  const steps = count(value.steps, 'step');
  const activeMs = count(value.activeMs, 'time');
  const idleMs = value.idleMs === undefined ? driveIdleMs() : count(value.idleMs, 'pause');
  if (idleMs === null) throw httpError(400, 'The pause limit must be a whole number above 0.');
  return { steps, activeMs, idleMs };
}

// The registry of live drives: id -> Drive. A stopped drive is removed after its last notice.
const registry = new Map();

// One model-driven run. The fields are read through getters; only the methods change them.
class Drive {
  #state = 'running';
  #pausedBy = null;
  #note = '';
  #steps = 0;
  #resumes = 0;
  #stopReason = null;
  #segmentStart = 0;
  #accumulated = 0;
  #idleTimer = null;
  #waiters = [];
  #onChange;
  #signal;
  #onAbort = null;

  constructor({ id, kind, projectId, label, limits, hotkey, onChange, signal }) {
    this.id = id;
    this.kind = kind;
    this.projectId = projectId;
    this.label = label;
    this.limits = limits;
    this.hotkey = hotkey;
    this.startedAt = Date.now();
    this.#onChange = typeof onChange === 'function' ? onChange : null;
    this.#segmentStart = this.startedAt;
    this.#signal = signal ?? null;
    if (this.#signal) {
      this.#onAbort = () => this.#finish('cancelled');
      this.#signal.addEventListener('abort', this.#onAbort, { once: true });
    }
    this.#changed();
  }

  get state() { return this.#state; }
  get pausedBy() { return this.#pausedBy; }
  get note() { return this.#note; }
  get steps() { return this.#steps; }
  get resumes() { return this.#resumes; }
  get stopReason() { return this.#stopReason; }

  // Wall time spent running. Paused time does not count.
  activeMs() {
    return this.#accumulated + (this.#state === 'running' ? Date.now() - this.#segmentStart : 0);
  }

  // Which limit has been reached: 'steps', 'time' or null. The controller checks it between actions.
  limitReached() {
    if (typeof this.limits.steps === 'number' && this.#steps >= this.limits.steps) return 'steps';
    if (typeof this.limits.activeMs === 'number' && this.activeMs() >= this.limits.activeMs) return 'time';
    return null;
  }

  pause(by = 'user', note = '') {
    if (!PAUSE_BY.includes(by)) throw httpError(400, 'A pause needs a reason: user, input, model or card.');
    if (this.#state !== 'running') throw httpError(409, `This run is ${this.#state}, so it cannot be paused.`);
    this.#closeSegment();
    this.#state = 'paused';
    this.#pausedBy = by;
    this.#note = by === 'model' ? cleanNote(note) : '';
    this.#clearIdle();
    this.#idleTimer = setTimeout(() => this.#finish('idle'), this.limits.idleMs);
    this.#idleTimer.unref?.();
    this.#changed();
  }

  resume(by = 'user') {
    if (by !== 'user' && by !== 'card') throw httpError(400, 'A resume comes from the user or from a card.');
    if (this.#state !== 'paused') throw httpError(409, `This run is ${this.#state}, so there is nothing to resume.`);
    if (this.#pausedBy === 'card' && by !== 'card') throw httpError(409, CARD_ONLY);
    if (by === 'card' && this.#pausedBy !== 'card') throw httpError(409, 'This run is not waiting for a card.');
    this.#clearIdle();
    this.#state = 'running';
    this.#pausedBy = null;
    this.#note = '';
    this.#resumes += 1;
    this.#segmentStart = Date.now();
    for (const waiter of this.#waiters.splice(0)) waiter.resolve();
    this.#changed();
  }

  // Stops the run for good. A second stop is refused (the drive is already gone from the registry by then).
  stop(reason = 'user') {
    if (this.#state === 'stopped') throw httpError(409, 'This run has already stopped.');
    this.#finish(reason);
  }

  // Counts one step of the run and returns the new count.
  tick() {
    if (this.#state === 'stopped') throw new DriveStopped(this.#stopReason);
    this.#steps += 1;
    this.#changed();
    return this.#steps;
  }

  // Resolves at once while the run runs, waits while it is paused, and rejects with DriveStopped once it has stopped.
  checkpoint() {
    if (this.#state === 'stopped') return Promise.reject(new DriveStopped(this.#stopReason));
    if (this.#state === 'running') return Promise.resolve();
    return new Promise((resolve, reject) => { this.#waiters.push({ resolve, reject }); });
  }

  // The pause and takeover names of the browser design: takeover is pause, release is resume by the user.
  takeover(by = 'user') { return this.pause(by); }
  release() { return this.resume('user'); }

  // The fields the bar, the pill and the events channel carry. Nothing else.
  summary() {
    return {
      id: this.id,
      kind: this.kind,
      projectId: this.projectId,
      label: this.label,
      state: this.#state,
      pausedBy: this.#pausedBy,
      note: this.#note,
      steps: this.#steps,
      limits: { ...this.limits },
      activeMs: this.activeMs(),
      startedAt: this.startedAt,
      stopReason: this.#stopReason,
    };
  }

  #closeSegment() {
    if (this.#state === 'running') this.#accumulated += Date.now() - this.#segmentStart;
  }

  #clearIdle() {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #finish(reason) {
    if (this.#state === 'stopped') return;
    this.#closeSegment();
    this.#clearIdle();
    this.#state = 'stopped';
    this.#pausedBy = null;
    this.#note = '';
    this.#stopReason = String(reason ?? 'user');
    if (this.#signal && this.#onAbort) this.#signal.removeEventListener('abort', this.#onAbort);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new DriveStopped(this.#stopReason));
    this.#changed();
    registry.delete(this.id);
    syncHotkey();
  }

  // Tells the run's own listener and every window. A listener that throws changes nothing here.
  #changed() {
    const s = this.summary();
    try {
      this.#onChange?.(s);
    } catch {
      // The caller's listener failed; the drive itself is unaffected.
    }
    events.publish({ type: 'drive', drive: s });
    events.publishState('drive');
  }
}

// Starts a drive. Throws Error status 400 for a bad kind or limit, and 409 when the project already has a live drive or a
// computer drive is live (one keyboard and mouse). canStart says the same before anything starts.
export function canStart(kind, projectId) {
  if (!KINDS.includes(kind)) return BAD_KIND;
  if (typeof projectId !== 'string' || projectId.length === 0) return NO_PROJECT;
  for (const drive of registry.values()) if (drive.projectId === projectId) return PROJECT_BUSY;
  if (kind === 'computer') {
    for (const drive of registry.values()) if (drive.kind === 'computer') return COMPUTER_BUSY;
  }
  return null;
}

// The drive's handle. `signal` (the turn's AbortSignal) stops it with reason 'cancelled'. `onChange` gets each summary. With
// hotkey true (the default) the stop key is registered while this drive is live.
export function startDrive({ kind, projectId, label = '', limits = {}, signal, onChange, hotkey = true } = {}) {
  const refusal = canStart(kind, projectId);
  if (refusal) throw httpError(KINDS.includes(kind) ? 409 : 400, refusal);
  const drive = new Drive({
    id: randomUUID(),
    kind,
    projectId,
    label: clip(String(label ?? ''), LABEL_MAX),
    limits: normalizeLimits(limits),
    hotkey: hotkey !== false,
    onChange,
    signal,
  });
  registry.set(drive.id, drive);
  listen();
  syncHotkey();
  if (signal?.aborted) drive.stop('cancelled');
  return drive;
}

// The live drive of a project, or null.
export function driveFor(projectId) {
  for (const drive of registry.values()) if (drive.projectId === projectId) return drive;
  return null;
}

export function getDrive(id) {
  return typeof id === 'string' ? registry.get(id) ?? null : null;
}

// Summaries of every live drive, newest first.
export function listDrives() {
  return [...registry.values()].map(drive => drive.summary()).sort((a, b) => b.startedAt - a.startedAt);
}

// Stops every live drive. Returns how many were stopped.
export function stopAll(reason = 'user') {
  let count = 0;
  for (const drive of [...registry.values()]) {
    try {
      drive.stop(reason);
      count += 1;
    } catch {
      // Already stopped by another path.
    }
  }
  return count;
}

// The desktop's messages about the stop key. Listens once, when the first drive starts.
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  onShellMessage('drive-stop', () => stopAll('hotkey'));
}

// The stop key's state as the desktop app reported it. Before any drive, nothing has been asked.
let hotkeyState = { ok: false, reason: '' };
let hotkeyOn = false;
let hotkeySeq = 0;
let hotkeyPending = null;

// The state of the stop key: { ok, accelerator, label, reason }. Under plain `node server.mjs` there is no desktop app.
export function hotkeyStatus() {
  if (!shellAvailable()) return { ok: false, reason: 'no desktop app' };
  return { ...hotkeyState };
}

// Resolves with hotkeyStatus() once the answer to the latest registration has arrived, or after ms.
export function hotkeyReady(ms = 1000) {
  const pending = hotkeyPending;
  if (!pending) return Promise.resolve(hotkeyStatus());
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(hotkeyStatus()), ms);
    timer.unref?.();
    pending.then(() => {
      clearTimeout(timer);
      resolve(hotkeyStatus());
    });
  });
}

const wantsHotkey = () => {
  for (const drive of registry.values()) if (drive.hotkey) return true;
  return false;
};

// Asks the desktop app to register the stop key while a drive that wants it is live, and to let it go when none is. Only the
// latest request's answer is kept, so a quick start and stop cannot leave a stale answer on the status.
function syncHotkey() {
  const want = wantsHotkey();
  if (want === hotkeyOn) return;
  hotkeyOn = want;
  const seq = ++hotkeySeq;
  if (!shellAvailable()) {
    hotkeyPending = null;
    return;
  }
  if (!want) {
    hotkeyPending = null;
    hotkeyState = { ok: false, reason: '' };
    shellRequest('drive-hotkey', { on: false }, { timeoutMs: HOTKEY_TIMEOUT_MS }).catch(() => {});
    return;
  }
  const accelerator = stopAccelerator(process.platform, store.get()?.driveStopKey ?? null);
  hotkeyPending = shellRequest('drive-hotkey', { on: true, accelerator }, { timeoutMs: HOTKEY_TIMEOUT_MS })
    .then(reply => {
      if (seq !== hotkeySeq) return;
      hotkeyState = reply?.ok === true
        ? { ok: true, accelerator, label: stopKeyLabel(process.platform, accelerator), reason: '' }
        : { ok: false, accelerator, reason: clip(String(reply?.reason ?? ''), 200) };
    }, () => {
      if (seq !== hotkeySeq) return;
      hotkeyState = { ok: false, accelerator, reason: 'The desktop app did not answer.' };
    })
    .finally(() => {
      if (seq !== hotkeySeq) return;
      hotkeyPending = null;
      events.publishState('drive');
    });
}
