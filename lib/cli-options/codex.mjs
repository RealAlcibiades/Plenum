// Codex CLI options: what the Muse Console panel offers for Codex, and the flags that carry each choice.
// Every flag here was checked against `codex exec --help` and `codex exec resume --help` (codex-cli 0.162.1).
//
// Left out on purpose:
// - Full access (danger-full-access) removes the sandbox, and Codex's bypass flag also skips every prompt.
// - Approval policy. `codex exec` has no approval flag of its own: only the top-level command takes
//   --ask-for-approval, and its `never` choice never asks you. The one approval flag exec does take,
//   --approve-for-me, sends approvals to an automatic reviewer instead of you, and the parser refuses it
//   together with --sandbox. So no approval flag is passed, and the app's 'ask' and 'auto' settings give Codex
//   the same arguments.
// - Web search. Only the top-level codex command accepts --search, so `codex exec` cannot switch it on or off.
// - Anything `codex exec resume` refuses. A resumed turn is sent only the flags it accepts (see argsFor), so a
//   change to the sandbox, folder or profile here does not reach a session that is already running.
// - The rest of `codex exec --help` that parity with the CLI could suggest: -c and --enable/--disable
//   (they can set any key, the sandbox and approval keys included), --oss and --local-provider (the prompt would go to a
//   model server Plenum has not configured), --ignore-rules (drops execpolicy rules that forbid commands), --worktree and
//   -o (they work or write outside the project folder), --cyber-access-program, and the two dangerously-bypass flags.
//
// The one -c the app does send besides the reasoning effort is the Plenum bridge (lib/mcp-server.mjs, amendment 10): argsFor takes the
// bridge's descriptor as `mcp` and returns `-c mcp_servers.plenum.*` overrides that start the bridge as a stdio MCP server for this run.
// They set only that server's command, arguments, environment and two time limits, never a sandbox or approval key. A read-only run gets
// none. Every value is a TOML literal string ('...'), which needs no double quote, so the Windows .cmd shim can carry it (lib/proc.mjs),
// and a value with a single quote or a control character is not passed at all.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAccess, folderRisk } from '../guard.mjs';

// The sandbox choices `codex exec -s` takes. Full access is not in this list, so normalize refuses it.
const SANDBOXES = ['read-only', 'workspace-write'];
// A profile name is the file name `<name>.config.toml`. The parser refuses dots, slashes, spaces and a leading
// dash, and accepts letters, digits, underscores and dashes (checked with `codex exec`).
const PROFILE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const PROFILE_MAX = 64;
const FOLDERS_MAX = 20;
const FOLDER_MAX = 120;

export const OPTIONS = [
  {
    key: 'sandbox',
    label: 'Sandbox',
    help: 'Default: Project folder only, which lets Codex change files in the project and the extra folders. Read only blocks every file change, which is safer but stops most coding work; full access is left out because it removes the sandbox.',
    type: 'select',
    choices: [
      { value: 'read-only', label: 'Read only' },
      { value: 'workspace-write', label: 'Project folder only' },
    ],
    default: 'workspace-write',
    group: 'Permissions',
  },
  {
    key: 'addDirs',
    label: 'Extra folders',
    help: 'Default: none. Codex may change files in these folders as well as the project, so list only folders it should write to, as full paths; a whole drive or your user folder is refused.',
    type: 'list',
    default: [],
    max: FOLDERS_MAX,
    group: 'Folders',
  },
  {
    key: 'profile',
    label: 'Config profile',
    help: 'Default: none. Names a profile file in your Codex settings folder, layered over the base settings; a profile can set other Codex options too, so name only one you have checked.',
    type: 'text',
    default: '',
    max: PROFILE_MAX,
    group: 'Behaviour',
  },
  {
    key: 'ignoreUserConfig',
    label: 'Ignore your Codex settings file',
    help: 'Default: Off. When on, Codex does not read config.toml in your Codex settings folder, so nothing in it can change the run, and your sign-in still works.',
    type: 'boolean',
    default: false,
    group: 'Behaviour',
  },
];

