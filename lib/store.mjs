import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishState } from './events.mjs';

export const HOME = process.env.MUSE_CONSOLE_HOME || path.join(os.homedir(), '.muse-console');
const FILE = path.join(HOME, 'state.json');
// The copy of the saved state from before the latest save. A damaged state.json is recovered from it (see recover).
const BAK = `${FILE}.bak`;
const MAX_MESSAGES = 300;
// A state file that cannot be read (busy or locked, not damaged) is read again this many times, WAIT_MS apart, before it is
// treated as unreadable. Antivirus or an indexer can hold it for a moment at start.
const READ_RETRIES = 3;
const READ_WAIT_MS = 200;

const defaults = () => ({
  projects: [], // { id, name, path, settings } (settings: the project's own overrides, see lib/projects.mjs)
  activeProject: null, // project id
  model: 'muse:muse-spark-1.2',
  advisor: 'anthropic:claude-opus-5-5', // null means off
  advisorAuto: false,
  approvals: 'ask', // 'ask' pauses for each edit or command; 'auto' runs them
  sessionMode: 'transcript', // 'native' resumes each CLI's own session; 'transcript' resends the chat
  relay: { autoRoute: false, countdownSec: 3, hops: null, stopOnError: true, dedupe: false },
  theme: 'system', // 'system' follows Windows; 'dark' and 'light' override it
  chats: {}, // project id -> messages
});

let state = defaults();
let writing = Promise.resolve();
// Set when the state file could not be moved aside, or could not be read at all. Until a save replaces it, that file must not
// be copied over the backup.
let keepBackup = false;
// Set when the state file could not be read at start (see unreadable). It may hold newer data than the backup, so the first
// save copies it aside as state.json.unread-<time> before replacing it.
let keepUnread = false;
// What load() did about a damaged or unreadable state file, or null. The page shows it once; ackHealth() clears it for this run.
let healthState = null;
// The message of the last save that failed, or null once a save has worked. publicState carries it (see saveFailure).
let saveFailureMessage = null;
// The state file's text as this process last read or wrote it, or null when there was no file. undefined means the file could not
// be read at start, so there is nothing to compare with (see writeState).
let known = null;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const validText = text => {
  try {
    asState(text);
    return true;
  } catch {
    return false;
  }
};

export async function load() {
  await loadFile();
  await setAsideBadChats();
  markInterrupted();
  return state;
}

async function loadFile() {
  // Temp files left by a save that was killed between its write and its rename are removed first.
  await removeStaleTemps();
  let text;
  try {
    text = await readStateFile();
  } catch (err) {
    known = null;
    // A file that is missing is a fresh start, unless a backup exists. Any other read error is not proof of damage, so nothing is
    // renamed.
    if (err.code === 'ENOENT') await missing();
    else await unreadable(err);
    return state;
  }
  known = text;
  try {
    state = asState(text);
  } catch (err) {
    await recover(err);
  }
  return state;
}

// Parses the text of a state file. The file must hold an object, its projects (when present) must be a list of objects and its
// chats (when present) must be an object. Any other shape throws, so the caller recovers, instead of starting with a value that
// fails later.
function asState(text) {
  // A UTF-8 byte-order mark is not part of JSON text, and an editor may add one. It is removed, as lib/rules.mjs does for its files.
  const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!isObject(parsed)) throw new Error('The state file does not hold an object.');
  if (parsed.projects !== undefined && !(Array.isArray(parsed.projects) && parsed.projects.every(isObject))) {
    throw new Error('The project list is not a list of projects.');
  }
  if (parsed.chats !== undefined && !isObject(parsed.chats)) throw new Error('The chat store is not an object.');
  const fresh = defaults();
  const loaded = { ...fresh, ...parsed };
  // A model or advisor that is not text (a file an older build damaged: "/model __proto__" saved {}) would fail every chat, so the default
  // takes its place. An advisor of null is how it is turned off.
  if (typeof loaded.model !== 'string') loaded.model = fresh.model;
  if (loaded.advisor !== null && typeof loaded.advisor !== 'string') loaded.advisor = fresh.advisor;
  return loaded;
}

