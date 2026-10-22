// Build focus in the prompt (lib/focus.mjs). When the project has build focus on, the chat gets FOCUS_CHAT, a build's coder gets
// FOCUS_CODER, its planner FOCUS_PLANNER and its reviewer FOCUS_REVIEWER. The text is added only; nothing here approves an action,
// widens a folder or turns a tool on. Other contexts (council, relay, compare, pipeline, advisor, compact, moderator) get nothing.
//
// The project is ctx.project when the caller passed it (the chat and the coder do), else the project whose folder is ctx.root
// (the planner and the reviewer are called with the root only). A call that matches no project, or a project with focus off,
// adds nothing, so a prompt with focus off is byte-identical to the prompt without this file.
import { buildFocusOf, FOCUS_CHAT, FOCUS_CODER, FOCUS_PLANNER, FOCUS_REVIEWER } from '../focus.mjs';
import { projectForRoot } from '../prompt.mjs';

// Focus is on for this call. A project the caller named wins over the folder lookup.
function focusOn(ctx) {
  const project = ctx.project ?? projectForRoot(ctx.root);
  return buildFocusOf(project);
}

// Order 40 puts the text after the AGENTS.md block (30) and before the attachment rule (50), so it sits with the other fixed texts.
export const parts = [
  {
    id: 'focus-chat',
    order: 40,
    contexts: ['chat'],
    text: async ctx => (focusOn(ctx) ? FOCUS_CHAT : null),
  },
  {
    id: 'focus-coder',
    order: 40,
    contexts: ['coder'],
    text: async ctx => (focusOn(ctx) ? FOCUS_CODER : null),
  },
  {
    id: 'focus-planner',
    order: 40,
    contexts: ['planner'],
    text: async ctx => (focusOn(ctx) ? FOCUS_PLANNER : null),
  },
  {
    id: 'focus-reviewer',
    order: 40,
    contexts: ['reviewer'],
    text: async ctx => (focusOn(ctx) ? FOCUS_REVIEWER : null),
  },
];
