// Store health: GET /api/store/health says whether Plenum loaded its backup, or started fresh, because the saved state file was
// damaged when it started. POST /api/store/health/ack clears that notice for this run. The recovery itself is in lib/store.mjs;
// these routes only report it. The server checks X-Muse-Console on every POST before this handler runs.

export const routes = [
  { method: 'GET', path: '/api/store/health', handler: healthRoute },
  { method: 'POST', path: '/api/store/health/ack', handler: ackRoute },
];

// { health: null } when the state file was read normally, or the recovery that happened at start.
async function healthRoute({ res, json, store }) {
  return json(res, 200, { health: store.health() });
}

async function ackRoute({ res, json, store }) {
  store.ackHealth();
  return json(res, 200, { ok: true });
}