// Reads the state file. A read that fails for a reason other than a missing file is tried again, up to READ_RETRIES times.
// The last error is thrown when every try fails.
async function readStateFile() {
  for (let tries = 0; ; tries++) {
    try {
      return await fs.readFile(FILE, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' || tries >= READ_RETRIES) throw err;
      await new Promise(resolve => setTimeout(resolve, READ_WAIT_MS));
    }
  }
}

// A damaged state file is renamed, never deleted, so its content stays on disk. The backup is loaded when it reads,
// and a fresh state otherwise. The outcome is kept for the page (health()) until it is acknowledged.
async function recover(err) {
  const corruptFile = `${FILE}.corrupt-${stamp()}`;
  let kept = null;
  try {
    await fs.rename(FILE, corruptFile);
    kept = corruptFile;
    known = null;
  } catch {
    // The damaged file stays where it is (another program holds it), so the next save must not copy it over the backup. It is
    // copied aside now instead. If even the copy fails, the next save copies it first and stops if that fails (copyUnread).
    keepBackup = true;
    try {
      await fs.copyFile(FILE, corruptFile);
      kept = corruptFile;
    } catch {
      keepUnread = true;
    }
  }
  const back = await loadBackup();
  const recovered = back.loaded ? 'backup' : 'defaults';
  console.warn(`Could not read ${FILE} (${err.code ?? 'damaged file'}). ${recovered === 'backup' ? 'Loaded the last backup.' : 'No usable backup was found, so Plenum starts fresh.'}`);
  healthState = { recovered, corruptFile: kept, at: Date.now(), home: HOME };
  // Only when the damaged file was kept: the loaded state is saved again, so a restart does not start from nothing.
  if (kept) await persist();
}

// The state file is missing. A fresh start is right only when there is no backup either. When a backup exists, it is loaded
// and the page is told, because the file was deleted or moved while Plenum was not running. A backup that is there but cannot be
// used is told too, so the fresh start is not silent.
async function missing() {
  const back = await loadBackup();
  if (back.loaded) {
    console.warn(`Could not find ${FILE}. Loaded the last backup.`);
    healthState = { recovered: 'backup', corruptFile: null, missing: true, at: Date.now(), home: HOME };
    return;
  }
  if (!back.present) return;
  console.warn(`Could not find ${FILE}, and its backup could not be used. Plenum starts fresh.`);
  healthState = { recovered: 'defaults', corruptFile: back.kept, missing: true, at: Date.now(), home: HOME };
}

// The state file could not be read even after the retries, so it is not known to be damaged. Nothing is renamed or deleted.
// The backup is loaded when it reads. keepBackup stops the next save from copying the unread file over the backup.
async function unreadable(err) {
  keepBackup = true;
  keepUnread = true;
  known = undefined;
  const back = await loadBackup();
  const recovered = back.loaded ? 'backup-readonly' : 'defaults';
  console.warn(`Could not read ${FILE} (${err.code ?? 'unknown error'}). ${recovered === 'backup-readonly' ? 'Loaded the last backup.' : 'No usable backup was found, so Plenum starts fresh.'}`);
  healthState = { recovered, corruptFile: null, unread: true, at: Date.now(), home: HOME };
}

// Loads the backup into state when it reads and holds a valid state. Otherwise state is the defaults. A backup that reads but is
// damaged is kept aside (keepBackupAside), so the next save cannot replace it. Returns { loaded, present, kept }: present says whether
// a backup file exists, kept is the path of the damaged backup's copy or null.
async function loadBackup() {
  let text;
  try {
    text = await fs.readFile(BAK, 'utf8');
  } catch (err) {
    state = defaults();
    return { loaded: false, present: err.code !== 'ENOENT', kept: null };
  }
  try {
    state = asState(text);
    return { loaded: true, present: true, kept: null };
  } catch {
    state = defaults();
    return { loaded: false, present: true, kept: await keepBackupAside() };
  }
}

// Moves a damaged backup aside as state.json.bak.corrupt-<time>. When the move fails it is copied instead. When neither works, the
// backup stays where it is and keepBackup stops the next save from copying over it. Returns the kept path or null.
async function keepBackupAside() {
  const kept = `${BAK}.corrupt-${stamp()}`;
  try {
    await fs.rename(BAK, kept);
    return kept;
  } catch {
    // The copy below is the fallback.
  }
  try {
    await fs.copyFile(BAK, kept);
    return kept;
  } catch {
    keepBackup = true;
    return null;
  }
}

// A chat entry must be null (no chat yet) or a list of objects. Any other value would fail every send, compact and clear on its
// project, so the value is kept in a file beside the state file and the entry starts empty. Nothing is deleted. When the value cannot
// be kept, the entry is left as it is.
async function setAsideBadChats() {
  const bad = Object.entries(state.chats ?? {}).filter(([, list]) => list !== null && !(Array.isArray(list) && list.every(isObject)));
  if (bad.length === 0) return;
  const kept = path.join(HOME, `state.json.damaged-chats-${stamp()}.json`);
  try {
    await fs.writeFile(kept, JSON.stringify(Object.fromEntries(bad), null, 2), { flag: 'wx' });
  } catch (err) {
    console.error(`Could not keep the damaged chats (${err.code ?? 'unknown error'}), so they are left as they are.`);
    return;
  }
  for (const [id] of bad) state.chats[id] = [];
  console.warn(`A chat in ${FILE} was not a list of messages. It was kept in ${kept}, and the chat starts empty.`);
  healthState ??= { recovered: 'chats', corruptFile: kept, at: Date.now(), home: HOME };
  // Saved once, so the reset survives a restart.
  await persist();
}

// A save writes its temp file under a name that holds the process id, then renames it into place. A process killed between the
// two leaves that file behind. The temp files of processes that are no longer running are removed. A running process's temp
// file is kept, so a second Plenum on the same folder is not touched.
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

async function removeStaleTemps() {
  for (const name of await fs.readdir(HOME).catch(() => [])) {
    const match = /^state\.json\.(\d+)\.tmp$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid !== process.pid && !alive(pid)) await fs.rm(path.join(HOME, name), { force: true }).catch(() => {});
  }
}

