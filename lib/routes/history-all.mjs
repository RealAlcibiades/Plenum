// Chat history search across every project. GET /api/history/search-all?q= runs the same matching as
// lib/routes/history.mjs over each project's saved chat, newest first. It reads only and changes nothing, and it needs
// no project id.
import { searchMessages } from './history.mjs';

export const routes = [
  { method: 'GET', path: '/api/history/search-all', handler: searchAllRoute },
];

const MAX_RESULTS = 50;
const MAX_QUERY = 200;

// The matches of every project, merged and sorted by the time of the message. Each hit carries its project's id and
// name, so the page can say where it is and switch there. An empty query answers with no results.
async function searchAllRoute({ url, res, json, store }) {
  const q = String(url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY);
  if (!q) return json(res, 200, { results: [] });
  const state = store.get();
  const results = [];
  for (const p of state.projects ?? []) {
    const messages = state.chats?.[p.id] ?? [];
    for (const hit of searchMessages(messages, q)) {
      results.push({ ...hit, ts: messages[hit.index]?.ts ?? 0, project: { id: p.id, name: p.name } });
    }
  }
  results.sort((a, b) => b.ts - a.ts);
  return json(res, 200, { results: results.slice(0, MAX_RESULTS) });
}
