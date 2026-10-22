// Git status for the project header: the branch, how far it is ahead or behind, and the changed and untracked files.
// gitStatus runs one read-only command in the project folder (`git status --porcelain=v2 --branch`) and parsePorcelain
// turns its output into numbers and paths. Nothing is written, and no request data reaches the command.
// The command goes through runGit (lib/git-run.mjs), like the review pane's, so a repository's own configuration cannot make it run
// a program: no fsmonitor, no hooks, no filter driver (the header asks for every open project at load and every 30 seconds, which
// is the easiest way to run one), and no status inside a submodule under its own configuration (DECISIONS item 30).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gitEnv } from './git-env.mjs';
import { runGit } from './git-run.mjs';

// The environment of every git child lives in lib/git-env.mjs; it is exported from here as well because the tests import it from here.
export { gitEnv };

// The whole argument list, fixed. The only thing that varies between calls is the folder the command runs in. runGit adds the
// overrides in front of it: core.fsmonitor and core.hooksPath emptied, every filter driver the configuration defines emptied, and
// --ignore-submodules=dirty after the command.
// The trailing '-- .' limits the status to the project folder. Without it a project inside a larger repository counts the
// changes of its sibling folders too (git prints those as ../sibling/..., relative to the folder it runs in).
const GIT_ARGS = Object.freeze(['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--', '.']);
// Windows cannot start a program in a folder whose path is this long or longer, unless long paths are switched on for the
// machine. The start then fails with ENOENT, which is what a missing git looks like, so the two are told apart by length.
const WIN_PATH_LIMIT = 259;
const TOO_LONG = `The folder path is too long for git (${WIN_PATH_LIMIT} characters or more).`;
const TIMEOUT_MS = 8000;
const MAX_BUFFER = 2 * 1024 * 1024;
// A long list of paths is cut here. The counts always cover every entry.
const MAX_PATHS = 200;

// git prints a path with unusual characters (quotes, tabs, and non-ASCII letters unless core.quotePath is off) inside double
// quotes with C escapes and octal bytes. This puts such a path back into plain text; any other text is returned as it is.
function unquote(text) {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const inner = text.slice(1, -1);
  const SIMPLE = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(String.fromCodePoint(inner.codePointAt(i))));
      if (inner.codePointAt(i) > 0xffff) i += 1;
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

// Everything after the first `skip` spaces of a line, or null when the line has fewer. A path may contain spaces, so the
// fields in front of it are counted instead of splitting on every space.
function afterFields(line, skip) {
  let at = -1;
  for (let i = 0; i < skip; i += 1) {
    at = line.indexOf(' ', at + 1);
    if (at < 0) return null;
  }
  return line.slice(at + 1);
}

// The path on an ordinary ('1 ') or rename ('2 ') entry. The fields in front of it are fixed: eight for '1 ', nine for
// '2 '. A rename ends with the new path, a tab and the old path, and the new path is the one that is kept. A line with
// fewer fields than that falls back to its last field.
function entryPath(line, skip, rename) {
  let rest = afterFields(line, skip);
  if (rest === null) rest = line.trimEnd().split(' ').pop();
  if (rename) rest = rest.split('\t')[0];
  return unquote(rest);
}

// Parses the output of `git status --porcelain=v2 --branch`. Pure: text in, one object out.
//   '# branch.head X'   the branch (git prints '(detached)' for a detached HEAD)
//   '# branch.oid H'    the commit HEAD points at (a full hash, or '(initial)' before the first commit)
//   '# branch.ab +A -B' commits ahead and behind the upstream (the line is missing when there is no upstream)
//   '1 ' and '2 '       changed files (a '2 ' entry is a rename or a copy; the new path is kept)
//   '? '                untracked files
//   'u '                files with an unresolved merge conflict (counted only)
// A detached HEAD sets detached to true and commit to the short form of the commit (empty when git gave no hash).
export function parsePorcelain(text) {
  const out = { branch: '', detached: false, commit: '', ahead: 0, behind: 0, changed: [], untracked: [], changedCount: 0, untrackedCount: 0, unmerged: 0, clean: true };
  let oid = '';
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
      out.branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (m) {
        out.ahead = Number(m[1]);
        out.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      out.changedCount += 1;
      if (out.changed.length < MAX_PATHS) out.changed.push(entryPath(line, line[0] === '1' ? 8 : 9, line[0] === '2'));
    } else if (line.startsWith('? ')) {
      out.untrackedCount += 1;
      if (out.untracked.length < MAX_PATHS) out.untracked.push(unquote(line.slice(2)));
    } else if (line.startsWith('u ')) {
      out.unmerged += 1;
    }
  }
  out.clean = out.changedCount === 0 && out.untrackedCount === 0 && out.unmerged === 0;
  if (out.branch === '(detached)') {
    out.detached = true;
    out.commit = /^[0-9a-f]{40,64}$/.test(oid) ? oid.slice(0, 7) : '';
  }
  return out;
}

// The state of the git repository in root. root must be an absolute path to an existing folder; the server passes the path
// of a project, which was checked when the project was added. Never rejects. The answer is one of
//   { repo: true, ...parsePorcelain }   a repository
//   { repo: false }                     not a repository, or not a usable folder
//   { repo: false, noGit: true }        git is not installed
//   { repo: false, error: '...' }       git did not answer (timeout, too much output, or any other failure)
//   { repo: false, error, tooLong: true } Windows could not start git in this folder: the path is too long (see WIN_PATH_LIMIT)
export async function gitStatus(root) {
  try {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return { repo: false };
    const stat = await fs.stat(root).catch(() => null);
    if (!stat || !stat.isDirectory()) return { repo: false };
    const r = await runGit(GIT_ARGS, { cwd: root, timeoutMs: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    if (r.ok) return { repo: true, ...parsePorcelain(r.stdout) };
    if (r.notFound) {
      // On Windows a folder path this long makes the start fail with ENOENT although git is installed. Any other ENOENT
      // means git itself cannot be found.
      if (process.platform === 'win32' && root.length >= WIN_PATH_LIMIT) return { repo: false, error: TOO_LONG, tooLong: true };
      return { repo: false, noGit: true };
    }
    if (r.code === 128 || /not a git repository/i.test(r.stderr)) return { repo: false };
    // A timeout, too much output, a configuration runGit could not neutralise, or any other failure.
    return { repo: false, error: 'git did not answer' };
  } catch {
    return { repo: false, error: 'git did not answer' };
  }
}