// What load() did about a damaged, unreadable or missing state file, or null when the file was read normally.
export function health() {
  return healthState;
}

export function ackHealth() {
  healthState = null;
}

// The message of the last save that failed, or null once a save has worked. The page shows it, so a change that the file does
// not hold is not hidden from the user.
export const saveFailure = () => saveFailureMessage;

export const get = () => state;

export function transcript(projectId) {
  return (state.chats[projectId] ??= []);
}

// Adds a message and returns the stored row, so a caller can finish it later (finishMessage) or take it out (removeMessage).
export function addMessage(projectId, message) {
  const list = transcript(projectId);
  const row = { ...message, ts: Date.now() };
  list.push(row);
  if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
  return row;
}

// A reply that streams is a draft row in the transcript (B-29). When it ends, the same row takes the finished reply's fields, so the
// transcript gets one row for the reply, not two. A row that is no longer in the transcript is added again instead.
export function finishMessage(projectId, row, fields) {
  const list = transcript(projectId);
  if (!list.includes(row)) return addMessage(projectId, fields);
  for (const key of Object.keys(row)) delete row[key];
  Object.assign(row, fields, { ts: Date.now() });
  return row;
}

// Takes a draft row out of the transcript, for a reply that ends with nothing to keep. A row that is not there is left alone.
export function removeMessage(projectId, row) {
  const list = transcript(projectId);
  const at = list.indexOf(row);
  if (at !== -1) list.splice(at, 1);
  return at !== -1;
}

// A reply still drafted when the state is read was cut off by a crash or a kill, since no run is live at start (B-29): the draft is marked
// interrupted, and so is a question that has no reply after it (a compact or an auto-fix row is not a question). The page says so.
function markInterrupted() {
  for (const list of Object.values(state.chats ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (row?.draft === true) {
        delete row.draft;
        row.interrupted = true;
      }
    }
    const last = list.at(-1);
    if (last && last.role === 'user' && !last.compact && !last.auto && !last.interrupted && ['chat', 'council', 'build'].includes(last.kind)) {
      last.interrupted = true;
    }
  }
}

