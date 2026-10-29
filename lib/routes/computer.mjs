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
//   mob-20, a phone taking over a run (only for a request the Bridge makes for a Full-tier phone; the others answer 403):
//   POST /api/computer/takeover           { id }        "Take over from phone": pauses the run (the person's pause) and gives this phone the
//                                                       run's screen to act on until Resume, Stop or another phone
//   POST /api/computer/live               { id }        a picture of what the run sees now: { image, width, height, nextMs }
//   POST /api/computer/input              { id, kind: 'tap' | 'scroll' | 'type' | 'key', x, y, width, height, dx?, dy?, button?, count?, text?,
//                                                       key? }   the person's tap, swipe, typing or key at a point of that picture
//
// The server checks the Plenum token on every /api/ request, and each POST checks it again here (requireToken). The terms gate
// (lib/legal.mjs) refuses every POST until the License Agreement is accepted.
//
// "Type it for me" is the person's own action for a step the model handed over (hand_over): a password, a code. The text goes straight
// to the keyboard of the program the run was using and is never read back, logged, stored or sent to a provider: this file holds it
// in one local variable for the length of the call and writes it nowhere, and no message that names it is ever built.
import { promises as fs } from 'node:fs';
import { requireToken } from '../auth.mjs';
import { shellAvailable, shellRequest } from '../shell.mjs';
import { bridge } from '../computer/bridge.mjs';
import { deleteAllRuns, deleteRun, framePath, listRuns, readRun } from '../computer/log.mjs';
import {
  MAX_ALLOWED_APPS, MAX_EDGES, MINUTES_RANGE, SCOPES, STEPS_RANGE, UNKNOWN_APPS, appAllowed, appName, exeKey, isBrowserExe, isDeniedExe,
  isTerminalExe, normalizeConfirm, normalizePaceMs,
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
  ...createControlRoutes(),
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

// ---------- a phone takes over a run (mob-20) ----------

// "Take over from phone" is the person pausing the run from their phone and then using its screen with their own hand: a tap, a swipe,
// typing or a key arrives from the phone and is sent to the program the run was using, the way the person would do it at the keyboard. It
// never goes through the model's steps (lib/computer/run.mjs), so none of the model's refusals apply to it, and none of its record changes:
// no action is counted or logged, and what was typed is in no reply, log line or event. How a phone's typing is kept from a model run:
//  - the routes answer only a request the Bridge made for a paired phone (x-plenum-device, which a phone cannot set and the desktop page,
//    the model's tools and the MCP bridge do not have), at the Full tier, and on the iOS store build only over the LAN carrier;
//  - they work only while the run is paused and this phone holds the takeover, taken after the pause: Resume, Stop, a pause for a card,
//    or another phone's takeover ends it, so a model step never runs at the same time as a phone's input (a step that was waiting when
//    the run was paused is held back by the run, and the takeover waits for one whose input was already on its way: run.idle(); the
//    hold is given only after that wait, so no input is accepted while the model's last one may still be landing, and each input
//    looks at the hold once more in the same tick it is handed to the driver, so a Resume that came while it was being checked wins);
//  - after Resume the model must take a new screenshot before it acts (the run's own rule), and it still never types into a password,
//    code or card field itself.
// What the phone may act on is what the run may use: Plenum's own windows, elevated programs and the never-allowed programs are refused at
// the point of the tap and in the program in front, and a program the run does not use is refused unless the run allows any app.
const PHONE_ONLY = 'This is for a paired phone.';
const DEVICE = /^[A-Za-z0-9_-]{1,128}$/;
const TAKE_FIRST = 'Take over the run from your phone first.';
const CARD_FIRST = 'A card is waiting for your answer. Answer it first, or press Stop.';
const MOVED_ON = 'The run was resumed before the takeover finished. Take over again.';
const NO_RUN_HERE = 'This run cannot be reached from here.';
const OUT_OF_PICTURE = 'That spot is outside the picture.';
const LIVE_NEXT_MS = 250;
const LIVE_MIN_MS = 200;
const LIVE_EDGE = 1280;
const LIVE_QUALITY = 60;
const LIVE_STALE_MS = 60_000;
const TEXT_MAX = 1000;
const SCROLL_TICKS = 20;
const TAKEOVER_SETTLE_MS = 350;
const TAKEOVER_IDLE_MS = 3000;
const KEY_NAMES = Object.freeze({
  Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace', Delete: 'delete', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left',
  ArrowRight: 'right', PageUp: 'pageup', PageDown: 'pagedown', Home: 'home', End: 'end',
});
const inRect = (p, r) => Boolean(r) && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
const finite = v => typeof v === 'number' && Number.isFinite(v);

// The routes, over a driver (lib/computer/bridge.mjs), the drive registry and the shell channel. The server uses the real ones; the tests
// pass fakes.
export function createControlRoutes({
  driver = bridge, drives = { getDrive }, shell = { available: shellAvailable, request: shellRequest }, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  // drive id -> { device, resumes, frame: { width, height, physical, scale, at } | null, last: { at, reply } | null, queue: Promise }
  const holds = new Map();

  function phoneOf(req, httpError) {
    const v = req.headers?.['x-plenum-device'];
    if (typeof v !== 'string' || !DEVICE.test(v)) throw httpError(403, PHONE_ONLY);
    return v;
  }

  async function bodyOf(readBody, req, httpError) {
    const body = await readBody(req);
    if (!isObject(body) || typeof body.id !== 'string') throw httpError(400, 'Say which run.');
    return body;
  }

  function driveOf(id, httpError) {
    const drive = drives.getDrive(id);
    if (!drive || drive.kind !== 'computer') {
      holds.delete(id);
      throw httpError(404, 'That run is no longer driving anything.');
    }
    return drive;
  }

  // The takeover this phone holds on a paused run, or a 409 that says what to do. A run that resumed since, or stopped, or waits for a
  // card, or was taken over by another phone, holds nothing.
  function holdOf(drive, device, httpError) {
    const hold = holds.get(drive.id);
    // A takeover that the run has moved on from is gone for everyone; another phone's ask does not end this phone's.
    if (hold && (hold.resumes !== drive.resumes || drive.state !== 'paused')) {
      holds.delete(drive.id);
    } else if (hold && hold.device === device) {
      if (drive.pausedBy === 'card') throw httpError(409, CARD_FIRST);
      return hold;
    }
    throw httpError(409, TAKE_FIRST);
  }

  function runOf(id, computerRun, httpError) {
    const run = typeof computerRun === 'function' ? computerRun(id) : null;
    if (!run || !isObject(run.settings)) throw httpError(409, NO_RUN_HERE);
    if (!driver.available) throw httpError(400, NO_DESKTOP);
    return run;
  }

  // The run's own view of which programs it may use. A run that allows any app lets the phone act in any app; every other run lets it
  // act in the programs the run lists (including those a card added), and in no other.
  const viewOf = run => ({ allow: run.allow ?? run.settings?.allow ?? [], unknownApps: run.settings?.unknownApps === 'allow' ? 'allow' : 'refuse' });

  async function ownExes() {
    const out = new Set();
    try {
      for (const w of await driver.windows()) if (w.own) out.add(exeKey(w.exe));
    } catch {
      // The windows could not be listed; the program in front is still judged.
    }
    return out;
  }

  const sayWhy = (verdict, name) => {
    if (verdict.why === 'Plenum itself') return 'That is a Plenum window. Plenum never acts on its own windows from a phone; use the computer for that.';
    if (verdict.why === 'elevated') return 'That window belongs to a program running as administrator. Plenum cannot control it.';
    if (verdict.why === 'never allowed') return 'Plenum never acts in that program. Use the computer for that.';
    return `${name} is not one of the programs this run uses. Add it to the run's list at the computer.`;
  };

  // The program in front (brought forward first when the run is on one window), then the program under each point, must be ones the run may use.
  async function gate(run, points) {
    const view = viewOf(run);
    const own = await ownExes();
    const judge = w => appAllowed({ exe: w.exe, own: w.own === true || own.has(exeKey(w.exe)), elevated: w.elevated === true }, view);
    let front = await driver.foreground();
    let verdict = front ? judge(front) : { ok: false, why: 'no window is in front' };
    const target = run.settings.scope === 'window' ? run.settings.targetWindow : null;
    if (!verdict.ok && target && verdict.why !== 'elevated' && verdict.why !== 'never allowed') {
      await driver.focus(target.id).catch(() => {});
      await wait(150);
      front = await driver.foreground();
      verdict = front ? judge(front) : { ok: false, why: 'no window is in front' };
    }
    if (!verdict.ok) return { ok: false, message: front ? sayWhy(verdict, appName(front.exe)) : 'No window is in front. Open the program on the computer.' };
    if (points.length) {
      let stack = null;
      try {
        stack = await driver.windows({ all: true });
      } catch {
        stack = null;
      }
      if (Array.isArray(stack)) {
        for (const p of points) {
          const top = stack.find(w => inRect(p, w.bounds));
          if (!top) continue;
          const judged = judge({ exe: top.exe });
          if (!judged.ok) return { ok: false, message: sayWhy(judged, appName(top.exe)) };
        }
      }
    }
    return { ok: true, front };
  }

  // One picture of what the run sees, as a data URL, with its size and where it sits on the screen. The desktop makes it a JPEG when it can
  // (computer-live-frame, desktop/handlers/computer.cjs); a driver without that answers a PNG.
  async function capture(run) {
    const { scope, target } = run.settings;
    const maxEdge = Math.min(LIVE_EDGE, Number.isInteger(run.settings.maxEdge) ? run.settings.maxEdge : LIVE_EDGE);
    if (shell.available()) {
      let reply = null;
      try {
        reply = await shell.request('computer-live-frame', { scope, target, maxEdge, quality: LIVE_QUALITY }, { timeoutMs: 20_000 });
      } catch {
        reply = null;
      }
      if (reply && reply.ok !== false && typeof reply.jpeg === 'string' && reply.jpeg) {
        return { image: `data:image/jpeg;base64,${reply.jpeg}`, width: reply.width, height: reply.height, physical: reply.physical, scale: reply.scale };
      }
    }
    const cap = await driver.capture({ scope, target, maxEdge });
    if (cap.ok === false) return { fail: cap.message };
    return { image: `data:image/png;base64,${Buffer.from(cap.png).toString('base64')}`, width: cap.width, height: cap.height, physical: cap.physical, scale: cap.scale };
  }

  // The geometry run.mjs keeps for a screenshot: where the picture sits on the screen and how many screen pixels one picture pixel is.
  function geometryOf(cap) {
    const physical = cap.physical && Number.isFinite(cap.physical.x) ? cap.physical : { x: 0, y: 0, width: cap.width, height: cap.height };
    const scale = cap.scale && cap.scale.x > 0 && cap.scale.y > 0 ? cap.scale : { x: physical.width / cap.width, y: physical.height / cap.height };
    return { width: cap.width, height: cap.height, physical, scale, at: now() };
  }

  // A point of the picture the phone shows (x, y in a picture of width by height) as a point of the screen, from the geometry of the last picture.
  function toScreen(geo, body) {
    const sx = (body.x / body.width) * geo.width;
    const sy = (body.y / body.height) * geo.height;
    return { x: Math.round(geo.physical.x + sx * geo.scale.x), y: Math.round(geo.physical.y + sy * geo.scale.y) };
  }

  function pointOf(body, httpError) {
    for (const name of ['x', 'y', 'width', 'height']) {
      if (!finite(body[name]) || body[name] < 0 || body[name] > 1_000_000) throw httpError(400, `${name} must be a number from 0 to 1,000,000.`);
    }
    if (body.width <= 0 || body.height <= 0) throw httpError(400, 'width and height must be above 0.');
    if (body.x > body.width || body.y > body.height) throw httpError(400, OUT_OF_PICTURE);
  }

  // ----- the routes -----

  async function takeoverRoute({ req, res, readBody, json, httpError, computerRun }) {
    requireToken(req, httpError);
    const device = phoneOf(req, httpError);
    const body = await bodyOf(readBody, req, httpError);
    const drive = driveOf(body.id, httpError);
    const run = runOf(drive.id, computerRun, httpError);
    if (drive.state === 'paused' && drive.pausedBy === 'card') throw httpError(409, CARD_FIRST);
    const wasRunning = drive.state === 'running';
    if (wasRunning) drive.pause('user');
    const resumes = drive.resumes;
    // Whoever held the run before does not hold it any more. This phone's hold is set only after the wait below, so a type or a key (which
    // need no picture) is not accepted while the model's last input may still be landing.
    holds.delete(drive.id);
    // A run on one window starts with that window in front, so the first picture and the first tap are of it.
    const target = run.settings.scope === 'window' ? run.settings.targetWindow : null;
    if (target) await driver.focus(target.id).catch(() => {});
    // A step the model had begun may still be finishing; the first picture waits for the input that was already on its way (bounded). A
    // run that cannot say when it is idle gets a fixed moment instead.
    if (typeof run.idle === 'function') await Promise.race([Promise.resolve().then(() => run.idle()).catch(() => {}), wait(TAKEOVER_IDLE_MS)]);
    else if (wasRunning) await wait(TAKEOVER_SETTLE_MS);
    // The run may have been resumed, stopped or sent to a card while this waited: then there is nothing to hold, and the model may be running.
    driveOf(drive.id, httpError);
    if (drive.state === 'paused' && drive.pausedBy === 'card') throw httpError(409, CARD_FIRST);
    if (drive.state !== 'paused' || drive.resumes !== resumes) throw httpError(409, MOVED_ON);
    holds.set(drive.id, { device, resumes, frame: null, last: null, queue: Promise.resolve() });
    return json(res, 200, { ok: true, takeover: true, drive: drive.summary() });
  }

  async function liveRoute({ req, res, readBody, json, httpError, computerRun }) {
    requireToken(req, httpError);
    const device = phoneOf(req, httpError);
    const body = await bodyOf(readBody, req, httpError);
    const drive = driveOf(body.id, httpError);
    const hold = holdOf(drive, device, httpError);
    const run = runOf(drive.id, computerRun, httpError);
    // A picture is made at most five times a second; an earlier ask gets the last one.
    if (hold.last && now() - hold.last.at < LIVE_MIN_MS) return json(res, 200, { ...hold.last.reply, cached: true });
    const cap = await capture(run);
    if (cap.fail) throw httpError(409, cap.fail);
    if (!(cap.width > 0) || !(cap.height > 0)) throw httpError(409, 'The screen could not be pictured.');
    hold.frame = geometryOf(cap);
    const reply = { ok: true, image: cap.image, width: cap.width, height: cap.height, nextMs: LIVE_NEXT_MS };
    hold.last = { at: now(), reply };
    return json(res, 200, reply);
  }

  async function inputRoute({ req, res, readBody, json, httpError, computerRun }) {
    requireToken(req, httpError);
    const device = phoneOf(req, httpError);
    const body = await bodyOf(readBody, req, httpError);
    let action;
    if (body.kind === 'tap') {
      pointOf(body, httpError);
      const button = body.button === undefined ? 'left' : body.button;
      if (button !== 'left' && button !== 'right') throw httpError(400, 'button must be left or right.');
      if (body.count !== undefined && body.count !== 1 && body.count !== 2) throw httpError(400, 'count must be 1 or 2.');
      action = { kind: 'click', button, count: body.count ?? 1 };
    } else if (body.kind === 'scroll') {
      pointOf(body, httpError);
      const dx = body.dx ?? 0;
      const dy = body.dy ?? 0;
      if (!finite(dx) || !finite(dy) || Math.abs(dx) > 1_000_000 || Math.abs(dy) > 1_000_000 || (dx === 0 && dy === 0)) throw httpError(400, 'Say how far to scroll: dx or dy.');
      const vertical = Math.abs(dy) >= Math.abs(dx);
      const ticks = Math.min(50, Math.max(1, Math.round((Math.abs(vertical ? dy : dx) / (vertical ? body.height : body.width)) * SCROLL_TICKS)));
      action = { kind: 'scroll', direction: vertical ? (dy > 0 ? 'down' : 'up') : (dx > 0 ? 'right' : 'left'), amount: ticks };
    } else if (body.kind === 'type') {
      if (typeof body.text !== 'string' || body.text === '') throw httpError(400, 'Type something first.');
      if (body.text.length > TEXT_MAX) throw httpError(400, `Type at most ${TEXT_MAX} characters at a time.`);
      if (CONTROL.test(body.text)) throw httpError(400, 'That text has a line break or another control character. Send Enter as a key.');
      action = { kind: 'type', text: body.text };
    } else if (body.kind === 'key') {
      if (typeof body.key !== 'string' || !Object.hasOwn(KEY_NAMES, body.key)) throw httpError(400, `key must be one of ${Object.keys(KEY_NAMES).join(', ')}.`);
      if (body.count !== undefined && (!Number.isInteger(body.count) || body.count < 1 || body.count > 20)) throw httpError(400, 'count must be a whole number from 1 to 20.');
      action = { kind: 'key', keys: [KEY_NAMES[body.key]], repeat: body.count ?? 1 };
    } else {
      throw httpError(400, 'kind must be tap, scroll, type or key.');
    }
    const drive = driveOf(body.id, httpError);
    const hold = holdOf(drive, device, httpError);
    const run = runOf(drive.id, computerRun, httpError);
    const pointed = body.kind === 'tap' || body.kind === 'scroll';
    if (pointed && (!hold.frame || now() - hold.frame.at > LIVE_STALE_MS)) throw httpError(409, 'Wait for the picture to load, then try again.');
    // Inputs from one takeover go one at a time, in the order they arrived.
    const turn = hold.queue.then(async () => {
      holdOf(drive, device, httpError);
      const at = pointed ? toScreen(hold.frame, body) : null;
      const gated = await gate(run, at ? [at] : []);
      if (!gated.ok) throw httpError(409, gated.message);
      if (at) Object.assign(action, at);
      // The last look: gate() awaited the windows, and a Resume (or a Stop, a card, another phone) may have come meanwhile. No await sits
      // between this look and the call, the way run.mjs looks last before it injects, so a resumed model never has this input land on its screen.
      holdOf(drive, device, httpError);
      const sent = await driver.input(action);
      if (!sent.ok) throw httpError(409, sent.message || 'The input could not be sent.');
      return appName(gated.front?.exe);
    });
    hold.queue = turn.then(() => {}, () => {});
    const app = await turn;
    return json(res, 200, { ok: true, app });
  }

  return [
    { method: 'POST', path: '/api/computer/takeover', handler: takeoverRoute },
    { method: 'POST', path: '/api/computer/live', handler: liveRoute },
    { method: 'POST', path: '/api/computer/input', handler: inputRoute },
  ];
}
