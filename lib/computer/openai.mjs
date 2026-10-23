// The OpenAI adapter for computer use: the Responses API computer tool, run through the same run as the Claude adapter, so the cards,
// limits, log, overlay and step rows are the run's (lib/computer/run.mjs), whichever model drives it.
//
// lib/providers.mjs hands a chat turn that has a computer run to streamComputer when the provider has a driver (lib/computer/drivers.mjs).
// This file talks to https://api.openai.com/v1/responses with fetch (no SDK), keeps the conversation with previous_response_id, and
// sends every action through the run handle (ctx.computer.step), which checks it, shows its step row and logs it. The driver adds no
// events of its own for computer actions.
//
//   streamComputer({ id, system, messages, signal, ctx, effort, onUsage, onStop, images, documents })  an async generator of reply text
//   toCanonicalAction(action)   the canonical action(s) (desktop/computer/actions.cjs shapes) for one OpenAI computer action
//   OPENAI_COMPUTER_MODEL       the model used when the chat names none ('gpt-6.1-sol', the id the tool page names; checked on the page)
//
// The rules this file keeps:
//  - The key is read for each run, sent only to api.openai.com, and never logged, stored or put in an error.
//  - Each provider safety check (pending_safety_checks) is a card through run.confirm. A check whose kind the person switched off is
//    acknowledged by the run without a card. Approved checks are echoed as acknowledged_safety_checks. A declined check ends the run.
//  - A function call is answered only for the two tools a computer run offers (confirm_with_user and hand_over), which go through
//    runTool as they do on the Claude path. Any other name gets an error answer and runs nothing.
//  - A screenshot is sent back with every computer_call. Once the run is over (limit, stop, budget) no screenshot can be taken, so
//    the run ends there with the run's own words as the reply.

import { keyFor } from '../keys.mjs';
import { IMAGE_REFUSAL } from '../images.mjs';
import { pdfRefusal } from '../attachments.mjs';
import { reportUsage, tokensFromChat } from '../pricing.mjs';
import { clip, describeCall, loadTools, runTool, toolsFor } from '../tools.mjs';
import { toCanonical } from './claude.mjs';

export const OPENAI_COMPUTER_MODEL = 'gpt-6.1-sol';
export const RESPONSES_URL = 'https://api.openai.com/v1/responses';

// The function tools a computer run offers to this provider, by name (the schemas are the ones in lib/tools/70-computer.mjs).
const FUNCTION_TOOLS = Object.freeze(['confirm_with_user', 'hand_over']);
// One scroll amount is 300 pixels, the unit the tool page uses; the desktop takes notches up to the same cap as the Claude path.
const SCROLL_PX = 300;
const SCROLL_MAX = 50;
// The pause a wait action asks for (the tool page sends no duration).
const WAIT_MS = 2000;
// The spend cap is checked every this many model requests, as the Claude path does.
const BUDGET_EVERY = 5;
const MAX_NOTE = 300;
const MAX_OUTPUT = 24_000;
const DECLINED_REPLY = 'The user declined a safety check.';
const DECLINED_NOTICE = 'Computer use stopped: you declined OpenAI\'s safety check.';
const BUTTONS = Object.freeze({ left: 'left', right: 'right', wheel: 'middle' });

const redact = (text, key) => (key ? String(text).split(key).join('[key]') : String(text));
const reasonOf = err => err?.cause?.code ?? err?.message ?? 'unknown error';

// The text of a message's parts: a string, or the text blocks of a content list. Other blocks (images, tool blocks from another
// provider) mean nothing to this one and are left out.
function plainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  return '';
}

const imagePart = base64 => ({ type: 'input_image', image_url: `data:image/png;base64,${base64}`, detail: 'original' });
const imageOf = res => res?.blocks?.find(b => b?.type === 'image')?.source?.data ?? null;

// The text of one output message item.
const textOf = item => (Array.isArray(item?.content) ? item.content : []).filter(p => p?.type === 'output_text' && typeof p.text === 'string').map(p => p.text).join('');

