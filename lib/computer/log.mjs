// The run log: what a computer run did, kept on this computer so the person can look it over afterwards. Each run is one folder,
//   <state folder>/computer/runs/<runId>/
//     run.json        { id, projectId, startedAt, model, task, settings, actions, events, frames, frameSizes, result }
//     frame-0001.png  every screenshot the model was given, in order
// The runId is `${Date.now()}-${8 hex}` (13 digits, a dash, 8 hex characters). The state folder is lib/store.mjs HOME, which the
// credential guard (lib/guard.mjs) already refuses to every tool, so the model's own file tools can never read a run. The log holds
// screenshots, the actions the model asked for (with the text it typed clipped to 60 characters and long digit runs masked), card
// answers and pauses. It holds no key, no token and no secret the person typed into the 'Type it for me' box.
//
//  - openRunLog({ projectId, settings, model, task }) -> a log: log.id, log.dir, await log.frame(png, { width, height }) -> n (1 based),
//    log.action({ n, action, summary, ok, reason, frame, point, app, at }), log.event({ kind, text, answer, by, at }),
//    await log.finish({ stopReason, actions, usage }). run.json is rewritten at most once every 500 ms and once more at finish.
//  - listRuns() newest first, 100 at most, summaries only: { id, startedAt, model, apps, scope, actions, frames, stopReason, bytes, live }.
//  - readRun(id) the whole run.json plus { bytes, live }. framePath(id, n) the file of one frame. Both check their arguments with a
//    pattern and resolve the file under the runs folder, and throw an Error with status 404 (or 400 for a bad id) otherwise.
//  - deleteRun(id) refuses the run that is still going (409). deleteAllRuns() removes every run but a live one.
//  - prune({ days = 7, maxBytes = 200 MB }) removes the runs older than `days` and then the oldest ones until the rest fit in maxBytes;
//    a live run is never removed. run.mjs calls it at the start of each run with the retention from the settings.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from '../store.mjs';
import { insideRoot } from '../files.mjs';
import { DEFAULTS, appName } from './policy.mjs';

export const RUNS_DIR = path.join(HOME, 'computer', 'runs');
export const RUN_ID = /^\d{13}-[a-f0-9]{8}$/;
const FRAME_FILE = /^frame-\d{4,5}\.png$/;
const WRITE_EVERY_MS = 500;
const MAX_LISTED = 100;
const TASK_MAX = 2000;
const TEXT_MAX = 600;
const APP_MAX = 80;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// The runs whose log is still open in this process.
const live = new Set();

// Printable text only, one line, clipped.
function clip(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).replace(/[\ud800-\udbff]$/, '');
}

const frameName = n => `frame-${String(n).padStart(4, '0')}.png`;

// Writes a file by way of a temp file, so a reader never sees half of it. A rename that is refused (a reader holds the file open on
// Windows) falls back to writing in place; a log that cannot be written is skipped and never stops the run.
async function writeJson(file, value) {
  const text = JSON.stringify(value);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
    await fs.writeFile(file, text).catch(() => {});
  }
}

// The names of the apps a run's settings allow, for the list.
const appsOf = settings => (Array.isArray(settings?.allow) ? settings.allow.map(a => a?.app ?? appName(a?.exe)) : []);

