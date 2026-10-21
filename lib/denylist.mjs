// Built-in command deny list. Checked before every shell command, in auto mode too. Contract:
//   checkCommand(commandLine, extraPatterns, options) -> { blocked: boolean, rule: string | null, parts: string[] }
// The built-in rules are always on: no setting, project or mode turns them off. A project can only add plain
// patterns of its own (extraPatterns). options.projectRoot is optional; with it, the project's own path (or a folder
// that holds it) counts as the project root in a recursive delete, as well as the relative forms such as . and *.
// A relative target is read from the folder the command runs in, which is the project root, moved by any cd before it:
// ../proj and cd .. && rm -rf proj both name a project at C:\work\proj. Without a root, a recursive delete that climbs
// out with .. to a single named folder counts, or only to the folder called options.projectName when that is given.
//
// The matching is deliberately over-cautious. It is a safety net for a model's mistakes, not a sandbox: a command
// built from variables or encoded text that this file cannot see through is not caught. Nothing here logs, stores or
// returns the command text except as the `parts` the caller already passed in.
import os from 'node:os';
import path from 'node:path';

export const MAX_DENY_PATTERNS = 50;
export const MAX_DENY_PATTERN_LENGTH = 120;

// The rule names a caller can show. `rule` is one of these, or `custom pattern "<text>"` for a project's own pattern.
export const RULES = Object.freeze({
  rmRoot: 'recursive delete of a drive root, home folder or project root',
  format: 'format',
  diskpart: 'diskpart',
  regDelete: 'reg delete',
  schtasks: 'schtasks /create',
  bcdedit: 'bcdedit',
  shutdown: 'shutdown',
  cipher: 'cipher /w',
  pipeShell: 'download piped into a shell',
  forcePush: 'git push --force',
  systemWrite: 'write to a system folder',
});

// ---------- custom patterns ----------

// Control characters, line breaks and invisible or direction-changing characters: a pattern with one would look
// different from what it matches.
const BAD_PATTERN_CHAR = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/;

// Validates a project's custom patterns and returns them trimmed, in order, without repeats (case-insensitive).
// Empty or unset gives []. A bad value throws an Error with a plain message, as the other project settings do.
// The messages never repeat the pattern.
export function normalizeDenyPatterns(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) throw new Error('Custom deny patterns must be a list of text patterns, or empty.');
  if (raw.length > MAX_DENY_PATTERNS) throw new Error(`At most ${MAX_DENY_PATTERNS} custom deny patterns are allowed.`);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error('Each custom deny pattern must be text.');
    if (BAD_PATTERN_CHAR.test(item)) throw new Error('A custom deny pattern cannot contain control characters.');
    const text = item.trim();
    // A blank entry would match every command, so it is dropped, never kept.
    if (text === '') continue;
    if (text.length > MAX_DENY_PATTERN_LENGTH) throw new Error(`A custom deny pattern can be at most ${MAX_DENY_PATTERN_LENGTH} characters.`);
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

// ---------- reading a command line ----------

// Characters that hide a word from the eye but not from the shell. Line breaks and tabs are kept for the caller.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
// Full-width letters and the like become plain ones, so a lookalike of a command is still read as the command.
const clean = s => s.normalize('NFKC').replace(/[\u0085\u2028\u2029]/g, '\n').replace(/\t/g, ' ').replace(INVISIBLE, '');

// The separators between commands. A single & is not a pipe, so it never joins a download to a shell on its own.
const SEPARATOR = /&&|\|\||\|&|[|&;\n\r]/g;
const HARD_OPS = new Set(['', '&&', '||', ';', '\n', '\r']);
const PIPE_OPS = new Set(['|', '|&']);
// cmd /c, powershell -Command and bash -c start another command line, so the part starts after them. PowerShell
// takes any prefix of -Command and -EncodedCommand, and -ec as well. The bounded repeats keep the match cheap.
const prefixesOf = word => Array.from(word, (_, k) => word.slice(0, k + 1));
const ENCODED_FLAGS = [...prefixesOf('encodedcommand'), 'ec'].join('|');
const PS_FLAGS = [...prefixesOf('command'), ENCODED_FLAGS].join('|');
const ENCODED = new RegExp(`-(?:${ENCODED_FLAGS})$`, 'i');
const WRAP = new RegExp(
  '((?<![\\w.-])(?:'
  + 'cmd(?:\\.exe)?(?:\\s*\\/[a-z]+){0,6}?\\s*\\/[ck]\\b'
  + `|(?:powershell|pwsh)(?:\\.exe)?(?:\\s+\\S+){0,12}?\\s+-(?:${PS_FLAGS})(?=\\s|$)`
  + '|(?:ba|z|da|k)?sh(?:\\.exe)?(?:\\s+-\\S+){0,6}?\\s+-[a-z]*c(?=\\s|$)'
  + '))', 'i');
const MAX_NESTING = 3;

// A half of a surrogate pair with no other half, and the control characters other than tab and line breaks: text that
// is not a script, so the bytes were not UTF-16 after all.
const NOT_UTF16_TEXT = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\u0000-\u0008\u000b\u000c\u000e-\u001f�]/;

