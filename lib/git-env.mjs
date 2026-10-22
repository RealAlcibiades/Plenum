// The environment every git child of Plenum gets (the header's status chip in lib/git-status.mjs and everything in lib/git-run.mjs).
// It is its own file so that lib/git-run.mjs and lib/git-status.mjs can both import it without importing each other.

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
