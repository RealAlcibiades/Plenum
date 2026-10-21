// A partial listing of the project's files, so the model knows what is there. Empty or unreadable folders add nothing.
// Moved unchanged from systemFor in server.mjs.
import { listTree } from '../files.mjs';

export const parts = [
  {
    id: 'project-files',
    order: 90,
    contexts: ['chat'],
    text: async ctx => {
      const files = await listTree(ctx.root).catch(() => []);
      return files.length ? `Project files (partial listing):\n${files.join('\n')}` : null;
    },
  },
];