// The text PowerShell's -EncodedCommand carries (base64 of UTF-16), or '' when it is not that. Any text counts, not only
// ASCII, as long as it decodes cleanly: a script with an accent or an emoji in it is still read.
function decodeCommand(piece) {
  const word = (piece.trim().split(/\s+/)[0] ?? '').replace(/^["']|["']$/g, '');
  if (word.length < 12 || !/^[A-Za-z0-9+/]+={0,2}$/.test(word)) return '';
  const bytes = Buffer.from(word, 'base64');
  // UTF-16 comes in pairs of bytes.
  if (bytes.length % 2 !== 0) return '';
  const text = bytes.toString('utf16le');
  return NOT_UTF16_TEXT.test(text) ? '' : text;
}

// Drops a quote that only opened or closed the part (cmd /c "a & b" leaves a and b as two parts, each with one stray
// quote), and a matching outer pair.
function unquote(p) {
  const q = p[0];
  if ((q === '"' || q === "'") && p.length > 1 && p.endsWith(q) && !p.slice(1, -1).includes(q)) return p.slice(1, -1).trim();
  let s = p;
  for (const c of ['"', "'"]) {
    if ((s.split(c).length - 1) % 2 === 1) s = s.startsWith(c) ? s.slice(1) : s.endsWith(c) ? s.slice(0, -1) : s;
  }
  return s.trim();
}

// PowerShell reads a backtick at the end of a line as "the command goes on": the next line is part of it. How the two
// lines join is not clear from here (Remove-` and Item is one word, while -Force` and -Recurse could be two), so a
// text with such a line is read both ways. The first way, with a space, is the one whose parts are shown.
const CONTINUED = /`[ \t]*(?:\r\n|[\n\r])/g;
function lineVariants(text) {
  if (!text.includes('`')) return [text];
  const spaced = text.replace(CONTINUED, ' ');
  return spaced === text ? [text] : [spaced, text.replace(CONTINUED, '')];
}

// Splits a cleaned command line into segments (at & && || | ;) and each segment into parts (at cmd /c and the like).
// A segment keeps the operator that came before it. A PowerShell -EncodedCommand adds its decoded text as more segments.
function segmentsOf(line, depth = 0) {
  // The & of 2>&1, >&2 and &>file is a redirection, not a separator.
  const text = line.replace(/([<>])&/g, '$1\u0001').replace(/&(?=>)/g, '\u0001');
  const out = [];
  const add = (chunk, op) => {
    const body = chunk.replace(/\u0001/g, '&').trim();
    if (!body) return;
    const pieces = body.split(WRAP);
    const parts = [];
    const nested = [];
    // split() with one capture group gives text, wrapper, text, wrapper, ... so the wrapper before a text is at k - 1.
    for (let k = 0; k < pieces.length; k += 2) {
      const part = unquote(pieces[k].trim());
      if (part) parts.push(part);
      if (k > 0 && depth < MAX_NESTING && ENCODED.test(pieces[k - 1])) {
        const decoded = decodeCommand(pieces[k]);
        if (decoded) for (const text of lineVariants(clean(decoded))) nested.push(...segmentsOf(text, depth + 1));
      }
    }
    if (nested.length) nested[0].op = ';';
    out.push({ op, text: body, parts }, ...nested);
  };
  let op = '';
  let start = 0;
  for (const m of text.matchAll(SEPARATOR)) {
    add(text.slice(start, m.index), op);
    op = m[0];
    start = m.index + m[0].length;
  }
  add(text.slice(start), op);
  return out;
}

// What the rules read: lower case, quotes and the escape characters ^ and ` removed (so "fo^rmat" and 'r''m' are
// still words), ${NAME} read as $NAME, and brackets turned into spaces so $(rm -rf /) and {rm,-rf,/} show their words.
const unbrace = s => s.toLowerCase().replace(/\$\{([^}]*)\}/g, '$$$1');
const scan = s => unbrace(s).replace(/["'`^]/g, '').replace(/[(){},]/g, ' ');
const tokensOf = s => scan(s).split(/\s+/).filter(Boolean);

// A quoted run with a space in it is one word to the shell: rm -rf "C:\My App" has one target. tokensOf splits it, which
// keeps the words of "$(rm -rf /)" and eval "rm -rf /" in view, so this is a second reading, used for the targets of a
// command. The spaces and brackets of such a run are swapped for characters that clean() takes out of any input (so none
// can be there already) while the line is split, and put back in each word. A run with a command substitution in it is
// left to tokensOf.
//
// There are two ways to find the runs, and a part is read both ways. QUOTED_RUN is the strict one: a quote in the middle
// of a word (don't) does not open a run. JOINED_RUN is how cmd.exe and the shells read quotes: every quote opens a run, a
// run joins the text on both sides of it, and a double quote with no partner runs to the end of the part. So C:\My" "App,
// C:\My" App", "C:\My "App and C:\My" App all read as the one path C:\My App, which is what rmdir /s /q C:\My" "App deletes.
// The strict reading stays because a stray quote (5" pipe) can pair the wrong quotes in the joined one.
const QUOTED_RUN = /(?<!\w)(?:"([^"]*)"|'([^']*)')/g;
const JOINED_RUN = /"([^"]*)(?:"|$)|'([^']*)'/g;
const HIDDEN = new Map([[' ', '\u0002'], ['(', '\u0003'], [')', '\u0004'], ['{', '\u0005'], ['}', '\u0006'], [',', '\u0007']]);
const SHOWN = new Map(Array.from(HIDDEN, ([shown, hidden]) => [hidden, shown]));
const hideRun = (run, double, single) => {
  const body = double ?? single;
  return /\s/.test(body) && !/\$\(|`|[<>]\(/.test(body) ? body.replace(/[\s(){},]/g, c => HIDDEN.get(c) ?? HIDDEN.get(' ')) : run;
};
// The words of a part with its quoted runs kept whole: one list for each way of finding the runs that gives a different
// reading (none when the part has no run to keep). The last is the one nearest to what the shell does.
function quotedTokensOf(s) {
  if (!/["']/.test(s)) return [];
  const text = unbrace(s);
  const readings = new Set();
  for (const runs of [QUOTED_RUN, JOINED_RUN]) {
    const hidden = text.replace(runs, hideRun);
    if (hidden !== text) readings.add(hidden);
  }
  return Array.from(readings, hidden => {
    const words = hidden.replace(/["'`^]/g, '').replace(/[(){},]/g, ' ').split(/\s+/).filter(Boolean);
    return words.map(w => w.replace(/[\u0002-\u0007]/g, c => SHOWN.get(c)));
  });
}

