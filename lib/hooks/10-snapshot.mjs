// Turn snapshots (pro-05). The project folder is recorded before each chat turn that is not in plan mode, and before each build, and
// again after a chat turn that was not stopped. Whatever wrote a file in between is then known: Claude Code, Codex, Gemini CLI, Muse Code
// or a shell command, because the folder itself is compared (lib/shadow.mjs). The record of the turn keeps the result as record.snap:
//   { before: { id, tree } }           a snapshot was taken before the turn
//   { skipped: reason }                none was: git is missing, the folder is too big, or the snapshot took too long
//   plus, after the turn: after: { id, tree }, changed (a count), files (the first 50 paths)
// Rewind (lib/routes/snapshots.mjs) uses record.snap.before.tree. Neither step ever stops a turn: a failure is a notice.
import { snapshot, changedBetween, prune, skipReason } from '../shadow.mjs';

const BUDGET_MS = 15000;
const FILES_KEPT = 50;
// Scope ids that were told, in this server run, that git is missing (the notice is shown once per scope).
const told = new Set();

// The promise, or { skipped: 'timeout' } when it takes longer than ms. The git child of an overdue snapshot is killed by its own
// deadline (lib/shadow.mjs), so the turn is not kept waiting for it.
function within(promise, ms) {
  let timer = null;
  const late = new Promise(resolve => {
    timer = setTimeout(() => resolve({ skipped: 'timeout' }), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// A chat notice. Before the stream opens the notice waits in ctx.notes; the server sends it then.
function notify(ctx, text) {
  if (typeof ctx.send === 'function') ctx.send({ type: 'notice', text });
  else (ctx.notes ??= []).push(text);
}

// Takes the 'before' snapshot of a chat turn or a build. In plan mode a chat turn changes nothing, so it has none.
export async function beforeTurn(ctx) {
  if (!ctx.record) return;
  if (ctx.kind === 'chat' && ctx.planMode) return;
  const scopeId = ctx.scope.id;
  let made;
  try {
    made = await within(snapshot(ctx.scope.root, scopeId, 'before', { budgetMs: BUDGET_MS }), BUDGET_MS);
  } catch (err) {
    made = { skipped: 'error', message: err.message };
  }
  if (made.id) {
    ctx.record.snap = { before: { id: made.id, tree: made.tree } };
    return;
  }
  if (made.skipped === 'git-missing') {
    ctx.record.snap = { skipped: skipReason('git-missing') };
    if (!told.has(scopeId)) {
      told.add(scopeId);
      notify(ctx, 'Turn snapshots need git, which was not found. Rewinding code is off until git is installed.');
    }
    return;
  }
  const reason = made.skipped === 'error' ? made.message : skipReason(made.skipped);
  ctx.record.snap = { skipped: reason };
  notify(ctx, `Turn snapshot skipped: ${reason}. Rewinding code is not available for this turn.`);
}

// Takes the 'after' snapshot, lists what the turn changed, and prunes old snapshots of the folder. Only when beforeTurn kept one.
export async function afterTurn(ctx) {
  const before = ctx.record?.snap?.before;
  if (!before) return;
  const scopeId = ctx.scope.id;
  const root = ctx.scope.root;
  const made = await within(snapshot(root, scopeId, 'after', { budgetMs: BUDGET_MS }), BUDGET_MS);
  if (!made.id) {
    ctx.changed = null;
    const reason = skipReason(made.skipped);
    notify(ctx, `Turn snapshot after the turn skipped: ${reason}. The files this turn changed are not listed.`);
    return;
  }
  const changes = await changedBetween(root, before.tree, made.tree);
  ctx.record.snap.after = { id: made.id, tree: made.tree };
  ctx.record.snap.changed = changes.length;
  ctx.record.snap.files = changes.slice(0, FILES_KEPT).map(c => c.path);
  ctx.changed = changes.map(c => c.path);
  // Pruning is not part of the turn's answer, so it runs behind the turn.
  prune(root, scopeId, { busy: ctx.busy ?? (() => false) }).catch(() => {});
}
