import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import { findOnPath, isExecutableFile } from './index.mjs';
import { pathFor } from './paths.mjs';

// Opens a terminal window that runs one sign-in command (for example `claude auth login`) and stays open until the
// user is done. Windows uses cmd start, macOS tells Terminal to do script through osascript, and Linux uses the first
// terminal program it finds. The command line is built from fixed strings: the program path found on this machine, a
// short list of plain-word arguments, and a window title that is cleaned first. Nothing the user typed goes in.
// Every function takes the platform as a parameter that defaults to process.platform.

// In the order they are tried. x-terminal-emulator is the Debian and Ubuntu name for "the user's choice".
export const LINUX_TERMINALS = Object.freeze(['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']);
const OSASCRIPT = '/usr/bin/osascript';
const DONE = 'Sign-in finished.';

const CONTROL = /[\u0000-\u001f\u007f]/;
const PLAIN_WORD = /^[\w.:=@+\/-]+$/;
// Characters the Windows command line would read as its own: quotes, variables, and the joining and redirect marks.
const CMD_UNSAFE = /["%&|<>^]/;

const fail = reason => ({ ok: false, reason });
// A word for a POSIX shell: in single quotes, with each single quote written '\''.
const shQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`;
// Text for an AppleScript string: backslashes and double quotes are escaped.
const asQuote = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// What runs inside the terminal on macOS and Linux. It starts in the home folder, so a window left open never locks the
// app's files, and sets the window title. pause keeps a window open that would otherwise close at once.
function loginScript(command, args, label, pause) {
  return [
    'cd "$HOME" 2>/dev/null',
    `printf '\\033]0;%s\\007' ${shQuote(label)}`,
    [command, ...args].map(shQuote).join(' '),
    'echo',
    pause ? `echo ${shQuote(`${DONE} Press Enter to close this window.`)}; read dummy` : `echo ${shQuote(`${DONE} You can close this window.`)}`,
  ].join('; ');
}

// How each Linux terminal takes a program and its arguments.
const LINUX_ARGS = {
  'x-terminal-emulator': script => ['-e', '/bin/sh', '-c', script],
  'gnome-terminal': (script, title) => ['--title', title, '--', '/bin/sh', '-c', script],
  konsole: script => ['-e', '/bin/sh', '-c', script],
  xterm: (script, title) => ['-T', title, '-e', '/bin/sh', '-c', script],
};

// The process to start, without starting it: { ok: true, file, argv, verbatim, windowsHide, waitForExit } or
// { ok: false, reason }. spec is { command, args, label }: command is the program's full path.
export function loginTerminalPlan(spec, { platform = process.platform, env = process.env, isExecutable = isExecutableFile } = {}) {
  const command = typeof spec?.command === 'string' ? spec.command : '';
  const args = Array.isArray(spec?.args) ? spec.args.map(String) : [];
  const label = String(spec?.label ?? '').replace(/[^\w .:()-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Sign-in';
  if (!command || CONTROL.test(command)) return fail('There is no program to run for this sign-in.');
  if (!args.every(a => PLAIN_WORD.test(a))) return fail('A sign-in argument is not a plain word, so no terminal was opened.');
  const manual = [pathFor(platform).basename(command), ...args].join(' ');

  if (platform === 'win32') {
    if (CMD_UNSAFE.test(command)) return fail('The program path has a character the Windows command line cannot take safely, so no terminal was opened.');
    // The window closes after a key press once the sign-in command ends.
    const line = `start "${label}" cmd /c ""${command}" ${args.join(' ')} & echo. & echo ${DONE} Press any key to close this window. & pause >nul"`;
    return { ok: true, file: 'cmd.exe', argv: ['/d', '/c', line], verbatim: true, windowsHide: false, waitForExit: false };
  }

  if (platform === 'darwin') {
    const script = loginScript(command, args, label, false);
    const argv = ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script "${asQuote(script)}"`, '-e', 'end tell'];
    return { ok: true, file: OSASCRIPT, argv, verbatim: false, windowsHide: true, waitForExit: true };
  }

  for (const name of LINUX_TERMINALS) {
    const file = findOnPath(name, { platform, env, isExecutable });
    if (!file) continue;
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
      return fail(`There is no graphical desktop here (DISPLAY is not set), so a terminal window cannot open. To sign in, run this in a terminal yourself: ${manual}`);
    }
    const argv = LINUX_ARGS[name](loginScript(command, args, label, true), label);
    return { ok: true, file, argv, verbatim: false, windowsHide: true, waitForExit: false };
  }
  return fail(`No terminal program was found (tried ${LINUX_TERMINALS.join(', ')}). To sign in, run this in a terminal yourself: ${manual}`);
}

// Opens the window. Resolves { ok: true } once it has been started, or { ok: false, reason } with a plain sentence.
// Where the launcher reports its own failure (osascript is refused control of Terminal) that is waited for, up to waitMs.
// env is the environment the terminal starts with; cwd is the folder it starts in. spawn replaces the real one in the tests.
export function openLoginTerminal(spec, { platform = process.platform, env = process.env, cwd = os.homedir(), spawn = nodeSpawn, isExecutable = isExecutableFile, waitMs = 8000 } = {}) {
  const plan = loginTerminalPlan(spec, { platform, env, isExecutable });
  if (!plan.ok) return Promise.resolve(fail(plan.reason));
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(plan.file, plan.argv, {
        cwd,
        env,
        detached: !plan.waitForExit,
        stdio: ['ignore', 'ignore', plan.waitForExit ? 'pipe' : 'ignore'],
        windowsHide: plan.windowsHide,
        windowsVerbatimArguments: plan.verbatim,
      });
    } catch (err) {
      return finish(fail(`Could not open a terminal window: ${err.message}`));
    }
    child.once('error', err => finish(fail(`Could not open a terminal window: ${err.message}`)));
    if (!plan.waitForExit) {
      child.once('spawn', () => {
        child.unref?.();
        finish({ ok: true });
      });
      return;
    }
    let said = '';
    child.stderr?.on('data', d => { said = (said + d).slice(-600); });
    // A first-time macOS permission prompt can sit for a while. After waitMs the window is taken to be on its way.
    const timer = setTimeout(() => {
      child.unref?.();
      child.stderr?.unref?.();
      finish({ ok: true });
    }, waitMs);
    child.once('close', code => {
      clearTimeout(timer);
      finish(code === 0 ? { ok: true } : fail(`Terminal would not open${said.trim() ? `: ${said.trim().slice(-300)}` : '.'} Allow Plenum to control Terminal in System Settings, Privacy and Security, Automation.`));
    });
  });
}
