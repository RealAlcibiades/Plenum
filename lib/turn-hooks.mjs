// Turn hooks (pro-05). The modules in lib/hooks/ run around each chat turn and each build, in file-name order. A module is a file named
// NN-name.mjs (two digits, then a dash and a lower-case name). It may export:
//   expandMessage(ctx, text)  -> { blocks: string[], labels: string[], notes: string[] }, run before the message is read. Each block
//                                 goes into the model's copy of the message after the attached files; labels go into the stored message
//                                 as its context; notes go out as notices. A 400 error (an Error with status 400) refuses the message
//                                 before anything is stored, and it is the only failure that does.
//   beforeTurn(ctx)           -> after the turn's record is stored and before the model runs. ctx.record is that stored message.
//   afterTurn(ctx, turn)      -> after the run, when it was not stopped. turn is what runTurn returned.
// Any other failure becomes the notice "A Plenum step (<file>) failed: <message>", and the turn goes on. A module that does not load is
// logged and left out; it never stops the server.
// The ctx is { project, scope (lib/scope.mjs), kind ('chat' | 'build'), ref, planMode, send (null until the reply stream opens), signal,
// store, record (the stored user message; a hook may add fields, and the state save keeps them), changed (null, or the paths the turn
// changed, set by the snapshot hook), followUp (a function, see server.mjs), busy (true while the project runs) }.
// Notices given before the stream opens are kept on ctx.notes; the caller sends them once the stream opens.
import { CODE_ROOT, listFiles, moduleUrl } from './overlay.mjs';

const NAME = /^\d\d-[a-z0-9-]+\.mjs$/;

const modules = [];
const files = listFiles('lib/hooks', name => NAME.test(name), CODE_ROOT);
for (const file of files) {
  try {
    // Top-level await: server.mjs imports this module statically, so the hooks are in place before the first turn.
    const mod = await import(moduleUrl(`lib/hooks/${file}`, CODE_ROOT));
    modules.push({ file, mod });
  } catch (err) {
    console.error(`Turn hooks: ${file} did not load:`, err.message);
  }
}

// The names of the hook modules in the order they run (for the tests and the status page).
export const hookFiles = () => modules.map(m => m.file);

// A notice for the chat: sent once the stream is open, otherwise kept until the caller sends it.
function notify(ctx, text) {
  if (typeof ctx.send === 'function') ctx.send({ type: 'notice', text });
  else (ctx.notes ??= []).push(text);
}

const failed = (file, err) => `A Plenum step (${file}) failed: ${err?.message ?? String(err)}`;

// The three runners over a list of { file, mod } entries. The server uses the modules loaded from lib/hooks/ (hookRunner()); a test
// passes its own list.
export function hookRunner(list = modules) {
  // Runs every expandMessage in order and collects what they return. A 400 error is rethrown; any other error is a notice.
  async function runExpand(ctx, text) {
    const out = { blocks: [], labels: [], notes: [] };
    for (const { file, mod } of list) {
      if (typeof mod.expandMessage !== 'function') continue;
      try {
        const got = await mod.expandMessage(ctx, text);
        if (Array.isArray(got?.blocks)) out.blocks.push(...got.blocks.map(String));
        if (Array.isArray(got?.labels)) out.labels.push(...got.labels.map(String));
        if (Array.isArray(got?.notes)) out.notes.push(...got.notes.map(String));
      } catch (err) {
        if (err?.status === 400) throw err;
        out.notes.push(failed(file, err));
      }
    }
    return out;
  }

  // Runs every beforeTurn in order. Never throws except through the hooks' own notices.
  async function runBefore(ctx) {
    for (const { file, mod } of list) {
      if (typeof mod.beforeTurn !== 'function') continue;
      try {
        await mod.beforeTurn(ctx);
      } catch (err) {
        notify(ctx, failed(file, err));
      }
    }
  }

  // Runs every afterTurn in order. Never throws.
  async function runAfter(ctx, turn) {
    for (const { file, mod } of list) {
      if (typeof mod.afterTurn !== 'function') continue;
      try {
        await mod.afterTurn(ctx, turn);
      } catch (err) {
        notify(ctx, failed(file, err));
      }
    }
  }

  return { runExpand, runBefore, runAfter };
}

const loaded = hookRunner();
export const runExpand = (ctx, text) => loaded.runExpand(ctx, text);
export const runBefore = ctx => loaded.runBefore(ctx);
export const runAfter = (ctx, turn) => loaded.runAfter(ctx, turn);
