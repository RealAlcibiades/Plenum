// delegate: hands one task to an agent (lib/agent-run.mjs). The agent's steps are shown nested under this call. The model names the
// type (agent: researcher, coder, tester, reviewer or a custom one) and may name a model and an effort; the saved agent settings
// (Settings > Agents, lib/agents.mjs) decide which types this caller may start, how many at once and per run, how deep agents may
// nest, and each type's limits. The tool is offered only when the caller may start at least one type; its description lists them.
//
// Every limit is enforced by runAgent, never here: plan mode, the caller's types, nesting depth, the run's ceiling, the caller's
// total, the model's capability for the kind, the type's folders, the spend cap and the optional start card. This file builds the
// definition the model sees, hands the call to runAgent with the turn's run, and writes the answer the model reads.
// An agent started by an agent (nesting) reaches here with ctx.agent set; ctx.delegable then holds the types it may start.

import { CODER_REFS, DEFAULT_CODER, coderRefs } from '../delegate.mjs';
import { clip } from '../tools.mjs';
import { labelFor } from '../providers.mjs';
import * as store from '../store.mjs';
import { projectForRoot } from '../prompt.mjs';
import { clock, openRun, runAgent } from '../agent-run.mjs';
import { describeTypes, effectiveAgents, limitsFor, typeByName } from '../agents.mjs';

// One run per chat turn: the turn's ctx.out object is shared by every delegate call of the reply, even when the calls run in parallel,
// so the calls share one count and one set of places. A ctx that carries its own run (ctx.agentRun) is used as it is.
const runs = new WeakMap();
function runFor(ctx, project) {
  const key = ctx.out !== null && typeof ctx.out === 'object' ? ctx.out : ctx;
  let run = runs.get(key);
  if (!run) {
    run = openRun({ projectId: project.id, kind: 'chat', signal: ctx.signal });
    runs.set(key, run);
  }
  return run;
}

// The settings in force for this call: the project's own agent block when it has a valid one, else the app's, else the defaults.
// A state that cannot be read gives the defaults, so a delegation is never lost to a settings problem.
function stateOf(ctx) {
  try {
    const st = store.get();
    const project = st.projects?.find(p => p.id === ctx.projectId) ?? projectForRoot(ctx.root) ?? null;
    return { st, project };
  } catch {
    return { st: null, project: null };
  }
}

function agentsFor(ctx) {
  const { st, project } = stateOf(ctx);
  try {
    return effectiveAgents(st, project);
  } catch {
    return effectiveAgents(null, null);
  }
}

function projectFor(ctx) {
  return stateOf(ctx).project ?? { id: ctx.projectId ?? 'unknown', path: ctx.root, settings: {} };
}

// Who is asking: the chat (or build, council seat, ...) that the server named, else the chat with the model in ctx.ref.
const callerOf = ctx => ctx.caller ?? { role: 'chat', ref: ctx.ref, label: ctx.ref ? labelFor(ctx.ref) : 'Chat', depth: 0 };
const rootRole = caller => (caller.role === 'agent' ? (caller.rootRole ?? 'chat') : caller.role);

// The name of a type as the step row shows it: its first letter capitalised and hyphens as spaces ('docs-writer' is 'Docs writer').
const shownName = raw => {
  const name = String(raw ?? 'coder').trim().replace(/-/g, ' ') || 'coder';
  return name.charAt(0).toUpperCase() + name.slice(1);
};

// ---------- the definition ----------

const FIRST = 'Hand one well-defined task to an agent that works on its own and reports back. Use it for independent work you can describe fully: a change to some files, a look through the project, a check to run. The agent cannot see this chat, so put every fact it needs in instructions.';

// The tool as the model sees it. `types` are the type objects this caller may start (describeTypes lists them).
export function delegateDef(types, refs = CODER_REFS) {
  const list = types.length ? describeTypes(types) : 'none';
  const models = refs.join(', ');
  return {
    description: `${FIRST} Several delegate calls in one reply run in parallel up to the limit; the rest wait. Give agents that edit files scopes that do not overlap, or they run one after another. Returns what the agent reported and the files it changed. Writes still need approval unless approvals are on auto. Types you may start: ${list}.`,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name for the task.' },
        instructions: { type: 'string', description: 'Exactly what to do, and the facts the agent needs.' },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Required for a type that edits files; optional focus folders for a read-only type. Project-relative files or folders the agent may change. Never the whole project, and never absolute or containing "..".',
        },
        agent: { type: 'string', description: 'One of the types listed below. Default coder.' },
        model: { type: 'string', description: `Optional model override, provider:id. Some that can edit: ${models}.` },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional. Default is the type\'s effort.' },
        coder: { type: 'string', description: 'Deprecated alias of model.' },
      },
      required: ['title', 'instructions'],
      additionalProperties: false,
    },
  };
}

