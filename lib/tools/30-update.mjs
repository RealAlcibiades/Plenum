// propose_update: queues a change to Plenum's own files as a pending bundle. The user applies it in the Updates panel, so no
// file changes here. A delegated coder cannot queue updates (scoped: 'off').

import { clip } from '../tools.mjs';

async function runPropose(input, ctx) {
  if (!ctx.queueUpdate) throw new Error('Updates are not available in this session.');
  const manifest = await ctx.queueUpdate({ summary: input.summary, files: input.files });
  return {
    ok: true,
    summary: `Queued update ${manifest.id}`,
    output: `Queued update ${manifest.id} with ${manifest.files.length} file(s): ${manifest.files.map(f => f.path).join(', ')}. The user can review it and apply it in the Updates panel.`,
  };
}

export const tools = [
  {
    name: 'propose_update',
    description: 'Send a change to Plenum itself. It becomes a pending bundle in the Updates panel, and the user applies it there (no file changes happen until then). Paths are relative to the Plenum source folder, for example lib/providers.mjs or public/app.js.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One or two sentences on what changed and why.' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string', description: 'Full new content of the file.' } },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['summary', 'files'],
      additionalProperties: false,
    },
    scoped: 'off',
    refusal: 'A delegated coder cannot propose changes to Plenum.',
    describe: input => clip(String(input.summary ?? ''), 200),
    run: runPropose,
  },
];
