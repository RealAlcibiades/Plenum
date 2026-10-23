// Chat history search and Markdown export. Each route is answered here; see lib/routes/index.mjs.
// Both read one project's saved transcript and change nothing. The server checks the Host header for every
// request, as it does for the rest of the API, so these GET routes need no extra header.
import { labelFor } from '../providers.mjs';
import { scopeOrMain, threadOf } from '../scope.mjs';

export const routes = [
  { method: 'GET', path: '/api/history/search', handler: searchRoute },
  { method: 'GET', path: '/api/history/export', handler: exportRoute },
];

const MAX_RESULTS = 50;
const MAX_QUERY = 200;
const SNIPPET_CHARS = 160;

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Line breaks and runs of spaces become one space, so a snippet or a heading stays on one line.
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// About 160 characters with the match in the middle, and an ellipsis wherever the text goes on past the window.
function snippetAround(content, at, length) {
  const room = Math.max(0, SNIPPET_CHARS - length);
  const start = Math.max(0, at - Math.floor(room / 2));
  const end = Math.min(content.length, at + length + Math.ceil(room / 2));
  return `${start > 0 ? '…' : ''}${oneLine(content.slice(start, end))}${end < content.length ? '…' : ''}`;
}

// The matches for a query: case-insensitive, plain text (not a pattern), newest first, at most 50. Each match carries
// the message's place in the transcript, so the page can find that message again.
export function searchMessages(messages = [], query = '') {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const pattern = new RegExp(escapeRegExp(q), 'i');
  const results = [];
  for (let index = messages.length - 1; index >= 0 && results.length < MAX_RESULTS; index--) {
    const m = messages[index];
    const content = typeof m?.content === 'string' ? m.content : '';
    const hit = pattern.exec(content);
    if (hit) results.push({ index, role: m.role, snippet: snippetAround(content, hit.index, hit[0].length) });
  }
  return results;
}

// The heading for a message: "You" for the user, the model's short name for a reply (the name the chat shows, see
// modelName in public/app.js), and "Conversation summary" for the summary that /compact leaves.
function headingFor(m) {
  if (m.compact) return 'Conversation summary';
  if (m.role === 'user') return 'You';
  if (!m.model) return 'Assistant';
  return oneLine(labelFor(m.model).replace(/\s*\(.*\)$/, '').replace(/^Claude\s+/, '')) || 'Assistant';
}

// The chat as Markdown: the project's name, then one section for each message. Tool steps come first, one line
// each, as the chat shows them, and a failed step is marked. The text is kept as the user wrote or the model replied.
export function exportMarkdown(project, messages = [], { thread } = {}) {
  // A thread other than Main says so in the title ("Project · Thread").
  const title = [oneLine(project?.name) || 'Chat', oneLine(thread)].filter(Boolean).join(' · ');
  const parts = [`# ${title}`];
  if (!messages.length) parts.push('This chat has no messages yet.');
  for (const m of messages) {
    parts.push(`## ${headingFor(m)}`);
    const steps = (m.tools ?? []).map(t => `- \`${oneLine(t.name)}\`: ${oneLine(t.summary)}${t.ok ? '' : ' (failed)'}`);
    if (steps.length) parts.push(['Tool steps:', '', ...steps].join('\n'));
    const body = String(m.content ?? '').trim();
    if (body) parts.push(body);
  }
  return `${parts.join('\n\n')}\n`;
}

// The project a request names. A missing id gets its own message; an unknown id is refused by projectById.
function projectParam(url, projectById, httpError) {
  const id = url.searchParams.get('project');
  if (!id) throw httpError(400, 'Choose a project first.');
  return projectById(id);
}

// The saved transcript of one thread (the scope, see lib/scope.mjs). Reading it does not create an entry, as store.transcript would.
const messagesOf = (store, scope) => store.get().chats?.[scope.id] ?? [];

// The thread a request names (the thread query), else the project's active thread.
const scopeOf = (store, project, url) => scopeOrMain(store, project, threadOf(url.searchParams));

async function searchRoute({ url, res, json, httpError, store, projectById }) {
  const project = projectParam(url, projectById, httpError);
  const scope = scopeOf(store, project, url);
  const q = String(url.searchParams.get('q') ?? '').trim();
  if (!q) throw httpError(400, 'Type a word or phrase to search for.');
  if (q.length > MAX_QUERY) throw httpError(400, `The search is limited to ${MAX_QUERY} characters.`);
  return json(res, 200, { results: searchMessages(messagesOf(store, scope), q) });
}

// The download's file name: the project name without the characters a Windows file name cannot hold, and without
// control characters, trailing dots or spaces. "chat" is used when nothing is left.
function fileNameFor(name, thread) {
  const base = [name, thread].filter(Boolean).join(' - ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"\/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '')
    .trim();
  return `${base || 'chat'}.md`;
}

async function exportRoute({ url, res, httpError, store, projectById }) {
  const project = projectParam(url, projectById, httpError);
  const scope = scopeOf(store, project, url);
  // Main's file keeps the project's name; another thread's adds its own ("Project - Thread").
  const threadName = scope.main ? '' : scope.name;
  const name = fileNameFor(project.name, threadName);
  // The plain copy is for clients that cannot read UTF-8 names. Both copies come from the cleaned name, so no header
  // can carry a line break or a quote.
  const plain = name.replace(/[^\x20-\x7e]/g, '_');
  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  return res.end(exportMarkdown(project, messagesOf(store, scope), { thread: threadName }));
}
