// run_command: a shell command in the project folder, with the platform's own shell (shellFor in lib/platform/index.mjs).
// The deny list reads the command text through `command` (see runTool in lib/tools.mjs). A command that names a credential
// folder is refused before any card, in auto and ask mode alike (commandCredentialHit in lib/tools.mjs, B-17).
// A delegated coder cannot run commands (scoped: 'refuse'), because a command can write anywhere.

import { runShell } from '../proc.mjs';
import { shellFor } from '../platform/index.mjs';
import { capDetail } from '../diff.mjs';
import { clip } from '../tools.mjs';

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 900;

const timeoutFor = input => Math.min(MAX_TIMEOUT_S, Math.max(5, Math.floor(Number(input.timeout_seconds) || DEFAULT_TIMEOUT_S)));

async function planRun(input) {
  const command = String(input.command ?? '').trim();
  if (!command) throw new Error('Give a command to run.');
  // The summary clips a long command, so the full command goes in the detail.
  return { summary: `Run: ${clip(command, 300)}`, detail: capDetail(`${command}\n\nFolder: project root\nTimeout: ${timeoutFor(input)} seconds`) };
}

async function runCommand(input, ctx) {
  const command = String(input.command ?? '').trim();
  const seconds = timeoutFor(input);
  const r = await runShell(command, { cwd: ctx.root, timeoutMs: seconds * 1000, signal: ctx.signal, shell: shellFor() });
  const status = r.error ? `failed to start: ${r.error}`
    : r.timedOut ? `timed out after ${seconds}s`
      : r.aborted ? 'stopped'
        : `exit code ${r.code}`;
  return {
    ok: r.code === 0,
    summary: `${clip(command, 80)} → ${status}`,
    output: clip(`${status}\n${r.output}`.trimEnd()),
  };
}

export const tools = [
  {
    name: 'run_command',
    description: `Run a shell command in the project folder. ${shellFor().hint} Returns the exit code and output. Needs user approval unless approvals are on auto.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_seconds: { type: 'integer', description: 'Default 120, maximum 900.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    command: input => String(input?.command ?? '').trim(),
    scoped: 'refuse',
    refusal: 'A delegated coder cannot run shell commands, because a command can change files outside its scope. Describe what should be checked in your summary instead.',
    describe: input => clip(String(input.command ?? ''), 200),
    plan: planRun,
    run: runCommand,
  },
];
