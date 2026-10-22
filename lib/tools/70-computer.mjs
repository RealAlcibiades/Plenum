// The computer toolset and the two tools that come with it (computer use, lib/computer). Shape: see the top of lib/tools/10-files.mjs.
//   - computer_toolset_20260801: one raw entry, offered only when ctx.computer is set (a computer run the person started, or the
//     one the model started through start_computer_use) and never to a delegated coder. The seventeen member tools are not
//     registered here: lib/providers.mjs sends them as the toolset and answers their calls through lib/computer/claude.mjs.
//   - confirm_with_user and hand_over: the model asks the person before a consequential step, or hands them the mouse and keyboard.
//     Both answer through the run (ctx.computer.confirm and handOver), which shows its own cards and pauses. runTool runs them
//     without a plan, so no card is shown twice.
// Neither is offered to a delegated coder (scoped 'off'), and neither shows in a chat without a run.

import { clip } from '../tools.mjs';

// The toolset entry, exactly as the API takes it: no name, no display size, and zoom on (it is on by default too).
export const COMPUTER_TOOLSET = Object.freeze({
  type: 'computer_toolset_20260801',
  configs: { zoom: { enabled: true } },
  cache_control: { type: 'ephemeral' },
});

export const CONFIRM_TOOL = {
  name: 'confirm_with_user',
  description: 'Ask the user to confirm one consequential action before you do it on the computer: sending a message or email, buying or paying, deleting or discarding, submitting a form, agreeing to terms, signing in. Say exactly what will happen. Do not use it for ordinary steps.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'What will happen, in one plain sentence.' },
      why: { type: 'string', description: 'Why it is needed for the task.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export const HAND_OVER_TOOL = {
  name: 'hand_over',
  description: 'Hand the mouse and keyboard to the user for a step you must not do: entering a password, a code, card or bank details, or anything they must do themselves. Say in one short sentence what they should do. Returns when they press Resume.',
  input_schema: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'One short sentence: what the user should do.' } },
    required: ['reason'],
    additionalProperties: false,
  },
};

const CODER_REFUSAL = 'A delegated coder cannot use the computer.';
const computerOn = ctx => !!ctx?.computer && !ctx.scope;
const noRun = () => ({ ok: false, summary: 'No computer run', output: 'No computer run is on. Ask the user to start one with /computer.' });

export const tools = [
  { raw: COMPUTER_TOOLSET, when: computerOn },
  {
    ...CONFIRM_TOOL,
    run: (input, ctx) => (ctx.computer ? ctx.computer.confirm({ action: input.action, why: input.why }) : noRun()),
    describe: input => clip(String(input?.action ?? ''), 80),
    scoped: 'off',
    refusal: CODER_REFUSAL,
    when: computerOn,
  },
  {
    ...HAND_OVER_TOOL,
    run: (input, ctx) => (ctx.computer ? ctx.computer.handOver({ reason: input.reason }) : noRun()),
    describe: input => clip(String(input?.reason ?? ''), 80),
    scoped: 'off',
    refusal: CODER_REFUSAL,
    when: computerOn,
  },
];