// Returns the saved settings with unknown keys dropped and defaults filled in. Throws Error with a plain
// message for a bad value, so the server can refuse the save and the panel can show why.
export function normalize(input) {
  const src = input ?? {};
  if (typeof src !== 'object' || Array.isArray(src)) throw new Error('Codex settings must be an object.');
  return {
    sandbox: sandboxValue(src.sandbox),
    addDirs: folderList(src.addDirs),
    profile: profileName(src.profile),
    ignoreUserConfig: switchValue(src.ignoreUserConfig, 'Ignore your Codex settings file'),
  };
}

// Arguments for `codex exec` (a new session) or `codex exec resume` (a resumed turn), as an array, never a shell
// string. The caller adds the prompt and the session id. `mode` ('ask' or 'auto') is part of the shared signature
// but changes nothing for Codex, because no approval flag is passed (see the note at the top). `readOnly` is for a
// run that must not change files: it gets the read-only sandbox and no extra folders, whatever the saved settings say.
export function argsFor(settings, { cwd, resume = false, readOnly = false, mcp } = {}) {
  // Normalize first, so a bad value can never reach the command line, even from a caller that skipped normalize.
  const s = normalize(settings);
  // A folder that folderRisk refuses is refused on a resumed turn and a read-only run too. A resumed turn sends no
  // folder flag, but the same settings are refused for a new session, so the cases never disagree.
  for (const dir of s.addDirs) refuseRisky(dir);
  // `exec resume` refuses -s, -C, -p and --add-dir (checked with the parser), so a resumed turn gets only the
  // flags it accepts. How Codex applies the saved session's own settings is not stated in its help. Its help lists
  // --ignore-user-config, so that one is sent on a resumed turn too, and the choice holds for every turn of a chat.
  // --skip-git-repo-check stays first: the caller's -i list ends at the first flag after it.
  // The bridge is for a chat turn that can change things, so a read-only run never gets it.
  const bridge = readOnly ? [] : mcpOverrides(mcp);
  if (resume) return [...(s.ignoreUserConfig ? ['--skip-git-repo-check', '--ignore-user-config'] : ['--skip-git-repo-check']), ...bridge];
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('Codex needs the project folder to run in.');
  // Without this flag Codex refuses to run outside a Git repository, and project folders are not always one.
  const args = ['--skip-git-repo-check', '-s', readOnly ? 'read-only' : s.sandbox, '-C', cwd];
  // Off adds nothing: the flag only stops config.toml from loading.
  if (s.ignoreUserConfig) args.push('--ignore-user-config');
  if (s.profile) args.push('-p', s.profile);
  // A read-only run gets no extra folders, because they are where Codex may write.
  if (!readOnly) for (const dir of s.addDirs) args.push('--add-dir', dir);
  return [...args, ...bridge];
}

