// Folder picker for "Browse…" in the add-project form. The native folder dialog belongs to the desktop shell, which holds the
// window. This module asks it over the same message channel the saved keys use (lib/keys.mjs) and waits for the answer.
// Under plain `node server.mjs` there is no channel, and the picker is reported as unavailable.
// Nothing is read from the folder here: the chosen path goes through POST /api/projects like a typed one.
import { randomUUID } from 'node:crypto';
import { parentChannel } from './keys.mjs';

// How long to wait for the person to choose a folder, or cancel, in the dialog. The desktop app keeps its dialog open until it is
// answered, so this is long: a shorter wait would give up while the dialog is still on screen.
const TIMEOUT_MS = 600_000;
// A path longer than this cannot be a real folder path, so it is refused rather than passed on.
const MAX_PATH = 4096;

// Picks waiting for an answer: request id -> { resolve, reject, timer }. Only one dialog is open at a time.
const pending = new Map();
// The channel the reply listener is on, so the listener is added once per channel.
let listening = null;
// The desktop channel, looked up on first use. null means there is none (plain Node).
let fallback;

function defaultChannel() {
  if (fallback === undefined) fallback = parentChannel();
  return fallback;
}

// The refusal for a pick while a folder dialog is open, here or in the desktop app.
const busyError = () => Object.assign(new Error('A folder picker is already open.'), { status: 409 });

// Only the reply a pick is waiting for is used. Every other message type is ignored.
function onReply(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== 'pick-folder-result') return;
  const waiting = pending.get(msg.id);
  if (!waiting) return;
  pending.delete(msg.id);
  clearTimeout(waiting.timer);
  // The desktop app answers busy when its dialog is already open. That is a refusal, not a cancelled dialog.
  if (msg.busy === true) {
    waiting.reject(busyError());
    return;
  }
  const folder = typeof msg.path === 'string' && msg.path.length > 0 && msg.path.length <= MAX_PATH ? msg.path : null;
  waiting.resolve(folder);
}

function listenOn(channel) {
  if (listening === channel) return;
  listening = channel;
  channel.onMessage(onReply);
}

// Asks the desktop app to open the folder dialog and resolves with its answer:
//  - { available: false } when there is no desktop app;
//  - { available: true, path } with the folder, or path null when the dialog was cancelled;
//  - { available: true, path: null, timedOut: true } when no answer came in time.
// Throws an Error with status 409 while another pick is still open, here or in the desktop app (its dialog is already open).
export async function pickFolder({ channel = defaultChannel(), timeoutMs = TIMEOUT_MS } = {}) {
  if (!channel) return { available: false };
  if (pending.size > 0) throw busyError();
  listenOn(channel);
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ available: true, path: null, timedOut: true });
    }, timeoutMs);
    pending.set(id, { timer, resolve: path => resolve({ available: true, path }), reject });
    try {
      channel.post({ type: 'pick-folder', id });
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      reject(Object.assign(new Error('The folder picker could not be opened.'), { status: 500 }));
    }
  });
}
