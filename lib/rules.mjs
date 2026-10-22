// Rules files: AGENTS.md, CLAUDE.md and GEMINI.md in the project root, and the global rules in the Plenum state folder (rules.md).
// The chat reads AGENTS.md and the global rules on every turn, so an edit shows up on the next message (lib/prompt-parts/30 and 35).
// The Rules panel (lib/routes/rules.mjs) lists and saves the files. A file whose real path is outside the project is refused, as is
// a credential folder. A save keeps a checkpoint of the old text (lib/checkpoints.mjs) and must carry the hash of the text the panel
// loaded, so a change made outside Plenum is never overwritten blind.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { HOME } from './store.mjs';
import { snapshotBeforeWrite } from './checkpoints.mjs';
import { checkAccess, isCredentialPath } from './guard.mjs';

// The three files the panel edits, in the order the panel shows them.
export const RULES_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const RULES_FILE = 'AGENTS.md';
// Long enough for a real guide, short enough that it does not crowd out the conversation. Plenum sends this many characters,
// and Codex caps its instructions at 32 KiB.
const MAX_CHARS = 32000;
export const PROJECT_MAX_CHARS = MAX_CHARS;
// The most a save can hold, and the most the panel loads into its editor. A longer file is shown read-only.
export const SAVE_MAX_CHARS = 64000;
// The most the global rules can hold. Plenum sends this many characters of them.
export const GLOBAL_MAX_CHARS = 16000;
// A file over this many bytes is not read into the panel at all.
const READ_MAX_BYTES = 1024 * 1024;
// A UTF-8 character takes at most 3 bytes per UTF-16 unit, so this many bytes always holds MAX_CHARS characters.
// The 4 extra bytes cover a character cut at the end of the read.
const MAX_READ_BYTES = MAX_CHARS * 3 + 4;
// The global rules file. It sits in the state folder, where Plenum keeps its own files; it is never written to a CLI's own folder.
export const GLOBAL_FILE = path.join(HOME, 'rules.md');

const CHANGED = 'The file changed on disk since you opened it. Reload to see the new text.';
const OUTSIDE = 'This file points outside the project folder, so it is not edited here.';
const NOT_FILE = 'This is not a regular file, so it is not edited here.';
const OVER_MB = 'This file is over 1 MB, so it is not edited here.';
const UNREADABLE = 'This file cannot be read, so it is not edited here.';
const PROJECT_CUT = 'This file is over 64,000 characters, so it is not edited here. Plenum sends only its first 32,000 characters.';
const GLOBAL_CUT = 'This file is over 64,000 characters, so it is not edited here. Plenum sends only its first 16,000 characters.';
const CREDENTIAL = 'That folder holds credentials and is off limits.';

// A refusal with the status the route answers. The message is for the person, so it says what happened and what to do.
export class RulesError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RulesError';
    this.status = status;
  }
}