// A command word without its folder or extension: C:\Windows\System32\format.com -> format.
const base = t => (t ?? '').replace(/\\/g, '/').split('/').pop().replace(/\.(?:exe|com|cmd|bat|ps1)$/, '');
const squash = s => s.toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- delete rule ----------

const DELETE_VERBS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'rimraf', 'deltree']);
// cmd's own switches (/s /q /f) are not targets.
const CMD_DELETE = new Set(['rd', 'rmdir', 'del', 'erase']);
const CMD_SWITCH = /^(?:\/[a-z?](?::[^/]*)?)+$/;
const GLOB_TAIL = /\/(?:\*\*?|\.\*|\*\.\*)$/;
const DRIVE_ROOT = /^(?:[a-z]:|\/(?:mnt\/|cygdrive\/)?[a-z]|\/\?\/[a-z]:|%(?:systemdrive|homedrive)%|\$env:(?:systemdrive|homedrive))$/;
const HOME_FOLDER = /^(?:~[a-z0-9._-]*|\$home|\$env:(?:home|userprofile)|%(?:userprofile|homepath|home)%|%homedrive%%homepath%|\/root|(?:\/mnt\/[a-z]|\/cygdrive\/[a-z]|\/[a-z]|[a-z]:)?\/(?:users|home)(?:\/[^/]+)?)$/;
// The folder a command runs in is the project root, so these name it: ., .., *, $PWD, %CD% and Get-Location.
const PROJECT_FOLDER = /^(?:\.{1,2}(?:\/\.{1,2})*|\*{1,2}|\*\.\*|\.\*|\$pwd(?:\.path)?|\$cd|%cd%|pwd|get-location|\$psscriptroot)$/;

// Lower case, forward slashes, no doubled slashes. trimmed() then drops a trailing slash (C:\ becomes c:, / stays /).
const slashed = p => p.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
const trimmed = p => p.replace(/(.)\/$/, '$1');
const folderOf = p => trimmed(path.posix.normalize(slashed(p)));
// Git Bash and WSL write C:\work as /c/work or /mnt/c/work. This gives the C: form, so both spellings compare equal.
const driveForm = t => t.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?=\/|$)/, '$1:');
// A word that does not depend on the folder the command runs in: it starts at a root or a drive, or at ~ or a variable.
const ABSOLUTE = /^(?:\/|[a-z]:)/;
const FROM_VARIABLE = /^[$%~]/;
// $PWD/../proj starts in the folder the command runs in, as ./../proj does.
const CWD_VARIABLE = /^(?:\$pwd(?:\.path)?|\$cd|%cd%|\$psscriptroot)(?=\/|$)/;

// The folders a delete must not reach: the home folder and, when the caller says, the project root. Each is kept in
// both spellings. cwd is the folder the command runs in, as a path from the project root (. at the start; a cd moves it,
// and a cd to an absolute path makes it one).
function contextFor(options) {
  const homes = new Set();
  try {
    const home = folderOf(os.homedir());
    homes.add(home).add(driveForm(home));
  } catch {
    // No home folder to name; the ~ and $HOME forms still count.
  }
  const given = typeof options?.projectRoot === 'string' ? options.projectRoot.trim() : '';
  const root = given ? folderOf(given) : '';
  const named = typeof options?.projectName === 'string' ? options.projectName.trim().toLowerCase() : '';
  return {
    homes,
    projectRoots: given ? [root, driveForm(root)] : [],
    // Where a relative target can be placed: only a root that is a full path says. The name is all that is left of one that is not.
    rootAbs: ABSOLUTE.test(root) ? root : null,
    rootName: (root && root !== '.' ? root.split('/').pop() : '') || named,
    cwd: '.',
    kinds: new Map(),
  };
}

// What a delete target names: 'fs' (a drive or the file system root), 'home', 'project' or null. The answer for a word
// is kept for the rest of the check, since a long command line repeats words. A cd drops what was kept.
function rootKind(arg, ctx) {
  if (!ctx.kinds.has(arg)) ctx.kinds.set(arg, rootKindOf(arg, ctx));
  return ctx.kinds.get(arg);
}

function kindOfPath(t, ctx) {
  if (t === '/' || DRIVE_ROOT.test(t)) return 'fs';
  const forms = [t, driveForm(t)];
  if (HOME_FOLDER.test(t) || forms.some(f => ctx.homes.has(f))) return 'home';
  // A folder that holds the project is the project root as far as a delete is concerned.
  if (PROJECT_FOLDER.test(t) || forms.some(f => ctx.projectRoots.some(r => r === f || r.startsWith(`${f}/`)))) return 'project';
  return null;
}

