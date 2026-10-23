// Computer use, the routes the Computer panel, the runs list and the cards read (skeleton of lib/routes/pick-folder.mjs). A run itself
// starts with a chat message that carries the person's settings (POST /api/chat with `computer`, server.mjs): nothing here starts one.
//
//   GET  /api/computer/probe              -> { available, supported, reason, displays, help, models, hotkey, note, ... } (the backend's probe)
//   GET  /api/computer/windows            -> { windows: [{ id, title, exe, app, displayId, minimized, denied, flag }] }, Plenum's own left out
//   POST /api/computer/request-permissions  macOS only: asks the system for the input permission once
//   GET  /api/computer/runs               -> { runs }    the kept runs, newest first
//   GET  /api/computer/run?id=            -> one run with its actions and events
//   GET  /api/computer/frame?run=&n=      -> the PNG of one screenshot (a page reads it with the token, as every /api/ route)
//   POST /api/computer/runs/delete        { id }  and  POST /api/computer/runs/delete-all  (a live run stays)
//   GET  /api/computer/prefs?project=     -> { prefs }   POST /api/computer/prefs { project, prefs }: the choices remembered per project
//   POST /api/computer/type               { id, text }  "Type it for me": the person's own text goes into the field the model asked about
//
// The server checks the Plenum token on every /api/ request, and each POST checks it again here (requireToken). The terms gate
// (lib/legal.mjs) refuses every POST until the License Agreement is accepted.
//
// "Type it for me" is the person's own action for a step the model handed over (hand_over): a password, a code. The text goes straight
// to the keyboard of the program the run was using and is never read back, logged, stored or sent to a provider: this file holds it
// in one local variable for the length of the call and writes it nowhere, and no message that names it is ever built.
import { promises as fs } from 'node:fs';
import { requireToken } from '../auth.mjs';
import { bridge } from '../computer/bridge.mjs';
import { deleteAllRuns, deleteRun, framePath, listRuns, readRun } from '../computer/log.mjs';
import {
  MAX_ALLOWED_APPS, MAX_EDGES, MINUTES_RANGE, SCOPES, STEPS_RANGE, UNKNOWN_APPS, appAllowed, appName, isBrowserExe, isDeniedExe, isTerminalExe,
  normalizeConfirm, normalizePaceMs,
} from '../computer/policy.mjs';
import { computerSupportDetail } from '../computer/support.mjs';
import { driverFor } from '../computer/drivers.mjs';
import { getDrive, stopAccelerator, stopKeyLabel } from '../drive.mjs';
import { permissionHelp, supportNote } from '../platform/computer.mjs';
import { CATALOG, labelFor } from '../providers.mjs';
import { allowedRefs } from '../tool-trust.mjs';

const NO_DESKTOP = 'Computer use needs the desktop app.';
const TITLE_MAX = 200;
const EXE_MAX = 260;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
// A secret typed for the person: a password or a code, not a document. Control characters are refused (a line break would press Enter).
const TYPED_MAX = 512;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const FOCUS_WAIT_MS = 250;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

export const routes = [
  { method: 'GET', path: '/api/computer/probe', handler: probeRoute },
  { method: 'GET', path: '/api/computer/windows', handler: windowsRoute },
  { method: 'POST', path: '/api/computer/request-permissions', handler: permissionsRoute },
  { method: 'GET', path: '/api/computer/runs', handler: runsRoute },
  { method: 'GET', path: '/api/computer/run', handler: runRoute },
  { method: 'GET', path: '/api/computer/frame', handler: frameRoute },
  { method: 'POST', path: '/api/computer/runs/delete', handler: deleteRoute },
  { method: 'POST', path: '/api/computer/runs/delete-all', handler: deleteAllRoute },
  { method: 'GET', path: '/api/computer/prefs', handler: prefsGetRoute },
  { method: 'POST', path: '/api/computer/prefs', handler: prefsPostRoute },
  { method: 'POST', path: '/api/computer/type', handler: typeRoute },
];

