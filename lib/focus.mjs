// Build focus: a per-project toggle that adds one fixed instruction text to every model's prompt, so the models get the code
// working and run only the checks that are strictly needed. It is an instruction, not a block. It changes no approval, scope
// or deny check; the approval mode decides what runs exactly as before.
//
// The flag is `buildFocus: true` on the project record (state.json), and it is absent when focus is off. Any other value
// reads as off: focus is not a protection, so off is the plain side. The texts are single strings, used as they are:
//   FOCUS_CHAT      the chat prompt (lib/prompt-parts/40-focus.mjs), for every model in the chat
//   FOCUS_REMINDER  one line on the newest message of a resumed Native session, which gets only the new message
//   FOCUS_CODER     a build's coder, and the delegate tool's coder (lib/delegate.mjs)
//   FOCUS_PLANNER   a build's planner
//   FOCUS_REVIEWER  a build's reviewer
// The routes are in lib/routes/focus.mjs; the page is public/ext-focus.js.

export const buildFocusOf = project => project?.buildFocus === true;

export const FOCUS_CHAT = 'Build focus is on for this project. The user wants working code first and only the checks that are strictly needed, so:\n- Do not run the full test suite, a linter, a type check or a production build unless the user asks for it in their message, or a change cannot be verified any other way.\n- When a check is needed, run the narrowest one that covers what you changed: one test file or one test name, one package, one target. Never run the whole suite to check one file.\n- Do not write new tests unless the user asks, and do not refactor or reformat code you were not asked to change.\n- Finish the task, then list in one short line the checks you skipped (for example: Skipped: full test suite, lint), so the user can run them.\nThe user turns this off with the Focus button.';

export const FOCUS_REMINDER = '(Build focus is on: run only the checks that are strictly needed, and name the ones you skipped.)';

export const FOCUS_CODER = 'Build focus is on. Change only what the task asks for. Do not add tests, refactors or formatting changes the task did not ask for. In your summary name any check the user should run.';

export const FOCUS_PLANNER = 'Build focus is on: do not add a task whose only purpose is to run tests, a linter or a build, and do not add tasks that only write tests unless the goal asks for them. Keep the plan to the tasks that change code.';

export const FOCUS_REVIEWER = 'Build focus is on. Missing tests, missing lint or an unrun suite are low severity on their own and never a reason for a changes verdict. Report real defects as usual.';
