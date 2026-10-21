// Folder picker for "Browse…" in the add-project form. The native folder dialog belongs to the desktop shell, which holds the
// window. This module asks it over the desktop message channel (lib/shell.mjs) and waits for the answer. The shell side is
// desktop/handlers/pick-folder.cjs.
// Under plain `node server.mjs` there is no channel, and the picker is reported as unavailable.
// Nothing is read from the folder here: the chosen path goes through POST /api/projects like a typed one.
import { shellChannel, shellRequest } from './shell.mjs';

// How long to wait for the person to choose a folder, or cancel, in the dialog. The desktop app keeps its dialog open until it is
// answered, so this is long: a shorter wait would give up while the dialog is still on screen.
const TIMEOUT_MS = 600_000;
// A path longer than this cannot be a real folder path, so it is refused rather than passed on.
const MAX_PATH = 4096;

// True while a pick is waiting for its answer. Only one dialog is open at a time.
let picking = false;

// The refusal for a pick while a folder dialog is open, here or in the desktop app.
const busyError = () => Object.assign(new Error('A folder picker is already open.'), { status: 409 });

// Asks the desktop app to open the folder dialog and resolves with its answer:
//  - { available: false } when there is no desktop app;
//  - { available: true, path } with the folder, or path null when the dialog was cancelled;
//  - { available: true, path: null, timedOut: true } when no answer came in time.
// Throws an Error with status 409 while another pick is still open, here or in the desktop app (its dialog is already open).
// `channel` is for tests; it defaults to the desktop channel, and null means there is none.
export async function pickFolder({ channel, timeoutMs = TIMEOUT_MS } = {}) {
  const ch = channel === undefined ? shellChannel() : channel;
  if (!ch) return { available: false };
  if (picking) throw busyError();
  picking = true;
  try {
    let reply;
    try {
      reply = await shellRequest('pick-folder', {}, { timeoutMs, channel: ch });
    } catch (err) {
      if (err?.status === 504) return { available: true, path: null, timedOut: true };
      if (err?.status === 500) throw Object.assign(new Error('The folder picker could not be opened.'), { status: 500 });
      throw err;
    }
    // The desktop app answers busy when its dialog is already open. That is a refusal, not a cancelled dialog.
    if (reply.busy === true) throw busyError();
    const folder = typeof reply.path === 'string' && reply.path.length > 0 && reply.path.length <= MAX_PATH ? reply.path : null;
    return { available: true, path: folder };
  } finally {
    picking = false;
  }
}
