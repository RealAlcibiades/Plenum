// POST /api/pick-folder: the "Browse…" button in the add-project form. The desktop app opens the folder dialog; the logic is
// in lib/pick-folder.mjs. The request body is not used. Under plain `node server.mjs` the answer is { available: false }.
// The server checks X-Muse-Console on every POST before this handler runs.
import { pickFolder } from '../pick-folder.mjs';

export const routes = [
  { method: 'POST', path: '/api/pick-folder', handler: pickRoute },
];

// Answers { available, path, timedOut? }. A pick already open is refused with status 409 through the error's own status.
async function pickRoute({ req, res, readBody, json }) {
  await readBody(req);
  return json(res, 200, await pickFolder());
}