// The -c overrides that start the bridge, as argument strings ('-c', 'key=value', ...), or [] when there is no bridge or a value in its
// descriptor cannot be written safely. Codex parses each value as TOML, so strings are literal strings in single quotes.
const SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const literal = v => (typeof v === 'string' && v && !/['\u0000-\u001f\u007f]/.test(v) ? `'${v}'` : null);
function mcpOverrides(mcp) {
  if (!mcp || typeof mcp !== 'object' || !SERVER_NAME.test(String(mcp.name ?? ''))) return [];
  const command = literal(mcp.command);
  const args = Array.isArray(mcp.args) && mcp.args.length && mcp.args.length <= 8 ? mcp.args.map(literal) : null;
  const env = mcp.env && typeof mcp.env === 'object' && !Array.isArray(mcp.env) ? Object.entries(mcp.env) : [];
  const envParts = env.map(([k, v]) => (ENV_NAME.test(k) && literal(v) ? `${k}=${literal(v)}` : null));
  const seconds = n => (Number.isInteger(n) && n >= 1 && n <= 86_400 ? n : null);
  const startup = seconds(mcp.startupSec ?? 30);
  const tool = seconds(mcp.toolSec ?? 3600);
  if (!command || !args || args.includes(null) || envParts.includes(null) || !startup || !tool) return [];
  const key = `mcp_servers.${mcp.name}`;
  const out = ['-c', `${key}.command=${command}`, '-c', `${key}.args=[${args.join(',')}]`];
  if (envParts.length) out.push('-c', `${key}.env={${envParts.join(',')}}`);
  // The defaults (10 seconds to start, 60 to answer a tool call) are too short for a card nobody has answered yet or an agent at work.
  out.push('-c', `${key}.startup_timeout_sec=${startup}`, '-c', `${key}.tool_timeout_sec=${tool}`);
  return out;
}

function sandboxValue(value) {
  if (value === undefined || value === null) return 'workspace-write';
  if (value === 'danger-full-access') {
    throw new Error(`Full access is not offered, because it removes the sandbox. Sandbox must be one of: ${SANDBOXES.join(', ')}.`);
  }
  if (!SANDBOXES.includes(value)) throw new Error(`Sandbox must be one of: ${SANDBOXES.join(', ')}.`);
  return value;
}

function switchValue(value, label) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

function profileName(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('Config profile must be text.');
  const name = value.trim();
  if (!name) return '';
  if (name.length > PROFILE_MAX) throw new Error(`Config profile is at most ${PROFILE_MAX} characters.`);
  if (!PROFILE_PATTERN.test(name)) {
    throw new Error('Config profile must be a plain name of letters, digits, dashes or underscores, for example work-fast.');
  }
  return name;
}

// Each entry becomes its own --add-dir flag (repeats are accepted, checked with `codex exec`). Paths are resolved
// here, so the path that is checked is the path that is passed on. Blank entries are dropped, and duplicates kept once.
function folderList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Extra folders must be a list.');
  if (value.length > FOLDERS_MAX) throw new Error(`Extra folders can hold at most ${FOLDERS_MAX} folders.`);
  const folders = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('Each extra folder must be text.');
    const text = item.trim();
    if (!text) continue;
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('Each extra folder must be one line of plain text.');
    if (text.length > FOLDER_MAX) throw new Error(`Each extra folder path is at most ${FOLDER_MAX} characters.`);
    if (!path.isAbsolute(text)) throw new Error('Extra folders must be full paths, for example C:\\Projects\\shared.');
    const folder = path.resolve(text);
    checkFolder(folder);
    refuseRisky(folder);
    if (!folders.includes(folder)) folders.push(folder);
  }
  return folders;
}

// Refuses a folder that folderRisk (lib/guard.mjs) refuses: a credential folder or one above it, Plenum's own folder,
// the Windows system folders, a drive, or the user's folder. The reason is named, with Codex as the app it is for.
function refuseRisky(folder) {
  const risk = folderRisk(folder);
  if (risk) throw new Error(`The folder cannot be given to Codex: ${risk}`);
}

// Refuses a folder that Codex must never be allowed to write: a whole drive or share, or the user's folder or any
// folder above it (the credential folders sit inside it). Anything else goes through the same write rules the app
// uses for its own agent (lib/guard.mjs), so the credential and Windows system folders stay off limits.
function checkFolder(folder) {
  checkPlace(folder);
  // A folder can be a link or junction to somewhere else, so the place it leads to gets the same checks.
  checkPlace(realFolder(folder));
}

function checkPlace(place) {
  const root = path.parse(place).root;
  if (place.replace(/[\\/]+$/, '') === root.replace(/[\\/]+$/, '')) {
    throw new Error('A whole drive cannot be an extra folder. Name a folder inside it.');
  }
  const home = path.resolve(os.homedir()).toLowerCase();
  const target = place.toLowerCase();
  if (home === target || home.startsWith(target + path.sep)) {
    throw new Error('That folder is your user folder or contains it, so Codex could change its sign-in files there. Name a narrower folder.');
  }
  checkAccess(place, { write: true });
}

// The place a folder really is: links and junctions are followed as far as the path exists, as lib/tools.mjs does.
// The part that does not exist yet is kept as written, so a folder that is still to be made is judged by its name.
function realFolder(folder) {
  let dir = folder;
  let tail = '';
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), tail);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return folder;
      tail = path.join(path.basename(dir), tail);
      dir = parent;
    }
  }
}
