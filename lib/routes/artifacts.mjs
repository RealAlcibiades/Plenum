// Artifacts: the side pane's preview of a page, an SVG drawing (public/ext-artifacts.js) and Save to project.
//
// POST /api/artifacts/stage takes { kind: 'html' | 'svg', content, web? } and keeps the content under a random id. The page then
// puts GET /api/artifacts/view?id=... in a sandboxed frame. The view answers with the content and its own Content-Security-Policy,
// so the artifact cannot reach Plenum, the project, the keys or the network: no connect, no form posts, no popups, and scripts
// only inline. web: true (the person's own switch in the pane) relaxes the policy to https only, and http or loopback stay blocked.
//
// POST /api/artifacts/save writes one file inside the project. It is a click the person makes, so plan mode does not refuse it
// (a model in plan mode still cannot write), but a running project does. The file goes through resolveInRoot and checkAccess, a
// checkpoint is taken before a file is replaced, and the write goes through a temp file and a rename.
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkAccess } from '../guard.mjs';
import { snapshotBeforeWrite } from '../checkpoints.mjs';
import { resolveInRoot } from '../tools.mjs';

export const MAX_CHARS = 2_000_000;
export const MAX_STAGED = 50;
export const STAGE_TTL_MS = 60 * 60 * 1000;

const STAGE_ERROR = 'Send kind html or svg and the content (at most 2 MB).';
const EXPIRED = 'That preview has expired. Open the artifact again.';
const TOO_LARGE = 'That file is over 2 MB, so Plenum does not save it.';
const PATH_ERROR = 'Give a path inside the project folder, such as docs/page.html. Plenum does not write inside .git.';
const RUNNING = 'This project is running. Use /cancel first.';
const KEEP_FAILED = 'Plenum could not keep a copy of the old file, so it is not replaced. Files over 5 MB cannot be replaced here.';
const SAVE_FAILED = 'Plenum could not save the file. Try again.';
const KINDS = new Set(['html', 'svg']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// id -> { kind, content, web, at }. A Map keeps insertion order, so the first key is the oldest entry.
const staged = new Map();

// A refusal with the status it should be answered with. The route turns it into an httpError.
export class ArtifactError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  { method: 'POST', path: '/api/artifacts/stage', handler: stageRoute },
  { method: 'GET', path: '/api/artifacts/view', handler: viewRoute },
  { method: 'POST', path: '/api/artifacts/save', handler: saveRoute },
];

// Drops every staged entry older than the time to live. Called on each stage, so the map stays small without a timer.
function sweep(now) {
  for (const [id, entry] of staged) {
    if (now - entry.at > STAGE_TTL_MS) staged.delete(id);
  }
}

// Keeps one preview and returns its id. The oldest entry goes when the map would hold more than MAX_STAGED.
export function stageArtifact(body, now = Date.now()) {
  if (!isObject(body) || !KINDS.has(body.kind) || typeof body.content !== 'string' || body.content.length > MAX_CHARS) {
    throw new ArtifactError(400, STAGE_ERROR);
  }
  sweep(now);
  const id = randomUUID();
  staged.set(id, { kind: body.kind, content: body.content, web: body.web === true, at: now });
  while (staged.size > MAX_STAGED) staged.delete(staged.keys().next().value);
  return id;
}

// The staged entry for an id, or a 404 when the id is unknown or has expired.
export function viewArtifact(id, now = Date.now()) {
  const entry = typeof id === 'string' && UUID.test(id) ? staged.get(id) : undefined;
  if (!entry) throw new ArtifactError(404, EXPIRED);
  if (now - entry.at > STAGE_TTL_MS) {
    staged.delete(id);
    throw new ArtifactError(404, EXPIRED);
  }
  return entry;
}

// The response headers for a staged entry. The policies are written out in full here, because this file is the only place
// that decides what an artifact may load.
export function headersFor(entry) {
  const shared = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
  };
  if (entry.kind === 'svg') {
    return {
      'content-type': 'image/svg+xml; charset=utf-8',
      ...shared,
      'content-security-policy': entry.web ? svgWebPolicy : svgPolicy,
    };
  }
  return {
    'content-type': 'text/html; charset=utf-8',
    ...shared,
    'content-security-policy': entry.web ? htmlWebPolicy : htmlPolicy,
  };
}

// Offline: no network at all. Scripts and styles only inline, so an artifact's own script still runs.
const htmlPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; base-uri 'none'; sandbox allow-scripts";
// With web access on (amendment 16): https only. http and the loopback stay blocked.
const htmlWebPolicy = "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline'; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src https:; form-action 'none'; frame-ancestors 'self'; base-uri 'none'; sandbox allow-scripts";
// An SVG never runs script, offline or with web access.
const svgPolicy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; base-uri 'none'; sandbox allow-scripts";
const svgWebPolicy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src https:; form-action 'none'; frame-ancestors 'self'; base-uri 'none'; sandbox allow-scripts";

