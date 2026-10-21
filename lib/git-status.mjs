// Git status for the project header: the branch, how far it is ahead or behind, and the changed and untracked files.
// gitStatus runs one read-only command in the project folder (`git status --porcelain=v2 --branch`) and parsePorcelain
// turns its output into numbers and paths. Nothing is written, and no request data reaches the command.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// The whole argument list, fixed. The only thing that varies between calls is the folder the command runs in.
// A repository's own config can name a program for core.fsmonitor, which git would run on every status; the header asks
// every 30 seconds, so it is switched off here (an empty value means off in every git version).
const GIT_ARGS = Object.freeze(['-c', 'core.fsmonitor=', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
const TIMEOUT_MS = 8000;
const MAX_BUFFER = 2 * 1024 * 1024;
// A long list of paths is cut here. The counts always cover every entry.
const MAX_PATHS = 200;

// The variables git needs to find itself and the user's git settings. Everything else in the server's environment stays out
// of the child, so a key held in the environment never reaches it, and a GIT_DIR or GIT_WORK_TREE set in the environment
// cannot point git somewhere other than the project folder.
const ENV_KEEP = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'XDG_CONFIG_HOME', 'LANG',
];

// Exported for the tests, which check what the child would be given.
export function gitEnv(source = process.env) {
  const env = {};
  const upper = new Map(Object.keys(source).map(key => [key.toUpperCase(), key]));
  for (const name of ENV_KEEP) {
    const key = upper.get(name);
    if (key !== undefined && typeof source[key] === 'string') env[key] = source[key];
  }
  // Status must not write: no index refresh lock, and never a prompt for a password.
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

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
//   '# branch.ab +A -B' commits ahead and behind the upstream (the line is missing when there is no upstream)
//   '1 ' and '2 '       changed files (a '2 ' entry is a rename or a copy; the new path is kept)
//   '? '                untracked files
//   'u '                files with an unresolved merge conflict (counted only)
export function parsePorcelain(text) {
  const out = { branch: '', ahead: 0, behind: 0, changed: [], untracked: [], changedCount: 0, untrackedCount: 0, unmerged: 0, clean: true };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
      out.branch = line.slice('# branch.head '.length).trim();
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
  return out;
}

// The state of the git repository in root. root must be an absolute path to an existing folder; the server passes the path
// of a project, which was checked when the project was added. Never rejects. The answer is one of
//   { repo: true, ...parsePorcelain }   a repository
//   { repo: false }                     not a repository, or not a usable folder
//   { repo: false, noGit: true }        git is not installed
//   { repo: false, error: '...' }       git did not answer (timeout, too much output, or any other failure)
export async function gitStatus(root) {
  try {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return { repo: false };
    const stat = await fs.stat(root).catch(() => null);
    if (!stat || !stat.isDirectory()) return { repo: false };
    return await new Promise(resolve => {
      execFile('git', GIT_ARGS, { cwd: root, env: gitEnv(), windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
        if (!err) return resolve({ repo: true, ...parsePorcelain(stdout) });
        if (err.code === 'ENOENT') return resolve({ repo: false, noGit: true });
        if (err.code === 128 || /not a git repository/i.test(String(stderr ?? ''))) return resolve({ repo: false });
        return resolve({ repo: false, error: 'git did not answer' });
      });
    });
  } catch {
    return { repo: false, error: 'git did not answer' };
  }
}