// A point from an action's x and y. OpenAI always sends both for these actions, so a missing one is an error, not a guess.
function pointOf(action) {
  const x = Number(action.x);
  const y = Number(action.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('This action needs an x and y position in the picture.');
  return { x: Math.round(x), y: Math.round(y) };
}

// Scroll notches for a signed distance in pixels: one per 300 pixels, at least one, at most the cap.
const notchesOf = distance => Math.min(SCROLL_MAX, Math.max(1, Math.round(Math.abs(distance) / SCROLL_PX)));

// One OpenAI computer action as the canonical actions the run takes. A scroll on both axes is two canonical scrolls, so the result is a
// list. Throws an Error with a plain message for an action this app does not run.
export function toCanonicalAction(action) {
  const a = action && typeof action === 'object' && !Array.isArray(action) ? action : null;
  if (!a || typeof a.type !== 'string') throw new Error('That computer action has no type.');
  switch (a.type) {
    case 'screenshot':
      return [{ kind: 'screenshot' }];
    case 'click':
      if (!Object.hasOwn(BUTTONS, a.button)) throw new Error('This click names a button this app does not press (left, right or wheel).');
      return [{ kind: 'click', button: BUTTONS[a.button], count: 1, modifiers: [], ...pointOf(a) }];
    case 'double_click':
      return [{ kind: 'click', button: 'left', count: 2, modifiers: [], ...pointOf(a) }];
    case 'drag': {
      const path = Array.isArray(a.path) ? a.path : [];
      if (path.length < 2) throw new Error('A drag needs a path of at least two points.');
      return [{ kind: 'drag', from: pointOf(path[0]), to: pointOf(path.at(-1)), modifiers: [] }];
    }
    case 'move':
      return [{ kind: 'move', ...pointOf(a) }];
    case 'scroll': {
      const dx = Number(a.scroll_x) || 0;
      const dy = Number(a.scroll_y) || 0;
      const at = pointOf(a);
      const out = [];
      if (dy) out.push({ kind: 'scroll', direction: dy > 0 ? 'down' : 'up', amount: notchesOf(dy), ...at });
      if (dx) out.push({ kind: 'scroll', direction: dx > 0 ? 'right' : 'left', amount: notchesOf(dx), ...at });
      return out;
    }
    case 'keypress': {
      const keys = Array.isArray(a.keys) ? a.keys : [];
      if (!keys.length || !keys.every(k => typeof k === 'string')) throw new Error('A key press needs a list of key names.');
      // The Claude adapter's key rules (names, aliases, the modifier order) apply to these too.
      return [toCanonical('key', { text: keys.join('+') })];
    }
    case 'type':
      return [toCanonical('type', { text: a.text })];
    case 'wait':
      return [{ kind: 'wait', ms: WAIT_MS }];
    default:
      throw new Error(`"${clip(a.type, 40)}" is not a computer action this app knows.`);
  }
}

// The request's tools: the computer tool, then the two function tools in the form the Responses API takes. strict is off because
// confirm_with_user has an optional field, which strict mode does not allow.
export async function functionToolsFor(ctx) {
  await loadTools();
  return toolsFor(ctx)
    .filter(t => FUNCTION_TOOLS.includes(t.name))
    .map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false }));
}

// The conversation before this request as plain messages (text only; the earlier turns' pictures are not kept).
export function historyInput(messages) {
  const out = [];
  for (const m of messages ?? []) {
    const text = plainText(m?.content);
    if (!text.trim()) continue;
    out.push({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: text });
  }
  return out;
}

// The first request's input: the conversation, with the first screenshot added to the newest user message. When the screenshot could not
// be taken, the reason goes in its place, so the model can take one itself.
export function firstInput(messages, shot) {
  const items = historyInput(messages);
  const picture = imageOf(shot)
    ? imagePart(imageOf(shot))
    : { type: 'input_text', text: `The first screenshot could not be taken: ${clip(String(shot?.output ?? 'no reason given'), MAX_NOTE)}. Take a screenshot before acting.` };
  const last = items.at(-1);
  if (last && last.role === 'user') items[items.length - 1] = { role: 'user', content: [{ type: 'input_text', text: last.content }, picture] };
  else items.push({ role: 'user', content: [picture] });
  return items;
}

// The Responses API answers an HTTP error with a JSON error object. The provider's words go out, never the request, and the key is
// removed from them. A 400 that names the safety-check fields is shown unchanged: the fields are not documented for every model.
async function failure(res, apiKey) {
  const raw = await res.text().catch(() => '');
  let detail = '';
  try {
    const parsed = JSON.parse(raw);
    detail = String(parsed?.error?.message ?? parsed?.message ?? '');
  } catch {
    detail = raw.replace(/<[^>]*>/g, ' ');
  }
  detail = redact(detail.replace(/\s+/g, ' ').trim(), apiKey);
  if (res.status === 401) return new Error('OpenAI rejected the key (401). Open Accounts and save a valid key.');
  if (res.status === 400 && /safety_checks/.test(detail)) return new Error(detail);
  return new Error(`OpenAI returned an error (${res.status}).${detail ? ` The provider said: ${clip(detail, MAX_NOTE)}` : ''}`);
}