// The types this ctx may offer, as objects. A chat-like caller gets the types its row lists; an agent gets ctx.delegable.
function offerTypes(ctx) {
  if (ctx.agent) return Array.isArray(ctx.delegable) ? ctx.delegable : [];
  const agents = ctx.agents ?? agentsFor(ctx);
  const caller = callerOf(ctx);
  const role = rootRole(caller);
  let lim;
  try {
    lim = limitsFor(agents, role, caller.ref);
  } catch {
    return [];
  }
  if (!lim.types.length || lim.total < 1 || lim.concurrent < 1) return [];
  return lim.types.map(n => typeByName(agents, n)).filter(Boolean);
}

// ---------- the call ----------

const refusal = (text, extra = {}) => ({ ok: false, denied: true, summary: clip(text, 300), output: `${text} Do not retry it.`, ...extra });

// Hands one task to an agent (lib/agent-run.mjs). The agent's steps are shown nested under the call.
async function runDelegate(input, ctx) {
  const agents = ctx.agents ?? agentsFor(ctx);
  const caller = callerOf(ctx);
  const lim = limitsFor(agents, rootRole(caller), caller.ref);
  const name = String(input.agent ?? 'coder');
  const type = typeByName(agents, name);
  if (!type || type.buildOnly) {
    return { ok: false, summary: `${name} is not an agent type`, output: `"${name}" is not an agent type you can start. Use one of: ${lim.types.join(', ') || 'none'}.` };
  }
  const project = ctx.project ?? projectFor(ctx);
  const run = ctx.agentRun ?? runFor(ctx, project);
  const title = clip(String(input.title ?? 'Delegated task'), 120);

  // The agent's steps are recorded with the reply, nested under this call.
  const steps = new Map();
  const nested = ev => {
    ctx.emit?.(ev);
    if (ev.type === 'tool') steps.set(ev.id, { name: ev.name, summary: ev.summary, parent: ev.parent });
    if (ev.type === 'tool_result' && steps.has(ev.id)) {
      ctx.out?.tools.push({ ...steps.get(ev.id), ok: ev.ok, result: ev.summary });
    }
  };

  const r = await runAgent({
    run,
    caller,
    agents,
    type,
    task: { id: ctx.parent, title: input.title, instructions: input.instructions, scope: input.scope, agent: name },
    project,
    root: ctx.root,
    mode: ctx.mode,
    signal: ctx.signal,
    approve: ctx.approve,
    emit: nested,
    parent: ctx.parent,
    tools: ctx.tools,
    denyPatterns: ctx.denyPatterns,
    focus: ctx.focus === true,
    rules: ctx.rules,
    fallbackRef: caller.ref ?? ctx.ref ?? DEFAULT_CODER,
    modelOverride: input.model ?? input.coder,
    effortOverride: input.effort,
    callerEffort: ctx.effort,
    // Only the tests set this: the stream an agent uses instead of the real providers (it is passed down to the agents it starts).
    stream: ctx.agentStream,
  });

  // A start that was refused before the agent began is the answer; so is a start card that was denied.
  if (r.denied) {
    return { ok: false, denied: true, summary: r.reason ? `Denied by user: ${r.reason}` : 'Denied by user', output: r.error };
  }
  if (r.refused) {
    return r.why === 'input'
      ? { ok: false, summary: `${type.label} · ${title}: not finished`, output: `Not finished: ${r.error}` }
      : refusal(r.error);
  }
  const took = clock(r.elapsedMs);
  const state = r.ok ? 'done' : 'not finished';
  const header = `${type.label} (${labelFor(r.model ?? caller.ref ?? DEFAULT_CODER)}) · ${state} in ${took}, ${r.turns} tool steps`;
  const lines = [header];
  if (type.returns === 'verdict') {
    const verdict = /^\s*VERDICT:.*$/im.exec(r.summary ?? '');
    if (verdict) lines.push(verdict[0].trim());
  }
  lines.push(r.ok ? `Done. ${r.summary}`.trim() : `Not finished: ${r.error ?? 'no reason given'}`);
  if (!r.ok && r.summary) lines.push(`The agent said: ${r.summary}`);
  if (r.changed.length) lines.push(`Changed: ${r.changed.join(', ')}`);
  if (r.outOfScope.length) lines.push(`Changed outside the scope: ${r.outOfScope.join(', ')}`);
  const count = r.changed.length;
  return {
    ok: r.ok,
    summary: `${type.label} · ${title}: ${state} in ${took}${count ? `, ${count} ${count === 1 ? 'file' : 'files'} changed` : ''}`,
    output: lines.join('\n'),
  };
}

// The static entry the registry holds. toolsFor asks `offer` for the definition each time, so the types listed are the ones this
// caller may start, and the tool is left out when it may start none.
export const tools = [
  {
    name: 'delegate',
    ...delegateDef([]),
    scoped: 'off',
    refusal: 'A delegated coder cannot delegate further.',
    describe: input => {
      const title = clip(String(input.title ?? 'Delegated task'), 200);
      return `${shownName(input.agent)} · ${title}`;
    },
    offer: ctx => {
      const types = offerTypes(ctx);
      if (!types.length) return null;
      let refs = CODER_REFS;
      try {
        refs = coderRefs();
      } catch {
        // A state that cannot be read leaves the shipped list.
      }
      return delegateDef(types, refs);
    },
    run: runDelegate,
  },
];
