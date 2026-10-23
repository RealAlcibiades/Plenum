// Quick compare: one prompt goes to two to four models at once, each answer streams into its own column, and the
// user keeps the one to continue from. Only Keep writes to the chat. The seats run as council seats do: read-only, with
// no tools and no session, and each seat runs in an empty scratch folder that is deleted afterwards. See lib/routes/index.mjs.
//
// Agents (agent-roles). A column can be allowed to start read-only agents in Agents > Limits (the Quick compare columns row, or a
// per-model override). runCompare is then given { project, agents, run } and each column's model gets the tool context seatContext
// (lib/agent-run.mjs) builds: the delegate tool alone, counted for that column. The column still has no file tool and still runs in its
// empty scratch folder. The agents' events (agent-start, agent-state, agent-done, tool, tool_result) go on the stream with `seat` set;
// the panel reads only delta, done and error, so it ignores them. One run covers all the columns and is closed when the stream ends.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRef, imagesFor, normalizeCouncil, withImageNote } from '../council.mjs';
import { buildSystem } from '../prompt.mjs';
import { streamChat } from '../providers.mjs';
import { forgetSession as forgetNativeSession } from '../sessions.mjs';
import * as realStore from '../store.mjs';
import { effectiveAgents } from '../agents.mjs';
import { checkImages, plainName } from '../images.mjs';
import { approvalModeOf, denyPatternsOf, effectiveSettings } from '../projects.mjs';
import { scopeOrMain, threadOf } from '../scope.mjs';

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

