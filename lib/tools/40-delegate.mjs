// delegate: hands one scoped coding task to a coder model (lib/delegate.mjs). The coder's steps are shown nested under this
// call. A delegated coder cannot delegate again (scoped: 'off'). The coder list comes from CODER_REFS in lib/delegate.mjs,
// so a new coder needs no edit here; the first one is the default.

import { CODER_REFS, runTask } from '../delegate.mjs';
import { clip } from '../tools.mjs';

const CODER_LIST = CODER_REFS.map((ref, i) => (i === 0 ? `${ref} (the default)` : ref)).join(', ');

// Hands one scoped task to a coder (delegate.mjs). The coder's steps are shown nested under this call.
async function runDelegate(input, ctx) {
  const steps = new Map();
  const nested = ev => {
    ctx.emit?.(ev);
    if (ev.type === 'tool') steps.set(ev.id, { name: ev.name, summary: ev.summary, parent: ev.parent });
    if (ev.type === 'tool_result' && steps.has(ev.id)) {
      ctx.out?.tools.push({ ...steps.get(ev.id), ok: ev.ok, result: ev.summary });
    }
  };
  const r = await runTask({
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
  });
  const lines = [r.ok ? `Done. ${r.summary}`.trim() : `Not finished: ${r.error ?? 'no reason given'}`];
  if (!r.ok && r.summary) lines.push(`The coder said: ${r.summary}`);
  if (r.changed.length) lines.push(`Changed: ${r.changed.join(', ')}`);
  if (r.outOfScope.length) lines.push(`Changed outside the scope: ${r.outOfScope.join(', ')}`);
  const title = clip(String(input.title ?? 'Delegated task'), 120);
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
