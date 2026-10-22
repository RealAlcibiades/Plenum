// Undo for /clear, /compact and Edit: put the kept chat back, or drop it. The kept chat is stored by lib/archive.mjs, which the
// clear and compact handlers in server.mjs and the rewind route fill. The server checks X-Muse-Console on every POST before
// these handlers run.
import { clearArchive, peekArchive, rewindFits, takeArchive } from '../archive.mjs';
import { forgetProjectSessions } from '../sessions.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// How many messages the live chat may hold and still take the kept chat back after a clear or a compact: none after a clear,
// and only the summary after a compact. An Edit is checked by rewindFits instead.
const allowedLive = reason => (reason === 'compact' ? 1 : 0);

export const routes = [
  { method: 'POST', path: '/api/chat/restore', handler: restoreRoute },
  { method: 'POST', path: '/api/chat/archive/discard', handler: discardRoute },
];

// POST /api/chat/restore with { project }. The kept messages replace the live chat, in their original order and with their
// original times. After an Edit they go back after the messages that stayed instead, and only while the chat is unchanged.
// The entry stays in place when the restore is refused, so it is only taken once the restore goes ahead.
async function restoreRoute({ req, res, readBody, json, projectById, httpError, store, publicState, running }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id.');
  const project = projectById(body.project);
  if (running.has(project.id)) throw httpError(409, 'This project is running. Use /cancel first.');
  const kept = peekArchive(project.id);
  if (!kept) throw httpError(404, 'Nothing to undo.');
  const log = store.transcript(project.id);
  if (kept.reason === 'rewind') {
    if (!rewindFits(project.id, log)) {
      throw httpError(409, 'The chat has changed since the Edit, so the removed messages cannot be put back.');
    }
  } else if (log.length > allowedLive(kept.reason)) {
    throw httpError(409, 'The chat has new messages, so the old chat cannot be put back.');
  }
  const entry = takeArchive(project.id);
  if (entry.reason === 'rewind') {
    // The Edit only cut the chat, so the removed messages follow the ones that stayed. The composer is left as it is.
    log.push(...entry.messages);
  } else {
    log.length = 0;
    log.push(...entry.messages);
  }
  // The CLI sessions were started from the chat that is now replaced, so the next turn starts a fresh one.
  forgetProjectSessions(project.id);
  await store.saveOrFail();
  return json(res, 200, publicState());
}

// POST /api/chat/archive/discard with { project }. Drops the kept chat, so the Undo line goes away for good.
async function discardRoute({ req, res, readBody, json, projectById, httpError, store }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id.');
  const project = projectById(body.project);
  clearArchive(project.id);
  await store.saveOrFail();
  return json(res, 200, { ok: true });
}