// One model, checked the same way the council checks a seat (checkRef). The message names the seat's letter when the client
// sends a valid one (seatId a, b, c or d), and "Quick compare" otherwise, so a bad model is never reported under the wrong seat.
const SEAT_LETTERS = ['a', 'b', 'c', 'd'];
export function checkSeatRef(raw, seatId) {
  const letter = typeof seatId === 'string' ? seatId.trim().toLowerCase() : '';
  return checkRef(raw, SEAT_LETTERS.includes(letter) ? `Seat ${letter.toUpperCase()}` : 'Quick compare');
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

// lib/agent-run.mjs is imported when a column that may start agents needs it, never at load time.
let agentRunLib = null;
const agentRun = () => (agentRunLib ??= import('../agent-run.mjs'));

// Runs one seat, pushing its events to the queue. Never throws: a failure is reported as the seat's own done event.
// `agentOpts` ({ project, agents, run, ... }) is present when the compare may let a column start agents.
// `images` (optional) are the checked pictures of the prompt. A column gets the ones its model takes (imagesFor), and a note otherwise.
async function runSeat({ seat, prompt, signal, queue, root, agentOpts, images = [] }) {
  let text = '';
  let error = '';
  let scratch = null;
  try {
    // Each seat gets a fresh, empty folder, so a CLI seat cannot reach the project.
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'plenum-compare-'));
    const base = await buildSystem('compare', { root, readOnly: true, ref: seat.ref, base: [SYSTEM] });
    const lib = agentOpts ? await agentRun() : null;
    const column = SEAT_LETTERS.indexOf(seat.id) + 1;
    const ctx = await lib?.seatContextFor({ ...agentOpts, role: 'compare', ref: seat.ref, seatId: seat.id, label: column > 0 ? `Column ${column}` : `Column ${seat.id}`, signal, emit: ev => queue.push({ ...ev, seat: seat.id }), effort: seat.effort, readOnlyCwd: scratch });
    const system = ctx ? lib.seatSystemWith(base, ctx) : base;
    const pictures = imagesFor(seat.ref, images);
    const stream = streamChat(seat.ref, { system, messages: [{ role: 'user', content: withImageNote(prompt, pictures.note) }], cwd: scratch, signal, effort: seat.effort, readOnly: true, images: pictures.images, ...(ctx ? { ctx } : {}) });
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
// `project`, `agents` (effectiveAgents) and `run` (openRun, closed by the caller: withRun in lib/agent-run.mjs) let a column start
// read-only agents within its limits; denyPatterns, tools, mode and approve matter only for a role whose cards are on.
async function* runCompare({ prompt, seats, signal, root, project, agents, run, denyPatterns, tools, mode, approve, images = [] }) {
  const queue = createQueue();
  const END = Symbol('end');
  const agentOpts = project && agents && run ? { project, agents, run, denyPatterns, tools, mode, approve } : null;
  const all = Promise.all(seats.map(seat => runSeat({ seat, prompt, signal, queue, root, agentOpts, images }))).finally(() => queue.push(END));
  for (;;) {
    const item = await queue.next();
    if (item === END) break;
    yield item;
  }
  await all;
}

// What a column's agents need once their cards are on (ROLE_META.cards, amendment 21): the run's approval, the project's deny patterns,
// its CLI options and its approval mode. The same four values a council seat is given (server.mjs). Without an approve, an edit type
// is refused rather than asked, so a caller that gives none stays read-only.
function cardsOf({ store, project, approve }) {
  const st = (store?.get ? store : realStore).get();
  return { approve, denyPatterns: denyPatternsOf(project), tools: effectiveSettings(st, project).tools, mode: approvalModeOf(st, project) };
}

// POST /api/compare. Streams a delta event for each piece of text, and a done event per seat ({ type: 'done', seat, ok, text, error? }).
// streamForProject sends the server's own final done event, with no seat, when the run ends.
async function compareRoute({ req, res, readBody, httpError, projectById, streamForProject, store, approvalRequester }) {
  const body = (await readBody(req)) ?? {};
  const project = projectById(body.project);
  let prompt;
  let seats;
  let images;
  try {
    prompt = checkPrompt(body.prompt);
    seats = checkCompareSeats(body.seats, body.effort);
    // The pictures sent with the prompt (pro-07 step 2), checked like a chat message's before any column starts.
    images = checkImages({ sent: body.images });
  } catch (err) {
    throw httpError(400, err.message);
  }
  // Nothing is written to the chat here. streamForProject refuses a thread that is already running. The run is the thread's (body.thread,
  // else the project's active thread); the columns run in their own empty folders, so the thread only names the run on the board.
  return streamForProject(req, res, project, async ({ signal, send, scope }) => {
    // One run for the whole compare: every column's agents count against the same ceiling (lib/agent-run.mjs).
    let agents = null;
    try {
      agents = effectiveAgents((store?.get ? store : realStore).get(), project);
    } catch {
      agents = null;
    }
    const root = scope?.root ?? project.path;
    if (!agents) return runCompare({ prompt, seats, signal, root, images });
    const { openRun, withRun } = await agentRun();
    const run = openRun({ projectId: project.id, kind: 'compare', signal });
    // The cards of a column's agents go to the Agents board and to this window's chat, as a council seat's do (server.mjs approvalRequester).
    const approve = typeof approvalRequester === 'function' ? approvalRequester(send, signal) : undefined;
    return withRun(run, runCompare({ prompt, seats, signal, root, project, agents, run, images, ...cardsOf({ store, project, approve }) }));
  }, undefined, { kind: 'compare' });
}

// POST /api/compare/keep. Writes the prompt and the chosen reply to the chat, in the shape a chat turn writes them,
// then forgets the kept seat's native session, which never saw that exchange. The next turn rebuilds it from the chat.
async function keepRoute({ req, res, readBody, httpError, store, projectById, running, publicState, json, forgetSession = forgetNativeSession }) {
  const body = (await readBody(req)) ?? {};
  const project = projectById(body.project);
  const scope = scopeOrMain(store, project, threadOf(body));
  // Like the other writes to a chat, it waits until the thread is idle, so the kept turn cannot land in the middle of a reply.
  if (running.has(scope.id)) throw httpError(409, 'This project is busy. Use /cancel first.');
  let prompt;
  let ref;
  try {
    prompt = checkPrompt(body.prompt);
    ref = checkSeatRef(body.seat, body.seatId);
  } catch (err) {
    throw httpError(400, err.message);
  }
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) throw httpError(400, 'That reply is empty, so there is nothing to keep.');
  if (text.length > MAX_REPLY) throw httpError(400, `The reply is ${text.length.toLocaleString('en-US')} characters. The limit is ${MAX_REPLY.toLocaleString('en-US')}, so it cannot be kept.`);
  // The pictures the compare was sent with are kept as a name and a size, as a chat message keeps them (never their bytes).
  const kept = Array.isArray(body.images)
    ? body.images.slice(0, 4).map(item => ({ name: plainName(item?.name, 'image'), size: Math.max(0, Math.floor(Number(item?.size)) || 0) }))
    : [];
  store.addMessage(scope.id, { role: 'user', kind: 'chat', content: prompt, attached: [], ...(kept.length ? { images: kept } : {}) });
  store.addMessage(scope.id, { role: 'assistant', kind: 'chat', model: ref, content: text });
  await store.saveOrFail();
  // Only after the transcript is saved. Without this, a native seat would resume a CLI session that lacks the kept exchange.
  forgetSession(scope.id, ref);
  return json(res, 200, publicState());
}

export const routes = [
  { method: 'POST', path: '/api/compare', handler: compareRoute },
  { method: 'POST', path: '/api/compare/keep', handler: keepRoute },
];