// One request. Resolves with the parsed response, or null when the signal stopped it (the caller then ends quietly).
async function create({ apiKey, body, signal }) {
  let res;
  try {
    res = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
      // A redirect is refused rather than followed, so the key and the conversation never go to another host.
      redirect: 'error',
    });
  } catch (err) {
    if (signal?.aborted) return null;
    if (/redirect/i.test(String(err?.cause?.message ?? ''))) throw new Error('OpenAI tried to redirect the request, so it was stopped. The key was not sent on.');
    throw new Error(`OpenAI could not be reached (${reasonOf(err)}). Check the connection, then send again.`);
  }
  if (!res.ok) {
    if (signal?.aborted) return null;
    throw await failure(res, apiKey);
  }
  let response;
  try {
    response = await res.json();
  } catch {
    throw new Error('OpenAI sent a reply this app could not read.');
  }
  if (!response || typeof response !== 'object') throw new Error('OpenAI sent a reply this app could not read.');
  if (response.error) throw new Error(`OpenAI stopped with an error: ${redact(clip(String(response.error?.message ?? 'no reason given'), MAX_NOTE), apiKey)}`);
  return response;
}

// One function call from the model: confirm_with_user or hand_over runs through runTool (the run shows the card or pauses), and the
// answer is its output. Anything else is answered with an error and runs nothing.
async function answerFunction(fn, ctx) {
  const name = String(fn?.name ?? '');
  const callId = String(fn?.call_id ?? '');
  let input = null;
  try {
    input = JSON.parse(fn?.arguments || '{}');
  } catch {
    input = null;
  }
  const isObject = Boolean(input) && typeof input === 'object' && !Array.isArray(input);
  let output;
  if (!FUNCTION_TOOLS.includes(name)) {
    output = `Error: "${clip(name, 40)}" is not a tool a computer run offers. Use the computer actions, confirm_with_user or hand_over.`;
  } else if (!isObject) {
    output = 'Error: the arguments for this tool call were not a JSON object, so the tool did not run. Send the call again with valid JSON arguments.';
  } else {
    const summary = describeCall(name, input);
    ctx.emit?.({ type: 'tool', id: callId, name, summary });
    const res = await runTool(name, input, ctx);
    const note = clip(String(res?.summary ?? ''), MAX_NOTE);
    ctx.emit?.({ type: 'tool_result', id: callId, ok: Boolean(res?.ok), summary: note });
    ctx.out?.tools?.push({ name, summary, ok: Boolean(res?.ok), result: note });
    output = clip(String(res?.output ?? ''), MAX_OUTPUT);
  }
  return { type: 'function_call_output', call_id: callId, output };
}

// One computer_call: its safety checks first (each a card), then its actions in order (stopping at the first that does not run), then a
// fresh screenshot for the answer. -> { items } to send back, or { end, text } when the run ends here.
export async function answerComputerCall(call, run) {
  const acknowledged = [];
  for (const check of Array.isArray(call.pending_safety_checks) ? call.pending_safety_checks : []) {
    const code = typeof check?.code === 'string' ? check.code : '';
    const message = typeof check?.message === 'string' ? check.message : '';
    const answer = await run.confirm({ action: `the step OpenAI flagged (${code || 'no code'})`, why: message, from: 'openai', code });
    if (answer.over) return { end: 'stopped', text: answer.output };
    if (!answer.approved) return { end: 'declined' };
    acknowledged.push({ id: typeof check?.id === 'string' ? check.id : String(check?.id ?? ''), code, message });
  }
  let note = null;
  let count = 0;
  for (const action of Array.isArray(call.actions) ? call.actions : []) {
    count += 1;
    let steps;
    try {
      steps = toCanonicalAction(action);
    } catch (err) {
      note = `Action ${count} did not run: ${err.message}`;
      break;
    }
    for (const canonical of steps) {
      const res = await run.step(canonical);
      if (res.over) return { end: 'stopped', text: res.output };
      if (!res.ok) {
        note = `Action ${count} did not run: ${clip(String(res.output ?? 'the step failed'), MAX_NOTE)}`;
        break;
      }
    }
    if (note) break;
  }
  const shot = await run.step({ kind: 'screenshot' });
  const picture = imageOf(shot);
  if (!picture) return { end: 'stopped', text: String(shot?.output ?? 'Computer use stopped.') };
  const items = [{
    type: 'computer_call_output',
    call_id: String(call.call_id ?? ''),
    output: { type: 'computer_screenshot', image_url: `data:image/png;base64,${picture}`, detail: 'original' },
    ...(acknowledged.length ? { acknowledged_safety_checks: acknowledged } : {}),
  }];
  if (note) items.push({ role: 'user', content: [{ type: 'input_text', text: `${note}. The rest of this step did not run. The screenshot above shows the screen now; take a fresh look before the next step.` }] });
  return { items };
}

