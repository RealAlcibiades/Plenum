// Edit and regenerate from an earlier question: the chat is cut back to that question, and the question's text goes back to
// the page to edit or send again. The messages that are cut are kept by lib/archive.mjs. The server checks X-Muse-Console on
// every POST before these handlers run.
import { keepArchive } from '../archive.mjs';
import { forgetProjectSessions } from '../sessions.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  { method: 'POST', path: '/api/chat/rewind', handler: rewindRoute },
];

// Only a question the person typed in chat can be the place to cut from: not a summary, a council question, a build note
// or a reply.
const editable = m => m.role === 'user' && m.kind === 'chat' && !m.compact;

// POST /api/chat/rewind with { project, index }. Removes the message at index and every message after it. The removed
// messages go to the archive (Undo), which puts them back after the messages that stayed while the chat is unchanged. The
// answer carries the question's text so the page can put it back.
async function rewindRoute({ req, res, readBody, json, projectById, httpError, store, publicState, running }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the message index.');
  const project = projectById(body.project);
  if (running.has(project.id)) throw httpError(409, 'This project is running. Use /cancel first.');
  const log = store.transcript(project.id);
  const index = body.index;
  if (!Number.isInteger(index) || index < 0 || index >= log.length || !editable(log[index])) {
    throw httpError(400, 'That message cannot be edited.');
  }
  const removed = log.splice(index);
  // The messages that stayed are passed too, so Undo can check that the chat has not moved on before it restores.
  keepArchive(project.id, removed, 'rewind', log);
  // The CLI sessions were started from the chat that is now cut, so the next turn starts a fresh one.
  forgetProjectSessions(project.id);
  await store.persist();
  return json(res, 200, { ...publicState(), removed: removed.length, text: removed[0].content });
}