// True when target is inside root. The root itself does not count, and neither does a path that climbs out of it.
function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Reads the first `count` bytes of a file and no more, so a very long file is never loaded whole.
async function readHead(file, count) {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buf, 0, count, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

const hashOf = bytes => createHash('sha256').update(bytes).digest('hex');
// A stand-in for the hash of a file the panel does not read (too large, outside the project, not a regular file). It moves when the
// file's size or time moves, which is all the panel needs to notice a change.
const statHash = st => 'stat:' + createHash('sha256').update(`${st.size}:${st.mtimeMs}`).digest('hex');
// The leading byte-order mark a Windows editor may add is not part of the text.
const stripBom = text => text.replace(/^﻿/, '');

// Cuts text to at most max characters, never inside a surrogate pair.
function cutTo(text, max) {
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}

// What the panel gets for a file it does not show as text: the size, a stand-in hash, and the reason it is read-only.
function blocked(st, note) {
  return { exists: true, bytes: st.size, chars: 0, hash: statHash(st), text: '', cut: false, editable: false, note };
}

// The part of an entry that comes from the file's bytes: the hash, the text (BOM removed, cut at the save limit) and the reason
// it is read-only. guardNote is the checkAccess message when the write rules refuse the file, or ''.
function fromBytes(bytes, st, guardNote, cutNote) {
  const hash = hashOf(bytes);
  const raw = stripBom(bytes.toString('utf8'));
  const chars = raw.length;
  const cut = chars > SAVE_MAX_CHARS;
  const text = cut ? cutTo(raw, SAVE_MAX_CHARS) : raw;
  const editable = !cut && !guardNote;
  return { exists: true, bytes: st.size, chars, hash, text, cut, editable, note: cut ? cutNote : guardNote };
}

// The reason the write rules refuse a project file at its real path, or ''. Credential folders and everything checkAccess refuses
// for writes (system folders, Plenum's own source) count.
function writeNote(real) {
  if (isCredentialPath(real)) return CREDENTIAL;
  try {
    checkAccess(real, { write: true });
    return '';
  } catch (err) {
    return err.message;
  }
}

// Returns { text, bytes } for the project's AGENTS.md, or null when there is no usable file. This is what the chat prompt reads.
// text is capped at 32,000 characters. bytes is the file size on disk, before the cap.
export async function loadProjectRules(projectPath) {
  let root;
  let real;
  try {
    root = await fs.realpath(projectPath);
    real = await fs.realpath(path.join(root, RULES_FILE));
  } catch {
    // No project folder, or no AGENTS.md in it.
    return null;
  }
  // Refused: the file, or a link to it, resolves outside the project folder, or into a credential folder.
  if (!insideRoot(root, real) || isCredentialPath(real)) return null;
  try {
    const stat = await fs.stat(real);
    if (!stat.isFile()) return null;
    // A file over the read limit is read only up to it. The cap below then trims the text to MAX_CHARS.
    const raw = stripBom(await readHead(real, Math.min(stat.size, MAX_READ_BYTES)));
    // An empty file has nothing to tell the model, so it counts as no file.
    if (!raw.trim()) return null;
    const text = cutTo(raw, MAX_CHARS);
    return { text, bytes: stat.size };
  } catch {
    // Unreadable, such as a folder named AGENTS.md. The chat goes on without it.
    return null;
  }
}

// The global rules for the prompt, or null. Same rules as loadProjectRules, for GLOBAL_FILE with GLOBAL_MAX_CHARS. A link is not
// followed, so a rules.md that points elsewhere is not read.
export async function loadGlobalRules() {
  const st = await fs.lstat(GLOBAL_FILE).catch(() => null);
  if (!st || !st.isFile()) return null;
  try {
    const raw = stripBom(await readHead(GLOBAL_FILE, Math.min(st.size, GLOBAL_MAX_CHARS * 3 + 4)));
    if (!raw.trim()) return null;
    return { text: cutTo(raw, GLOBAL_MAX_CHARS), bytes: st.size };
  } catch {
    return null;
  }
}

// The entry for a rules file that is not there. The panel offers Create for it.
function absentEntry(name) {
  return { name, exists: false, bytes: 0, chars: 0, hash: 'absent', text: '', cut: false, editable: true, note: '' };
}

// One project file, read for the panel. Refusals keep the text back: the panel never shows a file outside the project or in a
// credential folder.
async function projectEntry(root, name) {
  const link = path.join(root, name);
  const lst = await fs.lstat(link).catch(() => null);
  if (!lst) return absentEntry(name);
  let real;
  try {
    real = await fs.realpath(link);
  } catch {
    // A link to nothing: it exists, but there is no file to read.
    return { name, ...blocked(lst, UNREADABLE) };
  }
  if (!insideRoot(root, real)) return { name, ...blocked(lst, OUTSIDE) };
  if (isCredentialPath(real)) return { name, ...blocked(lst, CREDENTIAL) };
  const st = await fs.stat(real).catch(() => null);
  if (!st) return { name, ...blocked(lst, UNREADABLE) };
  if (!st.isFile()) return { name, ...blocked(st, NOT_FILE) };
  if (st.size > READ_MAX_BYTES) return { name, ...blocked(st, OVER_MB) };
  const bytes = await fs.readFile(real);
  return { name, ...fromBytes(bytes, st, writeNote(real), PROJECT_CUT) };
}

// One entry per rules file, in RULES_FILES order. A project folder that is not there gives three absent files, so the panel
// still opens; saving then says the folder cannot be found.
export async function listProjectRules(projectPath) {
  let root = null;
  try {
    root = await fs.realpath(projectPath);
  } catch {
    root = null;
  }
  const out = [];
  for (const name of RULES_FILES) out.push(root ? await projectEntry(root, name) : absentEntry(name));
  return out;
}

// Serialises saves to one file, so two saves of the same file run one after the other and the second one sees the first.
const queues = new Map();
function serial(key, job) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

// The text as it is saved: BOM removed, every line ending turned into the one the file already uses.
function shapeText(text, eol) {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').join(eol);
}

// Writes bytes to a temporary file in the same folder, then renames it over target, so a crash never leaves half a file.
async function writeAtomic(target, bytes) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, bytes, { flag: 'wx' });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function checkText(text, max, tooLong) {
  if (typeof text !== 'string') throw new RulesError(400, 'Send the text as a string.');
  if (text.length > max) throw new RulesError(400, tooLong);
  if (text.includes('\u0000')) throw new RulesError(400, 'The text cannot contain NUL characters.');
}

// The hash the panel loaded. A save without it is refused, because it could overwrite a change the panel never saw.
function checkSeen(seen) {
  if (typeof seen !== 'string' || seen === '') throw new RulesError(400, 'Send the hash of the text you loaded, so a change on disk is not overwritten.');
}