// Opens the log of a new run: makes its folder and writes the first run.json. `settings` is the run's settings
// (normalizeRunSettings); only the facts a review needs are kept: the apps and their exes, the scope, the target app, the limits.
export async function openRunLog({ projectId = '', settings = {}, model = '', task = '', root = RUNS_DIR, maxFrameBytes = DEFAULTS.logMB * 1024 * 1024 } = {}) {
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  const doc = {
    id,
    projectId: String(projectId ?? ''),
    startedAt: Date.now(),
    model: clip(String(model ?? ''), 120),
    task: clip(String(task ?? ''), TASK_MAX),
    settings: {
      scope: settings.scope ?? null,
      target: settings.targetWindow ? { app: appName(settings.targetWindow.exe), exe: settings.targetWindow.exe } : { display: settings.display ?? null },
      allow: (settings.allow ?? []).map(a => ({ app: appName(a.exe), exe: a.exe })),
      steps: settings.steps ?? null,
      minutes: settings.minutes ?? null,
      paceMs: settings.paceMs ?? null,
      confirmEvery: settings.confirmEvery === true,
      unknownApps: settings.unknownApps ?? null,
      maxEdge: settings.maxEdge ?? null,
      confirm: settings.confirm ?? null,
      numberGuard: settings.numberGuard !== false,
      askAnyway: settings.askAnyway === true,
    },
    actions: [],
    events: [],
    frames: 0,
    // The size each screenshot was sent at, so the review can place a ring on it by percentage: frameSizes[n - 1] = { width, height }.
    frameSizes: [],
    result: null,
  };
  let nextFrame = 0;
  let frameBytes = 0;
  let full = false;
  let written = 0;
  let timer = null;
  let writing = Promise.resolve();
  let closed = false;
  const file = path.join(dir, 'run.json');
  const write = () => {
    timer = null;
    writing = writing.then(() => writeJson(file, doc));
    return writing;
  };
  const schedule = () => {
    if (closed || timer) return;
    const wait = Math.max(0, WRITE_EVERY_MS - (Date.now() - written));
    written = Date.now() + wait;
    timer = setTimeout(write, wait);
    timer.unref?.();
  };
  live.add(id);
  await writeJson(file, doc);
  written = Date.now();

  return {
    id,
    dir,
    // Saves one screenshot and returns its number once the file is on disk, so a card that names it can be shown at once.
    async frame(png, { width = 0, height = 0 } = {}) {
      const n = ++nextFrame;
      const bytes = Buffer.from(png);
      // One run never keeps more screenshots than the whole log may hold; the later ones are numbered but not written, and the
      // review says so.
      if (frameBytes + bytes.length > maxFrameBytes) {
        if (!full) {
          full = true;
          this.event({ kind: 'notice', text: 'The log is full, so later screenshots are not kept.' });
        }
      } else {
        try {
          await fs.writeFile(path.join(dir, frameName(n)), bytes);
          frameBytes += bytes.length;
        } catch {
          // The frame is missing from the review; the run goes on.
        }
      }
      doc.frames = Math.max(doc.frames, n);
      doc.frameSizes[n - 1] = { width: Number.isFinite(width) ? Math.round(width) : 0, height: Number.isFinite(height) ? Math.round(height) : 0 };
      schedule();
      return n;
    },
    action({ n, action = '', summary = '', ok = true, reason = '', frame = null, point = null, app = '', at = Date.now() } = {}) {
      doc.actions.push({
        n: Number.isInteger(n) ? n : doc.actions.length + 1,
        action: clip(String(action), 40),
        summary: clip(String(summary), 120),
        ok: ok === true,
        ...(ok === true ? {} : { reason: clip(String(reason), 300) }),
        frame: Number.isInteger(frame) ? frame : null,
        point: point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: Math.round(point.x), y: Math.round(point.y) } : null,
        app: clip(String(app), APP_MAX),
        at,
      });
      schedule();
    },
    event({ kind = 'notice', text = '', answer, by, at = Date.now() } = {}) {
      doc.events.push({
        kind: String(kind),
        text: clip(String(text), TEXT_MAX),
        ...(answer === undefined ? {} : { answer: clip(String(answer), 40) }),
        ...(by === undefined ? {} : { by: clip(String(by), 40) }),
        at,
      });
      schedule();
    },
    // Writes the end of the run and closes the log. Safe to call twice.
    async finish({ stopReason = null, actions = null, usage = null } = {}) {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      doc.result = {
        stopReason: stopReason === null ? null : clip(String(stopReason), 160),
        actions: Number.isInteger(actions) ? actions : doc.actions.filter(a => a.ok).length,
        usage: usage && typeof usage === 'object' ? usage : null,
        finishedAt: Date.now(),
      };
      writing = writing.then(() => writeJson(file, doc));
      await writing;
      live.delete(id);
    },
    get closed() {
      return closed;
    },
    // For the tests and the summary the run hands the server: the numbers as they stand.
    summary() {
      return { id, actions: doc.actions.filter(a => a.ok).length, frames: doc.frames, apps: appsOf(doc.settings), scope: doc.settings.scope };
    },
  };
}

// ---------- reading ----------

const validId = id => typeof id === 'string' && RUN_ID.test(id);

