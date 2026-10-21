// Quick compare: one prompt goes to two to four models at once, each answer streams into its own column, and the
// user keeps the one to continue from. Only Keep writes to the chat. The seats run as council seats do: read-only, with
// no tools and no session, and each seat runs in an empty scratch folder that is deleted afterwards. See lib/routes/index.mjs.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCouncil } from '../council.mjs';
import { streamChat } from '../providers.mjs';
import { forgetSession as forgetNativeSession } from '../sessions.mjs';

export const MIN_SEATS = 2;
export const MAX_SEATS = 4;
// The same cap as a chat turn (MAX_PROMPT in lib/providers.mjs). Every seat gets the whole prompt.
const MAX_PROMPT = 150_000;
// The longest reply Keep will write to the chat. The server checks it, so a client cannot write more.
const MAX_REPLY = 200_000;
// Said to every seat, so the replies can be compared. A seat cannot open files, so it answers from the message alone.
const SYSTEM = 'This is a side-by-side comparison: several models get the same message, and the user will keep one reply. You have no tools and cannot open or change any files, so answer the message itself.';
const ABORTED = Symbol('aborted');

// The message a seat shows: the provider's own words when it gave them, cut to a readable length.
function errorText(err) {
  const api = err?.error?.error?.message;
  const text = String(api ? `${api}${err.status ? ` (HTTP ${err.status})` : ''}` : err?.message ?? err).trim();
  return text.length > 800 ? `${text.slice(0, 800)}…` : text || 'Unknown error.';
}

// The prompt as the chat stores it: trimmed, present, and no longer than a chat turn may be.
function checkPrompt(raw) {
  const prompt = typeof raw === 'string' ? raw.trim() : '';
  if (!prompt) throw new Error('Write a prompt first.');
  if (prompt.length > MAX_PROMPT) throw new Error(`The prompt is ${prompt.length.toLocaleString('en-US')} characters. The limit is ${MAX_PROMPT.toLocaleString('en-US')}; shorten it.`);
  return prompt;
}

// Checks the seats of a quick compare: 2 to 4 models, each one the council accepts, and one effort for all of them.
// Returns [{ id, ref, effort }] with the refs in the council's form, provider:model. Throws an Error with a message for the user.
export function checkCompareSeats(seats, effort) {
  if (!Array.isArray(seats)) throw new Error('Quick compare needs 2 to 4 seats, sent as a list of models.');
  if (seats.length < MIN_SEATS || seats.length > MAX_SEATS) throw new Error(`Quick compare needs 2 to 4 seats; this one has ${seats.length}.`);
  // The council's own check runs on the seats, so a model is accepted here exactly when the council would accept it.
  const { seats: checked } = normalizeCouncil({ seats: seats.map(ref => ({ ref, effort })), moderator: { ref: seats[0] } });
  return checked.map(s => ({ id: s.id, ref: s.ref, effort: s.effort }));
}

// One model, checked the same way. A council needs two seats, so the rules run on a pair of the same model.
export function checkSeatRef(raw) {
  return checkCompareSeats([raw, raw])[0].ref;
}

