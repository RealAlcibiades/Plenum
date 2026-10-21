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

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function load() {
  let text;
  try {
    text = await readStateFile();
  } catch (err) {
    // Only a file that is missing is a fresh start. Any other read error is not proof of damage, so nothing is renamed.
    if (err.code === 'ENOENT') state = defaults();
    else await unreadable(err);
    return state;
  }
  try {
    const parsed = JSON.parse(text);
    if (!isObject(parsed)) throw new Error('The state file does not hold an object.');
    state = { ...defaults(), ...parsed };
  } catch (err) {
    await recover(err);
  }
  return state;
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
  const corruptFile = `${FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let kept = null;
  try {
    await fs.rename(FILE, corruptFile);
    kept = corruptFile;
  } catch {
    // The damaged file stays where it is, so the next save must not copy it over the backup.
    keepBackup = true;
  }
  const recovered = (await loadBackup()) ? 'backup' : 'defaults';
  console.warn(`Could not read ${FILE} (${err.code ?? 'damaged file'}). ${recovered === 'backup' ? 'Loaded the last backup.' : 'No usable backup was found, so Plenum starts fresh.'}`);
  healthState = { recovered, corruptFile: kept, at: Date.now(), home: HOME };
  // Only when the damaged file was moved aside: the loaded state is saved again, so a restart does not start from nothing.
  if (kept) await persist();
}

// The state file could not be read even after the retries, so it is not known to be damaged. Nothing is renamed or deleted.
// The backup is loaded when it reads. keepBackup stops the next save from copying the unread file over the backup.
async function unreadable(err) {
  keepBackup = true;
  keepUnread = true;
  const recovered = (await loadBackup()) ? 'backup-readonly' : 'defaults';
  console.warn(`Could not read ${FILE} (${err.code ?? 'unknown error'}). ${recovered === 'backup-readonly' ? 'Loaded the last backup.' : 'No usable backup was found, so Plenum starts fresh.'}`);
  healthState = { recovered, corruptFile: null, unread: true, at: Date.now(), home: HOME };
}

// Loads the backup into state when it reads and holds an object. Otherwise state is the defaults. Returns whether it loaded.
async function loadBackup() {
  try {
    const parsed = JSON.parse(await fs.readFile(BAK, 'utf8'));
    if (!isObject(parsed)) throw new Error('The backup does not hold an object.');
    state = { ...defaults(), ...parsed };
    return true;
  } catch {
    state = defaults();
    return false;
  }
}

// What load() did about a damaged or unreadable state file, or null when the file was read normally.
export function health() {
  return healthState;
}

export function ackHealth() {
  healthState = null;
}

export const get = () => state;

export function transcript(projectId) {
  return (state.chats[projectId] ??= []);
}

export function addMessage(projectId, message) {
  const list = transcript(projectId);
  list.push({ ...message, ts: Date.now() });
  if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
}

// Writes go to a temp file and are renamed into place, and they run one at a time.
export function persist() {
  // Every window is told the state changed (lib/events.mjs); calls close together become one event.
  publishState('persist');
  writing = writing
    .then(async () => {
      await fs.mkdir(HOME, { recursive: true });
      // The saved file is copied to the backup before it is replaced, so one good copy is always kept.
      if (!keepBackup) await fs.copyFile(FILE, BAK).catch(() => {});
      if (keepUnread) {
        const unreadCopy = `${FILE}.unread-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        // A file that is gone needs no copy. Any other failure leaves the flag set, so the next save tries again.
        await fs.copyFile(FILE, unreadCopy).then(() => { keepUnread = false; }, err => { if (err.code === 'ENOENT') keepUnread = false; });
      }
      const tmp = `${FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2));
      await fs.rename(tmp, FILE);
      keepBackup = false;
    })
    .catch(err => console.error('Could not save state:', err.message));
  return writing;
}
