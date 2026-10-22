// start_computer_use (amendment 08): lets the model start a computer run itself, in a chat turn of the desktop app, when the project's
// switch "The model may start computer use itself" is on (off by default). Shape: see the top of lib/tools/10-files.mjs.
//   - Offered only when the server set ctx.startComputer, which it does only for that switch, in the desktop app and for a Claude
//     route that can drive a computer; and only while no run is on this turn (ctx.computer unset). A delegated coder never gets it.
//   - run calls ctx.startComputer (server.mjs), which builds the run from the project's remembered choices and shows the start card
//     first. Nothing here starts a run: the card is the consent, and it shows in every approval mode.
//   - A second call in the same turn is refused by the server ('A run is already going.').

import { clip } from '../tools.mjs';

const SCOPES = ['window', 'display'];

export const START_TOOL = {
  name: 'start_computer_use',
  description: 'Start a computer run for this message, so you can see the screen and use the mouse and keyboard for one task: inside one app window (the default) or a whole display. Use it only when the person asked for work on their screen, or agreed to it, and the task cannot be done with the files or the browser. Plenum shows the person a start card first, and nothing runs until they approve it. Say in task what the run is for.',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'What the run is for, in one or two sentences.' },
      scope: { type: 'string', enum: SCOPES, description: 'window (one app window, the default) or display (the whole screen).' },
      app: { type: 'string', description: 'Optional. The app to use, by name, as it appears in the window list.' },
    },
    required: ['task'],
    additionalProperties: false,
  },
};

export const tools = [
  {
    ...START_TOOL,
    run: (input, ctx) => ctx.startComputer({
      task: typeof input?.task === 'string' ? input.task : '',
      scope: SCOPES.includes(input?.scope) ? input.scope : undefined,
      app: typeof input?.app === 'string' ? input.app : undefined,
    }),
    describe: input => clip(String(input?.task ?? 'Computer use'), 80),
    scoped: 'off',
    refusal: 'A delegated coder cannot start computer use.',
    when: ctx => typeof ctx?.startComputer === 'function' && !ctx.computer && !ctx.scope,
  },
];