// A relative target, read from the folder the command runs in. With the project root known, a path that climbs out of it
// with .. is placed (../proj is C:\work\proj for a project at C:\work\proj). Without it, the one thing that can be said is
// that a lone folder just above, which is the project's own folder when it has the project's name, is a project root.
function relativeKind(t, ctx) {
  const full = trimmed(path.posix.normalize(path.posix.join(ctx.cwd, t)));
  if (ABSOLUTE.test(full)) return kindOfPath(full, ctx);
  if (!/^\.\.(?:\/|$)/.test(full)) return null;
  if (ctx.rootAbs) return kindOfPath(trimmed(path.posix.normalize(path.posix.join(ctx.rootAbs, full))), ctx);
  const above = /^(?:\.\.\/)+([^/]+)$/.exec(full);
  return above && (!ctx.rootName || above[1] === ctx.rootName) ? 'project' : null;
}

function rootKindOf(arg, ctx) {
  let t = slashed(arg).replace(CWD_VARIABLE, '.');
  if (GLOB_TAIL.test(t)) t = t.replace(GLOB_TAIL, '') || '/';
  t = trimmed(path.posix.normalize(t));
  return kindOfPath(t, ctx) ?? (ABSOLUTE.test(t) || FROM_VARIABLE.test(t) ? null : relativeKind(t, ctx));
}

// Moves ctx.cwd for a cd (or pushd, Set-Location) part. A destination that is a variable, ~ or - is not followed.
const CD_VERBS = new Set(['cd', 'chdir', 'pushd', 'push-location', 'set-location', 'sl']);
const MAX_CWD = 260;
function followCd(part, tokens, ctx) {
  if (!CD_VERBS.has(base(tokens[0]))) return;
  const words = quotedTokensOf(part).at(-1) ?? tokens;
  let dest = null;
  for (const a of words.slice(1)) {
    if (a.length > 1 && a.startsWith('-')) {
      // -Path:.. carries its target in the flag itself.
      const cut = a.search(/[:=]/);
      if (cut > 0 && cut < a.length - 1) { dest = a.slice(cut + 1); break; }
      continue;
    }
    // cd /d D:\work: the switch is not the destination.
    if (CMD_SWITCH.test(a)) continue;
    dest = a;
    break;
  }
  // A very long destination, or a path that has climbed very far, is not followed: the cost of reading it grows with its length.
  if (dest === null || FROM_VARIABLE.test(dest) || dest === '-' || dest.length > MAX_CWD) return;
  const to = slashed(dest);
  let next = trimmed(path.posix.normalize(ABSOLUTE.test(to) ? to : path.posix.join(ctx.cwd, to)));
  // Above a drive or the root there is nowhere further to go.
  if (ABSOLUTE.test(ctx.cwd) && !ABSOLUTE.test(next)) next = '/';
  if (next.length > MAX_CWD) return;
  ctx.cwd = next;
  ctx.kinds.clear();
}

// Whether a word is a flag for recursion: -r, -rf, --recursive, -Recurse, or cmd's /s on its delete commands.
// Any flag with an r in it counts: too many is fine, too few is not.
function recursiveFlag(verb, a) {
  if (CMD_DELETE.has(verb) && CMD_SWITCH.test(a)) return a.split('/').includes('s');
  if (a.length < 2 || !a.startsWith('-')) return false;
  const cut = a.search(/[:=]/);
  const flag = cut > 0 ? a.slice(0, cut) : a;
  return flag === '--recursive' || /^-[a-z]*r[a-z]*$/.test(flag);
}

// A delete command aimed at a drive root or the home folder, or a recursive one aimed at the project root. It reads
// every word after the verb, however many there are: a root far from the verb is still its target.
function deletesRoot(verb, tokens, from, ctx) {
  let recursive = false;
  let project = false;
  for (let k = from; k < tokens.length; k++) {
    const a = tokens[k];
    if (a === '--') continue;
    if (recursiveFlag(verb, a)) recursive = true;
    // cmd's own switches (/s /q /f) are not targets.
    if (CMD_DELETE.has(verb) && CMD_SWITCH.test(a)) continue;
    let target = a;
    if (a.length > 1 && a.startsWith('-')) {
      // -Path:C:\ and --dir=/ carry their target in the flag itself.
      const cut = a.search(/[:=]/);
      if (cut <= 0 || cut >= a.length - 1) continue;
      target = a.slice(cut + 1);
    }
    const kind = rootKind(target, ctx);
    if (kind === 'fs' || kind === 'home') return true;
    if (kind === 'project') project = true;
  }
  return project && recursive;
}

// ---------- system folder rule ----------

const WRITE_VERBS = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'rimraf', 'mv', 'move', 'ren', 'rename', 'mkdir', 'md', 'touch', 'truncate', 'ln', 'mklink',
  'chmod', 'chown', 'chgrp', 'chattr', 'takeown', 'icacls', 'attrib', 'dd', 'tee', 'tar', 'unzip', '7z', 'curl', 'wget',
  'remove-item', 'move-item', 'rename-item', 'new-item', 'set-content', 'add-content', 'clear-content', 'out-file', 'expand-archive',
  'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'ri', 'mi', 'ni', 'rni',
]);
// For a copy the first path is the source, so only the paths after it (and a -t or -Destination value) are written to.
const COPY_VERBS = new Set(['cp', 'copy', 'xcopy', 'robocopy', 'copy-item', 'cpi', 'install', 'rsync', 'scp']);
const DEST_FLAG = /^-(?:t|target-directory|destination|dest|to)$/;
const SYSTEM_PATHS = [
  /^(?:(?:\/mnt|\/cygdrive)?\/[a-z]|[a-z]:)?\/(?:windows|winnt)(?:\/|$)/,
  /(?:^|\/)(?:system32|syswow64)(?:\/|$)/,
  /^(?:%(?:systemroot|windir)%|\$env:(?:systemroot|windir))(?:\/|$)/,
  /^(?:%systemdrive%|\$env:systemdrive)\/(?:windows|winnt)(?:\/|$)/,
  /^\/(?:etc|bin|sbin|boot|lib|lib32|lib64|usr|sys|proc)(?:\/|$)/,
  // A disk device, not /dev/null or /dev/stdout.
  /^\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|disk|md|dm-|loop|mapper)/,
];

