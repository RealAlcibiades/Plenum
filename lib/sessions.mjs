import { randomUUID } from 'node:crypto';
import { get, persist } from './store.mjs';

// Native sessions: a chat seat's CLI keeps its own conversation, so a turn sends only the new message.
// Each project and seat has one record in the app state: sessions[projectId][ref] =
// { provider, sessionId, createdAt, lastUsedAt }. lastUsedAt stays null until a turn has finished.
//
// Which CLIs can resume, checked against each CLI's --help (no prompt was sent):
//   Claude Code 2.1.296: --session-id <uuid> starts a session with our id; --resume <session-id> continues it.
//   Codex 0.162.1: `exec resume <SESSION_ID>` continues one; `exec --json` prints events that carry the id.
//   Gemini 0.63.0: --session-id <uuid> starts one, but --resume is described as "latest" or an index,
//     so resuming by id is not shown. Off until someone confirms it.
//   Muse Code 1.4.7: exec has --session-id, but the only resume shown is the interactive `muse resume`. Off.
const RESUMABLE = new Set(['anthropic', 'codex']);
// Providers whose CLI takes an id we choose. Codex prints its own id instead.
const CHOOSES_ID = new Set(['anthropic', 'gemini']);
const LABEL = { anthropic: 'Claude', codex: 'Codex', gemini: 'Gemini', muse: 'Muse Code', cursor: 'Cursor', grok: 'Grok Build', echo: 'Test' };
// What a CLI says when the session it was asked to resume does not exist.
const GONE = /no (saved |previous )?(conversation|session|thread)|(conversation|session|thread) .{0,60}(not found|does not exist|no longer)|no such (session|thread)|unknown (session|thread|conversation)|invalid session identifier/i;

const providerOf = ref => ref.slice(0, ref.indexOf(':'));
export const sessionLabel = ref => LABEL[providerOf(ref)] ?? providerOf(ref);

// 'native' or 'transcript' (the default, and what every older state file means).
export const sessionMode = (settings = get()) => (settings.sessionMode === 'native' ? 'native' : 'transcript');

// True only in native mode, and only for a provider whose CLI resumes by id.
export const sessionEnabled = (ref, settings = get()) => sessionMode(settings) === 'native' && RESUMABLE.has(providerOf(ref));

export function getSession(projectId, ref) {
  return get().sessions?.[projectId]?.[ref] ?? null;
}

// Starts a record for a seat. Claude and Gemini get their UUID now; Codex's id comes with its first reply.
// Muse Code has no verified resume, so it gets no record (null).
export function newSession(projectId, ref) {
  const provider = providerOf(ref);
  if (!RESUMABLE.has(provider) && !CHOOSES_ID.has(provider)) return null;
  const rec = { provider, sessionId: CHOOSES_ID.has(provider) ? randomUUID() : null, createdAt: Date.now(), lastUsedAt: null };
  const s = get();
  s.sessions ??= {};
  s.sessions[projectId] ??= {};
  s.sessions[projectId][ref] = rec;
  persist();
  return rec;
}

export function forgetSession(projectId, ref) {
  const s = get();
  if (!s.sessions?.[projectId]?.[ref]) return;
  delete s.sessions[projectId][ref];
  persist();
}

// Clears every seat's session for a project. Call it after /clear and /compact, so the CLI does not keep the old chat.
export function forgetProjectSessions(projectId) {
  const s = get();
  if (!s.sessions?.[projectId]) return;
  delete s.sessions[projectId];
  persist();
}

// Runs in progress, one per project and seat. A second run on the same session is refused, not queued.
const busy = new Set();

// Opens the session for one chat turn. Returns null when the turn is not native, so the caller uses the transcript.
// `emit` receives the notice events. Throws at once if the session is busy.
// lastReplyModel: the model that wrote the most recent chat reply before this turn (null if none). When another
// model answered after this seat last replied, the seat's session has not seen that reply, so it is not resumed.
// The returned object: { sessionId, resume, moved, emit, setId, fallBack, touch, release }.
// A record counts as resumable only after one turn has finished. An unfinished one is replaced, so a failed
// first turn leaves nothing that a later turn would try to resume.
export function openSession(projectId, ref, { emit, lastReplyModel = null } = {}) {
  if (!projectId || !sessionEnabled(ref)) return null;
  const key = `${projectId}\n${ref}`;
  if (busy.has(key)) {
    throw new Error(`The ${sessionLabel(ref)} session for this chat is busy: another reply is still using it. Wait for it to finish, or use /cancel, then send again.`);
  }
  busy.add(key);
  let rec = getSession(projectId, ref);
  const hadSession = !!(rec?.sessionId && rec.lastUsedAt);
  const inStep = lastReplyModel == null || lastReplyModel === ref;
  const resume = hadSession && inStep;
  if (!resume) rec = newSession(projectId, ref);
  // A record that /clear or a newer run has replaced is left alone.
  const current = () => getSession(projectId, ref) === rec;
  const live = {
    sessionId: rec.sessionId,
    resume,
    moved: hadSession && !inStep,
    emit: typeof emit === 'function' ? emit : () => {},
    // Codex: the id its first reply printed.
    setId(id) {
      live.sessionId = id;
      if (current()) {
        rec.sessionId = id;
        persist();
      }
    },
    // The CLI no longer has the session: start over with a fresh record. The caller then sends the whole transcript.
    fallBack() {
      rec = newSession(projectId, ref);
      live.sessionId = rec.sessionId;
      live.resume = false;
    },
    touch() {
      if (current()) {
        rec.lastUsedAt = Date.now();
        persist();
      }
    },
    release() {
      busy.delete(key);
    },
  };
  return live;
}

// The one failure a native turn answers with a fresh session: the CLI does not have the session it was asked to resume.
export const looksGone = text => GONE.test(String(text ?? ''));
export function goneError(message) {
  const err = new Error(message);
  err.sessionGone = true;
  return err;
}