// Windows device names, with or without an extension. Windows reads such a name as the device, not a file.
const WINDOWS_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

// A path the person typed for Save: relative, inside the folder, with no drive letter, no colon (which Windows reads as a stream
// or a drive), no empty segment, no segment that ends in a dot or a space (Windows drops it, so '...', '.git.' or 'page.html.' names
// another folder or file; '.' and '..' end in a dot too), and no Windows device name. Returns the path with forward slashes, or null.
export function relativeSavePath(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 400 || /[\0:]/.test(text)) return null;
  if (path.isAbsolute(text) || text.startsWith('/') || text.startsWith('\\')) return null;
  const segments = text.split(/[\\/]/);
  if (segments.some(seg => seg === '' || /[. ]$/.test(seg) || WINDOWS_NAME.test(seg))) return null;
  return segments.join('/');
}

// Writes one artifact into the project. Returns { exists: true } when the file is there and overwrite is not true, else
// { saved: true, path }. Throws ArtifactError for every refusal.
export async function saveArtifact(project, body) {
  const rel = relativeSavePath(body.path);
  if (!rel) throw new ArtifactError(400, PATH_ERROR);
  if (typeof body.content !== 'string') throw new ArtifactError(400, 'Send the content as text.');
  if (body.content.length > MAX_CHARS) throw new ArtifactError(400, TOO_LARGE);
  // A project folder that was moved or deleted is said so, not blamed on the path (B-33). The same answer as the other routes.
  const folder = await fs.stat(project.path).catch(() => null);
  if (!folder?.isDirectory()) throw new ArtifactError(400, `The project folder is missing: ${project.path}. Put it back, or remove the project.`);

  let target;
  try {
    target = await resolveInRoot(project.path, rel, { write: true });
  } catch {
    throw new ArtifactError(400, PATH_ERROR);
  }
  try {
    // The check is made on the real path: the folder's real root plus the relative part, which has no link in it (a link is refused below).
    checkAccess(path.join(target.realRoot, target.rel), { write: true });
  } catch (err) {
    throw new ArtifactError(403, err.message);
  }

  const info = await fs.lstat(target.abs).catch(() => null);
  if (info && !info.isFile()) throw new ArtifactError(400, 'That path is a folder or a link. Name a file.');
  if (info && body.overwrite !== true) return { exists: true };
  if (info) {
    // The old copy is kept first. If it cannot be kept (for example it is over 5 MB), the file is not replaced.
    const kept = await snapshotBeforeWrite({ projectId: project.id, projectPath: project.path, absPath: target.abs, label: `Save artifact ${target.rel}` });
    if (!kept) throw new ArtifactError(409, KEEP_FAILED);
  }

  const tmp = `${target.abs}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.mkdir(path.dirname(target.abs), { recursive: true });
    await fs.writeFile(tmp, body.content, 'utf8');
    await fs.rename(tmp, target.abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    console.error('Artifacts: save failed:', err.message);
    throw new ArtifactError(500, SAVE_FAILED);
  }
  return { saved: true, path: target.rel };
}

// Turns a refusal from the helpers above into the server's own error. Any other error is passed on unchanged.
function asHttp(httpError, err) {
  if (err instanceof ArtifactError) return httpError(err.status, err.message);
  return err;
}

// POST /api/artifacts/stage. Answers { id }.
async function stageRoute({ req, res, readBody, json, httpError }) {
  const body = await readBody(req);
  try {
    return json(res, 200, { id: stageArtifact(body) });
  } catch (err) {
    throw asHttp(httpError, err);
  }
}

// GET /api/artifacts/view?id=... The route answers the response itself, with the policy the entry was staged with.
function viewRoute({ res, url, httpError }) {
  let entry;
  try {
    entry = viewArtifact(url.searchParams.get('id'));
  } catch (err) {
    throw asHttp(httpError, err);
  }
  res.writeHead(200, headersFor(entry));
  res.end(entry.content);
}

// POST /api/artifacts/save with { project, path, content, overwrite? }. A running project is refused; plan mode is not (amendment 31).
async function saveRoute({ req, res, readBody, json, projectById, httpError, running }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project, the path and the content.');
  const project = projectById(body.project);
  if (running.has(project.id)) throw httpError(409, RUNNING);
  try {
    return json(res, 200, await saveArtifact(project, body));
  } catch (err) {
    throw asHttp(httpError, err);
  }
}

// Exposed for the tests only: the number of entries staged now.
export const stagedCount = () => staged.size;