// ---------- the panel's facts ----------

async function probeRoute({ res, json, store }) {
  let probe = { supported: false, reason: NO_DESKTOP };
  if (bridge.available) {
    try {
      const got = await bridge.probe();
      if (isObject(got)) probe = got;
    } catch (err) {
      probe = { supported: false, reason: err.message };
    }
  }
  const accelerator = stopAccelerator(process.platform, store.get().driveStopKey);
  return json(res, 200, {
    ...probe,
    available: bridge.available,
    help: bridge.available ? permissionHelp(process.platform, probe) : '',
    models: await computerModelList(),
    hotkey: { accelerator, label: stopKeyLabel(process.platform, accelerator) },
    note: supportNote(process.platform),
  });
}

// Every model the app runs (the catalog, and the API models whose tools are allowed), each with whether it can run the computer now.
// The check is the chat's own (server.mjs computerSupportFor): the Claude and OpenAI or Google drivers first, then the generic
// screenshot loop for an API model with a saved key. A model that cannot is listed too, disabled, with the reason (UI-ARCH 1, 10.5).
function labelOf(ref) {
  try {
    return labelFor(ref);
  } catch {
    return ref;
  }
}
async function computerModelList() {
  const refs = [...new Set([...CATALOG.map(c => `${c.provider}:${c.id}`), ...allowedRefs()])];
  const generic = await driverFor('generic');
  const out = [];
  for (const ref of refs) {
    let detail = await computerSupportDetail(ref);
    if (detail.level === 'no' && typeof generic?.genericSupportDetail === 'function') {
      detail = (await generic.genericSupportDetail(ref)) ?? detail;
    }
    const ready = detail.level !== 'no';
    out.push({ ref, name: labelOf(ref), ready, note: ready ? (detail.note || '') : (detail.note || 'cannot use the computer') });
  }
  return out;
}

async function windowsRoute({ res, json }) {
  if (!bridge.available) return json(res, 200, { available: false, windows: [] });
  const list = await bridge.windows();
  const windows = list.filter(w => w && !w.own).map(w => ({
    id: String(w.id),
    title: text(w.title, TITLE_MAX),
    exe: text(w.exe, EXE_MAX),
    app: appName(w.exe),
    displayId: w.displayId === undefined || w.displayId === null ? null : String(w.displayId),
    minimized: w.minimized === true,
    denied: isDeniedExe(w.exe),
    flag: isBrowserExe(w.exe) ? 'browser' : isTerminalExe(w.exe) ? 'terminal' : null,
  }));
  return json(res, 200, { available: true, windows });
}

async function permissionsRoute({ req, res, readBody, json, httpError }) {
  requireToken(req, httpError);
  await readBody(req);
  if (process.platform !== 'darwin') throw httpError(400, 'Only a Mac needs to be asked for these permissions.');
  if (!bridge.available) throw httpError(400, NO_DESKTOP);
  const reply = await bridge.requestAccess();
  return json(res, 200, { ok: true, requested: Array.isArray(reply?.requested) ? reply.requested : [] });
}

// ---------- the runs ----------

async function runsRoute({ res, json }) {
  return json(res, 200, { runs: await listRuns() });
}

async function runRoute({ res, url, json, httpError }) {
  const id = url.searchParams.get('id');
  if (!id) throw httpError(400, 'Say which run.');
  return json(res, 200, await readRun(id));
}

