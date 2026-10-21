// The first line of the chat prompt: who the agent is and which folder it works in. With the server's tool loop on, the two
// tool paragraphs follow. Moved unchanged from systemFor in server.mjs (see lib/prompt.mjs for the part shape).
import { shellFor } from '../platform/index.mjs';
import { APP_ROOT } from '../updates.mjs';

const TOOL_USE = 'Work through the tools. Read a file before you edit it. Prefer edit_file for small changes and write_file for new files. Use search_text and list_dir to find code. Run tests or builds with run_command when they help. Paths are relative to the project folder, or absolute (for example C:\\Users\\name\\Documents\\notes.txt) when the user gives one. A path outside the project needs the user\'s approval, which they see as a card; say briefly why you need it.';

export const parts = [
  {
    id: 'core',
    order: 10,
    contexts: ['chat'],
    text: async ctx => {
      const lines = [`You are the coding agent inside Plenum. Project folder: ${ctx.root}. ${shellFor().osLine}`];
      if (ctx.agent) {
        lines.push(
          TOOL_USE,
          `To change Plenum itself, call propose_update with paths relative to its source folder (${APP_ROOT}). The user reviews and applies that bundle in the Updates panel.`,
        );
      }
      return lines.join('\n\n');
    },
  },
];
