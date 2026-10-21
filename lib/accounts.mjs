import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, resolveLaunch, childEnv, stripAnsi } from './proc.mjs';
import { openLoginTerminal } from './platform/terminal.mjs';

// Sign-in and key handling for the Accounts panel. Keys are never written to the app's state file or logs.
// Muse Code and Codex sign-in happens in their own terminal windows, so their credentials stay with those tools.
// The functions that differ by platform take the platform as a parameter that defaults to process.platform.

// The five provider key names are the envVar values in api-providers.mjs, plus ANTHROPIC_API_KEY. These are the
// names the key store holds (desktop/keyvault.cjs lists the same names). Keys are never written to the Windows
// user environment or any other plain-text place from here.
const SAVABLE = new Set(['ANTHROPIC_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY']);

// Reads one user-level environment variable from the registry (Windows only). Elsewhere it reads this process's environment.
export function readUserEnv(name, platform = process.platform) {
  if (platform !== 'win32') return Promise.resolve(process.env[name] ?? null);
  return new Promise(resolve => {
    execFile('reg', ['query', 'HKCU\\Environment', '/v', name], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const m = String(out).match(new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*)$`, 'm'));
      resolve(m ? m[1].trim() : null);
    });
  });
}

// Runs a CLI to completion and returns its output. Used for short status checks.
export async function runCli(command, args) {
  const launch = await resolveLaunch(command, args);
  if (!launch) return { code: null, output: '', error: `${command} is not installed or not on PATH.` };
  return new Promise(resolve => {
    const child = spawn(launch.file, launch.argv, {
      env: childEnv(command),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: launch.verbatim,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ code: null, output: '', error: e.message }));
    child.on('close', code => resolve({ code, output: stripAnsi(out).trim(), error: stripAnsi(err).trim().slice(-800) }));
  });
}

// Opens a new terminal window that runs `command args` and stays open for the sign-in flow. How the window is opened
// on each platform is in lib/platform/terminal.mjs. It starts in the home folder, not the app folder, so a window left
// open never locks the app's files. A platform that cannot open one throws, with the reason in plain words.
export async function openSignIn(command, args, title, platform = process.platform) {
  const exe = await findExecutable(command, platform);
  if (!exe) throw new Error(`${command} is not installed or not on PATH.`);
  // The same cleaned environment the tool runs with, so it signs in the way it will be used.
  const opened = await openLoginTerminal({ command: exe, args, label: title }, { platform, env: childEnv(command), cwd: os.homedir() });
  if (!opened.ok) throw new Error(opened.reason);
}

// Muse Code keeps its saved sign-in here (the path its own installer reports).
export function museSignedIn() {
  return existsSync(path.join(os.homedir(), '.config', 'muse', 'auth.json'));
}