// A path under the Windows folder or a Linux system folder. `of=/dev/sda` is read as its value. Dots in the
// path are resolved first, so /tmp/../etc is /etc.
function isSystemPath(raw) {
  const t = path.posix.normalize(slashed(raw.replace(/^[a-z][\w-]*=/, '')) || '.');
  return SYSTEM_PATHS.some(re => re.test(t));
}

// Whether the command word at tokens[i] writes to a system folder: a path in one is among the words after it, as a plain
// word, as the value of a flag (-Path:C:\Windows, --output=/etc/x) or as the word after -t or -Destination. For a copy the
// first path is the source, so it is passed over. Every word after the command word is read, however many there are.
function writesSystem(verb, tokens, i, search) {
  const isFlag = a => a.length > 1 && a.startsWith('-');
  // The word after -t or -Destination is its value, and a flag after a value is a flag again (-t -t /etc has /etc left over).
  const value = search.once('dest-value', () => {
    const marks = new Uint8Array(tokens.length);
    for (let k = 1; k < tokens.length; k++) marks[k] = DEST_FLAG.test(tokens[k - 1]) && !marks[k - 1] ? 1 : 0;
    return marks;
  });
  const system = (a, k) => {
    if (!isFlag(a) || value[k]) return isSystemPath(a);
    const cut = a.search(/[:=]/);
    return cut > 0 && isSystemPath(a.slice(cut + 1));
  };
  const first = search.next('system', system, i);
  if (first < 0 || !COPY_VERBS.has(verb)) return first >= 0;
  // The source is the first word that is not a flag or the value of one. It is the only path that does not count, so the
  // copy writes to a system folder when the first one found is not the source, or when there is another after it.
  const source = search.next('source', (a, k) => !isFlag(a) && !value[k], i);
  return first !== source || search.after('system', system, source);
}

// A redirect (>, >>) into a system folder.
function redirectsSystem(text) {
  for (const m of text.matchAll(/>>?\|?\s*([^\s<>|]+)/g)) {
    if (isSystemPath(m[1])) return true;
  }
  return false;
}

// ---------- the other rules ----------

const REGISTRY_PATH = /^(?:-\w+:)?(?:hk(?:lm|cu|cr|u|cc):|registry::)/;
const REGISTRY_VERBS = new Set([...DELETE_VERBS, 'remove-itemproperty', 'clear-item', 'clear-itemproperty']);
const FORCE_FLAG = /^(?:--force(?:-with-lease|-if-includes)?(?:=.*)?|-[a-z]*f[a-z]*|\+[^\s+].*)$/;
// The words of a commit message or similar free text after -m are not commands: "graceful shutdown" is let through.
const MESSAGE_FLAG = /^(?:-[a-z]*m|--(?:message|body|title|description))(?:=.*)?$/;

function messageWords(tokens) {
  const skip = new Array(tokens.length).fill(false);
  if (!tokens.some(t => base(t) === 'git')) return skip;
  for (let i = 0; i < tokens.length; i++) {
    if (!MESSAGE_FLAG.test(tokens[i])) continue;
    for (let j = i + 1; j < tokens.length && !tokens[j].startsWith('-'); j++) skip[j] = true;
  }
  return skip;
}

// The other command words a rule looks at. Any word not in one of these sets is passed over, so a very long command line
// stays cheap to read.
const RULE_VERBS = new Set([
  'format', 'format-volume', 'clear-disk', 'mke2fs', 'wipefs', 'diskpart', 'reg', 'schtasks', 'register-scheduledtask', 'register-scheduledjob',
  'bcdedit', 'shutdown', 'stop-computer', 'restart-computer', 'poweroff', 'systemctl', 'cipher', 'git', 'sed', 'find', 'xargs',
]);
const isMkfs = verb => /^mkfs(?:\.|$)/.test(verb);
const watches = verb => DELETE_VERBS.has(verb) || REGISTRY_VERBS.has(verb) || WRITE_VERBS.has(verb) || COPY_VERBS.has(verb)
  || RULE_VERBS.has(verb) || isMkfs(verb);

// Only listing() still reads a part in pieces (see there): no rule for a command word cuts its arguments short.
const FULL_SCANS = 25;
const ARG_WINDOW = 128;

// A command word is asked about every word after it, and a part can be nearly all command words, so asking each of them
// again would make a long part quadratic. These questions are answered from an index kept for the part instead: the first
// word after a point that passes a test, and whether any word after a point does. Each is found by reading the part once
// (the command words come in order, and the answer for an earlier one holds for a later one), so no word is read again and
// none is left out. `key` names the test, and a test must mean the same each time it is asked under one key.
function wordSearch(tokens) {
  const firsts = new Map();
  const lasts = new Map();
  const kept = new Map();
  return {
    // Something worked out from the words once for the whole part.
    once(key, make) {
      if (!kept.has(key)) kept.set(key, make());
      return kept.get(key);
    },
    // The index of the first word after i that passes test(word, index), or -1.
    next(key, test, i) {
      const known = firsts.get(key);
      if (known && i >= known.from && (known.at < 0 || known.at > i)) return known.at;
      let at = -1;
      for (let k = i + 1; k < tokens.length && at < 0; k++) if (test(tokens[k], k)) at = k;
      firsts.set(key, { from: i, at });
      return at;
    },
    // Whether a word after i, and before `end` when that is given, passes test(word, index). The last one found is kept.
    after(key, test, i, end = tokens.length) {
      const known = lasts.get(key);
      if (known && i >= known.from) return known.at > i;
      let at = -1;
      for (let k = end - 1; k > i && at < 0; k--) if (test(tokens[k], k)) at = k;
      lasts.set(key, { from: i, at });
      return at > i;
    },
  };
}