// The driver. ctx.computer is the run (set for the whole turn by server.mjs), and ctx is the turn's context (emit, out, mode, root).
export async function* streamComputer({ id, system, messages = [], signal, ctx, effort, onUsage, onStop, images, documents } = {}) {
  if (images?.length) throw new Error(IMAGE_REFUSAL);
  if (documents?.length) throw new Error(pdfRefusal(documents.length === 1 ? documents[0].name : ''));
  const run = ctx?.computer;
  if (!run) throw new Error('No computer run is on for this turn.');
  const apiKey = await keyFor('openai');
  if (!apiKey) throw new Error('No OpenAI key is saved. Open Accounts, paste the key and save it.');
  const model = String(id || OPENAI_COMPUTER_MODEL);
  // server.mjs adds the run's rules to the system text already; a run the model started adds them to its tool result only, so they are
  // added here when they are missing.
  const rules = run.systemText;
  const base = String(system ?? '');
  const instructions = base.includes(rules) ? base : [base, rules].filter(s => s.trim()).join('\n\n');
  const tools = [{ type: 'computer' }, ...(await functionToolsFor(ctx))];
  const reports = [];
  const first = await run.step({ kind: 'screenshot' });
  let input = firstInput(messages, first);
  let previous = null;

  for (let request = 0; ; request++) {
    if (signal?.aborted) return;
    if (request >= run.maxRequests) {
      yield `\n\n[Stopped after ${run.maxRequests} requests. Send a follow-up to continue.]`;
      return;
    }
    const body = { model, instructions, tools, input, ...(previous ? { previous_response_id: previous } : {}) };
    const at = Date.now();
    const response = await create({ apiKey, body, signal });
    if (!response) return;
    previous = typeof response.id === 'string' ? response.id : previous;
    // The tokens of a request that was answered are counted, even when the run ends after it.
    const tokens = tokensFromChat(response.usage);
    if (tokens) {
      const record = { at, ...tokens };
      reports.push(record);
      reportUsage(onUsage, record);
    }
    const output = Array.isArray(response.output) ? response.output : [];
    for (const item of output) {
      if (item?.type !== 'message') continue;
      const said = textOf(item);
      if (said) yield said;
    }
    const calls = output.filter(item => item?.type === 'computer_call');
    const functions = output.filter(item => item?.type === 'function_call');
    if (!calls.length && !functions.length) {
      if (response.incomplete_details?.reason === 'max_output_tokens') onStop?.('length');
      return;
    }
    // A spend cap is checked every fifth request, before the actions of that reply run (as the Claude path does).
    if ((request + 1) % BUDGET_EVERY === 0 && run.budgetCheck(reports)?.over) return;

    const next = [];
    for (const fn of functions) next.push(await answerFunction(fn, ctx));
    let ended = null;
    for (const call of calls) {
      const answer = await answerComputerCall(call, run);
      if (answer.end) {
        ended = answer;
        break;
      }
      next.push(...answer.items);
    }
    if (ended) {
      if (ended.end === 'declined') {
        ctx.emit?.({ type: 'notice', kind: 'computer', text: DECLINED_NOTICE });
        // Finished as a user stop, as the Gemini driver ends a declined check: the run log and summary say so. It is done before the reply
        // is yielded, so a caller that stops reading after the reply still leaves the run finished.
        await run.finish('user');
        yield DECLINED_REPLY;
      } else if (ended.text) {
        yield ended.text;
      }
      return;
    }
    input = next;
  }
}
