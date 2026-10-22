// delegate: hands one scoped coding task to a coder model (lib/delegate.mjs). The coder's steps are shown nested under this
// call. A delegated coder cannot delegate again (scoped: 'off'). The coder list comes from CODER_REFS in lib/delegate.mjs,
// so a new coder needs no edit here; the first one is the default.
//
// The saved agent settings (Settings > Agents, lib/agents.mjs) are read here. The tool starts a Coder, so the Coder type and the Chat
// row of Limits apply: whether a reply may start a Coder at all, how many at once and per reply (a gate for the turn), whether each
// start asks first, and the Coder's model, effort, folders and instructions where the person changed them. A Coder that still has the
// shipped settings runs exactly as before. Tool steps, time limits, commands and nesting are not read yet (IN_FORCE in lib/agents.mjs).

import { CODER_REFS, runTask } from '../delegate.mjs';
import { cleanReason, clip } from '../tools.mjs';
import { labelFor } from '../providers.mjs';
import * as store from '../store.mjs';
import { projectForRoot } from '../prompt.mjs';
import { agentSystem, createGate, delegation, effectiveAgents, resetTypeTo } from '../agents.mjs';

const CODER_LIST = CODER_REFS.map((ref, i) => (i === 0 ? `${ref} (the default)` : ref)).join(', ');

// The Coder type as shipped. A saved Coder that differs from it only in fields the tool does not read runs as it always did.
const SHIPPED = resetTypeTo('coder');

// One gate per chat turn: the turn's ctx.out object is shared by every delegate call of the reply, even when the calls run in parallel.
const gates = new WeakMap();
function gateFor(ctx) {
  const key = ctx.out !== null && typeof ctx.out === 'object' ? ctx.out : ctx;
  let gate = gates.get(key);
  if (!gate) {
    gate = createGate();
    gates.set(key, gate);
  }
  return gate;
}

// The settings in force for this call: the project's own agent block when it has a valid one, else the app's, else the defaults.
// A state that cannot be read gives the defaults, so a delegation is never lost to a settings problem.
function agentsFor(ctx) {
  try {
    const st = store.get();
    const project = st.projects?.find(p => p.id === ctx.projectId) ?? projectForRoot(ctx.root);
    return effectiveAgents(st, project);
  } catch {
    return effectiveAgents(null, null);
  }
}

// What runTask is told about a Coder that differs from the shipped one, or undefined when nothing it reads differs.
function coderAgent(type, ctx) {
  const textChanged = type.brief !== SHIPPED.brief || type.folders.join('\n') !== SHIPPED.folders.join('\n');
  const modelChanged = type.model !== SHIPPED.model;
  const effortChanged = type.effort !== SHIPPED.effort;
  if (!textChanged && !modelChanged && !effortChanged) return undefined;
  const agent = {};
  // A model of null is "the model that asked": the asking model when it is a coder, else the default coder.
  if (modelChanged) agent.model = type.model ?? (CODER_REFS.includes(ctx.ref) ? ctx.ref : undefined);
  if (effortChanged && type.effort) agent.effort = type.effort;
  if (type.folders.length) agent.folders = type.folders;
  // Commands and the web are not offered to a delegated coder, so the text must not say they are. Build focus comes from the prompt part.
  if (textChanged) agent.system = agentSystem({ ...type, commands: false, web: false }, { focus: false });
  return agent;
}

const notAllowed = message => ({ ok: false, denied: true, summary: 'Not allowed by the agent settings', output: `${message} Do not retry it.` });