const CACHED = a => a === '--cached';
const IN_PLACE = a => /^(?:--in-place|-[a-z]*i[a-z.]*)(?:=.*)?$/.test(a);
const DRIVE = a => /^[a-z]:[\\/]?$/.test(a);
const CREATE = a => /^[/-]create$/.test(a);
const POWER_OFF = a => a === 'poweroff' || a === 'halt' || a === 'reboot';
const WIPE = a => /^[/-]w(?::|$)/.test(a);
const REGISTRY = a => REGISTRY_PATH.test(a);
const FORCE = a => FORCE_FLAG.test(a);

// find: its start paths come first, after any -H -L -P or -O option. Leaving them out means the folder it is run in.
const FIND_OPTION = /^-(?:[hlp]|o\d)$/;
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/;
const FIND_PATH = a => !FIND_OPTION.test(a);
const FIND_END = a => !FIND_OPTION.test(a) && (a.startsWith('-') || a === '!');

// find, at tokens[i], aimed at a drive root, the home folder or the project root with -delete, or with -exec of a delete
// command. Its start paths are the words up to the first one that is not a path; a later find in the same run has the
// rest of the same words, so each run is read once.
function findDeletesRoot(tokens, i, ctx, search) {
  const deletes = (a, k) => a === '-delete' || (FIND_EXEC.test(a) && DELETE_VERBS.has(base(tokens[k + 1])));
  if (!search.after('find-delete', deletes, i)) return false;
  const stop = search.next('find-end', FIND_END, i);
  const end = stop < 0 ? tokens.length : stop;
  if (!search.after(`find-path ${end}`, FIND_PATH, i, end)) return true;
  return search.after(`find-root ${end}`, a => FIND_PATH(a) && rootKind(a, ctx) !== null, i, end);
}

// The rule the command word `verb`, at tokens[i], breaks, with every word after it as its arguments, or null. `swept`
// holds the kinds of delete command that have been read to the end of the part already, and found nothing.
function verbRule(verb, tokens, i, ctx, swept, search) {
  if (DELETE_VERBS.has(verb)) {
    // A later command of a kind that has been read to the end and found nothing reads a part of the same words, so it need
    // not read them again. git rm --cached only takes files out of the index.
    const kind = CMD_DELETE.has(verb);
    if (!(base(tokens[i - 1]) === 'git' && search.after('cached', CACHED, i)) && !swept.has(kind)) {
      if (deletesRoot(verb, tokens, i + 1, ctx)) return RULES.rmRoot;
      swept.add(kind);
    }
  }
  if (REGISTRY_VERBS.has(verb) && search.after('registry', REGISTRY, i)) return RULES.regDelete;
  if (isMkfs(verb)) return RULES.format;
  switch (verb) {
    // "format" is also a word in npm run format and git log --format, so it needs a drive after it.
    case 'format': if (search.after('drive', DRIVE, i)) return RULES.format; break;
    case 'format-volume': case 'clear-disk': case 'mke2fs': case 'wipefs': return RULES.format;
    case 'diskpart': return RULES.diskpart;
    case 'reg': if (tokens[i + 1] === 'delete' || tokens[i + 2] === 'delete') return RULES.regDelete; break;
    case 'schtasks': if (search.after('create', CREATE, i)) return RULES.schtasks; break;
    case 'register-scheduledtask': case 'register-scheduledjob': return RULES.schtasks;
    case 'bcdedit': return RULES.bcdedit;
    case 'shutdown': case 'stop-computer': case 'restart-computer': case 'poweroff': return RULES.shutdown;
    case 'systemctl': if (search.after('power-off', POWER_OFF, i)) return RULES.shutdown; break;
    case 'cipher': if (search.after('wipe', WIPE, i)) return RULES.cipher; break;
    case 'git': {
      // -f, -fu, --force, --force-with-lease and a +ref all rewrite the remote.
      const push = search.next('push', a => a === 'push', i);
      if (push >= 0 && search.after('force', FORCE, push)) return RULES.forcePush;
      break;
    }
    case 'find': if (findDeletesRoot(tokens, i, ctx, search)) return RULES.rmRoot; break;
    case 'xargs': {
      // What xargs deletes comes from a pipe or a file, so it cannot be read here: a recursive delete is refused outright.
      // (git rm --cached only takes files out of the index.)
      const del = search.next('delete-word', a => DELETE_VERBS.has(base(a)), i);
      if (del >= 0 && !(base(tokens[del - 1]) === 'git' && search.after('cached', CACHED, i))) {
        const cmd = CMD_DELETE.has(base(tokens[del]));
        if (search.after(cmd ? 'recursive-cmd' : 'recursive', a => recursiveFlag(base(tokens[del]), a), del)) return RULES.rmRoot;
      }
      break;
    }
    default:
  }
  const inPlace = verb === 'sed' && search.after('in-place', IN_PLACE, i);
  if ((WRITE_VERBS.has(verb) || COPY_VERBS.has(verb) || inPlace) && writesSystem(verb, tokens, i, search)) return RULES.systemWrite;
  return null;
}