// A screenshot is private (it is the person's screen), so it is never cached and never sniffed as anything but an image.
async function frameRoute({ res, url, httpError }) {
  const file = await framePath(url.searchParams.get('run') ?? '', url.searchParams.get('n') ?? '');
  const body = await fs.readFile(file).catch(() => null);
  if (!body) throw httpError(404, 'No such screenshot.');
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

async function deleteRoute({ req, res, readBody, json, httpError }) {
  requireToken(req, httpError);
  const body = await readBody(req);
  if (!isObject(body) || typeof body.id !== 'string') throw httpError(400, 'Say which run.');
  return json(res, 200, await deleteRun(body.id));
}

async function deleteAllRoute({ req, res, readBody, json, httpError }) {
  requireToken(req, httpError);
  await readBody(req);
  return json(res, 200, await deleteAllRuns());
}

// ---------- what the panel remembers ----------

const whole = (value, what, range) => {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw Object.assign(new Error(`${what} must be a whole number from ${range.min.toLocaleString('en-US')} to ${range.max.toLocaleString('en-US')}.`), { status: 400 });
  }
  return value;
};
const bool = (value, what) => {
  if (typeof value !== 'boolean') throw Object.assign(new Error(`${what} must be true or false.`), { status: 400 });
  return value;
};
const exeText = (value, what) => {
  if (typeof value !== 'string' || value.length > EXE_MAX || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error(`${what} must be a program name of at most ${EXE_MAX} characters.`), { status: 400 });
  }
  return value.trim().toLowerCase();
};

// Checks the choices the panel sends back and keeps only the fields it knows. A field that is left out is not remembered; a field that
// does not fit refuses the whole request, so nothing is stored from a half-wrong one. The windows themselves are never stored: a window id
// is not the same next time, so the panel keeps the program (targetExe, allowExes) and finds its window again.
export function normalizePrefs(input) {
  if (!isObject(input)) throw Object.assign(new Error('Send the remembered choices as an object.'), { status: 400 });
  const out = {};
  if (input.targetExe !== undefined && input.targetExe !== null && input.targetExe !== '') out.targetExe = exeText(input.targetExe, 'The remembered program');
  if (input.allowExes !== undefined && input.allowExes !== null) {
    if (!Array.isArray(input.allowExes)) throw Object.assign(new Error('The remembered apps must be a list.'), { status: 400 });
    // More than the cap is cut to the cap (the panel ticks at most MAX_ALLOWED_APPS apps; a longer list is not an error).
    out.allowExes = [...new Set(input.allowExes.map(e => exeText(e, 'A remembered app')))].slice(0, MAX_ALLOWED_APPS);
  }
  if (input.scope !== undefined) {
    if (!SCOPES.includes(input.scope)) throw Object.assign(new Error('The scope must be window or display.'), { status: 400 });
    out.scope = input.scope;
  }
  if (input.steps !== undefined) out.steps = input.steps === null ? null : whole(input.steps, 'Actions', STEPS_RANGE);
  if (input.minutes !== undefined) out.minutes = whole(input.minutes, 'Minutes of activity', MINUTES_RANGE);
  if (input.confirmEvery !== undefined) out.confirmEvery = bool(input.confirmEvery, 'Ask before every action');
  if (input.unknownApps !== undefined) {
    if (!UNKNOWN_APPS.includes(input.unknownApps)) throw Object.assign(new Error('Other apps must be ask, refuse or allow.'), { status: 400 });
    out.unknownApps = input.unknownApps;
  }
  if (input.maxEdge !== undefined) {
    if (!MAX_EDGES.includes(input.maxEdge)) throw Object.assign(new Error(`The screenshot size must be one of ${MAX_EDGES.join(', ')}.`), { status: 400 });
    out.maxEdge = input.maxEdge;
  }
  if (input.paceMs !== undefined) out.paceMs = normalizePaceMs(input.paceMs);
  if (input.confirm !== undefined) out.confirm = normalizeConfirm(input.confirm, 'computer');
  if (input.numberGuard !== undefined) out.numberGuard = bool(input.numberGuard, 'The number guard');
  if (input.model !== undefined && input.model !== null && input.model !== '') {
    if (typeof input.model !== 'string' || !MODEL_RE.test(input.model)) throw Object.assign(new Error('The remembered model is not a model.'), { status: 400 });
    out.model = input.model;
  }
  return out;
}

function projectIdOf(raw, projectById, httpError) {
  if (typeof raw !== 'string' || !raw) throw httpError(400, 'Say which project.');
  return projectById(raw).id;
}