// Hands one scoped task to a coder (delegate.mjs). The coder's steps are shown nested under this call.
async function runDelegate(input, ctx) {
  const found = delegation(agentsFor(ctx), { role: 'chat', ref: ctx.ref, name: 'coder' });
  if (!found.ok) return notAllowed(found.error);
  const { type, limits, who } = found;
  const agent = coderAgent(type, ctx);
  const title = clip(String(input.title ?? 'Delegated task'), 120);

  // Ask before each start, when the Chat row says so. Approve all answers every card, as it does elsewhere.
  if (limits.askToStart && typeof ctx.approve === 'function' && ctx.mode !== 'all') {
    const ref = input.coder || agent?.model || CODER_REFS[0];
    const scope = Array.isArray(input.scope) && input.scope.length ? input.scope.join(', ') : '(none given)';
    const card = {
      summary: `Start ${type.label} agent: ${title}`,
      detail: `Type: ${type.label} (edits files)\nModel: ${labelFor(ref)}\nScope: ${clip(scope, 400)}\n\nInstructions:\n${clip(String(input.instructions ?? ''), 2000)}`,
    };
    if (!(await ctx.approve(card))) {
      const reason = cleanReason(card.reason);
      return { ok: false, denied: true, summary: reason ? `Denied by user: ${reason}` : 'Denied by user', output: `The user did not allow this agent to start.${reason ? ` The user said: ${reason}` : ''}` };
    }
  }

  // At most `concurrent` agents run at once in this reply, the rest wait; past the per-reply number a start is refused.
  const total = Math.min(limits.total, limits.perRun);
  const entered = await gateFor(ctx).enter({ concurrent: limits.concurrent, total, signal: ctx.signal });
  if (!entered.ok) {
    if (entered.reason === 'total') return notAllowed(`${who} has started ${total} agents in this reply, its limit. Finish with what you have.`);
    return { ok: false, summary: `${title}: not finished`, output: 'Not finished: Stopped before it started.' };
  }

  const steps = new Map();
  const nested = ev => {
    ctx.emit?.(ev);
    if (ev.type === 'tool') steps.set(ev.id, { name: ev.name, summary: ev.summary, parent: ev.parent });
    if (ev.type === 'tool_result' && steps.has(ev.id)) {
      ctx.out?.tools.push({ ...steps.get(ev.id), ok: ev.ok, result: ev.summary });
    }
  };
  let r;
  try {
    r = await runTask({
      task: { id: ctx.parent ?? 'delegate', title: input.title, instructions: input.instructions, scope: input.scope, coder: input.coder, effort: input.effort },
      root: ctx.root,
      mode: ctx.mode,
      signal: ctx.signal,
      approve: ctx.approve,
      emit: nested,
      parent: ctx.parent,
      tools: ctx.tools,
      projectId: ctx.projectId,
      denyPatterns: ctx.denyPatterns,
      agent,
    });
  } finally {
    entered.release();
  }
  const lines = [r.ok ? `Done. ${r.summary}`.trim() : `Not finished: ${r.error ?? 'no reason given'}`];
  if (!r.ok && r.summary) lines.push(`The coder said: ${r.summary}`);
  if (r.changed.length) lines.push(`Changed: ${r.changed.join(', ')}`);
  if (r.outOfScope.length) lines.push(`Changed outside the scope: ${r.outOfScope.join(', ')}`);
  return {
    ok: r.ok,
    summary: `${title}: ${r.ok ? 'done' : 'not finished'}${r.changed.length ? `, ${r.changed.length} file(s) changed` : ''}`,
    output: lines.join('\n'),
  };
}

export const tools = [
  {
    name: 'delegate',
    description: 'Hand one well-defined coding task to a coder model that works only inside the scope you give. Use it for independent edits you can describe fully. The coder cannot see this chat, so put every fact it needs in instructions. Several delegate calls in one reply run in parallel, so give them scopes that do not overlap. Returns what the coder reported and the files it changed. Writes still need approval unless approvals are on auto.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name for the task.' },
        instructions: { type: 'string', description: 'Exactly what to change, and the facts the coder needs.' },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Project-relative files or folders the coder may change. Required. Never the whole project, and never absolute or containing "..".',
        },
        coder: {
          type: 'string',
          description: `Optional. One of ${CODER_LIST}.`,
        },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional. Default high.' },
      },
      required: ['title', 'instructions', 'scope'],
      additionalProperties: false,
    },
    scoped: 'off',
    refusal: 'A delegated coder cannot delegate further.',
    describe: input => clip(String(input.title ?? 'Delegated task'), 200),
    run: runDelegate,
  },
];