// The rule broken by one reading of a part's words, or null.
function wordsRule(all, ctx) {
  const skip = messageWords(all);
  const tokens = all.filter((_, k) => !skip[k]);
  const swept = new Set();
  const search = wordSearch(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const verb = base(tokens[i]);
    if (!watches(verb)) continue;
    // A command word reads every word after it, wherever it comes in the part and however many command words come before.
    const rule = verbRule(verb, tokens, i, ctx, swept, search);
    if (rule) return rule;
  }
  return null;
}

// Every built-in rule, for one part. The command words are looked for anywhere in the part, not only at its start,
// so sudo, start, xargs, eval and the like do not hide them. `words` is tokensOf(part). A part with a quoted run that
// holds spaces is read again with the run kept whole, so a project at "C:\My App" is found as a delete target.
function builtInRule(part, words, ctx) {
  const rule = wordsRule(words, ctx);
  if (rule) return rule;
  for (const kept of quotedTokensOf(part)) {
    const found = wordsRule(kept, ctx);
    if (found) return found;
  }
  return redirectsSystem(scan(part)) ? RULES.systemWrite : null;
}

// ---------- a delete that takes its target from a pipe ----------

const LISTERS = new Set(['get-childitem', 'gci', 'dir', 'ls', 'find']);
// Get-ChildItem flags that take a value, which is not a path.
const LIST_VALUE_FLAGS = new Set(['-filter', '-include', '-exclude', '-depth', '-attributes']);
const RECURSE_FLAG = new RegExp(`^-(?:${prefixesOf('recurse').join('|')})$`);

// A listing command in the part that is aimed at a drive root or the home folder (strong) or at the project root, and
// whether it asked for what is below its paths too (Get-ChildItem -Recurse, dir /s). A listing with no path is aimed at
// the folder it runs in. Returns null when there is none.
function listing(tokens, ctx) {
  let seen = 0;
  for (let i = 0; i < tokens.length; i++) {
    const verb = base(tokens[i]);
    if (!LISTERS.has(verb)) continue;
    // Unlike the command words of the other rules, a part made of listing commands is read for its first FULL_SCANS only,
    // and each reads the ARG_WINDOW words after it. This is the one rule for a delete that is still read in pieces.
    if (++seen > FULL_SCANS) break;
    const args = tokens.slice(i + 1, i + 1 + ARG_WINDOW);
    const paths = [];
    let deep = false;
    if (verb === 'find') {
      for (const a of args) {
        if (FIND_OPTION.test(a)) continue;
        if (a.startsWith('-') || a === '!') break;
        paths.push(a);
      }
    } else {
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (RECURSE_FLAG.test(a) || a === '/s') deep = true;
        if (a.length > 1 && a.startsWith('-')) {
          const cut = a.search(/[:=]/);
          if (cut > 0 && cut < a.length - 1) paths.push(a.slice(cut + 1));
          else if (LIST_VALUE_FLAGS.has(a)) k++;
        } else if (!CMD_SWITCH.test(a)) {
          paths.push(a);
        }
      }
    }
    const kinds = paths.length ? paths.map(p => rootKind(p, ctx)) : ['project'];
    const strong = kinds.some(k => k === 'fs' || k === 'home');
    if (strong || kinds.includes('project')) return { strong, deep };
  }
  return null;
}

// Whether a pipeline stage deletes what the stage before it hands over: a delete verb in it and, for a listing of the
// project root, a flag for recursion on the delete or a listing that went through everything below.
function deletesListed(tokens, listed) {
  let recursiveFlags = false;
  let recursiveSwitch = false;
  let deletes = false;
  let recursive = false;
  // From the end, so each word is read once: what a delete verb needs is in the words after it.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const verb = base(tokens[i]);
    if (DELETE_VERBS.has(verb)) {
      deletes = true;
      if (recursiveFlags || (CMD_DELETE.has(verb) && recursiveSwitch)) recursive = true;
    }
    if (recursiveFlag('rm', tokens[i])) recursiveFlags = true;
    else if (recursiveFlag('rd', tokens[i])) recursiveSwitch = true;
  }
  return deletes && (listed.strong || recursive || listed.deep);
}

// ---------- a download that reaches a shell ----------

const DOWNLOADERS = 'curl|wget|irm|iwr|invoke-webrequest|invoke-restmethod|downloadstring|webclient|aria2c';
const DOWNLOAD = new RegExp(`\\b(?:${DOWNLOADERS})\\b`);
// The same words as the first word of a command substitution: $(curl ...), <(wget ...), `aria2c ...`.
const SUBSTITUTED_DOWNLOAD = new RegExp(`(?:<\\(|\\$\\(|\`)\\s*(?:${DOWNLOADERS})\\b`);
const SHELLS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'csh', 'tcsh', 'fish', 'busybox', 'wsl', 'cmd', 'powershell', 'pwsh', 'iex', 'invoke-expression',
]);
// eval and source (and a lone . in front of a command) run the text they are given.
const RUNNERS = new Set(['eval', 'source']);
// Interpreters that run a program read from standard input when they have none of their own. Each has the letters of the
// flags that bring a program or a module (python -m, node -e, perl -e) or stop it running anything (-h), the letters whose
// value is the rest of the word, and the letters whose value is the next word. A script file is a program of its own too.
// The letters are lower case, as the words are. The match is over-cautious: a flag not listed here leaves it reading stdin.
const INTERPRETERS = [
  [/^(?:python[\d.]*|py|pypy[\d.]*)$/, 'cmh', '', 'w'],
  [/^node(?:js)?$/, 'epvh', '', 'r'],
  [/^perl[\d.]*$/, 'eh', 'imfdx', ''],
  [/^ruby[\d.]*$/, 'eh', '', 'r'],
  [/^php[\d.]*$/, 'rbefh', '', 'dct'],
];
const OWN_LONG_FLAG = /^--(?:eval|print|version|help|command)(?:=.*)?$/;
// 2>&1, > file, < file, >> file: where the input and output go, which is not an argument.
const REDIRECT = /^\d*[<>]/;
const REDIRECT_ALONE = /^\d*(?:>>?|<{1,3})$/;
// Words that run the next command: sudo bash, env FOO=1 sh, start powershell.
const PREFIXES = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'command', 'exec', 'call', 'start', 'runas', 'nice', 'xargs', 'stdbuf', 'setsid', 'builtin', 'timeout']);

