// The server's side of the desktop shell's message channel: a request that waits for the shell's answer, and the messages the shell
// sends on its own. The channel is the one lib/keys.mjs opens (parentChannel): the desktop app's utility-process port, or nothing
// when Plenum was started with plain Node. Requests are matched by id, so a reply meant for another request is never taken.
//  - shellRequest(type, payload, { timeoutMs }) posts { ...payload, type, id } and resolves the reply whose type is `${type}-result`
//    and whose id matches (the reply as the shell sent it: busy, path, ok and so on).
//  - onShellMessage(type, fn) gets the unsolicited messages of one type (a type that does not end in -result).
//  - shellPost(message) sends one message and does not wait.
// Nothing here logs, and nothing here adds a key or a token to a message: a caller decides what its payload holds.
import { randomUUID } from 'node:crypto';
import { parentChannel } from './keys.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const NO_DESKTOP = 'This needs the Plenum desktop app, and Plenum was started with node.';
const NO_ANSWER = 'The desktop app did not answer in time.';
const NOT_REACHED = 'The desktop app could not be reached.';

// The channel, looked up once: undefined until the first use, then the channel or null when there is none (plain Node).
let channel;
// Channels this module has added its listener to, so the listener is added once per channel.
const listening = new WeakSet();
// Requests waiting for an answer: request id -> { reply: `${type}-result`, resolve, timer }.
const waiting = new Map();
// Listeners for unsolicited messages: type -> Set of functions.
const subscribers = new Map();

// The desktop channel, or null when there is none. Looked up on first use.
export function shellChannel() {
  if (channel === undefined) channel = parentChannel();
  return channel;
}

// Whether the desktop app is there to answer. False under plain Node.
export function shellAvailable() {
  return shellChannel() !== null;
}

function failure(message, status) {
  return Object.assign(new Error(message), { status });
}

// Routes one message from the shell: a reply goes to the request it answers; anything else goes to its type's listeners.
// A reply nobody waits for is dropped, and a listener that throws never stops the others.
function dispatch(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  if (msg.type.endsWith('-result')) {
    const request = waiting.get(msg.id);
    if (!request || msg.type !== request.reply) return;
    waiting.delete(msg.id);
    clearTimeout(request.timer);
    request.resolve(msg);
    return;
  }
  const listeners = subscribers.get(msg.type);
  if (!listeners) return;
  for (const fn of [...listeners]) {
    try {
      fn(msg);
    } catch {
      // A listener that throws changes nothing for the others.
    }
  }
}

// Adds this module's one listener to a channel, the first time the channel is used.
function listen(ch) {
  if (listening.has(ch)) return;
  listening.add(ch);
  ch.onMessage(dispatch);
}

// Asks the desktop app to do one thing and resolves with its reply. Rejects with an Error that has a status:
//  - 503 when there is no desktop app (plain Node);
//  - 504 when no reply with this request's id came within timeoutMs;
//  - 500 when the message could not be posted.
// `channel` is for callers and tests that hold their own channel; it defaults to the desktop channel.
export function shellRequest(type, payload = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, channel: given } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof type !== 'string' || type.length === 0) {
      reject(new TypeError('A shell request needs a message type.'));
      return;
    }
    const ch = given === undefined ? shellChannel() : given;
    if (!ch) {
      reject(failure(NO_DESKTOP, 503));
      return;
    }
    listen(ch);
    const id = randomUUID();
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(failure(NO_ANSWER, 504));
    }, timeoutMs);
    waiting.set(id, { reply: `${type}-result`, resolve, timer });
    try {
      // type and id are ours, so the payload cannot change them.
      ch.post({ ...payload, type, id });
    } catch {
      clearTimeout(timer);
      waiting.delete(id);
      reject(failure(NOT_REACHED, 500));
    }
  });
}

// Listens for unsolicited messages of one type from the shell (the browser and computer features use it for events). Returns a
// function that stops the listening. Replies (types ending in -result) belong to shellRequest and cannot be listened to here.
export function onShellMessage(type, fn) {
  if (typeof type !== 'string' || type.length === 0 || type.endsWith('-result')) {
    throw new TypeError('A shell message listener needs a type that is not a -result reply.');
  }
  if (typeof fn !== 'function') throw new TypeError('A shell message listener needs a function.');
  const ch = shellChannel();
  if (ch) listen(ch);
  let listeners = subscribers.get(type);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(type, listeners);
  }
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && subscribers.get(type) === listeners) subscribers.delete(type);
  };
}

// Sends one message to the shell without waiting for anything. Returns false when it could not be sent (no desktop app, or the
// post failed); it never throws.
export function shellPost(message, { channel: given } = {}) {
  const ch = given === undefined ? shellChannel() : given;
  if (!ch) return false;
  try {
    ch.post(message);
    return true;
  } catch {
    return false;
  }
}
