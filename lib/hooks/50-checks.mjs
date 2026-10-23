// Check after each turn (pro-06). After a chat turn that was not stopped and not in plan mode, the project's check command runs once
// when the turn changed files. The snapshot hook (lib/hooks/10-snapshot.mjs) has set ctx.changed by now, because it comes first in the
// file-name order: [] means nothing changed, so nothing runs and nothing is said. null means no snapshot was kept, and then the check runs
// only when the turn wrote a file with a tool step or the model is a CLI, whose own writes Plenum cannot see.
// When a changed file can change what the command runs (lib/checks.mjs definitionFiles), the check is not run by itself: the notice says
// which file, and the person presses Run checks after looking at the change.
// Auto-fix (off by default) sends a failed check's output to the model as a normal turn (ctx.followUp, marked 'auto-fix'), then checks
// again, up to the project's number of rounds (1 to 10, 2 by default). Each round's own change is taken with the snapshot hook's after
// step, so a round that changes a file that defines the check stops the loop like the first turn does. Stop ends the loop at once, and a
// refused follow-up (the spend cap, plan mode) ends it with the notice the server already gave. The notice for the last round says so.
import { afterTurn as snapshotAfter } from './10-snapshot.mjs';
import { checksOf, definitionFiles, failureMessage, isCliRef, modelLabel, namesOfWrites, replyOfTurn, runAndRecord, wroteFiles } from '../checks.mjs';

// Sends the events to the chat. A hook always has the stream open here (the turn ran), so the events go out at once.
function emit(ctx, events) {
  if (typeof ctx.send !== 'function') return;
  for (const ev of events) ctx.send(ev);
}

// Runs the check for one reply, and says what happened.
async function runFor(ctx, cfg, reply) {
  const got = await runAndRecord({ project: ctx.project, cfg, root: ctx.scope.root, signal: ctx.signal, reply, store: ctx.store });
  emit(ctx, got.events);
  return got;
}

// The check is not run: the reply says which changed file held it back, and the chat says so (the words the page shows too).
async function holdBack(ctx, reply, cfg, files) {
  const shown = files.slice(0, 50);
  if (reply) {
    reply.check = { skipped: 'definition-changed', files: shown };
    await ctx.store.persist?.();
  }
  emit(ctx, [{ type: 'notice', text: `Checks not run automatically: this turn changed ${shown[0]}, which can change what ${cfg.command} runs. Look at the change, then press Run checks.` }]);
}

// The files a turn changed for the definition check. With a snapshot that is the changed list. Without one, the names of the files the
// turn's write steps named, which is a best guess (the list is not known).
const changedOf = (ctx, reply) => (Array.isArray(ctx.changed) ? ctx.changed : [...namesOfWrites(reply)]);

// The changed files of the auto-fix round that the follow-up made. The snapshot hook takes its after step against the round's own before
// step (set when the follow-up began), and sets ctx.changed to what the round changed, or leaves it null when there is no snapshot.
async function changedByRound(ctx) {
  ctx.changed = null;
  await snapshotAfter(ctx);
  return Array.isArray(ctx.changed) ? ctx.changed : null;
}

export async function afterTurn(ctx) {
  if (ctx.kind !== 'chat' || ctx.planMode || !ctx.project || !ctx.scope) return;
  const cfg = checksOf(ctx.project);
  if (!cfg || !cfg.auto || ctx.signal?.aborted) return;
  // A turn that changed nothing runs no check and says nothing.
  if (Array.isArray(ctx.changed) && ctx.changed.length === 0) return;
  const reply = replyOfTurn(ctx.store, ctx.project.id, ctx.record);
  if (!Array.isArray(ctx.changed) && !isCliRef(ctx.ref) && !wroteFiles(reply)) return;

  const defs = definitionFiles(changedOf(ctx, reply), cfg.command);
  if (defs.length) return holdBack(ctx, reply, cfg, defs);

  let got = await runFor(ctx, cfg, reply);
  let round = 0;
  for (;;) {
    const failing = Boolean(got.result) && !got.result.ok && !got.result.aborted;
    // Auto-fix is off unless the project turned it on; then a failed check goes to the model, up to the project's rounds.
    if (!failing || !cfg.autoFix || ctx.signal?.aborted) break;
    if (round >= cfg.fixRounds) {
      emit(ctx, [{ type: 'notice', text: `Auto-fix stopped after ${cfg.fixRounds} rounds. The checks still fail.` }]);
      break;
    }
    if (typeof ctx.followUp !== 'function') break;
    round += 1;
    emit(ctx, [{ type: 'notice', text: `Auto-fix ${round} of ${cfg.fixRounds}: sending the failures to ${modelLabel(ctx.ref)}.` }]);
    const fixed = await ctx.followUp(failureMessage({ ...got.result, output: got.full }), { marker: 'auto-fix' });
    if (!fixed || ctx.signal?.aborted) break;
    const fixReply = replyOfTurn(ctx.store, ctx.project.id, ctx.record);
    const changed = await changedByRound(ctx);
    const fixDefs = definitionFiles(changed ?? [...namesOfWrites(fixReply)], cfg.command);
    if (fixDefs.length) {
      await holdBack(ctx, fixReply, cfg, fixDefs);
      break;
    }
    got = await runFor(ctx, cfg, fixReply);
  }
}
