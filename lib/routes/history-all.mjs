// Chat history search across every project. GET /api/history/search-all?q= runs the same matching as
// lib/routes/history.mjs over each project's saved chats, newest first, every thread of every project (open or closed; lib/threads.mjs).
// It reads only and changes nothing, and it needs no project id.
import { searchMessages } from './history.mjs';
import { threadsOf } from '../threads.mjs';

export const routes = [
  { method: 'GET', path: '/api/history/search-all', handler: searchAllRoute },
];

const MAX_RESULTS = 50;
const MAX_QUERY = 200;

// The matches of every project, merged and sorted by the time of the message. Each hit carries its project's id and
// name, so the page can say where it is and switch there, and the thread it is in ({ id, name, main, closed }). When a project has
// several threads the name a hit shows is "Project · Thread" (the Main thread is "Project · Main"), so a match names its thread. An empty
// query answers with no results.
async function searchAllRoute({ url, res, json, store }) {
  const q = String(url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY);
  if (!q) return json(res, 200, { results: [] });
  const state = store.get();
  const results = [];
  for (const p of state.projects ?? []) {
    const record = threadsOf(state, p);
    const several = record.list.length > 1;
    for (const t of record.list) {
      const messages = state.chats?.[t.id] ?? [];
      const where = several ? `${p.name} · ${t.name}${t.closedAt ? ' (closed)' : ''}` : p.name;
      for (const hit of searchMessages(messages, q)) {
        results.push({ ...hit, ts: messages[hit.index]?.ts ?? 0, project: { id: p.id, name: where }, thread: { id: t.id, name: t.name, main: t.main === true, closed: Boolean(t.closedAt) } });
      }
    }
  }
  results.sort((a, b) => b.ts - a.ts);
  return json(res, 200, { results: results.slice(0, MAX_RESULTS) });
}