// Whether an interpreter given these arguments runs a program from standard input: a lone - says so, and so does having
// no program of its own (a flag with code or a module, a script file).
function readsStdin(args, [, own, attached, separate]) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (REDIRECT.test(a)) {
      if (REDIRECT_ALONE.test(a)) k++;
      continue;
    }
    if (a === '-') return true;
    if (!a.startsWith('-')) return false;
    if (a.startsWith('--')) {
      if (OWN_LONG_FLAG.test(a)) return false;
      continue;
    }
    for (let c = 1; c < a.length; c++) {
      if (own.includes(a[c])) return false;
      if (attached.includes(a[c])) break;
      if (separate.includes(a[c])) {
        if (c === a.length - 1) k++;
        break;
      }
    }
  }
  return true;
}

// Whether the word at tokens[k] is a shell, or an interpreter that is given its program on standard input.
function runsStdin(tokens, k) {
  const name = base(tokens[k]);
  if (SHELLS.has(name)) return true;
  const interpreter = INTERPRETERS.find(([re]) => re.test(name));
  return interpreter !== undefined && readsStdin(tokens.slice(k + 1), interpreter);
}

function startsShell(tokens) {
  let i = 0;
  while (i < tokens.length && /^[a-z_]\w*=/.test(tokens[i])) i++;
  if (runsStdin(tokens, i)) return true;
  if (!PREFIXES.has(base(tokens[i]))) return false;
  for (let k = i + 1; k < Math.min(tokens.length, i + 9); k++) {
    if (runsStdin(tokens, k)) return true;
  }
  return false;
}

// A shell, iex, eval or source handed a download without a pipe: iex (irm url), bash <(curl url), sh -c "$(curl url)",
// eval "$(curl url)", source <(curl url).
function feedsShell(text) {
  const names = tokensOf(text).map(base);
  const lower = text.toLowerCase();
  if (names.some(n => n === 'iex' || n === 'invoke-expression') && DOWNLOAD.test(scan(lower))) return true;
  return (names.some(n => SHELLS.has(n) || RUNNERS.has(n)) || names[0] === '.') && SUBSTITUTED_DOWNLOAD.test(lower);
}

// ---------- custom patterns, in use ----------

// A caller may pass a list that was not validated here, so anything that is not a non-blank string is ignored. A blank
// pattern is never used: it would match every command.
function customPatterns(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const text = clean(raw).trim();
    if (text) out.push({ text, plain: squash(text), bare: squash(scan(text)) });
  }
  return out;
}

// A plain substring, any case, against the part as written and against the part without its quotes.
function customRule(part, patterns) {
  if (patterns.length === 0) return null;
  const plain = squash(part);
  const bare = squash(scan(part));
  for (const p of patterns) {
    if (plain.includes(p.plain) || (p.bare !== '' && bare.includes(p.bare))) return `custom pattern "${p.text}"`;
  }
  return null;
}

// ---------- the check ----------

// The first rule that the segments of one reading of a command line break, or null. ctx is the context of that reading
// alone, since a cd in one reading is not a cd in the other.
function firstRule(segments, ctx, custom) {
  // True once a download has been seen in the current pipeline's statement (statements end at ; && || and line breaks).
  let downloaded = false;
  // The listing of a drive root, the home folder or the project root that the current pipeline began with, or null.
  let listed = null;
  for (const seg of segments) {
    if (HARD_OPS.has(seg.op)) {
      downloaded = false;
      listed = null;
    }
    const piped = PIPE_OPS.has(seg.op);
    if (piped && downloaded && startsShell(tokensOf(seg.text))) return RULES.pipeShell;
    if (feedsShell(seg.text)) return RULES.pipeShell;
    if (DOWNLOAD.test(scan(seg.text))) downloaded = true;
    for (const part of seg.parts) {
      const words = tokensOf(part);
      if (piped && listed && deletesListed(words, listed)) return RULES.rmRoot;
      const rule = builtInRule(part, words, ctx) ?? customRule(part, custom);
      if (rule) return rule;
      listed ??= listing(words, ctx);
      followCd(part, words, ctx);
    }
  }
  return null;
}

export function checkCommand(commandLine, extraPatterns = [], options = {}) {
  const line = Array.isArray(commandLine) ? commandLine.join(' ') : String(commandLine ?? '');
  const readings = lineVariants(clean(line)).map(text => segmentsOf(text));
  const parts = readings[0].flatMap(s => s.parts);
  const custom = customPatterns(extraPatterns);
  for (const segments of readings) {
    const rule = firstRule(segments, contextFor(options), custom);
    if (rule) return { blocked: true, rule, parts };
  }
  return { blocked: false, rule: null, parts };
}
