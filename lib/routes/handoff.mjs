// Handoff draft (pro-10). Owned by the plan-meter feature. POST /api/handoff/draft writes a note for another model to take over a
// task that the current one stopped on (for example at a plan limit). It is a draft only: no model is called, and Plenum never
// sends it. The page puts the text in the composer, and the person edits it and presses Enter.
//   POST /api/handoff/draft { project, thread?, from, to, error? } -> { text, fromLabel, toLabel }
//     from and to are model refs (parseRef: an alias such as codex, or provider:id); a bad one is refused with 400.
// The note quotes the chat: the goal (the first message after the newest compact summary, or the summary itself), the latest
// request, the files touched (tool records and git status, at most 30) and the last chat reply. Each quoted text is cut
// (600 characters, 800 for the reply) and every line gets '> ' in front. Nothing outside the project folder is read.
import { requireToken } from '../auth.mjs';
import { gitStatus } from '../git-status.mjs';
import { labelFor, parseRef } from '../providers.mjs';
import { scopeFor } from '../scope.mjs';

const REQUEST_CUT = 600;
const REPLY_CUT = 800;
const FILES_MAX = 30;
const ERROR_LINE_MAX = 200;
const FILE_TOOLS = new Set(['write_file', 'edit_file', 'Write', 'Edit', 'MultiEdit']);
const NONE = '(none)';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The name a person reads: the catalog label without its note in brackets ("Muse Spark 1.2", "Codex").
export const shortLabel = ref => labelFor(ref).replace(/\s*\(.*\)$/, '');

const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// A quoted text, cut and with '> ' in front of every line. A missing text is quoted as (none).
function quote(text, max) {
  const body = typeof text === 'string' ? cut(text, max) : NONE;
  return body.split('\n').map(line => `> ${line}`).join('\n');
}

// The goal: the first user chat message after the newest compact summary. With no message after it, the summary itself. With no
// summary, the first user chat message of the chat.
export function firstRequest(log) {
  const summary = log.findLastIndex(m => m?.compact === true);
  const isRequest = m => m?.role === 'user' && m.kind === 'chat' && m.compact !== true && typeof m.content === 'string';
  // With no summary, slice(0) is the whole chat.
  const found = log.slice(summary + 1).find(isRequest);
  if (found) return found.content;
  if (summary >= 0 && typeof log[summary].content === 'string') return log[summary].content;
  return undefined;
}

// The latest request: the newest user chat message that is not a summary.
export function latestRequest(log) {
  const hit = [...log].reverse().find(m => m?.role === 'user' && m.kind === 'chat' && m.compact !== true && typeof m.content === 'string');
  return hit?.content;
}

// The last chat reply that has text: the newest assistant chat message with content.
export function latestReply(log) {
  const hit = [...log].reverse().find(m => m?.role === 'assistant' && m.kind === 'chat' && typeof m.content === 'string' && m.content.trim() !== '');
  return hit?.content;
}

// The files touched: the paths of the file tool records that succeeded, then the changed and untracked files git lists. Unique,
// at most FILES_MAX. A tool record's summary is the path for these tools.
export function filesTouched(log, git) {
  const out = [];
  const seen = new Set();
  const add = p => {
    if (out.length >= FILES_MAX || typeof p !== 'string' || !p.trim() || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const m of log) {
    for (const t of m?.tools ?? []) {
      if (FILE_TOOLS.has(t?.name) && t.ok !== false) add(t.summary);
    }
  }
  if (git?.repo) {
    for (const p of git.changed ?? []) add(p);
    for (const p of git.untracked ?? []) add(p);
  }
  return out;
}

// The first line of the error, at most 200 characters. Empty when there is none.
export function errorLine(error) {
  return String(error ?? '').split('\n')[0].trim().slice(0, ERROR_LINE_MAX);
}

// The note itself. fromLabel and toLabel are the names the person reads.
export function handoffText({ fromLabel, toLabel, error = '', log = [], git = null }) {
  const stopped = errorLine(error);
  const files = filesTouched(log, git);
  const fileLines = files.length ? files.map(p => `- ${p}`).join('\n') : '- none recorded';
  return [
    `Handoff from ${fromLabel} to ${toLabel}. ${fromLabel} stopped${stopped ? `: "${stopped}"` : ''}. Please take over the task below. The chat so far comes with this message, but your own session starts fresh.`,
    '',
    'Goal (the first message in this chat):',
    quote(firstRequest(log), REQUEST_CUT),
    '',
    'Latest request:',
    quote(latestRequest(log), REQUEST_CUT),
    '',
    'Files touched so far:',
    fileLines,
    '',
    `Last reply from ${fromLabel} (shortened):`,
    quote(latestReply(log), REPLY_CUT),
    '',
    `Continue from where ${fromLabel} stopped. Read the files above before you change them.`,
  ].join('\n');
}

export const routes = [
  {
    method: 'POST',
    path: '/api/handoff/draft',
    handler: async ({ req, res, json, readBody, httpError, store, projectById }) => {
      requireToken(req, httpError);
      // readBody gives back whatever the JSON was, so a bare null, a string or a list is refused before any field is read.
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the project, from and to, for example {"project": "abc123", "from": "codex", "to": "muse"}.');
      const project = projectById(body.project);
      if (!project) throw httpError(400, 'No such project. Add a folder with /add <path>.');
      let from;
      let to;
      try {
        from = parseRef(body.from);
      } catch (err) {
        throw httpError(400, err.message);
      }
      try {
        to = parseRef(body.to);
      } catch (err) {
        throw httpError(400, err.message);
      }
      const error = typeof body.error === 'string' ? body.error : '';
      const scope = scopeFor(store, project, typeof body.thread === 'string' ? body.thread : undefined);
      const git = await gitStatus(scope.root);
      const fromLabel = shortLabel(from);
      const toLabel = shortLabel(to);
      const text = handoffText({ fromLabel, toLabel, error, log: store.transcript(project.id), git });
      return json(res, 200, { text, fromLabel, toLabel });
    },
  },
];