async function prefsGetRoute({ res, url, json, store, projectById, httpError }) {
  const id = projectIdOf(url.searchParams.get('project'), projectById, httpError);
  const prefs = store.get().computerPrefs?.[id];
  return json(res, 200, { prefs: isObject(prefs) ? prefs : null });
}

async function prefsPostRoute({ req, res, readBody, json, store, projectById, httpError }) {
  requireToken(req, httpError);
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send the project and its remembered choices.');
  const id = projectIdOf(body.project, projectById, httpError);
  const prefs = normalizePrefs(body.prefs);
  const st = store.get();
  st.computerPrefs = isObject(st.computerPrefs) ? st.computerPrefs : {};
  st.computerPrefs[id] = prefs;
  await store.saveOrFail();
  return json(res, 200, { prefs });
}

// ---------- "Type it for me" ----------

// The window the model handed over in, as { id, exe } (run.handoverWindow, recorded when hand_over was called). Never another window: a run
// that has moved into a second app (an approved one) must not get the person's text in the first app. Null when the run did not record one.
function windowOfRun(run) {
  const w = run.handoverWindow;
  return w && w.id !== undefined && w.id !== null ? { id: String(w.id), exe: w.exe } : null;
}

const typing = new Set();

// POST body { id, text }: id is the drive of a computer run that is waiting for the person (the model called hand_over). The window the
// run was using is brought forward, checked once more, and the text is typed into it. The answer says only that it was typed and into
// which app. The run stays paused: the person presses Resume when they are done, and the model must take a screenshot before it acts.
async function typeRoute({ req, res, readBody, json, httpError, computerRun }) {
  requireToken(req, httpError);
  const body = await readBody(req);
  if (!isObject(body) || typeof body.id !== 'string' || typeof body.text !== 'string') throw httpError(400, 'Send the run and the text to type.');
  const typed = body.text;
  if (typed.length < 1 || typed.length > TYPED_MAX) throw httpError(400, `Type between 1 and ${TYPED_MAX} characters.`);
  if (CONTROL.test(typed)) throw httpError(400, 'That text has a line break or another control character, which Plenum does not type.');
  const drive = getDrive(body.id);
  if (!drive || drive.kind !== 'computer') throw httpError(404, 'That run is no longer driving anything.');
  if (drive.state !== 'paused' || drive.pausedBy !== 'model') throw httpError(409, 'The model has not asked you to do a step right now.');
  const run = typeof computerRun === 'function' ? computerRun(body.id) : null;
  if (!run) throw httpError(409, 'This run cannot be reached from here. Click into the field yourself and type it.');
  if (!bridge.available) throw httpError(400, NO_DESKTOP);
  if (typing.has(body.id)) throw httpError(409, 'Typing is already in progress.');
  typing.add(body.id);
  try {
    const target = windowOfRun(run);
    if (!target) throw httpError(409, 'Click into the field yourself and type it.');
    await bridge.focus(target.id);
    await new Promise(resolve => setTimeout(resolve, FOCUS_WAIT_MS));
    const front = await bridge.foreground();
    // The run's live list (run.allow: the starting list plus every program an approval card added since), not the list the run started
    // with (run.settings.allow): a hand-over in a program the person approved mid-run must be typed into like any other.
    const view = { allow: run.allow ?? run.settings?.allow ?? [], unknownApps: run.settings?.unknownApps };
    // Typed only when the window in front is the one the model handed over in, and its program is still allowed.
    const ok = front && String(front.id) === String(target.id) && appAllowed(front, view).ok;
    if (!ok) throw httpError(409, 'Click into the field yourself and type it.');
    const sent = await bridge.input({ kind: 'type', text: typed });
    if (!sent.ok) throw httpError(409, sent.message || 'The text could not be typed.');
    return json(res, 200, { ok: true, app: appName(front.exe) });
  } finally {
    typing.delete(body.id);
  }
}
