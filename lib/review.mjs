// What the review pane shows: the changed files of a project, read from git, with each file's diff, its hunks and a hash of its
// full diff. The hash is what a hunk action must quote back (lib/routes/review.mjs), so a file that changed since the pane was drawn
// is refused. When the folder is not a repository, a turn snapshot may answer instead (lib/shadow.mjs, from pro-05; without that
// module the answer is "none").
//
// Git runs through lib/git-run.mjs with fixed arguments: three processes read the changes (staged, not staged, and the untracked
// list) and one reads the branch name. The paths in the output are the ones git reported; nothing the page sends reaches git here.
// The two diffs run with DIFF_SAFE and with the repository's filter drivers emptied by runGit, so opening a changed folder in the pane
// starts no program the repository named (DECISIONS item 30).
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { capDetail } from './diff.mjs';
import { checkAccess } from './guard.mjs';
import { DIFF_SAFE, runGit } from './git-run.mjs';

// At most this many files in all, across the groups. The rest are dropped and the answer says truncated.
export const MAX_CHANGED_FILES = 300;
// The text a file shows in the pane: the same cap as an approval card. Show all asks for the full text, cut at FULL_CHARS.
export const DETAIL_CHARS = 40_000;
export const FULL_CHARS = 2_000_000;
// An untracked file larger than this is listed without its text.
export const UNTRACKED_MAX_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;
const DIFF_MAX_BUFFER = 64 * 1024 * 1024;
// git writes the diff headers with these prefixes whatever diff.noprefix or diff.mnemonicPrefix say.
const PREFIXES = Object.freeze(['--src-prefix=a/', '--dst-prefix=b/']);
const DIFF_ARGS = Object.freeze(['-M', '-U3', '--relative', ...PREFIXES, ...DIFF_SAFE]);
const NOT_A_REPO_CODE = 128;

export class ReviewError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const sha256 = text => createHash('sha256').update(text).digest('hex');

// ---------- git's diff output ----------

// Splits `git diff` output into one list of lines per file. A file starts at a line beginning 'diff --git '.
function fileSections(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = [line];
      out.push(cur);
    } else if (cur) {
      cur.push(line);
    }
  }
  // The text ends with a newline, which leaves one empty line at the end of the last file.
  for (const lines of out) while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return out;
}

