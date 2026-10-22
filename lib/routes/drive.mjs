// The drive controls (lib/drive.mjs): what the drive bar and the drive pill send. GET /api/drive lists the live drives and the state of
// the stop key. POST /api/drive/pause, /resume and /stop take { id } and act on that drive only, so no run can be started here.
// POST /api/drive/show-app brings Plenum's window forward through the desktop app; under plain node it answers 400.
// The server checks the Plenum token on every /api/ request before any handler runs. The four POST routes check it again
// (requireToken) before they read the body or touch a run, so each is safe on its own.
import { requireToken } from '../auth.mjs';
import { getDrive, hotkeyStatus, listDrives } from '../drive.mjs';
import { shellPost } from '../shell.mjs';
import { cleanReason } from '../tools.mjs';

export const routes = [
  { method: 'GET', path: '/api/drive', handler: listRoute },
  { method: 'POST', path: '/api/drive/pause', handler: pauseRoute },
  { method: 'POST', path: '/api/drive/resume', handler: resumeRoute },
  { method: 'POST', path: '/api/drive/stop', handler: stopRoute },
  { method: 'POST', path: '/api/drive/show-app', handler: showRoute },
];

// Answers { drives, hotkey }: every live drive's summary, newest first, and the stop key's state.
async function listRoute({ res, json }) {
  return json(res, 200, { drives: listDrives(), hotkey: hotkeyStatus() });
}

// Reads the body and finds the live drive its id names. A drive that has stopped is no longer in the registry, so it answers 404.
async function driveFromBody({ req, readBody, httpError }) {
  const body = await readBody(req);
  const drive = typeof body.id === 'string' ? getDrive(body.id) : null;
  if (!drive) throw httpError(404, 'That run is no longer driving anything.');
  return { drive, body };
}

// Pause is the person's own pause. The state machine's refusals (for example pausing a stopped run) pass through with their 409.
async function pauseRoute(args) {
  requireToken(args.req, args.httpError);
  const { drive } = await driveFromBody(args);
  drive.pause('user');
  return args.json(args.res, 200, { drive: drive.summary() });
}

// Resume is the person's own. A run paused for a card answers 409 here: the card is answered first, or the run is stopped.
async function resumeRoute(args) {
  requireToken(args.req, args.httpError);
  const { drive } = await driveFromBody(args);
  drive.resume('user');
  return args.json(args.res, 200, { drive: drive.summary() });
}

// Stop ends the run. An optional reason is cleaned like a denial's reason and recorded with the stop.
async function stopRoute(args) {
  requireToken(args.req, args.httpError);
  const { drive, body } = await driveFromBody(args);
  const reason = cleanReason(body.reason);
  drive.stop(reason ? 'user: ' + reason : 'user');
  return args.json(args.res, 200, { drive: drive.summary() });
}

// Brings Plenum's window to the front, for the bar's "Show Plenum" while a card waits. Nothing else happens in the desktop app.
async function showRoute({ req, res, readBody, json, httpError }) {
  requireToken(req, httpError);
  await readBody(req);
  if (!shellPost({ type: 'drive-show' })) throw httpError(400, 'This needs the desktop app.');
  return json(res, 200, { ok: true });
}