// Saves one of the three rules files in the project. Returns its new entry.
// A file that exists is checkpointed first; a save is refused unless its hash is the one the caller loaded.
export function saveProjectRules({ projectId, projectPath, name, text, seen } = {}) {
  return serial(`project:${String(projectPath)}:${String(name)}`, async () => {
    if (!RULES_FILES.includes(name)) throw new RulesError(400, 'That file is not one of the rules files: AGENTS.md, CLAUDE.md or GEMINI.md.');
    checkText(text, SAVE_MAX_CHARS, 'The rules file can be at most 64,000 characters.');
    checkSeen(seen);
    let root;
    try {
      root = await fs.realpath(projectPath);
    } catch {
      throw new RulesError(400, 'The project folder cannot be found.');
    }
    const link = path.join(root, name);
    const lst = await fs.lstat(link).catch(err => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    let target = link;
    let existing = Buffer.alloc(0);
    let current = 'absent';
    if (lst) {
      // An existing file is edited at its real place: a link inside the project is followed, and a link out is refused.
      let real;
      try {
        real = await fs.realpath(link);
      } catch {
        throw new RulesError(400, UNREADABLE);
      }
      if (!insideRoot(root, real)) throw new RulesError(400, OUTSIDE);
      const st = await fs.stat(real);
      if (!st.isFile()) throw new RulesError(400, NOT_FILE);
      if (st.size > READ_MAX_BYTES) throw new RulesError(400, OVER_MB);
      const refusal = writeNote(real);
      if (refusal) throw new RulesError(400, refusal);
      existing = await fs.readFile(real);
      // A file longer than the save limit is shown read-only, so the server refuses it too, whatever hash is sent.
      if (stripBom(existing.toString('utf8')).length > SAVE_MAX_CHARS) throw new RulesError(400, PROJECT_CUT);
      current = hashOf(existing);
      target = real;
    } else {
      const refusal = writeNote(link);
      if (refusal) throw new RulesError(400, refusal);
    }
    if (current !== seen) throw new RulesError(409, CHANGED);
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    if (lst) {
      // The checkpoint of the old text comes before the overwrite. If none can be kept, the file is left as it is.
      const kept = await snapshotBeforeWrite({ projectId, projectPath: root, absPath: target, label: 'Rules: ' + name });
      if (!kept) throw new RulesError(500, 'Plenum could not keep a checkpoint of the file, so it was not saved. Try again.');
    }
    await writeAtomic(target, Buffer.from(shapeText(text, eol), 'utf8'));
    return projectEntry(root, name);
  });
}

// The global rules as the panel shows them: exists, bytes, chars, hash, text, cut, editable and note. Cut at the save limit.
export async function readGlobalRules() {
  const lst = await fs.lstat(GLOBAL_FILE).catch(() => null);
  if (!lst) return absentGlobal();
  if (lst.isSymbolicLink()) return blocked(lst, 'This file points somewhere else, so it is not edited here.');
  if (!lst.isFile()) return blocked(lst, NOT_FILE);
  if (lst.size > READ_MAX_BYTES) return blocked(lst, OVER_MB);
  const bytes = await fs.readFile(GLOBAL_FILE);
  return fromBytes(bytes, lst, '', GLOBAL_CUT);
}

function absentGlobal() {
  return { exists: false, bytes: 0, chars: 0, hash: 'absent', text: '', cut: false, editable: true, note: '' };
}

// Saves the global rules to GLOBAL_FILE, keeping the previous text as rules.md.bak. Returns the new entry (readGlobalRules).
export function saveGlobalRules({ text, seen } = {}) {
  return serial('global', async () => {
    checkText(text, GLOBAL_MAX_CHARS, 'The global rules can be at most 16,000 characters.');
    checkSeen(seen);
    await fs.mkdir(HOME, { recursive: true });
    const lst = await fs.lstat(GLOBAL_FILE).catch(err => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    let existing = Buffer.alloc(0);
    let current = 'absent';
    if (lst) {
      if (lst.isSymbolicLink()) throw new RulesError(400, 'This file points somewhere else, so it is not edited here.');
      if (!lst.isFile()) throw new RulesError(400, NOT_FILE);
      if (lst.size > READ_MAX_BYTES) throw new RulesError(400, OVER_MB);
      existing = await fs.readFile(GLOBAL_FILE);
      if (stripBom(existing.toString('utf8')).length > SAVE_MAX_CHARS) throw new RulesError(400, GLOBAL_CUT);
      current = hashOf(existing);
    }
    if (current !== seen) throw new RulesError(409, CHANGED);
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    if (lst) await fs.copyFile(GLOBAL_FILE, GLOBAL_FILE + '.bak').catch(err => {
      if (err.code !== 'ENOENT') throw err;
    });
    await writeAtomic(GLOBAL_FILE, Buffer.from(shapeText(text, eol), 'utf8'));
    return readGlobalRules();
  });
}