// git quotes a path that has unusual characters: double quotes, C escapes and octal bytes. This reads it back as text.
function unquote(text) {
  const s = String(text).replace(/\t$/, '');
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const inner = s.slice(1, -1);
  const SIMPLE = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
    } else if (Object.hasOwn(SIMPLE, inner[i + 1])) {
      bytes.push(SIMPLE[inner[i + 1]]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// The name on a '--- ' or '+++ ' line: a/PATH or b/PATH, or null for /dev/null.
function sideName(text, prefix) {
  const name = unquote(text);
  if (name === '/dev/null') return null;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

// The name on a 'diff --git a/P b/P' line when the header has no +++ or --- line (a binary file). Both names are P when the file
// was not renamed, so the name is the text between 'a/' and the ' b/' that follows it.
function nameFromGitLine(line) {
  const rest = line.slice('diff --git '.length);
  const n = (rest.length - 5) / 2;
  if (Number.isInteger(n) && n > 0 && rest.startsWith('a/') && rest.slice(2 + n, 3 + n) === ' ' && rest.slice(3 + n, 5 + n) === 'b/' && rest.slice(2, 2 + n) === rest.slice(5 + n)) {
    return rest.slice(2, 2 + n);
  }
  const last = rest.lastIndexOf(' b/');
  return last >= 0 ? unquote(rest.slice(last + 3)) : unquote(rest);
}

// What a file's header lines say: its path, the old path for a rename, its status letter and whether git calls it binary.
function headerOf(header) {
  let oldSide = null;
  let newSide = null;
  let renameFrom = null;
  let renameTo = null;
  let isNew = false;
  let isGone = false;
  let binary = false;
  for (const line of header) {
    if (line.startsWith('--- ')) oldSide = sideName(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) newSide = sideName(line.slice(4), 'b/');
    else if (line.startsWith('rename from ')) renameFrom = unquote(line.slice('rename from '.length));
    else if (line.startsWith('rename to ')) renameTo = unquote(line.slice('rename to '.length));
    else if (line.startsWith('new file mode')) isNew = true;
    else if (line.startsWith('deleted file mode')) isGone = true;
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) binary = true;
  }
  const status = renameFrom !== null ? 'R' : isNew ? 'A' : isGone ? 'D' : 'M';
  return { oldSide, newSide, renameFrom, renameTo, status, binary };
}

// The file's diff lines, split into its header (before the first hunk) and its hunks. Hunk i starts at a line beginning '@@ '
// and runs to the next one. A hunk's firstLine is the index of its header line among the file's lines.
function parseFile(lines) {
  const starts = [];
  lines.forEach((line, i) => {
    if (line.startsWith('@@ ')) starts.push(i);
  });
  const headerEnd = starts.length ? starts[0] : lines.length;
  const hunks = starts.map((from, index) => ({
    index,
    header: lines[from],
    firstLine: from,
    from,
    to: index + 1 < starts.length ? starts[index + 1] : lines.length,
  }));
  let added = 0;
  let removed = 0;
  for (let i = headerEnd; i < lines.length; i += 1) {
    if (lines[i].startsWith('+')) added += 1;
    else if (lines[i].startsWith('-')) removed += 1;
  }
  return { header: lines.slice(0, headerEnd), hunks, added, removed };
}

// The file object for one file of a diff. full is the whole diff text of the file, which the hash covers.
function fileFromSection(lines, group) {
  const parsed = parseFile(lines);
  const meta = headerOf(parsed.header);
  let filePath = meta.newSide ?? meta.renameTo ?? meta.oldSide;
  if (filePath === null || filePath === undefined) filePath = nameFromGitLine(lines[0]);
  const full = `${lines.join('\n')}\n`;
  return {
    group,
    path: filePath,
    ...(meta.status === 'R' && meta.renameFrom !== null ? { oldPath: meta.renameFrom } : {}),
    status: meta.status,
    added: parsed.added,
    removed: parsed.removed,
    binary: meta.binary,
    tooLarge: false,
    full,
    diffHash: sha256(full),
    hunks: parsed.hunks.map(h => ({ index: h.index, header: h.header, firstLine: h.firstLine })),
  };
}

// The git diff of a file that git does not track yet, written the way git writes a new file. The text is read with a size and
// binary check by the caller. A file with no lines has no hunk.
function newFileFromText(rel, text) {
  const lines = String(text).split('\n');
  const noEol = lines.length > 0 && lines[lines.length - 1] !== '';
  if (lines[lines.length - 1] === '') lines.pop();
  const head = [`diff --git a/${rel} b/${rel}`, 'new file mode 100644', '--- /dev/null', `+++ b/${rel}`];
  const body = lines.map(line => `+${line}`);
  if (noEol && body.length) body.push('\\ No newline at end of file');
  const all = [...head, ...(body.length ? [`@@ -0,0 +1,${lines.length} @@`, ...body] : [])];
  const hunks = body.length ? [{ index: 0, header: all[head.length], firstLine: head.length }] : [];
  return {
    group: 'untracked',
    path: rel,
    status: 'U',
    added: lines.length,
    removed: 0,
    binary: false,
    tooLarge: false,
    full: `${all.join('\n')}\n`,
    diffHash: sha256(`${all.join('\n')}\n`),
    hunks,
  };
}

// The per-file object the page and the API get. The full text stays on the server (see fullOf).
function publicFile(f) {
  const full = f.full ?? '';
  const diffHash = f.diffHash ?? sha256(full);
  const out = {
    path: f.path,
    status: f.status,
    added: f.added ?? 0,
    removed: f.removed ?? 0,
    binary: Boolean(f.binary),
    tooLarge: Boolean(f.tooLarge),
    diff: f.binary || f.tooLarge ? '' : capDetail(full, DETAIL_CHARS),
    capped: !f.binary && !f.tooLarge && full.length > DETAIL_CHARS,
    diffHash,
    hunks: f.hunks ?? [],
  };
  if (f.oldPath !== undefined) out.oldPath = f.oldPath;
  return out;
}

// The text for Show all: the whole diff, cut at FULL_CHARS.
export function cutFull(full) {
  const s = String(full ?? '');
  if (s.length <= FULL_CHARS) return s;
  const note = '\n…the rest of the diff is cut.';
  return `${s.slice(0, FULL_CHARS - note.length)}${note}`;
}

// The patch for one hunk of a file: the file's own header lines and that one hunk, ready for git apply. null when there is no
// such hunk. The text comes from git's own output; nothing from the page is in it.
export function patchFor(full, index) {
  const lines = String(full).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const { header, hunks } = parseFile(lines);
  const hunk = hunks[index];
  if (!hunk || !Number.isInteger(index)) return null;
  return `${[...header, ...lines.slice(hunk.from, hunk.to)].join('\n')}\n`;
}

// ---------- reading the changes ----------

// Keeps the first MAX_CHANGED_FILES of the tracked files, staged first. The untracked files take the room that is left.
function underLimit(groups) {
  let left = MAX_CHANGED_FILES;
  let truncated = false;
  const out = {};
  for (const name of ['staged', 'unstaged']) {
    const list = groups[name] ?? [];
    out[name] = list.slice(0, Math.max(0, left));
    if (list.length > out[name].length) truncated = true;
    left -= out[name].length;
  }
  return { groups: out, truncated };
}

// One untracked file as the group entry. A file the guard refuses (a link into a credential folder) returns null and is not listed.
async function untrackedEntry(root, rel) {
  const abs = path.resolve(root, ...rel.split('/'));
  const info = await fs.lstat(abs).catch(() => null);
  if (!info || info.isDirectory()) return null;
  // A link is followed here too: git lists a junction's files under its own name, so the place it leads to is checked.
  let real;
  try {
    real = await fs.realpath(abs);
    checkAccess(real);
  } catch {
    return null;
  }
  if (info.isSymbolicLink() || info.size > UNTRACKED_MAX_BYTES) {
    const why = info.isSymbolicLink() ? 'binary' : 'large';
    const entry = { group: 'untracked', path: rel, status: 'U', added: 0, removed: 0, binary: why === 'binary', tooLarge: why === 'large', full: '', hunks: [] };
    entry.diffHash = sha256(`${why}:${info.size}:${info.mtimeMs}`);
    return entry;
  }
  const data = await fs.readFile(real);
  if (data.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return { group: 'untracked', path: rel, status: 'U', added: 0, removed: 0, binary: true, tooLarge: false, full: '', hunks: [], diffHash: sha256(`binary:${data.length}`) };
  }
  return newFileFromText(rel, data.toString('utf8'));
}

// The changes in the repository at root, with the full diff text of each file (for the hunk and file routes).
// Resolves { repo: false } for a folder that is not a repository, { repo: false, noGit: true } when git is not installed, and
// { repo: true, branch, groups, truncated } otherwise. Throws a ReviewError (status 500 or 413) when git fails.
export async function collectChanges(root) {
  const empty = { groups: { staged: [], unstaged: [], untracked: [] }, truncated: false };
  // Outside a repository `git diff --cached` is not a repository error: git reads it as a --no-index diff and fails with a usage
  // message (exit 129), so the repository test is asked on its own. The answer is "true" inside the work tree.
  // --show-prefix is the project folder inside the repository ('' when the project is the repository's top folder). The diffs are
  // relative to the project folder (--relative), so a hunk applied with git apply needs that prefix (see apply in routes/review.mjs).
  const inside = await runGit(['rev-parse', '--is-inside-work-tree', '--show-prefix'], { cwd: root });
  if (inside.notFound) return { repo: false, noGit: true, ...empty };
  if (!inside.ok && inside.code !== NOT_A_REPO_CODE) throw new ReviewError(500, 'Plenum could not read the changes. Try again.');
  const [flag = '', prefixLine = ''] = inside.ok ? inside.stdout.split('\n') : [];
  if (!inside.ok || flag.trim() !== 'true') return { repo: false, ...empty };
  const prefix = prefixLine.trim();
  const stagedRun = await runGit(['diff', '--cached', ...DIFF_ARGS], { cwd: root, maxBuffer: DIFF_MAX_BUFFER });
  if (stagedRun.notFound) return { repo: false, noGit: true, ...empty };
  if (stagedRun.tooBig) throw new ReviewError(413, 'The changes are too large to read at once.');
  if (!stagedRun.ok) throw new ReviewError(500, 'Plenum could not read the changes. Try again.');
  const unstagedRun = await runGit(['diff', ...DIFF_ARGS], { cwd: root, maxBuffer: DIFF_MAX_BUFFER });
  if (unstagedRun.tooBig) throw new ReviewError(413, 'The changes are too large to read at once.');
  if (!unstagedRun.ok) throw new ReviewError(500, 'Plenum could not read the changes. Try again.');
  const untrackedRun = await runGit(['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root });
  if (!untrackedRun.ok) throw new ReviewError(500, 'Plenum could not read the changes. Try again.');
  const branchRun = await runGit(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root });

  const staged = fileSections(stagedRun.stdout).map(lines => fileFromSection(lines, 'staged'));
  const unstaged = fileSections(unstagedRun.stdout).map(lines => fileFromSection(lines, 'unstaged'));
  // The tracked files keep the first places; the untracked ones take what room is left, in git's order.
  const kept = underLimit({ staged, unstaged });
  let room = MAX_CHANGED_FILES - kept.groups.staged.length - kept.groups.unstaged.length;
  const names = untrackedRun.stdout.split('\0').filter(Boolean);
  const untracked = [];
  let untrackedCut = false;
  for (const rel of names) {
    if (room <= 0) {
      untrackedCut = true;
      break;
    }
    const entry = await untrackedEntry(root, rel);
    if (entry) {
      untracked.push(entry);
      room -= 1;
    }
  }
  const groups = { staged: kept.groups.staged, unstaged: kept.groups.unstaged, untracked };
  const branch = branchRun.ok ? branchRun.stdout.trim() || null : null;
  return { repo: true, branch, prefix, groups, truncated: kept.truncated || untrackedCut };
}

// The public answer for the changes of a folder (no full text): { repo, branch, groups, truncated }.
export async function changes(root) {
  const state = await collectChanges(root);
  if (!state.repo) return { repo: false, ...(state.noGit ? { noGit: true } : {}) };
  return {
    repo: true,
    branch: state.branch,
    groups: publicGroups(state.groups),
    truncated: state.truncated,
  };
}

export function publicGroups(groups) {
  const out = {};
  for (const [name, files] of Object.entries(groups)) out[name] = files.map(publicFile);
  return out;
}

// The full diff text of a file in an answer from collectChanges (or a snapshot), for Show all.
export function fullOf(file) {
  return file.full ?? file.diff ?? '';
}

// The module that answers for a folder that is not a repository. It is named through a variable, not a plain string: lib/shadow.mjs
// comes with pro-05 and does not exist yet, and the update check (checkImports in lib/updates.mjs) refuses a bundle that imports a
// file which is neither in the bundle nor installed, which a plain string here would do to every update that ships this file.
// When pro-05 adds the file, this can become a plain import.
const SHADOW_MODULE = './shadow.mjs';

// The changed files of a folder that is not a repository, from a turn snapshot. lib/shadow.mjs (pro-05) is loaded when it exists.
// Returns { groups: { snapshot: [...] }, truncated } or null when there is no such module or it does not answer.
export async function snapshotChanges(root, scopeId, since) {
  let mod;
  try {
    mod = await import(SHADOW_MODULE);
  } catch {
    return null;
  }
  if (typeof mod.reviewChanges !== 'function') return null;
  try {
    const out = await mod.reviewChanges(root, scopeId, since);
    const files = Array.isArray(out?.groups?.snapshot) ? out.groups.snapshot : null;
    if (!files) return null;
    const kept = files.slice(0, MAX_CHANGED_FILES).map(f => ({ ...f, group: 'snapshot' }));
    return { groups: { snapshot: kept.map(publicFileSnapshot) }, truncated: files.length > MAX_CHANGED_FILES };
  } catch {
    return null;
  }
}

// A snapshot file already comes in the public shape (its diff is capped by pro-05); this keeps the fields the pane uses.
function publicFileSnapshot(f) {
  return {
    path: String(f.path ?? ''),
    status: typeof f.status === 'string' ? f.status : 'M',
    added: Number(f.added) || 0,
    removed: Number(f.removed) || 0,
    binary: Boolean(f.binary),
    tooLarge: Boolean(f.tooLarge),
    diff: typeof f.diff === 'string' ? f.diff : '',
    capped: Boolean(f.capped),
    diffHash: typeof f.diffHash === 'string' ? f.diffHash : sha256(String(f.diff ?? '')),
    hunks: Array.isArray(f.hunks) ? f.hunks : [],
  };
}