// Lets several seats push events while one consumer pulls them in arrival order.
function createQueue() {
  const items = [];
  let wake = null;
  return {
    push(item) {
      items.push(item);
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    async next() {
      while (!items.length) await new Promise(r => { wake = r; });
      return items.shift();
    },
  };
}

// Iterates a stream but gives up the moment the signal fires, even if the provider is slow to notice.
async function* abortable(iterable, signal) {
  const it = iterable[Symbol.asyncIterator]();
  let onAbort;
  const gone = new Promise(resolve => {
    onAbort = () => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    for (;;) {
      const pending = it.next();
      pending.catch(() => {}); // if the abort wins the race, a later failure of this call is not news
      const r = await Promise.race([pending, gone]);
      if (r === ABORTED || r.done) return;
      yield r.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    Promise.resolve(it.return?.()).catch(() => {});
  }
}

const removeScratch = dir => (dir ? fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}) : null);

// Runs one seat, pushing its events to the queue. Never throws: a failure is reported as the seat's own done event.
async function runSeat({ seat, prompt, signal, queue }) {
  let text = '';
  let error = '';
  let scratch = null;
  try {
    // Each seat gets a fresh, empty folder, so a CLI seat cannot reach the project.
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'plenum-compare-'));
    const stream = streamChat(seat.ref, { system: SYSTEM, messages: [{ role: 'user', content: prompt }], cwd: scratch, signal, effort: seat.effort, readOnly: true });
    for await (const delta of abortable(stream, signal)) {
      if (!delta) continue;
      text += delta;
      queue.push({ type: 'delta', seat: seat.id, text: delta });
    }
  } catch (err) {
    if (!signal.aborted) error = errorText(err);
  } finally {
    await removeScratch(scratch);
  }
  if (signal.aborted) error = 'Stopped.';
  else if (!error && !text.trim()) error = 'The model returned no answer.';
  queue.push({ type: 'done', seat: seat.id, ok: !error, text, ...(error ? { error } : {}) });
}

// Runs every seat at once and yields their events as they arrive: a delta for each piece of text, then one done per seat.
async function* runCompare({ prompt, seats, signal }) {
  const queue = createQueue();
  const END = Symbol('end');
  const all = Promise.all(seats.map(seat => runSeat({ seat, prompt, signal, queue }))).finally(() => queue.push(END));
  for (;;) {
    const item = await queue.next();
    if (item === END) break;
    yield item;
  }
  await all;
}

// POST /api/compare. Streams a delta event for each piece of text, and a done event per seat ({ type: 'done', seat, ok, text, error? }).
// streamForProject sends the server's own final done event, with no seat, when the run ends.
async function compareRoute({ req, res, readBody, httpError, projectById, streamForProject }) {
  const body = (await readBody(req)) ?? {};
  const project = projectById(body.project);
  let prompt;
  let seats;
  try {
    prompt = checkPrompt(body.prompt);
    seats = checkCompareSeats(body.seats, body.effort);
  } catch (err) {
    throw httpError(400, err.message);
  }
  // Nothing is written to the chat here. streamForProject refuses a project that is already running.
  return streamForProject(req, res, project, async ({ signal }) => runCompare({ prompt, seats, signal }));
}

// POST /api/compare/keep. Writes the prompt and the chosen reply to the chat, in the shape a chat turn writes them,
// then forgets the kept seat's native session, which never saw that exchange. The next turn rebuilds it from the chat.
async function keepRoute({ req, res, readBody, httpError, store, projectById, running, publicState, json, forgetSession = forgetNativeSession }) {
  const body = (await readBody(req)) ?? {};
  const project = projectById(body.project);
  // Like the other writes to a chat, it waits until the project is idle, so the kept turn cannot land in the middle of a reply.
  if (running.has(project.id)) throw httpError(409, 'This project is busy. Use /cancel first.');
  let prompt;
  let ref;
  try {
    prompt = checkPrompt(body.prompt);
    ref = checkSeatRef(body.seat);
  } catch (err) {
    throw httpError(400, err.message);
  }
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) throw httpError(400, 'That reply is empty, so there is nothing to keep.');
  if (text.length > MAX_REPLY) throw httpError(400, `The reply is ${text.length.toLocaleString('en-US')} characters. The limit is ${MAX_REPLY.toLocaleString('en-US')}, so it cannot be kept.`);
  store.addMessage(project.id, { role: 'user', kind: 'chat', content: prompt, attached: [] });
  store.addMessage(project.id, { role: 'assistant', kind: 'chat', model: ref, content: text });
  await store.persist();
  // Only after the transcript is saved. Without this, a native seat would resume a CLI session that lacks the kept exchange.
  forgetSession(project.id, ref);
  return json(res, 200, publicState());
}

export const routes = [
  { method: 'POST', path: '/api/compare', handler: compareRoute },
  { method: 'POST', path: '/api/compare/keep', handler: keepRoute },
];
