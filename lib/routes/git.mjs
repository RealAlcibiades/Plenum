// Git status route for the project header: GET /api/git?project=ID. The command and the parsing are in lib/git-status.mjs.
// The folder is the project's own path, which was checked when the project was added. Nothing in the request reaches the
// git command. The answer is kept for 5 seconds per project, so several windows and the page's own timer never start more
// than one git process at a time for a project.
import { gitStatus } from '../git-status.mjs';

const TTL_MS = 5000;
// The page asks for a fresh answer when a run has just ended. That still waits a second, so a loop of requests cannot start
// git again and again.
const FRESH_TTL_MS = 1000;

// project id -> { at, value, path }: the last answer and when it was read.
const cache = new Map();
// project id -> the answer being read now, so two requests at the same moment share one git process.
const reading = new Map();

export const routes = [
  { method: 'GET', path: '/api/git', handler: statusRoute },
];

async function statusRoute({ res, url, json, projectById }) {
  // A project id that is not known is refused by projectById.
  const project = projectById(url.searchParams.get('project'));
  const ttl = url.searchParams.get('fresh') === '1' ? FRESH_TTL_MS : TTL_MS;
  const hit = cache.get(project.id);
  // The path is compared too, so a project whose folder was changed never shows the old folder's answer.
  if (hit && hit.path === project.path && Date.now() - hit.at < ttl) return json(res, 200, hit.value);

  let pending = reading.get(project.id);
  if (!pending || pending.path !== project.path) {
    pending = { path: project.path, promise: gitStatus(project.path) };
    reading.set(project.id, pending);
    pending.promise.then(value => {
      cache.set(project.id, { at: Date.now(), value, path: project.path });
    }).finally(() => {
      if (reading.get(project.id) === pending) reading.delete(project.id);
    });
  }
  return json(res, 200, await pending.promise);
}
