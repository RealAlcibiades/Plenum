// The browser tools (brw-03): the model drives the Plenum browser pane, and the person watches. The tools themselves, their rules and
// their cards are in lib/browser-tools.mjs; this file only registers them (see the shape at the top of lib/tools/10-files.mjs).
//   - Offered only when ctx.browser is true: the server sets it for a chat turn in the desktop app while the pane's switch "Let the
//     model use this browser" is on. A plan-mode turn, the advisor, council, relay, compare and pipelines have no ctx, so they never
//     get these tools; a delegated coder (ctx.scope) is refused (scoped: 'off').
//   - browser_screenshot is offered only to a model that can see images (ctx.vision), because its result is a picture.
//   - The cards are asked inside run (ctx.approve), not through a plan: lib/tools.mjs shows a plan's card only in Ask first, while these
//     cards must also show in Auto-approve, and Approve all answers them only when the project covers the browser.

import { BROWSER_TOOL_DEFS, BROWSER_TOOLS, browserOn, describeBrowserCall } from '../browser-tools.mjs';

const CODER_REFUSAL = 'A delegated coder cannot use the browser.';

export const tools = BROWSER_TOOL_DEFS.map(def => ({
  name: def.name,
  description: def.description,
  input_schema: def.input_schema,
  run: (input, ctx) => BROWSER_TOOLS[def.name].run(input, ctx),
  describe: input => describeBrowserCall(def.name, input),
  scoped: 'off',
  refusal: CODER_REFUSAL,
  when: def.name === 'browser_screenshot' ? ctx => browserOn(ctx) && ctx.vision === true : ctx => browserOn(ctx),
}));