// The saved file is copied to the backup before it is replaced, so one good copy is always kept. A backup that is read-only (the
// copy carries that attribute over from a read-only state file) is made writable first, so the copy can replace it. A copy that
// fails is reported and the save goes on. A missing state file has nothing to copy, so that is not reported.
async function backUp(disk) {
  if (keepBackup) return;
  // A state file on disk that does not hold a valid state is not copied over the backup, which keeps the last good save.
  if (typeof disk === 'string' && !validText(disk)) return;
  await fs.chmod(BAK, 0o600).catch(() => {});
  await fs.copyFile(FILE, BAK).catch(err => {
    if (err.code !== 'ENOENT') console.warn(`Could not copy ${FILE} to the backup (${err.code ?? 'unknown error'}). The backup is older than the last save.`);
  });
}

// The state file could not be read at start, so it is copied aside before the first save replaces it. A missing file needs no copy.
// Any other failure stops the save, so the unread file is never replaced without a copy.
async function copyUnread() {
  const unreadCopy = `${FILE}.unread-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    await fs.copyFile(FILE, unreadCopy);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  keepUnread = false;
}

// The state file as it is on disk now: its text, null when there is no file, or undefined when it cannot be read.
async function diskText() {
  try {
    return await fs.readFile(FILE, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? null : undefined;
  }
}

// One save: the backup, then the state written to a temp file and renamed over the state file. Never rejects. Resolves to null
// when the save worked, or to the failure message. A failed save removes its temp file.
async function writeState() {
  try {
    await fs.mkdir(HOME, { recursive: true });
    const disk = await diskText();
    // Another Plenum on the same folder saved since this process last read or wrote the file. Replacing it would drop that save, so
    // this one is refused and the change stays on screen until the window is restarted. A file that is gone is not a conflict: it
    // was removed while Plenum ran, and this save writes it again.
    if (known !== undefined && typeof disk === 'string' && disk !== known) {
      saveFailureMessage = 'Another Plenum changed the state file in this folder, so this window\'s changes were not saved. Close the other Plenum and restart this one.';
      console.error('Could not save state: the state file was changed by another Plenum.');
      publishState('save-failed');
      return saveFailureMessage;
    }
    await backUp(disk);
    if (keepUnread) await copyUnread();
    const tmp = `${FILE}.${process.pid}.tmp`;
    const text = JSON.stringify(state, null, 2);
    try {
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, FILE);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    known = text;
    keepBackup = false;
    saveFailureMessage = null;
    return null;
  } catch (err) {
    saveFailureMessage = `Plenum could not save its state file (${err.code ?? 'unknown error'}).`;
    console.error('Could not save state:', err.message);
    publishState('save-failed');
    return saveFailureMessage;
  }
}

// Writes go to a temp file and are renamed into place, and they run one at a time. Every window is told the state changed
// (lib/events.mjs); calls close together become one event. The promise never rejects. It resolves to null when the save worked,
// or to the failure message. Callers that must know whether the change reached the file use saveOrFail().
export function persist() {
  publishState('persist');
  writing = writing.then(writeState);
  return writing;
}

// The same save, queued the same way, but without telling the windows. A reply's draft is saved this way while it streams: the stream
// already shows the reply, so a redraw would only repeat it. It never rejects; a failed save is kept in saveFailure as usual.
export function persistQuiet() {
  writing = writing.then(writeState);
  return writing;
}

// Saves, and throws when the save failed, so a route answers with an error instead of a success that the file does not back up.
// The error has status 500, because the server maps an error without a status to 400.
export async function saveOrFail() {
  const failure = await persist();
  if (failure === null) return;
  throw Object.assign(new Error(`${failure} The change is shown but is lost on restart until a save works.`), { status: 500 });
}