// The size of every file in a run's folder.
async function folderBytes(dir) {
  let total = 0;
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const info = await fs.stat(path.join(dir, name)).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

async function readDoc(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
}

const startOf = id => Number(id.slice(0, 13));

function summaryOf(id, doc, bytes) {
  const isLive = live.has(id);
  return {
    id,
    startedAt: Number.isFinite(doc?.startedAt) ? doc.startedAt : startOf(id),
    model: doc?.model ?? '',
    apps: appsOf(doc?.settings),
    scope: doc?.settings?.scope ?? null,
    actions: Array.isArray(doc?.actions) ? doc.actions.filter(a => a.ok).length : 0,
    frames: Number.isInteger(doc?.frames) ? doc.frames : 0,
    stopReason: doc?.result?.stopReason ?? (isLive ? null : 'interrupted'),
    bytes,
    live: isLive,
  };
}

async function runIds(root) {
  const names = await fs.readdir(root).catch(() => []);
  return names.filter(validId).sort().reverse();
}

// The runs, newest first, at most 100, as summaries.
export async function listRuns({ root = RUNS_DIR } = {}) {
  const out = [];
  for (const id of (await runIds(root)).slice(0, MAX_LISTED)) {
    const dir = path.join(root, id);
    const doc = await readDoc(dir);
    out.push(summaryOf(id, doc, await folderBytes(dir)));
  }
  return out;
}

// One run with its actions and events. Throws 400 for a bad id and 404 when there is no such run.
export async function readRun(id, { root = RUNS_DIR } = {}) {
  if (!validId(id)) throw httpError(400, 'That is not a run.');
  const dir = path.join(root, id);
  if (!insideRoot(root, dir)) throw httpError(400, 'That is not a run.');
  const doc = await readDoc(dir);
  if (!doc) throw httpError(404, 'No such run. It may have been deleted.');
  return { ...doc, id, bytes: await folderBytes(dir), live: live.has(id) };
}

// The file of one screenshot. Throws 404 for a bad id or number, a link, or a frame that is not there.
export async function framePath(id, n, { root = RUNS_DIR } = {}) {
  const num = typeof n === 'number' ? n : typeof n === 'string' && /^\d{1,5}$/.test(n) ? Number(n) : NaN;
  if (!validId(id) || !Number.isInteger(num) || num < 1 || num > 99999) throw httpError(404, 'No such screenshot.');
  const file = path.join(root, id, frameName(num));
  if (!insideRoot(root, file) || !FRAME_FILE.test(path.basename(file))) throw httpError(404, 'No such screenshot.');
  const info = await fs.lstat(file).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) throw httpError(404, 'No such screenshot.');
  return file;
}

// ---------- removing ----------

// Removes one run. The run that is still going is refused (409).
export async function deleteRun(id, { root = RUNS_DIR } = {}) {
  if (!validId(id)) throw httpError(400, 'That is not a run.');
  if (live.has(id)) throw httpError(409, 'This run is still going. Stop it first.');
  const dir = path.join(root, id);
  if (!insideRoot(root, dir)) throw httpError(400, 'That is not a run.');
  const info = await fs.lstat(dir).catch(() => null);
  if (!info) throw httpError(404, 'No such run. It may have been deleted.');
  await fs.rm(dir, { recursive: true, force: true });
  return { deleted: id };
}

// Removes every run but a live one. Returns how many were removed.
export async function deleteAllRuns({ root = RUNS_DIR } = {}) {
  let removed = 0;
  for (const id of await runIds(root)) {
    if (live.has(id)) continue;
    await fs.rm(path.join(root, id), { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }
  return { removed };
}

// Keeps the log to the retention: a run older than `days` goes, then the oldest runs go until the rest are at most maxBytes. A live
// run stays whatever its age or size. Returns the ids that were removed.
export async function prune({ days = DEFAULTS.logDays, maxBytes = DEFAULTS.logMB * 1024 * 1024, now = Date.now(), root = RUNS_DIR } = {}) {
  const removed = [];
  const kept = [];
  const cutoff = now - days * 86_400_000;
  for (const id of (await runIds(root)).reverse()) {
    if (live.has(id)) {
      kept.push({ id, bytes: await folderBytes(path.join(root, id)), live: true });
      continue;
    }
    if (startOf(id) < cutoff) {
      await fs.rm(path.join(root, id), { recursive: true, force: true }).catch(() => {});
      removed.push(id);
      continue;
    }
    kept.push({ id, bytes: await folderBytes(path.join(root, id)), live: false });
  }
  let total = kept.reduce((sum, r) => sum + r.bytes, 0);
  // kept is oldest first, so the oldest runs are the first to go.
  for (const run of kept) {
    if (total <= maxBytes) break;
    if (run.live) continue;
    await fs.rm(path.join(root, run.id), { recursive: true, force: true }).catch(() => {});
    removed.push(run.id);
    total -= run.bytes;
  }
  return removed;
}
